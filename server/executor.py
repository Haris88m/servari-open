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
_DEFAULT_RISK = 14  # unknown gate -> "ask" band; will not auto-act


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


def _executed_ids() -> set:
    """Set of gate-queue entry ids that already have a terminal event recorded.
    'executed', 'skipped' and 'error' are all terminal — an entry is processed at
    most once, so a re-run is a strict no-op for already-seen ids."""
    return {ev.get("id") for ev in _read_events()
            if isinstance(ev, dict) and ev.get("id")}


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
    """Process every approved-but-not-yet-executed gate-queue entry exactly once.

    For each: gate -> risk score -> autonomy.decide(agent, score). Execute only if
    verdict == 'act' AND the action is allow-listed; else record 'skipped'. Any
    error is caught and recorded as 'error'. Returns a summary of this tick."""
    seen = _executed_ids()
    executed = skipped = errored = 0

    for entry in _approved_entries():
        eid = entry.get("id")
        if not eid or eid in seen:
            continue  # exactly-once: never reprocess a recorded id

        action = (entry.get("action") or "").strip()
        agent = (entry.get("agent") or "unknown").strip()
        gate = (entry.get("gate") or "").strip()
        base = {"id": eid, "action": action, "agent": agent, "gate": gate,
                "ts": _now_iso()}
        try:
            score = _gate_to_score(gate)
            verdict_obj = autonomy.decide(agent, score)
            verdict = verdict_obj.get("verdict", "queue")

            if verdict != "act":
                _append_event({**base, "verdict": verdict, "status": "skipped",
                               "ok": False, "out_excerpt": "",
                               "reason": f"verdict={verdict} (not 'act'): "
                                         f"{verdict_obj.get('reason', '')}"})
                skipped += 1
                seen.add(eid)
                continue

            fn = EXECUTOR_ACTIONS.get(action)
            if fn is None:
                _append_event({**base, "verdict": verdict, "status": "skipped",
                               "ok": False, "out_excerpt": "",
                               "reason": f"action '{action}' not in executor "
                                         f"allow-list"})
                skipped += 1
                seen.add(eid)
                continue

            result = fn() or {}
            out = str(result.get("out", ""))[:500]
            _append_event({**base, "verdict": verdict, "status": "executed",
                           "ok": bool(result.get("ok")), "out_excerpt": out,
                           "reason": "act+allow-listed"})
            executed += 1
            seen.add(eid)

        except Exception as e:  # fail-closed; never crash the loop
            _append_event({**base, "verdict": "error", "status": "error",
                           "ok": False, "out_excerpt": "",
                           "reason": f"{type(e).__name__}: {e}"})
            errored += 1
            seen.add(eid)

    return {"ok": True, "tick_ts": _now_iso(), "executed": executed,
            "skipped": skipped, "errored": errored}


def state() -> dict:
    """Engine state derived from the append-only log: running is best-effort
    (the loop is driven by app.py's background thread, so from the core we report
    whether any tick has been recorded), last_tick + the executed/skipped counts."""
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
    return {
        "running": True,
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
