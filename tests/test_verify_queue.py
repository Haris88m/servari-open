# -*- coding: utf-8 -*-
"""verify_queue.py — the fast-verify gate queue.

The load-bearing claims under test:
  - the audit file is APPEND-ONLY: an enqueue line and every decision are
    separate appended lines; prior bytes are never rewritten,
  - the gate HOLDS: enqueue only parks intent (status pending) — nothing acts,
  - a decision resolves pending exactly once; double-decide never re-decides,
  - missing/corrupt audit lines degrade gracefully, never crash.
"""
from __future__ import annotations

import json


def _queue_file(servari_home):
    return servari_home / "demo-data" / "gate-queue.jsonl"


# --------------------------------------------------------------------------- #
# Enqueue parks; nothing executes
# --------------------------------------------------------------------------- #

def test_enqueue_parks_a_pending_entry(vq, servari_home):
    entry_id = vq.enqueue(
        agent="test-agent", gate="real-send", action="send-the-mail",
        summary="park it for a human", detail="d", rollback="r",
    )
    assert isinstance(entry_id, str) and len(entry_id) == 10
    lines = _queue_file(servari_home).read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["id"] == entry_id
    assert entry["status"] == "pending"
    assert entry["gate"] == "real-send"
    assert entry["agent"] == "test-agent"
    assert entry["rollback"] == "r"


def test_enqueue_defaults_for_blank_fields(vq):
    entry_id = vq.enqueue(agent="", gate="", action="a", summary="s")
    entry = next(e for e in vq.list_pending() if e["id"] == entry_id)
    assert entry["agent"] == "unknown"
    assert entry["gate"] == "unspecified"


def test_missing_queue_file_means_empty_queue(vq, servari_home):
    assert not _queue_file(servari_home).exists()
    assert vq.list_pending() == []
    assert vq.history() == []


# --------------------------------------------------------------------------- #
# APPEND-ONLY invariant
# --------------------------------------------------------------------------- #

def test_decision_appends_and_never_rewrites_prior_bytes(vq, servari_home):
    entry_id = vq.enqueue("a", "deploy", "ship-it", "deploy the demo")
    qfile = _queue_file(servari_home)
    bytes_before = qfile.read_bytes()

    decided = vq.decide(entry_id, "approve", "looks good")

    bytes_after = qfile.read_bytes()
    # the strongest append-only statement: the old audit is a byte-prefix
    assert bytes_after.startswith(bytes_before)
    assert len(bytes_after) > len(bytes_before)

    lines = [json.loads(ln) for ln in bytes_after.decode("utf-8").splitlines()]
    assert len(lines) == 2
    assert lines[0]["status"] == "pending"          # original line untouched
    assert lines[1]["type"] == "decision"
    assert lines[1]["decision"] == "approve"
    assert decided["status"] == "approved"
    assert decided["note"] == "looks good"


def test_pending_resolves_via_replay_not_line_count(vq):
    """Mirrors verify_all V003: pending+decision are 2 audit events, and the
    reconciled pending view drops the decided entry."""
    before = len(vq.history(100000))
    entry_id = vq.enqueue("agent", "publish", "publish-artifact", "synthetic")
    assert any(e["id"] == entry_id for e in vq.list_pending())

    decided = vq.decide(entry_id, "approve", "verification approval")
    assert decided["id"] == entry_id
    assert not any(e["id"] == entry_id for e in vq.list_pending())

    hist = vq.history(100000)
    assert len(hist) >= before + 2
    related = [e for e in hist if e.get("id") == entry_id]
    assert related[0].get("status") == "pending"
    assert related[-1].get("type") == "decision"


def test_reject_path(vq):
    entry_id = vq.enqueue("agent", "spend", "buy-credits", "spend request")
    decided = vq.decide(entry_id, "reject", "not now")
    assert decided["status"] == "rejected"
    assert vq.list_pending() == []


# --------------------------------------------------------------------------- #
# Decide-once honesty
# --------------------------------------------------------------------------- #

def test_double_decide_does_not_rewrite_or_redecide(vq, servari_home):
    entry_id = vq.enqueue("agent", "merge-to-main", "merge", "merge request")
    first = vq.decide(entry_id, "approve")
    assert first["status"] == "approved"
    lines_after_first = len(_queue_file(servari_home).read_text(
        encoding="utf-8").splitlines())

    second = vq.decide(entry_id, "reject", "trying to flip the decision")
    # the audit stays honest: no new line, status unchanged
    lines_after_second = len(_queue_file(servari_home).read_text(
        encoding="utf-8").splitlines())
    assert lines_after_second == lines_after_first
    assert second["status"] == "approved"


def test_decide_unknown_id_or_bad_decision_is_refused(vq):
    entry_id = vq.enqueue("agent", "secret", "rotate-key", "rotate")
    assert vq.decide("ffffffffff", "approve") == {}     # unknown id
    assert vq.decide(entry_id, "maybe") == {}            # bad decision word
    # the entry is still pending — a refused decision changed nothing
    assert any(e["id"] == entry_id for e in vq.list_pending())


# --------------------------------------------------------------------------- #
# Graceful degradation + history caps
# --------------------------------------------------------------------------- #

def test_corrupt_audit_line_is_tolerated(vq, servari_home):
    good_id = vq.enqueue("agent", "deploy", "act-1", "good entry")
    with _queue_file(servari_home).open("a", encoding="utf-8") as f:
        f.write("{this line is not json\n")
    pending = vq.list_pending()
    assert [e["id"] for e in pending] == [good_id]   # corrupt line skipped
    assert all(isinstance(e, dict) for e in vq.history())


def test_pending_listed_oldest_first(vq):
    first = vq.enqueue("a1", "deploy", "older-action", "first in")
    second = vq.enqueue("a2", "deploy", "newer-action", "second in")
    ids = [e["id"] for e in vq.list_pending()]
    assert ids == [first, second]


def test_history_limit_caps_and_bad_limit_defaults(vq):
    for i in range(5):
        vq.enqueue("agent", "deploy", f"act-{i}", f"entry {i}")
    assert len(vq.history(2)) == 2
    assert json.loads(json.dumps(vq.history(2)[-1]))["action"] == "act-4"  # newest last
    assert len(vq.history("not-a-number")) == 5      # falls back to default 50
    assert len(vq.history(-3)) == 5                   # non-positive -> default 50
