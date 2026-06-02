#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
health.py — the health & reliability surface for the SERVARI shell.

Reliability is the promise under load:
  - never drop the one who depends on you
  - no single point of failure
  - graceful degradation

This module is the health surface that PROVES the operation is up. It reads the
demo state files and returns a compact, fail-closed status. It is deliberately
FAST (pure file reads, NO heavy subprocesses) and FAIL-CLOSED: a failed read of
any one input degrades THAT one check to DEGRADED/UNKNOWN; the whole call never
crashes.

Wiring (the server integrates servari_server.py, not this file):
    GET /api/health  ->  health_check()

CLI:
    python health.py   ->  prints the health JSON

STDLIB only. cp1252-safe (utf-8 reads with errors='replace'; stdout/stderr
reconfigured to utf-8). Honest by construction: a check that cannot be read reads
UNKNOWN, never a guessed value.
"""

import json
import os
import sys
from pathlib import Path

# never die on a non-cp1252 byte when printing on Windows.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Status vocabulary for sub-checks. A read that succeeds and looks healthy -> OK.
# A read that succeeds but reveals a degraded condition -> DEGRADED.
# A read that fails (missing file / bad parse / any error) -> UNKNOWN.
OK = "OK"
DEGRADED = "DEGRADED"
UNKNOWN = "UNKNOWN"


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


ROOT = _home()
DEMO = ROOT / "demo-data"

NERVOUS = DEMO / "nervous-system.json"          # services/channels index
AGENTS_FILE = DEMO / "agents.json"              # neutral demo agent roster
GATE_QUEUE = DEMO / "gate-queue.jsonl"
SELF_STATE = DEMO / "self-state.json"


# --------------------------------------------------------------------------- #
# Sub-checks. Each returns a dict {status, ...detail}. Each is fully guarded:
# any exception inside becomes status=UNKNOWN with a note. NEVER raises.
# --------------------------------------------------------------------------- #

def _check_services() -> dict:
    """Services connected + channel count from the services index."""
    try:
        if not NERVOUS.is_file():
            return {"status": UNKNOWN, "note": "nervous-system.json missing"}
        data = json.loads(NERVOUS.read_text(encoding="utf-8", errors="replace"))
        health = data.get("health", {}) or {}
        roster = health.get("roster", {}) or {}
        integ = health.get("integration", {}) or {}
        channels = data.get("channels", {}) or {}

        services = roster.get("services")
        connected = integ.get("connected")
        disconnected = integ.get("disconnected")
        verdict = integ.get("verdict")
        channel_count = len(channels) if isinstance(channels, dict) else None

        # Degraded if integration reports any disconnected service, or the
        # verdict is not the all-connected verdict, or we have no channels.
        status = OK
        if isinstance(disconnected, int) and disconnected > 0:
            status = DEGRADED
        if verdict and str(verdict).upper() != "ALL CONNECTED":
            status = DEGRADED
        if channel_count == 0:
            status = DEGRADED

        return {
            "status": status,
            "services": services,
            "connected": connected,
            "disconnected": disconnected,
            "verdict": verdict,
            "channels": channel_count,
        }
    except Exception as e:
        return {"status": UNKNOWN, "note": f"read/parse failed: {type(e).__name__}"}


def _check_agents() -> dict:
    """Count the agents present in the demo roster (a neutral demo file)."""
    try:
        if not AGENTS_FILE.is_file():
            return {"status": UNKNOWN, "note": "agents.json missing"}
        data = json.loads(AGENTS_FILE.read_text(encoding="utf-8", errors="replace"))
        agents = data.get("agents") if isinstance(data, dict) else data
        count = len(agents) if isinstance(agents, list) else 0

        status = OK
        # Expected floor: the roster should carry at least a couple of agents.
        if count < 1:
            status = DEGRADED

        return {
            "status": status,
            "agents": count,
        }
    except Exception as e:
        return {"status": UNKNOWN, "note": f"read/parse failed: {type(e).__name__}"}


def _check_gate_queue() -> dict:
    """Pending gate count. Missing queue -> UNKNOWN (the queue may not exist yet).

    The queue is an append-only AUDIT: a 'pending' enqueue line is later resolved by a
    separate 'decision' line bearing the same id. Pending must therefore be computed by
    REPLAYING the audit per id (latest status wins) — NOT by counting raw lines, which
    leaves a resolved entry counted forever and flips the shell to a false DEGRADED.
    verify_queue.list_pending() owns that reconciliation rule; reuse it (single source of
    truth). Fail-closed: if it can't be imported, degrade THIS check to UNKNOWN, never crash.
    """
    try:
        if not GATE_QUEUE.is_file():
            # No queue file is a real, common state (no gates raised yet).
            # That is UNKNOWN, not a crash and not a false DEGRADED.
            return {"status": UNKNOWN, "note": "gate-queue.jsonl missing", "pending": None}

        # total = raw audit lines (enqueues + decisions); pending = reconciled-by-id.
        total = sum(
            1 for ln in GATE_QUEUE.read_text(encoding="utf-8", errors="replace").splitlines()
            if ln.strip()
        )
        try:
            import importlib
            # Guarantee the sibling import works no matter how health.py was loaded.
            _here = str(Path(__file__).resolve().parent)
            if _here not in sys.path:
                sys.path.insert(0, _here)
            vq = importlib.import_module("verify_queue")  # sibling in server/
            pending = len(vq.list_pending())
        except Exception as e:
            # Reconciler unavailable -> we cannot HONESTLY count pending. Don't guess.
            return {"status": UNKNOWN, "total": total,
                    "note": f"verify_queue reconcile unavailable: {type(e).__name__}"}

        # Real pending (someone is waiting on a gate) is a reliability signal -> DEGRADED.
        status = DEGRADED if pending > 0 else OK
        return {"status": status, "pending": pending, "total": total}
    except Exception as e:
        return {"status": UNKNOWN, "note": f"read/parse failed: {type(e).__name__}"}


def _check_gauges() -> dict:
    """Cached self-state value if present; else UNKNOWN.

    Do NOT run heavy subprocesses. Read the cached self-state receipt only. A
    gauge that errored reads UNKNOWN, never a guessed value.
    """
    try:
        if not SELF_STATE.is_file():
            return {"status": UNKNOWN, "note": "self-state.json missing (no cached gauge)"}
        data = json.loads(SELF_STATE.read_text(encoding="utf-8", errors="replace"))
        gauge_errors = data.get("gauge_errors", [])
        heartbeat = data.get("heartbeat")
        roster = data.get("roster", {}) or {}
        integ = data.get("integration", {}) or {}

        status = OK
        if isinstance(gauge_errors, list) and len(gauge_errors) > 0:
            status = DEGRADED
        if heartbeat and str(heartbeat).upper() not in ("REGISTERED", "RUNNING", "OK"):
            status = DEGRADED

        return {
            "status": status,
            "heartbeat": heartbeat,
            "gauge_errors": len(gauge_errors) if isinstance(gauge_errors, list) else None,
            "services": roster.get("services"),
            "integration_verdict": integ.get("verdict"),
        }
    except Exception as e:
        return {"status": UNKNOWN, "note": f"read/parse failed: {type(e).__name__}"}


# --------------------------------------------------------------------------- #
# The health surface.
# --------------------------------------------------------------------------- #

def health_check() -> dict:
    """FAST, FAIL-CLOSED health status.

    Returns a compact dict:
        {verdict: OK|DEGRADED, ts_note, checks:{...}, summary}

    Verdict policy (graceful degradation):
      - If any sub-check is DEGRADED  -> overall DEGRADED.
      - UNKNOWN sub-checks (e.g. a queue file that does not exist yet) do NOT
        by themselves flip the whole surface to DEGRADED — that would punish a
        normal empty state. But if EVERYTHING is UNKNOWN, the surface cannot
        prove it is up, so it reports DEGRADED (fail-closed: unproven != OK).
      - Otherwise -> OK.
    The whole function never raises; each sub-check is independently guarded.
    """
    checks = {}
    try:
        checks["services"] = _check_services()
    except Exception as e:
        checks["services"] = {"status": UNKNOWN, "note": f"check crashed: {type(e).__name__}"}
    try:
        checks["agents"] = _check_agents()
    except Exception as e:
        checks["agents"] = {"status": UNKNOWN, "note": f"check crashed: {type(e).__name__}"}
    try:
        checks["gate_queue"] = _check_gate_queue()
    except Exception as e:
        checks["gate_queue"] = {"status": UNKNOWN, "note": f"check crashed: {type(e).__name__}"}
    try:
        checks["gauges"] = _check_gauges()
    except Exception as e:
        checks["gauges"] = {"status": UNKNOWN, "note": f"check crashed: {type(e).__name__}"}

    statuses = [c.get("status", UNKNOWN) for c in checks.values()]
    n_degraded = statuses.count(DEGRADED)
    n_ok = statuses.count(OK)
    n_unknown = statuses.count(UNKNOWN)

    if n_degraded > 0:
        verdict = DEGRADED
    elif n_ok == 0:
        # Nothing could be confirmed OK -> we cannot prove the operation is up.
        verdict = DEGRADED
    else:
        verdict = OK

    summary = (
        f"{n_ok} OK / {n_degraded} DEGRADED / {n_unknown} UNKNOWN "
        f"across {len(checks)} checks"
    )

    return {
        "verdict": verdict,
        "ts_note": "point-in-time read of the state files; fast, no subprocess",
        "checks": checks,
        "summary": summary,
    }


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        result = health_check()
    except Exception as e:
        # Absolute backstop: even an unexpected error returns a valid DEGRADED
        # payload rather than a traceback. The surface must never crash.
        result = {
            "verdict": DEGRADED,
            "ts_note": "health_check raised; backstop engaged",
            "checks": {},
            "summary": f"backstop: {type(e).__name__}",
        }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    # Exit 0 always: the health surface reports status in the JSON body, not via
    # exit code, so a monitor never confuses "the check ran" with "the system is OK".
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
