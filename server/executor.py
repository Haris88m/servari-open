#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""executor.py — THE MISSING EXECUTION ENGINE CORE.

SERVARI's autonomy stack has three pieces that, until now, never closed the loop:

  1. verify_queue.py  — parks gated actions; the operator approves/rejects them.
  2. autonomy.py      — the per-agent dial that turns (level + risk-score) into a
                        verdict: "act" | "report" | "queue".
  3. (missing)        — the thing that, once an item is APPROVED, actually RUNS a
                        safe action. Without it, an approval went nowhere. This
                        module is that missing third piece.

run_once() walks the approved entries in the gate queue, and for each one it has
not executed before:
    - maps the entry's gate-class to a risk score,
    - asks autonomy.decide(agent, score) for a verdict,
    - executes ONLY if verdict == "act" AND the action is in the EXECUTOR
      allow-list of safe, read-only / diagnostic operations,
    - otherwise records a "skipped" event with the reason,
    - records exactly one "executed" / "skipped" / "error" event per entry to an
      append-only log (engine-executed.jsonl), so an item is NEVER run twice.

Safety stance (matches AGENTS.md + the server's ACTIONS philosophy):
  - STDLIB ONLY. No runtime pip dependency.
  - The allow-list contains ONLY side-effect-light, read-only/diagnostic actions.
    Nothing here deploys, spends, sends, or publishes — those stay PARKED in the
    gate queue forever; the dial can never widen the band enough to auto-cross
    them, and even if it did, they are not in this allow-list so they cannot run.
  - Fail-closed: any error while processing an entry is caught, recorded as an
    "error" event, and the loop continues. The loop never crashes the caller.
  - Append-only discipline mirrors verify_queue: one JSON object per line, the
    log is never rewritten, executed-state is replayed from it.

Log file: demo-data/engine-executed.jsonl
  event: {id, action, agent, gate, verdict, status, ok, out_excerpt, reason, ts}
    status is one of: "executed" | "skipped" | "error"

Importable + unit-testable. Self-test:
    python server/executor.py --self-test
prints a single PASS/FAIL line and exits 0/1.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import platform
import shutil
import sys
from pathlib import Path

# Force UTF-8 stdout/stderr so non-ASCII never crashes a Windows cp1252 console.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

# verify_queue + autonomy live beside this file in server/. Importing them by
# module name works when server/ is on sys.path (it is when SERVARI imports us,
# and we ensure it below for the standalone-script case too).
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import autonomy        # noqa: E402  (after sys.path setup, by design)
import verify_queue    # noqa: E402


# ---------------------------------------------------------------------------
# data-home resolution — identical pattern to verify_queue / autonomy
# ---------------------------------------------------------------------------
def _home() -> Path:
    """Resolve the data home (SERVARI_HOME env, else repo root, else cwd)."""
    env = os.environ.get("SERVARI_HOME")
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p.resolve()
    here = Path(__file__).resolve().parent      # .../server
    repo = here.parent                          # repo root
    if (repo / "demo-data").is_dir():
        return repo
    return Path.cwd()


def _log_path() -> Path:
    """The append-only executed-log path, resolved fresh each call so tests that
    set SERVARI_HOME at runtime see the right file (mirrors how verify_queue and
    autonomy re-resolve home on each call rather than caching at import)."""
    return _home() / "demo-data" / "engine-executed.jsonl"


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# the EXECUTOR allow-list — SAFE, side-effect-light, read-only / diagnostic only
# ---------------------------------------------------------------------------
# Mirrors the server's ACTIONS philosophy: each action is read-only or a bounded
# local probe. NO deploy / spend / send / publish — those stay parked in the gate
# queue and are intentionally absent here so they can never execute autonomously.
def _act_python_version() -> dict:
    return {"ok": True,
            "out": f"Python {platform.python_version()} on "
                   f"{platform.system()} {platform.release()}"}


def _act_disk_free() -> dict:
    try:
        total, _used, free = shutil.disk_usage(str(_home()))
        gb = 1024 ** 3
        return {"ok": True,
                "out": f"disk free: {free / gb:.1f} GB of {total / gb:.1f} GB "
                       f"(home={_home()})"}
    except Exception as e:  # fail-closed
        return {"ok": False, "out": f"error: {type(e).__name__}: {e}"}


def _act_workspace_health() -> dict:
    """Read-only snapshot of the local data home: which key stores exist."""
    home = _home()
    demo = home / "demo-data"
    parts = [
        f"home: {home}",
        f"demo-data present: {demo.is_dir()}",
        f"gate-queue present: {(demo / 'gate-queue.jsonl').is_file()}",
        f"autonomy-levels present: {(demo / 'autonomy-levels.json').is_file()}",
        f"agents dir present: {(demo / 'agents').is_dir()}",
    ]
    try:
        pending = len(verify_queue.list_pending())
        parts.append(f"gate-queue pending: {pending}")
    except Exception:
        parts.append("gate-queue pending: unavailable")
    return {"ok": demo.is_dir(), "out": "\n".join(parts)}


def _act_public_verification() -> dict:
    """Report whether the bundled verification harness is present. Read-only —
    we do NOT execute the harness from the autonomous loop (it can spawn the
    engine / bind ports); presence is the safe diagnostic here."""
    script = _home() / "scripts" / "verify_all.py"
    return {"ok": script.is_file(),
            "out": f"verify_all.py present: {script.is_file()} ({script})"}


def _act_rss_refresh() -> dict:
    """No-op-safe diagnostic placeholder for the rss-refresh action: the real RSS
    cache lives inside the server process. From the standalone executor we only
    report that the action was recognized — no network side effects."""
    return {"ok": True, "out": "rss-refresh acknowledged (cache lives in server "
                               "process; no autonomous network fetch performed)"}


EXECUTOR_ACTIONS = {
    "python-version": _act_python_version,
    "disk-free": _act_disk_free,
    "workspace-health": _act_workspace_health,
    "public-verification": _act_public_verification,
    "rss-refresh": _act_rss_refresh,
}


# ---------------------------------------------------------------------------
# gate-class -> risk score (lower = safer; bands per autonomy.py: <=8 silent)
# ---------------------------------------------------------------------------
# Read-only diagnostics map LOW (safe band). The hard human-gate classes map to
# the refuse band so autonomy.decide() can NEVER return "act" for them — a second
# line of defense on top of the allow-list.
_GATE_RISK = {
    "read-only": 4,
    "diagnostic": 4,
    "network-read": 6,
    "deploy": 20,
    "real-send": 20,
    "spend": 20,
    "publish": 20,
    "merge-to-main": 18,
    "secret": 20,
}
_DEFAULT_RISK = 20  # unknown gate -> HIGH-risk band (same as deploy/spend/etc.):
#                     a complete second barrier so an unrecognized gate is queued,
#                     never auto-acted, even if the allow-list were ever widened.


def _gate_to_score(gate: str) -> int:
    return _GATE_RISK.get((gate or "").strip(), _DEFAULT_RISK)


# ---------------------------------------------------------------------------
# executed-log I/O — append-only, replay-based (mirrors verify_queue discipline)
# ---------------------------------------------------------------------------
def _read_events() -> list:
    """Every executed-log line as a parsed dict. Missing file -> []. Never raises."""
    out: list = []
    path = _log_path()
    try:
        if not path.is_file():
            return out
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass  # tolerate a corrupt line; the log stays readable
    except Exception:
        return out
    return out


def _append_event(obj: dict) -> bool:
    """Append one JSON object as a line. Creates parent dir + file. True on success."""
    path = _log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False


def _terminal_ids() -> set:
    """Set of gate-queue entry ids that are TERMINAL for re-processing.

    Only a real execution is terminal: an id is never run again once it has an
    'executed' line, OR a 'started' claim line (the claim is written BEFORE the
    action runs, so a lone 'started' means the action was already attempted and
    must not be retried — this is what makes execution exactly-once even if the
    process dies between act and the terminal 'executed' record).

    Crucially, 'skipped' and 'error' are NOT terminal here. A 'skipped' is the
    result of autonomy.decide returning a non-'act' verdict (e.g. the agent was
    at a low level, or the action was not yet allow-listed) — that decision is
    not permanent, so when the operator later raises the dial the still-approved
    entry must be re-evaluated and can finally execute. An 'error' from a
    transient failure (decide raised, a disk hiccup) likewise must be retryable
    rather than permanently burned. Re-evaluation is rate-limited elsewhere
    (see _last_nonterminal) so a permanently-parked entry is not re-logged every
    tick."""
    return {ev.get("id") for ev in _read_events()
            if isinstance(ev, dict) and ev.get("id")
            and ev.get("status") in ("executed", "started")}


def _last_nonterminal() -> dict:
    """Map id -> last recorded (status, reason) for entries whose latest event is
    a non-terminal 'skipped'/'error'. Used to suppress re-logging an unchanged
    skip/error every tick: we only append a new non-terminal event when the
    verdict/reason actually changes."""
    out: dict = {}
    for ev in _read_events():
        if not isinstance(ev, dict):
            continue
        eid = ev.get("id")
        if not eid:
            continue
        status = ev.get("status")
        if status in ("skipped", "error"):
            out[eid] = (status, ev.get("reason", ""))
        elif status in ("executed", "started"):
            out.pop(eid, None)  # later terminal event clears any prior skip/error
    return out


def _approved_entries() -> list:
    """Gate-queue entries whose latest status is 'approved', oldest-first."""
    try:
        idx = verify_queue._index_status()
    except Exception:
        return []
    approved = [v["entry"] for v in idx.values()
                if v.get("status") == "approved"]
    approved.sort(key=lambda e: e.get("ts", ""))
    return approved


# ---------------------------------------------------------------------------
# the loop
# ---------------------------------------------------------------------------
def run_once() -> dict:
    """Process the approved gate-queue entries once.

    For each entry that is NOT already terminal (executed/started-claimed):
    gate -> risk score -> autonomy.decide(agent, score). Execute only if
    verdict == 'act' AND the action is allow-listed; otherwise record 'skipped'.
    Any error is caught and recorded as 'error'. 'skipped'/'error' are NOT
    terminal — the entry is re-evaluated on later ticks (so raising the dial lets
    a still-approved entry finally run), but a repeated skip/error with the same
    reason is suppressed to avoid log spam.

    Exactly-once for real executions is enforced by a claim line: we append a
    'started' record (and verify it persisted) BEFORE invoking the side-effecting
    action, then append the terminal 'executed' record after. On replay a lone
    'started' is treated as already-attempted and never re-run, so a crash or a
    failed terminal-record write can never cause a double execution.

    Always writes a lightweight per-tick heartbeat so liveness can be derived
    from the tick itself, not only from work product."""
    terminal = _terminal_ids()
    prior = _last_nonterminal()
    executed = skipped = errored = 0

    for entry in _approved_entries():
        eid = entry.get("id")
        if not eid or eid in terminal:
            continue  # exactly-once: never reprocess an executed/claimed id

        action = (entry.get("action") or "").strip()
        agent = (entry.get("agent") or "unknown").strip()
        gate = (entry.get("gate") or "").strip()
        base = {"id": eid, "action": action, "agent": agent, "gate": gate,
                "ts": _now_iso()}

        def _record_nonterminal(status: str, reason: str, verdict: str) -> bool:
            """Append a skipped/error event only if it is new or its reason
            changed since the last recorded non-terminal event for this id.
            Returns True if a new event was actually written (a repeated,
            unchanged skip/error is suppressed and returns False)."""
            if prior.get(eid) == (status, reason):
                return False  # unchanged — suppress to avoid per-tick log spam
            _append_event({**base, "verdict": verdict, "status": status,
                           "ok": False, "out_excerpt": "", "reason": reason})
            prior[eid] = (status, reason)
            return True

        try:
            score = _gate_to_score(gate)
            verdict_obj = autonomy.decide(agent, score)
            verdict = verdict_obj.get("verdict", "queue")

            if verdict != "act":
                if _record_nonterminal(
                        "skipped",
                        f"verdict={verdict} (not 'act'): "
                        f"{verdict_obj.get('reason', '')}",
                        verdict):
                    skipped += 1
                continue

            fn = EXECUTOR_ACTIONS.get(action)
            if fn is None:
                if _record_nonterminal(
                        "skipped",
                        f"action '{action}' not in executor allow-list",
                        verdict):
                    skipped += 1
                continue

            # CLAIM before acting: persist a 'started' line first. If it does not
            # persist, do NOT run the action — the ledger must be able to record
            # the attempt, else a replay would double-execute. The claim makes the
            # id terminal for re-processing immediately.
            if not _append_event({**base, "verdict": verdict,
                                  "status": "started", "ok": False,
                                  "out_excerpt": "", "reason": "claim"}):
                if _record_nonterminal(
                        "error",
                        "ledger_write_failed: could not persist 'started' "
                        "claim; refusing to run action unrecorded", "error"):
                    errored += 1
                continue
            terminal.add(eid)

            result = fn() or {}
            out = str(result.get("out", ""))[:500]
            _append_event({**base, "verdict": verdict, "status": "executed",
                           "ok": bool(result.get("ok")), "out_excerpt": out,
                           "reason": "act+allow-listed"})
            executed += 1

        except Exception as e:  # fail-closed; never crash the loop
            if _record_nonterminal("error", f"{type(e).__name__}: {e}", "error"):
                errored += 1

    _append_event({"id": "", "status": "tick", "ts": _now_iso(),
                   "executed": executed, "skipped": skipped,
                   "errored": errored})

    return {"ok": True, "tick_ts": _now_iso(), "executed": executed,
            "skipped": skipped, "errored": errored}


# A tick/event older than this many seconds is considered stale -> not running.
_RUNNING_WINDOW_SECONDS = 15


def _parse_iso(ts: str):
    """Parse an ISO-8601 timestamp (as written by _now_iso) to an aware datetime.
    Returns None on any malformed/empty value — callers treat None as 'stale'."""
    if not ts:
        return None
    try:
        dt = datetime.datetime.fromisoformat(ts)
    except Exception:
        return None
    if dt.tzinfo is None:  # treat naive as UTC
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def state() -> dict:
    """Engine state derived from the append-only log: running reflects LIVENESS —
    true only if the last recorded event timestamp is within
    _RUNNING_WINDOW_SECONDS of now; a missing/empty/stale log yields running=False.
    Liveness comes from the per-tick heartbeat line ({status:'tick'}) that
    run_once writes EVERY invocation, so an alive engine that has nothing to do
    still keeps running=True. 'tick' and 'started' lines are ignored for the
    executed/skipped/errored counts; only real terminal events are counted."""
    events = _read_events()
    executed = sum(1 for e in events
                   if isinstance(e, dict) and e.get("status") == "executed")
    skipped = sum(1 for e in events
                  if isinstance(e, dict) and e.get("status") == "skipped")
    errored = sum(1 for e in events
                  if isinstance(e, dict) and e.get("status") == "error")
    last_tick = ""
    for e in reversed(events):
        if isinstance(e, dict) and e.get("ts"):
            last_tick = e.get("ts", "")
            break

    running = False
    last_dt = _parse_iso(last_tick)
    if last_dt is not None:
        age = (datetime.datetime.now(datetime.timezone.utc) - last_dt).total_seconds()
        running = 0 <= age <= _RUNNING_WINDOW_SECONDS

    return {
        "running": running,
        "last_tick": last_tick,
        "executed_count": executed,
        "skipped_count": skipped,
        "errored_count": errored,
    }


# ---------------------------------------------------------------------------
# self-test — isolated temp SERVARI_HOME; asserts exactly-once + double-run no-op
# ---------------------------------------------------------------------------
def self_test() -> bool:
    """Enqueue a gate, approve it, run_once twice, assert exactly-once execution.
    Runs in an isolated temp SERVARI_HOME so it never touches real demo-data."""
    import tempfile

    prev_home = os.environ.get("SERVARI_HOME")
    tmp = tempfile.mkdtemp(prefix="servari-executor-selftest-")
    try:
        (Path(tmp) / "demo-data").mkdir(parents=True, exist_ok=True)
        os.environ["SERVARI_HOME"] = tmp
        # Point verify_queue's module-level QUEUE at the temp home too (it caches
        # ROOT/QUEUE at import time from _home()).
        verify_queue.ROOT = Path(tmp)
        verify_queue.QUEUE = Path(tmp) / "demo-data" / "gate-queue.jsonl"

        # 1) enqueue a SAFE, allow-listed action under a read-only gate
        eid = verify_queue.enqueue(
            agent="self-test-agent", gate="read-only", action="python-version",
            summary="self-test exactly-once",
        )
        assert eid, "enqueue returned no id"

        # default autonomy level L2 acts-then-reports on <=8 ... but verdict must
        # be 'act' to execute. read-only -> score 4. Set the agent to L5 so the
        # safe band returns 'act' (silent) deterministically.
        autonomy_set = autonomy.set_level("self-test-agent", 5)
        assert autonomy_set.get("ok"), f"set_level failed: {autonomy_set}"

        # not approved yet -> run_once must do nothing
        r0 = run_once()
        assert r0["executed"] == 0, f"executed before approval: {r0}"

        # 2) approve it
        upd = verify_queue.decide(eid, "approve", "self-test approve")
        assert upd.get("status") == "approved", f"approve failed: {upd}"

        # 3) first run -> exactly one execution
        r1 = run_once()
        assert r1["executed"] == 1, f"first run should execute 1: {r1}"

        st1 = state()
        assert st1["executed_count"] == 1, f"state executed_count != 1: {st1}"

        # 4) second run -> strict no-op (exactly-once / never double-execute)
        r2 = run_once()
        assert r2["executed"] == 0 and r2["skipped"] == 0, \
            f"double-run not a no-op: {r2}"

        st2 = state()
        assert st2["executed_count"] == 1, \
            f"executed_count changed on re-run: {st2}"

        # 5) a hard-gate action must be SKIPPED even if approved (gate held).
        # Use a distinct action so the deterministic id differs from step 1's
        # (id = sha1(ts|agent|action); same-second + same action would collide).
        eid2 = verify_queue.enqueue(
            agent="self-test-agent", gate="deploy", action="disk-free",
            summary="hard gate must not auto-execute",
        )
        assert eid2 and eid2 != eid, f"expected a distinct id for step 5: {eid2}"
        verify_queue.decide(eid2, "approve", "approved but high-risk")
        r3 = run_once()
        assert r3["executed"] == 0 and r3["skipped"] == 1, \
            f"hard-gate entry should be skipped, not executed: {r3}"

        # 6) an UNKNOWN/unrecognized gate must ALSO be skipped even when approved:
        # the gate-score layer defaults unknown gates to the HIGH-risk score, so
        # autonomy.decide queues rather than acts. The allow-list is not the only
        # barrier — this proves the second barrier holds for unrecognized gates.
        eid3 = verify_queue.enqueue(
            agent="self-test-agent", gate="totally-unknown-gate",
            action="workspace-health",
            summary="unknown gate must not auto-execute",
        )
        assert eid3 and eid3 not in (eid, eid2), \
            f"expected a distinct id for step 6: {eid3}"
        verify_queue.decide(eid3, "approve", "approved but unknown gate")
        r4 = run_once()
        assert r4["executed"] == 0 and r4["skipped"] == 1, \
            f"unknown-gate entry should be skipped, not executed: {r4}"

        # 6b) 'skipped' is NOT terminal: an entry skipped because the dial was too
        # low must EXECUTE once the operator raises the agent's level. Enqueue a
        # safe allow-listed action, drop the agent to L1 (so a read-only score
        # yields a non-'act' verdict -> skipped), approve, tick -> skipped; then
        # raise the dial to L5 and tick again -> it finally executes. This is the
        # exact regression for the 'skipped is terminal' bug.
        before_exec = state()["executed_count"]
        eid_lift = verify_queue.enqueue(
            agent="lift-agent", gate="read-only", action="disk-free",
            summary="skipped-then-executed after dial raised",
        )
        assert eid_lift, "enqueue (6b) returned no id"
        assert autonomy.set_level("lift-agent", 1).get("ok"), "set L1 failed"
        verify_queue.decide(eid_lift, "approve", "approved at L1")
        r_low = run_once()
        assert r_low["executed"] == 0 and r_low["skipped"] >= 1, \
            f"entry should be skipped at L1: {r_low}"
        assert state()["executed_count"] == before_exec, \
            "nothing should have executed yet at L1"
        assert autonomy.set_level("lift-agent", 5).get("ok"), "set L5 failed"
        r_high = run_once()
        assert r_high["executed"] == 1, \
            f"after raising dial the still-approved entry must execute: {r_high}"
        assert state()["executed_count"] == before_exec + 1, \
            "executed_count must increment after the dial is raised"
        # and it is now terminal — a further tick is a no-op for this id
        r_again = run_once()
        assert r_again["executed"] == 0, \
            f"executed entry must not re-run: {r_again}"

        # 6c) exactly-once survives a failed terminal-record write: a lone
        # 'started' claim (no 'executed' line) must be treated as already-attempted
        # and NEVER re-run on replay. Simulate a crash-after-claim by writing a
        # bare 'started' line for an approved entry, then asserting run_once does
        # not execute it.
        before_claim = state()["executed_count"]
        eid_claim = verify_queue.enqueue(
            agent="lift-agent", gate="read-only", action="disk-free",
            summary="claim-only must not re-run",
        )
        verify_queue.decide(eid_claim, "approve", "approved; will pre-claim")
        _append_event({"id": eid_claim, "action": "disk-free",
                       "agent": "lift-agent", "gate": "read-only",
                       "verdict": "act", "status": "started", "ok": False,
                       "out_excerpt": "", "reason": "claim",
                       "ts": _now_iso()})
        r_claim = run_once()
        assert r_claim["executed"] == 0, \
            f"a pre-claimed (started) entry must not execute on replay: {r_claim}"
        assert state()["executed_count"] == before_claim, \
            "claim-only entry must not change executed_count"

        # 6d) liveness from the heartbeat: an idle tick (no approved-unseen work)
        # still writes a 'tick' line, so state().running is True right after a tick
        # even when zero entries were processed.
        r_idle = run_once()
        assert r_idle["executed"] == 0, f"idle tick should do no work: {r_idle}"
        assert state()["running"] is True, \
            "running must be True immediately after a heartbeat tick"

        # 7) liveness: with no recent tick, state().running must be False. The last
        # event was written 'now', so backdate it past the freshness window by
        # appending a fresh event with an old ts, then assert running is False.
        old_ts = (datetime.datetime.now(datetime.timezone.utc)
                  - datetime.timedelta(seconds=_RUNNING_WINDOW_SECONDS + 60)
                  ).isoformat(timespec="seconds")
        _append_event({"id": "selftest-stale", "action": "", "agent": "",
                       "gate": "", "verdict": "skipped", "status": "skipped",
                       "ok": False, "out_excerpt": "", "reason": "stale-tick probe",
                       "ts": old_ts})
        st_stale = state()
        assert st_stale["running"] is False, \
            f"running must be False when last tick is stale: {st_stale}"

        # 8) liveness: an empty/missing log yields running=False cleanly (no crash).
        empty_home = tempfile.mkdtemp(prefix="servari-executor-empty-")
        prev = os.environ.get("SERVARI_HOME")
        try:
            (Path(empty_home) / "demo-data").mkdir(parents=True, exist_ok=True)
            os.environ["SERVARI_HOME"] = empty_home
            st_empty = state()
            assert st_empty["running"] is False and st_empty["last_tick"] == "", \
                f"empty log must yield running=False, last_tick='': {st_empty}"
        finally:
            if prev is None:
                os.environ.pop("SERVARI_HOME", None)
            else:
                os.environ["SERVARI_HOME"] = prev
            os.environ["SERVARI_HOME"] = tmp  # restore the step-1..7 home
            shutil.rmtree(empty_home, ignore_errors=True)

        return True
    except AssertionError as e:
        print(f"self-test assertion failed: {e}")
        return False
    except Exception as e:  # fail-closed
        print(f"self-test crashed: {type(e).__name__}: {e}")
        return False
    finally:
        # restore environment + verify_queue module globals
        if prev_home is None:
            os.environ.pop("SERVARI_HOME", None)
        else:
            os.environ["SERVARI_HOME"] = prev_home
        verify_queue.ROOT = verify_queue._home()
        verify_queue.QUEUE = verify_queue.ROOT / "demo-data" / "gate-queue.jsonl"
        try:
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="SERVARI execution engine core (autonomy -> verify_queue -> execute).")
    ap.add_argument("--self-test", action="store_true",
                    help="run the isolated exactly-once self-test; print PASS/FAIL.")
    ap.add_argument("--run-once", action="store_true",
                    help="process approved entries once; print the tick summary.")
    ap.add_argument("--state", action="store_true",
                    help="print the engine state derived from the executed log.")
    args = ap.parse_args(argv)

    if args.self_test:
        ok = self_test()
        print("PASS" if ok else "FAIL")
        return 0 if ok else 1

    if args.run_once:
        print(json.dumps(run_once(), ensure_ascii=False, indent=2))
        return 0

    if args.state:
        print(json.dumps(state(), ensure_ascii=False, indent=2))
        return 0

    ap.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
