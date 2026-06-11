# -*- coding: utf-8 -*-
"""retention.py — the metric-gated retention loop (KEEP / REVERT).

The load-bearing claims under test (via the PUBLIC API against a probe metric
registry written into the isolated home — no module monkeypatching):
  - no gating metric degraded  -> KEEP (ties allowed, improvement welcome),
  - a gating metric degraded   -> REVERT with BYTE-EXACT restoration,
  - a metric that cannot run at decide-time -> fail-closed REVERT,
  - a run can be decided exactly ONCE,
  - the audit is append-only and decisions land in history().

The probe metric scores a target file by its count of GOOD lines (the same
shape retention's own _self_test uses, but exercised through the real
registry file rather than internals).
"""
from __future__ import annotations

import json
import sys

import pytest

PROBE_SCRIPT = (
    "import sys\n"
    "n = sum(1 for ln in open(sys.argv[1], encoding='utf-8') if 'GOOD' in ln)\n"
    "print('QUALITY: %d' % n)\n"
)


@pytest.fixture
def probe(servari_home):
    """Write a probe target + metric script + registry into the temp home.
    Returns (target_path, script_path)."""
    target = servari_home / "probe_target.txt"
    target.write_text("GOOD\nGOOD\nGOOD\n", encoding="utf-8")  # quality = 3
    script = servari_home / "probe_metric.py"
    script.write_text(PROBE_SCRIPT, encoding="utf-8")
    _write_registry(servari_home, target, script, gating=True)
    return target, script


def _write_registry(home, target, script, gating):
    reg_dir = home / "demo-data" / "retention"
    reg_dir.mkdir(parents=True, exist_ok=True)
    registry = {"metrics": [{
        "id": "probe_quality",
        "label": "probe (GOOD-line count)",
        "cmd": [sys.executable, str(script), str(target)],
        "cwd": ".",
        "parse": {"mode": "regex", "pattern": "QUALITY:\\s*(\\d+)",
                  "group": 1, "type": "int"},
        "higher_is_better": True,
        "gating": gating,
        "timeout_sec": 60,
    }]}
    (reg_dir / "retention_metrics.json").write_text(
        json.dumps(registry), encoding="utf-8")


# --------------------------------------------------------------------------- #
# Baseline contract
# --------------------------------------------------------------------------- #

def test_baseline_records_scores_and_snapshot(retention, probe, servari_home):
    target, _ = probe
    result = retention.baseline([str(target)])
    assert result["ok"] is True
    assert result["run_id"].startswith("run_")
    assert result["baseline_scores"] == {"probe_quality": 3}
    assert result["snapshot_errors"] == []
    # a byte-exact snapshot of the target exists under runs/<id>/snapshot/
    snap_dir = (servari_home / "demo-data" / "retention" / "runs"
                / result["run_id"] / "snapshot")
    snaps = list(snap_dir.iterdir())
    assert len(snaps) == 1
    assert snaps[0].read_bytes() == target.read_bytes()


def test_baseline_requires_targets_and_known_metrics(retention, probe):
    target, _ = probe
    assert retention.baseline([])["error"] == "no_targets"
    bad = retention.baseline([str(target)], metrics=["no-such-metric"])
    assert bad["ok"] is False
    assert bad["error"] == "no_valid_metrics"
    assert bad["unknown_metrics"] == ["no-such-metric"]


def test_baseline_reports_missing_target_in_snapshot_errors(retention, probe):
    result = retention.baseline(["does-not-exist.txt"])
    assert any("target_not_a_file" in e for e in result["snapshot_errors"])


# --------------------------------------------------------------------------- #
# KEEP: improvement and ties survive
# --------------------------------------------------------------------------- #

def test_improvement_is_kept(retention, probe):
    target, _ = probe
    run = retention.baseline([str(target)])
    with target.open("a", encoding="utf-8") as f:
        f.write("GOOD\n")                            # quality 3 -> 4
    decision = retention.decide(run["run_id"])
    assert decision["ok"] is True
    assert decision["decision"] == "KEEP"
    assert decision["after_scores"] == {"probe_quality": 4}
    assert decision["restored_files"] == []          # KEEP does not restore
    assert target.read_text(encoding="utf-8").count("GOOD") == 4


def test_tie_is_not_degradation(retention, probe):
    target, _ = probe
    run = retention.baseline([str(target)])
    # no edit at all: scores tie at 3 -> KEEP
    decision = retention.decide(run["run_id"])
    assert decision["decision"] == "KEEP"


# --------------------------------------------------------------------------- #
# REVERT: degradation restores byte-exact baseline
# --------------------------------------------------------------------------- #

def test_degradation_reverts_byte_exact(retention, probe):
    target, _ = probe
    target.write_text("GOOD\nGOOD\nGOOD\nGOOD\nGOOD\n", encoding="utf-8")
    pre_break = target.read_bytes()                  # quality 5 baseline bytes
    run = retention.baseline([str(target)])
    assert run["baseline_scores"] == {"probe_quality": 5}

    target.write_text("GOOD\nBAD\nBAD\n", encoding="utf-8")  # quality 1
    decision = retention.decide(run["run_id"])

    assert decision["decision"] == "REVERT"
    assert any("degraded" in r for r in decision["reasons"])
    assert len(decision["restored_files"]) == 1
    assert decision["restore_errors"] == []
    assert target.read_bytes() == pre_break          # byte-exact restoration


def test_metric_failure_at_decide_time_fails_closed_to_revert(
        retention, probe):
    target, script = probe
    original = target.read_bytes()
    run = retention.baseline([str(target)])
    script.unlink()                                   # the metric can no longer run
    decision = retention.decide(run["run_id"])
    assert decision["decision"] == "REVERT"
    assert any("run_failed" in r for r in decision["reasons"])
    assert target.read_bytes() == original


def test_non_gating_metric_degradation_is_kept(retention, servari_home):
    target = servari_home / "probe_target.txt"
    target.write_text("GOOD\nGOOD\nGOOD\n", encoding="utf-8")
    script = servari_home / "probe_metric.py"
    script.write_text(PROBE_SCRIPT, encoding="utf-8")
    _write_registry(servari_home, target, script, gating=False)

    run = retention.baseline([str(target)])
    target.write_text("BAD\n", encoding="utf-8")      # quality 3 -> 0
    decision = retention.decide(run["run_id"])
    assert decision["decision"] == "KEEP"             # non-gating cannot revert
    assert any("degraded_nongating" in r for r in decision["reasons"])
    assert target.read_text(encoding="utf-8") == "BAD\n"


# --------------------------------------------------------------------------- #
# Decide-once + unknown-run handling
# --------------------------------------------------------------------------- #

def test_double_decide_is_rejected(retention, probe):
    target, _ = probe
    run = retention.baseline([str(target)])
    first = retention.decide(run["run_id"])
    assert first["ok"] is True
    second = retention.decide(run["run_id"])
    assert second["ok"] is False
    assert second["error"] == "already_decided"
    assert second["decision"] == first["decision"]


def test_unknown_or_missing_run_id(retention, probe):
    assert retention.decide("run_doesnotexist")["error"] == "unknown_run_id"
    assert retention.decide("")["error"] == "no_run_id"


# --------------------------------------------------------------------------- #
# Pending view + append-only audit
# --------------------------------------------------------------------------- #

def test_pending_lists_undecided_runs_only(retention, probe):
    target, _ = probe
    run = retention.baseline([str(target)])
    pending_ids = [p["run_id"] for p in retention.pending()]
    assert run["run_id"] in pending_ids
    retention.decide(run["run_id"])
    assert run["run_id"] not in [p["run_id"] for p in retention.pending()]


def test_audit_is_append_only_and_history_returns_decisions(
        retention, probe, servari_home):
    target, _ = probe
    audit = servari_home / "demo-data" / "retention" / "audit.jsonl"

    run = retention.baseline([str(target)])
    bytes_after_baseline = audit.read_bytes()
    retention.decide(run["run_id"])
    bytes_after_decide = audit.read_bytes()

    assert bytes_after_decide.startswith(bytes_after_baseline)  # append-only
    events = [json.loads(ln) for ln in
              bytes_after_decide.decode("utf-8").splitlines() if ln.strip()]
    assert [e["type"] for e in events] == ["baseline", "decision"]

    decisions = retention.history()
    assert decisions[-1]["run_id"] == run["run_id"]
    assert decisions[-1]["decision"] in ("KEEP", "REVERT")
