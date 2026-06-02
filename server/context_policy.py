#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""context_policy.py — THE CONTEXT-PRESSURE POLICY, FIRST-CLASS.

THE CONCEPT: the LLM context window IS the agent's RAM. A compaction / restart is
a swap to disk. An agent's eviction policy often lives only IMPLICITLY ("findings
into context, never raw data"). This module makes it FIRST-CLASS — an explicit
written POLICY + a mechanism that:

  1. MEASURES context pressure from REAL signals (live transcript size+age,
     active-work staleness, work-log entries newer than the last checkpoint).
  2. VERIFIES the SWAP-FILE CONTRACT — that everything which MUST survive a context
     compaction is already persisted to disk (the SURVIVAL PINS).
  3. CHECKPOINTS — repairs what it mechanically can (refresh the active-work
     marker's last_checkpoint), reports what only a human can fix, appends an audit line.

The principle the policy protects: a compaction is only SAFE when every survival pin
is on disk. If a pin is missing, the agent risks waking up amnesiac about an open
HIGH risk or in-flight work. survival_check is HONEST — it reports REAL missing pins;
a missing pin is the tool WORKING, not failing.

All state is read from / written under demo-data/ so the shell runs standalone.
Point SERVARI_HOME at your own data dir to wire real signals.

Functions (importable — for servari_server.py wiring):
  pressure()             -> dict   measure real context-pressure signals
  survival_check()       -> dict   verify each SURVIVAL PIN is on disk right now
  checkpoint(note="")    -> dict   repair-what-you-can + report + audit-append
  policy()               -> dict   return the POLICY structure

CLI:
  python context_policy.py --pressure
  python context_policy.py --survival-check
  python context_policy.py --checkpoint [--note "..."]
  python context_policy.py --policy
  python context_policy.py --self-test

Stdlib only. cp1252-safe. Fail-closed/graceful: missing file -> sane verdict,
never crash.
"""
from __future__ import annotations
import argparse
import datetime
import glob
import json
import os
import re
import sys

# Force UTF-8 stdout/stderr so any non-ASCII never crashes on Windows consoles.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass


# --- data-home resolution (SERVARI_HOME env, else repo root, else cwd) -----------
def _home():
    """Resolve the data home. Prefer SERVARI_HOME; else the repo root (parent of
    this server/ dir) when it contains demo-data/; else cwd. Never raises."""
    env = os.environ.get("SERVARI_HOME")
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    here = os.path.dirname(os.path.abspath(__file__))   # .../server
    repo = os.path.dirname(here)                         # repo root
    if os.path.isdir(os.path.join(repo, "demo-data")):
        return repo
    return os.getcwd()


ROOT = _home()
DEMO = os.path.join(ROOT, "demo-data")

# --- canonical paths (all under demo-data/) -------------------------------------
ACTIVE_WORK = os.path.join(DEMO, "active-work.json")          # current work id + status
WORK_ENTRIES = os.path.join(DEMO, "work-log")                 # work-log/NNN-slug.md entries
SESSIONS_DIR = os.path.join(DEMO, "sessions")                # session facets SNNN.md
GATE_QUEUE = os.path.join(DEMO, "gate-queue.jsonl")
CONTEXT_DIR = os.path.join(DEMO, "context")
AUDIT = os.path.join(CONTEXT_DIR, "audit.jsonl")
TRANSCRIPT_DIR = os.path.join(DEMO, "transcripts")           # demo session transcripts (*.jsonl)

# --- pressure thresholds (the dial; tunable, documented) ------------------------
# Transcript size in MB: a fresh conversation grows; large = compaction approaching.
TRANSCRIPT_MB_MEDIUM = 2.0     # >= this -> at least MEDIUM
TRANSCRIPT_MB_HIGH = 5.0       # >= this -> HIGH
# Work-log entries newer than the checkpoint = un-checkpointed in-flight work.
NEWER_ENTRIES_MEDIUM = 1       # >= this -> at least MEDIUM (active-work is behind)
NEWER_ENTRIES_HIGH = 3         # >= this -> HIGH (checkpoint badly behind reality)


# ===========================================================================
# THE POLICY (first-class, encoded as data; pretty-printed by --policy)
# ===========================================================================
POLICY = {
    "name": "SERVARI Context-Pressure Policy",
    "concept": (
        "The LLM context window is RAM; a compaction/restart is a swap to disk. "
        "This policy governs what may ENTER context (admission), what to LET GO "
        "first under pressure (eviction priority), what MUST be on disk before a "
        "compaction is safe (survival pins), and how the agent re-warms after a "
        "swap (recovery contract)."
    ),
    "admission": {
        "doc": "What MAY enter context.",
        "rules": [
            "FINDINGS not raw data (run the analysis; only keep the result).",
            "SUMMARIES not dumps (counts / IDs / specific examples, never full JSON blobs).",
            "ONE-LINE tool outputs preferred (terse PASS / FAIL <paths> over verbose logs).",
            "A file enters context only when its CONTENT (not a computed property of it) is needed.",
        ],
    },
    "eviction_priority": {
        "doc": "What to LET GO first when context pressure rises (earlier = evict sooner).",
        "order": [
            "1. completed-task details (the task is done; its trace is on disk if it mattered).",
            "2. intermediate tool outputs (the finding was extracted; the raw output is spent).",
            "3. old conversation turns (superseded context, already-acted-upon exchanges).",
            "NEVER EVICT: unpersisted HIGH risks; open gates; in-flight work state — "
            "these must be PERSISTED before they can leave context (see survival pins).",
        ],
    },
    "survival_pins": {
        "doc": "Must be ON DISK before a compaction is safe (the swap-file contract).",
        "pins": [
            "active-work.json FRESH — current work id + status, not behind the work-log.",
            "current work-log entry EXISTS — the in-flight work has a canonical record.",
            "open HIGH risks RECORDED — in the work entry or active-work.json (never context-only).",
            "pending gate decisions PARKED — in the gate queue (gate-queue.jsonl), not context-only.",
            "session facet APPENDED — the current session SNNN.md exists under sessions/.",
        ],
    },
    "recovery_contract": {
        "doc": "After any compaction/restart, the agent re-warms in this order.",
        "order": [
            "1. read active-work.json (warm-boot: current work id + status + next_action).",
            "2. read recent work-log entries (what-happened canonical record).",
            "3. read the agent's identity/config files (who-I-am; the cold-boot tier).",
        ],
    },
}


# ===========================================================================
# helpers (fail-closed; missing file -> sane default, never raise)
# ===========================================================================
def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _now_iso():
    return _now().isoformat(timespec="seconds")


def _safe_mtime(path):
    """File mtime as aware UTC datetime, or None if absent/unreadable."""
    try:
        ts = os.path.getmtime(path)
        return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
    except (OSError, ValueError):
        return None


def _age_min(dt):
    """Minutes between dt and now; None-safe (returns None)."""
    if dt is None:
        return None
    return round((_now() - dt).total_seconds() / 60.0, 1)


def _load_active_work():
    """Parse active-work.json -> dict, or {} on any failure. Never raises."""
    try:
        with open(ACTIVE_WORK, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return {}


def _newest_transcript():
    """(path, size_mb, age_min) of the newest *.jsonl transcript, or (None, 0.0, None).
    Degrades gracefully if the transcript dir is absent."""
    try:
        candidates = glob.glob(os.path.join(TRANSCRIPT_DIR, "*.jsonl"))
    except OSError:
        candidates = []
    # Only regular files are transcripts — a directory named "*.jsonl" can match the
    # glob; reject it so it can never be reported as the newest transcript.
    candidates = [c for c in candidates if os.path.isfile(c)]
    if not candidates:
        return None, 0.0, None
    newest = None
    newest_mtime = None
    for p in candidates:
        m = _safe_mtime(p)
        if m is None:
            continue
        if newest_mtime is None or m > newest_mtime:
            newest, newest_mtime = p, m
    if newest is None:
        return None, 0.0, None
    try:
        size_mb = round(os.path.getsize(newest) / (1024.0 * 1024.0), 3)
    except OSError:
        size_mb = 0.0
    return newest, size_mb, _age_min(newest_mtime)


_ENTRY_RE = re.compile(r"^(\d+)-")


def _max_work_entry_number():
    """Highest NNN among work-log entries/NNN-slug.md, or None. Never raises."""
    try:
        names = os.listdir(WORK_ENTRIES)
    except OSError:
        return None
    nums = []
    for n in names:
        m = _ENTRY_RE.match(n)
        if m and n.lower().endswith(".md"):
            try:
                nums.append(int(m.group(1)))
            except ValueError:
                pass
    return max(nums) if nums else None


def _work_entry_exists(wid):
    """True if a work-log/<wid>-*.md file exists for the given work id."""
    if wid is None:
        return False
    try:
        for n in os.listdir(WORK_ENTRIES):
            m = _ENTRY_RE.match(n)
            if m and n.lower().endswith(".md"):
                try:
                    if int(m.group(1)) == int(wid):
                        return True
                except ValueError:
                    pass
    except (OSError, TypeError, ValueError):
        return False
    return False


# ===========================================================================
# 1. pressure() — measure REAL context-pressure signals
# ===========================================================================
def pressure():
    """Measure real context pressure. Returns:
      {transcript_mb, transcript_age_min, transcript_path,
       active_work_stale: bool, stale_detail,
       work_entries_newer_than_checkpoint: int,
       active_work_id, newest_work_entry,
       pressure: 'LOW'|'MEDIUM'|'HIGH', recommendation}

    Signals (all REAL, read from disk now):
      (a) newest live transcript size (MB) + age (min) — the agent's RAM-on-disk;
      (b) active-work.json staleness — file mtime age + id-vs-newest-entry skew;
      (c) count of work-log entries NEWER than active-work.json's work id.
    Never raises; absent signals degrade to the safe side."""
    t_path, t_mb, t_age = _newest_transcript()

    aw = _load_active_work()
    aw_id = aw.get("work_id")
    try:
        aw_id_int = int(aw_id)
    except (TypeError, ValueError):
        aw_id_int = None

    newest_entry = _max_work_entry_number()

    # entries newer than the checkpoint = un-checkpointed in-flight work
    if aw_id_int is not None and newest_entry is not None:
        newer = max(0, newest_entry - aw_id_int)
    else:
        newer = 0

    # active-work staleness: id behind the newest entry OR file untouched a long time
    aw_mtime = _safe_mtime(ACTIVE_WORK)
    aw_age = _age_min(aw_mtime)
    stale = False
    stale_bits = []
    if aw_id_int is None:
        stale = True
        stale_bits.append("active-work.json missing or has no integer work_id")
    if newer > 0:
        stale = True
        stale_bits.append(
            f"work_id {aw_id_int} is {newer} behind newest entry {newest_entry}"
        )
    stale_detail = "; ".join(stale_bits) if stale_bits else "fresh"

    # --- compose pressure level from the strongest signal --------------------
    level = "LOW"
    drivers = []
    if t_mb >= TRANSCRIPT_MB_HIGH:
        level = "HIGH"
        drivers.append(f"transcript {t_mb}MB >= {TRANSCRIPT_MB_HIGH}MB")
    elif t_mb >= TRANSCRIPT_MB_MEDIUM:
        level = _max_level(level, "MEDIUM")
        drivers.append(f"transcript {t_mb}MB >= {TRANSCRIPT_MB_MEDIUM}MB")

    if newer >= NEWER_ENTRIES_HIGH:
        level = "HIGH"
        drivers.append(f"{newer} work entries un-checkpointed >= {NEWER_ENTRIES_HIGH}")
    elif newer >= NEWER_ENTRIES_MEDIUM:
        level = _max_level(level, "MEDIUM")
        drivers.append(f"{newer} work entr{'y' if newer == 1 else 'ies'} un-checkpointed")

    if not drivers:
        drivers.append("all signals nominal")

    if level == "HIGH":
        rec = (
            "HIGH pressure — run survival_check NOW; persist any open HIGH risk / gate "
            "decision; run checkpoint() before continuing. A compaction here risks amnesia."
        )
    elif level == "MEDIUM":
        rec = (
            "MEDIUM pressure — verify survival pins (survival_check) and checkpoint() at "
            "the next natural boundary; safe to continue meanwhile."
        )
    else:
        rec = "LOW pressure — no action needed; continue working."

    return {
        "transcript_mb": t_mb,
        "transcript_age_min": t_age,
        "transcript_path": t_path,
        "active_work_stale": stale,
        "stale_detail": stale_detail,
        "active_work_age_min": aw_age,
        "work_entries_newer_than_checkpoint": newer,
        "active_work_id": aw_id_int,
        "newest_work_entry": newest_entry,
        "pressure": level,
        "pressure_drivers": drivers,
        "recommendation": rec,
    }


def _max_level(a, b):
    rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
    return a if rank.get(a, 0) >= rank.get(b, 0) else b


# ===========================================================================
# 2. survival_check() — verify each SURVIVAL PIN is satisfied right now
# ===========================================================================
def survival_check():
    """Verify each SURVIVAL PIN is on disk right now (the swap-file contract).
    Returns {pins: {name: {ok, detail}}, all_ok: bool, missing: [...]}.
    A missing pin is the tool WORKING (a real gap), not failing. Never raises."""
    pins = {}
    aw = _load_active_work()

    # PIN 1: active-work.json FRESH (exists + integer id + not behind newest entry)
    aw_id = aw.get("work_id")
    try:
        aw_id_int = int(aw_id)
    except (TypeError, ValueError):
        aw_id_int = None
    newest_entry = _max_work_entry_number()
    if not aw:
        pins["active_work_fresh"] = {
            "ok": False, "detail": "active-work.json missing or unparseable"}
    elif aw_id_int is None:
        pins["active_work_fresh"] = {
            "ok": False, "detail": "active-work.json has no integer work_id"}
    elif newest_entry is not None and aw_id_int < newest_entry:
        pins["active_work_fresh"] = {
            "ok": False,
            "detail": f"work_id {aw_id_int} is behind newest work-log entry {newest_entry}"}
    else:
        pins["active_work_fresh"] = {
            "ok": True,
            "detail": f"work_id {aw_id_int} (newest entry {newest_entry})"}

    # PIN 2: current work-log entry EXISTS for the active work id
    if aw_id_int is None:
        pins["current_work_entry_exists"] = {
            "ok": False, "detail": "no active work id to check an entry for"}
    elif _work_entry_exists(aw_id_int):
        pins["current_work_entry_exists"] = {
            "ok": True, "detail": f"work-log/{aw_id_int}-*.md present"}
    else:
        pins["current_work_entry_exists"] = {
            "ok": False, "detail": f"no work-log/{aw_id_int}-*.md for active work"}

    # PIN 3: open HIGH risks RECORDED (in the entry or active-work.json, not context-only)
    # We can only verify the CHANNEL is open: active-work.json carries a next_action /
    # status field where HIGH risks are recorded. If the field is present and non-empty,
    # the recording channel exists. (We cannot prove a context-only risk is absent — that
    # is a human call; we verify the disk channel is usable.)
    risk_field = ""
    for key in ("next_action", "status"):
        v = aw.get(key)
        if isinstance(v, str) and v.strip():
            risk_field += v
    if not aw:
        pins["open_high_risks_recorded"] = {
            "ok": False,
            "detail": "active-work.json absent — no on-disk channel to record HIGH risks"}
    elif risk_field.strip():
        mentions_high = "HIGH" in risk_field or "GATED" in risk_field
        pins["open_high_risks_recorded"] = {
            "ok": True,
            "detail": (
                "on-disk risk channel present in active-work.json "
                f"(next_action/status; {'mentions HIGH/gated items' if mentions_high else 'no HIGH flagged'})"
            )}
    else:
        pins["open_high_risks_recorded"] = {
            "ok": False,
            "detail": "active-work.json has no next_action/status field to record HIGH risks"}

    # PIN 4: pending gate decisions PARKED (gate-queue.jsonl readable)
    pins["pending_gate_decisions_parked"] = _check_gate_queue()

    # PIN 5: session facet APPENDED (the active session's SNNN.md exists)
    pins["session_facet_appended"] = _check_session_facet(aw)

    missing = [name for name, p in pins.items() if not p["ok"]]
    return {"pins": pins, "all_ok": len(missing) == 0, "missing": missing}


def _check_gate_queue():
    """PIN 4 helper. The gate-queue must be READABLE (parked decisions survive on disk).
    Absent file = OK (no parked decisions to lose); present-but-corrupt = NOT ok."""
    if not os.path.isfile(GATE_QUEUE):
        return {"ok": True, "detail": "gate-queue.jsonl absent — no pending parked decisions"}
    try:
        # Single pass: confirm every line parses AND count pending against THIS module's
        # configured GATE_QUEUE. We replay status (pending entry -> decision line) exactly,
        # bound to the path we are checking — never delegating to a sibling module that
        # resolves a DIFFERENT queue path. Replaying here also avoids any sys.path mutation.
        status = {}  # id -> latest status
        with open(GATE_QUEUE, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)  # confirm each line is parseable
                except json.JSONDecodeError:
                    return {"ok": False,
                            "detail": "gate-queue.jsonl has a corrupt line (parked decision at risk)"}
                if not isinstance(ev, dict):
                    continue
                _id = ev.get("id")
                if not _id:
                    continue
                if ev.get("type") == "decision":
                    if _id in status:
                        status[_id] = ev.get("status", ev.get("decision", "decided"))
                else:
                    status[_id] = ev.get("status", "pending")
        pending = sum(1 for s in status.values() if s == "pending")
        return {"ok": True,
                "detail": f"gate-queue.jsonl readable ({pending} pending parked)"}
    except OSError as e:
        return {"ok": False, "detail": f"gate-queue.jsonl unreadable: {e}"}


def _check_session_facet(aw):
    """PIN 5 helper. The active session's facet SNNN.md must exist on disk."""
    sess = aw.get("session")
    if not isinstance(sess, str) or not sess.strip():
        # no declared session — fall back to "any facet exists" (boot state)
        try:
            any_facet = any(
                n.upper().startswith("S") and n.lower().endswith(".md")
                for n in os.listdir(SESSIONS_DIR)
            )
        except OSError:
            any_facet = False
        if any_facet:
            return {"ok": True,
                    "detail": "no session declared in active-work.json; session facets exist"}
        return {"ok": False,
                "detail": "no session declared and no session facets found"}
    facet = os.path.join(SESSIONS_DIR, f"{sess.strip()}.md")
    if os.path.isfile(facet):
        return {"ok": True, "detail": f"sessions/{sess.strip()}.md present"}
    return {"ok": False,
            "detail": f"sessions/{sess.strip()}.md MISSING for active session {sess.strip()}"}


# ===========================================================================
# 3. checkpoint() — repair what's mechanically fixable + report + audit
# ===========================================================================
def checkpoint(note=""):
    """Repair what survival_check found missing WHERE MECHANICALLY POSSIBLE, report
    what only a human can fix, append an audit line. Returns:
      {ts, note, before: <survival_check>, repaired: [...], needs_human: [...],
       after: <survival_check>, audit_appended: bool}.

    What checkpoint() CAN mechanically do:
      - refresh active-work.json's status field with a checkpoint stamp
        {last_checkpoint: ts, note} (a non-destructive merge — never rewrites the work).
    What it CANNOT do (reports to a human):
      - create a missing work-log entry (content is the human's to write);
      - record a context-only HIGH risk it cannot see;
      - append a missing session facet (content is the human's to write);
      - bump a stale work_id (that is the work-close action, not a checkpoint).
    Never raises; on any write failure, reports it and still returns a verdict."""
    ts = _now_iso()
    before = survival_check()
    repaired = []
    needs_human = []

    # --- the one mechanical repair: stamp last_checkpoint into active-work.json ---
    stamp_result = _stamp_checkpoint(ts, note)
    if stamp_result["ok"]:
        repaired.append(stamp_result["detail"])
    else:
        needs_human.append(f"could not stamp active-work.json checkpoint: {stamp_result['detail']}")

    # --- everything else missing is human-only ---------------------------------
    human_map = {
        "active_work_fresh": (
            "active-work.json work_id is stale (behind the work-log) — a human "
            "closes/advances the work; a checkpoint cannot bump the id (that would forge a close)."
        ),
        "current_work_entry_exists": (
            "the current work-log entry is missing — a human writes the entry content "
            "(work-log/<id>-slug.md); a checkpoint cannot author it."
        ),
        "open_high_risks_recorded": (
            "no on-disk HIGH-risk channel — a human records open HIGH risks into the work "
            "entry or active-work.json.next_action before any compaction."
        ),
        "session_facet_appended": (
            "the active session facet is missing — a human appends sessions/<SNNN>.md content."
        ),
        "pending_gate_decisions_parked": (
            "the gate-queue is corrupt/unreadable — a human repairs the gate-queue state "
            "(verify_queue.py) before relying on parked decisions surviving."
        ),
    }
    for name in before["missing"]:
        if name in human_map:
            needs_human.append(human_map[name])

    after = survival_check()

    audit_obj = {
        "ts": ts,
        "type": "checkpoint",
        "note": (note or "").strip(),
        "before_all_ok": before["all_ok"],
        "before_missing": before["missing"],
        "repaired": repaired,
        "needs_human": needs_human,
        "after_all_ok": after["all_ok"],
        "after_missing": after["missing"],
    }
    audit_appended = _append_audit(audit_obj)

    return {
        "ts": ts,
        "note": (note or "").strip(),
        "before": before,
        "repaired": repaired,
        "needs_human": needs_human,
        "after": after,
        "audit_appended": audit_appended,
    }


def _stamp_checkpoint(ts, note):
    """Non-destructive merge: write a context_checkpoint block into active-work.json.
    Never touches work_id/status/title (no forging a close). Returns {ok, detail}."""
    aw = _load_active_work()
    if not aw:
        return {"ok": False, "detail": "active-work.json absent/unparseable — nothing to stamp"}
    try:
        aw["context_checkpoint"] = {
            "last_checkpoint": ts,
            "note": (note or "").strip(),
            "by": "context_policy.py",
        }
        os.makedirs(os.path.dirname(ACTIVE_WORK), exist_ok=True)
        tmp = ACTIVE_WORK + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(aw, f, indent=2, ensure_ascii=False)
        os.replace(tmp, ACTIVE_WORK)
        return {"ok": True, "detail": f"stamped active-work.json context_checkpoint={ts}"}
    except OSError as e:
        return {"ok": False, "detail": str(e)}


def _append_audit(obj):
    """Append one JSON line to demo-data/context/audit.jsonl. Creates dir+file. True on success."""
    try:
        os.makedirs(CONTEXT_DIR, exist_ok=True)
        with open(AUDIT, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        return True
    except OSError:
        return False


# ===========================================================================
# 4. policy() — return the POLICY structure
# ===========================================================================
def policy():
    """Return the first-class POLICY structure (admission / eviction / pins / recovery)."""
    return POLICY


# ===========================================================================
# self-test (a runnable proof the module works)
# ===========================================================================
def self_test():
    """Run a deterministic self-test of all four functions against the REAL state.
    Honest: a survival pin reported missing is the tool WORKING. Returns
    {ok, checks: [...], summary}."""
    checks = []

    def _check(name, cond, detail=""):
        checks.append({"check": name, "ok": bool(cond), "detail": detail})

    # T1: policy() returns the 4-section structure
    p = policy()
    _check("policy_has_four_sections",
           all(k in p for k in ("admission", "eviction_priority", "survival_pins", "recovery_contract")),
           detail=f"keys={sorted(p.keys())}")

    # T2: pressure() returns a valid level + all contract keys
    pr = pressure()
    contract_keys = {
        "transcript_mb", "transcript_age_min", "active_work_stale", "stale_detail",
        "work_entries_newer_than_checkpoint", "pressure", "recommendation",
    }
    _check("pressure_contract_keys_present", contract_keys.issubset(pr.keys()),
           detail=f"missing={sorted(contract_keys - set(pr.keys()))}")
    _check("pressure_level_valid", pr["pressure"] in ("LOW", "MEDIUM", "HIGH"),
           detail=f"pressure={pr['pressure']}")
    _check("pressure_transcript_mb_is_number", isinstance(pr["transcript_mb"], (int, float)),
           detail=f"transcript_mb={pr['transcript_mb']}")

    # T3: survival_check() returns the contract shape + boolean all_ok
    sc = survival_check()
    _check("survival_contract_keys_present",
           all(k in sc for k in ("pins", "all_ok", "missing")),
           detail=f"keys={sorted(sc.keys())}")
    _check("survival_all_ok_is_bool", isinstance(sc["all_ok"], bool),
           detail=f"all_ok={sc['all_ok']}, missing={sc['missing']}")
    _check("survival_pins_each_have_ok_detail",
           all(isinstance(v, dict) and "ok" in v and "detail" in v for v in sc["pins"].values()),
           detail=f"pin_names={sorted(sc['pins'].keys())}")

    # T4: checkpoint() runs, appends audit
    cp = checkpoint(note="self-test checkpoint (no-op stamp)")
    _check("checkpoint_appended_audit", cp["audit_appended"] is True,
           detail=f"audit={AUDIT}")
    _check("checkpoint_after_consistent",
           isinstance(cp["after"], dict) and "all_ok" in cp["after"],
           detail=f"after_all_ok={cp['after'].get('all_ok')}")

    # T5: audit.jsonl is now present and its last line is parseable JSON
    last_ok = False
    last_detail = "audit not found"
    if os.path.isfile(AUDIT):
        try:
            with open(AUDIT, "r", encoding="utf-8", errors="replace") as f:
                lines = [l for l in f.read().splitlines() if l.strip()]
            if lines:
                json.loads(lines[-1])
                last_ok = True
                last_detail = f"{len(lines)} audit lines; last parseable"
        except (OSError, json.JSONDecodeError) as e:
            last_detail = f"audit read error: {e}"
    _check("audit_jsonl_tail_parseable", last_ok, detail=last_detail)

    ok = all(c["ok"] for c in checks)
    passed = sum(1 for c in checks if c["ok"])
    return {
        "ok": ok,
        "checks": checks,
        "summary": f"{passed}/{len(checks)} self-test checks passed",
    }


# ===========================================================================
# CLI
# ===========================================================================
def _emit(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="The context-pressure policy — pressure / survival-check / checkpoint / policy.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--pressure", action="store_true",
                   help="Measure real context pressure (transcript + active-work staleness).")
    g.add_argument("--survival-check", action="store_true",
                   help="Verify each survival pin is on disk right now (the swap-file contract).")
    g.add_argument("--checkpoint", action="store_true",
                   help="Repair what's mechanically fixable + report human-only gaps + audit-append.")
    g.add_argument("--policy", action="store_true",
                   help="Pretty-print the first-class context-pressure POLICY.")
    g.add_argument("--self-test", action="store_true",
                   help="Run the deterministic self-test against the real state.")
    ap.add_argument("--note", default="", help="Optional note for --checkpoint audit.")
    args = ap.parse_args(argv)

    if args.pressure:
        _emit(pressure())
        return 0

    if args.survival_check:
        result = survival_check()
        _emit(result)
        # exit 0 when all pins satisfied; exit 1 when any survival pin is missing
        # (a real on-disk gap that must close before a compaction is safe).
        return 0 if result["all_ok"] else 1

    if args.checkpoint:
        result = checkpoint(note=args.note)
        _emit(result)
        # exit 0 when post-checkpoint all pins satisfied; exit 1 when human action still owed.
        return 0 if result["after"]["all_ok"] else 1

    if args.policy:
        _emit(policy())
        return 0

    if args.self_test:
        result = self_test()
        _emit(result)
        return 0 if result["ok"] else 1

    ap.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
