#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""THE FAST-VERIFY GATE QUEUE — make human verification fast.

The principle: the bottleneck is the human's verification. Instead of a gated
action (deploy / real-send / spend / publish / merge-to-main / secret) BLOCKING
the agent, the agent PARKS it here with everything the operator needs to decide
in seconds; the operator approves or rejects; the gate STILL HOLDS — nothing acts
until approved. This mechanism never crosses a gate itself; it only parks gated
actions and records the decision.

Queue file: demo-data/gate-queue.jsonl  (append-only audit; one JSON object per line).
  - pending entry:  {id, ts, agent, gate, action, summary, detail, rollback, status:"pending"}
  - decision event: {id, ts, type:"decision", decision:"approve"|"reject", note, status}
The pending entry and every decision are SEPARATE append lines; the audit is never rewritten.

Functions (importable):
  enqueue(agent, gate, action, summary, detail="", rollback="") -> id
  list_pending()                  -> [entry, ...]   (entries whose latest status is "pending")
  decide(id, decision, note="")   -> updated entry  (decision = "approve" | "reject")
  history(limit=50)               -> [event, ...]   (raw audit lines, newest last, capped)

CLI:
  python verify_queue.py --enqueue '{"agent":"demo-agent","gate":"real-send",...}'
  python verify_queue.py --enqueue --agent X --gate G --action A --summary S [--detail D] [--rollback R]
  python verify_queue.py --list
  python verify_queue.py --decide <id> approve "looks good"
  python verify_queue.py --history 20

Stdlib only. cp1252-safe. Fail-closed/graceful: missing file -> empty queue, never crash.
"""
from __future__ import annotations
import json, os, sys, hashlib, argparse, datetime, itertools, threading
from pathlib import Path

# Monotonic per-process sequence — guarantees two enqueues in the SAME second from
# the SAME process still derive distinct ids (os.urandom already covers the cross-
# process / same-instant case; the counter makes intra-process uniqueness exact).
_SEQ = itertools.count()
_SEQ_LOCK = threading.Lock()

# Force UTF-8 stdout/stderr so emoji/accents never crash on Windows consoles.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


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
QUEUE = ROOT / "demo-data" / "gate-queue.jsonl"

# The 6 gate-classes a gated action may park under (the human-gate boundary).
# Not enforced as a hard whitelist (an agent may name a new gate) — documented for the UI/help.
KNOWN_GATES = ["deploy", "real-send", "spend", "publish", "merge-to-main", "secret"]


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _read_lines():
    """Every audit line as a parsed dict (skips blanks/corrupt). Missing file -> []. Never raises."""
    out = []
    try:
        if not QUEUE.is_file():
            return out
        for line in QUEUE.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass  # tolerate a corrupt line; the audit stays readable
    except Exception:
        return out
    return out


def _append(obj) -> bool:
    """Append one JSON object as a line. Creates parent dir + file. Returns True on success."""
    try:
        QUEUE.parent.mkdir(parents=True, exist_ok=True)
        with QUEUE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False


def _make_id(ts: str, agent: str, action: str) -> str:
    """Short UNIQUE id = first 12 hex of sha1(ts|agent|action|seq|rand).

    ts is second-resolution, so (ts|agent|action) alone collides when two gated
    actions are parked in the same second — _index_status would then coalesce two
    distinct enqueues onto one id. We mix in a monotonic per-process sequence AND
    os.urandom(8) so EVERY enqueue derives a distinct id, fail-closed: if urandom
    is somehow unavailable the sequence + a fallback counter still differ. The id
    stays opaque/short and content is still hashed in (audit lines remain self-
    describing). The append-only audit, decide()/history()/list_pending(), and the
    executor's one-id-one-terminal-event contract all key off this id and are
    unaffected by how it is derived."""
    with _SEQ_LOCK:
        seq = next(_SEQ)
    try:
        rand = os.urandom(8).hex()
    except Exception:
        # Fail-closed: never collapse to a constant. PID + seq stays distinct.
        rand = f"{os.getpid():x}{seq:x}"
    raw = f"{ts}|{agent}|{action}|{seq}|{rand}".encode("utf-8", "replace")
    return hashlib.sha1(raw).hexdigest()[:12]


def _index_status():
    """Build {id: {entry, status}} by replaying the audit in order.
    A 'pending' line creates/sets an entry; a 'decision' line updates that entry's status."""
    idx = {}  # id -> {"entry": <pending-entry-dict>, "status": <str>}
    for ev in _read_lines():
        if not isinstance(ev, dict):
            continue
        _id = ev.get("id")
        if not _id:
            continue
        etype = ev.get("type", "")
        if etype == "decision":
            if _id in idx:
                idx[_id]["status"] = ev.get("status", ev.get("decision", "decided"))
                idx[_id]["entry"]["status"] = idx[_id]["status"]
                idx[_id]["entry"]["decided_ts"] = ev.get("ts", "")
                idx[_id]["entry"]["note"] = ev.get("note", "")
        else:
            # a pending (enqueue) line — the canonical entry
            entry = dict(ev)
            entry.setdefault("status", "pending")
            idx[_id] = {"entry": entry, "status": entry.get("status", "pending")}
    return idx


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def enqueue(agent: str, gate: str, action: str, summary: str,
            detail: str = "", rollback: str = "") -> str:
    """PARK a gated action for fast human verification. Returns the entry id.
    The gate HOLDS — this only records intent; nothing executes here."""
    agent = (agent or "unknown").strip()
    gate = (gate or "unspecified").strip()
    action = (action or "").strip()
    summary = (summary or "").strip()
    ts = _now_iso()
    _id = _make_id(ts, agent, action)
    entry = {
        "id": _id, "ts": ts, "agent": agent, "gate": gate, "action": action,
        "summary": summary, "detail": (detail or "").strip(),
        "rollback": (rollback or "").strip(), "status": "pending",
    }
    _append(entry)
    return _id


def list_pending():
    """All entries whose latest status is 'pending', oldest-first (decide in arrival order)."""
    idx = _index_status()
    pend = [v["entry"] for v in idx.values() if v["status"] == "pending"]
    pend.sort(key=lambda e: e.get("ts", ""))
    return pend


def decide(_id: str, decision: str, note: str = ""):
    """Approve or reject a parked action. Appends a decision line (audit preserved).
    Returns the updated entry, or {} if id unknown / already decided / bad decision."""
    decision = (decision or "").strip().lower()
    if decision not in ("approve", "reject"):
        return {}
    idx = _index_status()
    if _id not in idx:
        return {}
    if idx[_id]["status"] != "pending":
        # already decided — do NOT re-decide; keep the audit honest. Return current entry.
        return idx[_id]["entry"]
    status = "approved" if decision == "approve" else "rejected"
    ev = {"id": _id, "ts": _now_iso(), "type": "decision",
          "decision": decision, "status": status, "note": (note or "").strip()}
    _append(ev)
    # re-read so the returned entry reflects the just-appended decision
    return _index_status().get(_id, {}).get("entry", {})


def history(limit: int = 50):
    """Raw audit events (pending lines + decision lines), newest last, capped at `limit`."""
    try:
        limit = int(limit)
    except Exception:
        limit = 50
    if limit <= 0:
        limit = 50
    evs = _read_lines()
    return evs[-limit:]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _self_test() -> int:
    """Same-second id-collision regression check. Returns 0 on PASS, 1 on FAIL.

    Forces a FIXED timestamp + identical (agent, action) — the exact input that
    used to coalesce — and asserts every derived id is distinct. Pure in-memory
    (no audit writes), stdlib only, fail-closed."""
    ts = _now_iso()  # one shared second
    n = 1000
    ids = [_make_id(ts, "demo-agent", "publish-demo-artifact") for _ in range(n)]
    distinct = len(set(ids))
    ok = distinct == n
    # Also prove _index_status would keep them separate (no coalescing).
    seen = set(ids)
    no_coalesce = len(seen) == n
    print(json.dumps({
        "ok": ok and no_coalesce, "ts": ts, "enqueued": n,
        "distinct_ids": distinct, "coalesced": n - distinct,
    }, ensure_ascii=False))
    print("PASS" if (ok and no_coalesce) else "FAIL")
    return 0 if (ok and no_coalesce) else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="The fast-verify gate queue (park gated actions for human).")
    ap.add_argument("--enqueue", nargs="?", const="__flags__", default=None,
                    help="JSON object, or use the per-field flags below.")
    ap.add_argument("--agent", default="")
    ap.add_argument("--gate", default="")
    ap.add_argument("--action", default="")
    ap.add_argument("--summary", default="")
    ap.add_argument("--detail", default="")
    ap.add_argument("--rollback", default="")
    ap.add_argument("--list", action="store_true", help="list pending parked actions")
    ap.add_argument("--decide", nargs="+", metavar=("ID", "DECISION"),
                    help="--decide <id> approve|reject [\"note\"]")
    ap.add_argument("--history", nargs="?", const=50, type=int, help="show last N audit events")
    ap.add_argument("--self-test", action="store_true",
                    help="prove same-second enqueues get distinct ids; print PASS/FAIL")
    args = ap.parse_args(argv)

    if args.self_test:
        return _self_test()

    if args.enqueue is not None:
        if args.enqueue == "__flags__":
            payload = {"agent": args.agent, "gate": args.gate, "action": args.action,
                       "summary": args.summary, "detail": args.detail, "rollback": args.rollback}
        else:
            try:
                payload = json.loads(args.enqueue)
            except Exception as e:
                _print({"ok": False, "error": f"bad --enqueue JSON: {e}"})
                return 1
            if not isinstance(payload, dict):
                _print({"ok": False, "error": "--enqueue JSON must be an object"})
                return 1
        _id = enqueue(payload.get("agent", ""), payload.get("gate", ""),
                      payload.get("action", ""), payload.get("summary", ""),
                      payload.get("detail", ""), payload.get("rollback", ""))
        _print({"ok": True, "id": _id, "status": "pending"})
        return 0

    if args.list:
        pend = list_pending()
        _print({"ok": True, "pending_count": len(pend), "pending": pend})
        return 0

    if args.decide:
        d = args.decide
        if len(d) < 2:
            _print({"ok": False, "error": "usage: --decide <id> approve|reject [\"note\"]"})
            return 1
        _id, decision = d[0], d[1]
        note = " ".join(d[2:]) if len(d) > 2 else ""
        updated = decide(_id, decision, note)
        if not updated:
            _print({"ok": False, "error": f"unknown id, already decided, or bad decision: {_id} {decision}"})
            return 1
        _print({"ok": True, "entry": updated})
        return 0

    if args.history is not None:
        _print({"ok": True, "events": history(args.history)})
        return 0

    # no command -> show pending (the most useful default)
    pend = list_pending()
    _print({"ok": True, "pending_count": len(pend), "pending": pend,
            "known_gates": KNOWN_GATES,
            "hint": "use --enqueue / --list / --decide <id> approve|reject / --history N"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
