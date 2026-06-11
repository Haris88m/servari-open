# -*- coding: utf-8 -*-
"""autonomy.py — the L0-L5 autonomy dial.

The load-bearing claim under test: the HARD HUMAN GATE HOLDS. Even at L5
(full auto), a high-risk score (>16, the "refuse" band) ALWAYS queues for a
human — the dial can widen the act/report bands but can never auto-cross the
gate. Plus: fail-closed on invalid scores, sane defaults on missing/corrupt
state, and validated persistence of the per-agent dial.
"""
from __future__ import annotations

import json

import pytest


# --------------------------------------------------------------------------- #
# THE HARD GATE
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("level", [0, 1, 2, 3, 4, 5])
@pytest.mark.parametrize("score", [17, 18, 19, 20])
def test_high_risk_always_queues_at_every_level(autonomy, level, score):
    """The invariant the gates HOLD: refuse-band scores queue at EVERY level."""
    assert autonomy.set_level("gate-agent", level)["ok"] is True
    result = autonomy.decide("gate-agent", score)
    assert result["verdict"] == "queue"
    assert result["level"] == level
    assert result["score_band"] == "refuse"


def test_l5_full_auto_still_queues_high_risk(autonomy):
    """The headline claim (mirrors verify_all V001): L5 + score 20 -> queue."""
    autonomy.set_level("verify-agent", 5)
    result = autonomy.decide("verify-agent", 20)
    assert result["verdict"] == "queue"
    assert result["level"] == 5
    assert "human approval" in result["reason"]


# --------------------------------------------------------------------------- #
# The dial matrix: each level's act/report/queue bands
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("level,score,expected", [
    # L0 suggest-only / L1 explicit-approval: NEVER act, everything queues.
    (0, 4, "queue"), (0, 8, "queue"), (0, 12, "queue"), (0, 16, "queue"),
    (1, 4, "queue"), (1, 8, "queue"), (1, 12, "queue"), (1, 16, "queue"),
    # L2 act-then-report-each: report safe (<=8); queue above.
    (2, 4, "report"), (2, 8, "report"), (2, 9, "queue"), (2, 13, "queue"),
    # L3 act-then-report-batch: report up to low-risk (<=12); queue above.
    (3, 8, "report"), (3, 12, "report"), (3, 13, "queue"), (3, 16, "queue"),
    # L4: silent on safe (<=8), report low-risk (9-12), queue moderate (13-16).
    (4, 4, "act"), (4, 8, "act"), (4, 9, "report"), (4, 12, "report"),
    (4, 13, "queue"), (4, 16, "queue"),
    # L5 full auto: silent through moderate (<=16); queue only high-risk.
    (5, 4, "act"), (5, 8, "act"), (5, 12, "act"), (5, 16, "act"),
])
def test_dial_matrix(autonomy, level, score, expected):
    autonomy.set_level("matrix-agent", level)
    result = autonomy.decide("matrix-agent", score)
    assert result["verdict"] == expected, result


def test_dial_is_monotonic_no_level_acts_beyond_its_ceiling(autonomy):
    """Higher level => act/report set only grows; queue set only shrinks."""
    autonomous_scores = {}
    for level in range(6):
        autonomy.set_level("mono-agent", level)
        autonomous_scores[level] = {
            s for s in range(4, 21)
            if autonomy.decide("mono-agent", s)["verdict"] in ("act", "report")
        }
    for level in range(5):
        assert autonomous_scores[level] <= autonomous_scores[level + 1]
    # and NO level ever auto-acts in the refuse band
    for level in range(6):
        assert autonomous_scores[level].isdisjoint({17, 18, 19, 20})


# --------------------------------------------------------------------------- #
# Fail-closed behaviour
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bad_score", ["not-a-score", None, "", "12.5x"])
def test_invalid_score_fails_closed_to_queue(autonomy, bad_score):
    autonomy.set_level("fc-agent", 5)  # even at full auto
    result = autonomy.decide("fc-agent", bad_score)
    assert result["verdict"] == "queue"
    assert result["score_band"] == "invalid"
    assert "fail_closed" in result["reason"]


def test_missing_state_file_yields_default_level(autonomy, servari_home):
    assert not (servari_home / "demo-data" / "autonomy-levels.json").exists()
    assert autonomy.get_level("never-seen-agent") == autonomy.DEFAULT_LEVEL == 2


def test_corrupt_state_file_never_crashes(autonomy, servari_home):
    state = servari_home / "demo-data" / "autonomy-levels.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text("{this is not json", encoding="utf-8")
    assert autonomy.get_level("any-agent") == 2
    assert autonomy.decide("any-agent", 5)["verdict"] == "report"  # L2 default


def test_state_sanitization_drops_out_of_range_levels(autonomy, servari_home):
    state = servari_home / "demo-data" / "autonomy-levels.json"
    state.write_text(json.dumps({
        "levels": {"too-high": 9, "stringy": "3", "garbage": "x", "neg": -2},
    }), encoding="utf-8")
    assert autonomy.get_level("too-high") == 2      # 9 dropped -> default
    assert autonomy.get_level("stringy") == 3       # int-coercible kept
    assert autonomy.get_level("garbage") == 2       # non-numeric dropped
    assert autonomy.get_level("neg") == 2           # out of range dropped


# --------------------------------------------------------------------------- #
# set_level validation + persistence
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("level,error", [
    (6, "level_out_of_range_0_5"),
    (-1, "level_out_of_range_0_5"),
    ("abc", "level_not_an_integer"),
    (None, "level_not_an_integer"),
])
def test_set_level_rejects_invalid(autonomy, level, error):
    result = autonomy.set_level("agent-x", level)
    assert result["ok"] is False
    assert result["error"] == error
    assert autonomy.get_level("agent-x") == 2  # no write happened


def test_set_level_rejects_empty_agent(autonomy):
    result = autonomy.set_level("", 3)
    assert result["ok"] is False
    assert result["error"] == "empty_agent_name"


def test_set_level_persists_to_state_file(autonomy, servari_home):
    assert autonomy.set_level("persist-agent", 4)["ok"] is True
    state = servari_home / "demo-data" / "autonomy-levels.json"
    assert state.is_file()
    on_disk = json.loads(state.read_text(encoding="utf-8"))
    assert on_disk["levels"]["persist-agent"] == 4
    assert autonomy.get_level("persist-agent") == 4


def test_all_levels_reports_definitions_and_default(autonomy):
    autonomy.set_level("a1", 0)
    autonomy.set_level("a2", 5)
    snapshot = autonomy.all_levels()
    assert snapshot["default_level"] == 2
    assert snapshot["levels"] == {"a1": 0, "a2": 5}
    assert set(snapshot["definitions"]) == {"0", "1", "2", "3", "4", "5"}
    for spec in snapshot["definitions"].values():
        assert spec["act_report_max"] <= 16  # no level's auto-band reaches refuse


# --------------------------------------------------------------------------- #
# CLI exit-code contract (callers branch on it without parsing JSON)
# --------------------------------------------------------------------------- #

def test_cli_decide_exit_codes(autonomy, capsys):
    assert autonomy.main(["--set", "cli-agent", "5"]) == 0
    assert autonomy.main(["--decide", "cli-agent", "8"]) == 0    # act
    assert autonomy.main(["--decide", "cli-agent", "20"]) == 2   # queue -> human
    assert autonomy.main(["--set", "cli-agent", "7"]) == 1       # invalid level
    out_lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.strip()]
    assert all(json.loads(ln) is not None for ln in out_lines)  # JSON per line
