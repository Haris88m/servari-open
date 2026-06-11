# -*- coding: utf-8 -*-
"""health.py — the fail-closed health report behind GET /api/health.

The load-bearing claims under test:
  - fail-closed: if NOTHING can be proven OK the verdict is DEGRADED
    (unproven != OK), yet the call never raises,
  - any DEGRADED sub-check flips the overall verdict to DEGRADED,
  - an UNKNOWN sub-check (e.g. no gate queue yet) does NOT flip an otherwise
    healthy surface — a normal empty state is not punished,
  - a PENDING GATE is workflow state, not system degradation: the verdict
    stays OK and the count surfaces as the top-level `pending_gates`,
  - the CLI reports status in the JSON body, exit code 0 always.
"""
from __future__ import annotations

import json


def _seed_healthy(home, *, nervous=None, agents=None, self_state=None):
    """Write the three state files a healthy shell reads. Keyword overrides
    let a test degrade exactly one input."""
    demo = home / "demo-data"
    (demo / "nervous-system.json").write_text(json.dumps(nervous or {
        "health": {
            "roster": {"services": 4},
            "integration": {"connected": 4, "disconnected": 0,
                            "verdict": "ALL CONNECTED"},
        },
        "channels": {"main": {}, "ops": {}},
    }), encoding="utf-8")
    (demo / "agents.json").write_text(json.dumps(
        agents if agents is not None else {"agents": [{"name": "scout"},
                                                      {"name": "clerk"}]}
    ), encoding="utf-8")
    (demo / "self-state.json").write_text(json.dumps(self_state or {
        "heartbeat": "REGISTERED", "gauge_errors": [],
        "roster": {"services": 4},
        "integration": {"verdict": "ALL CONNECTED"},
    }), encoding="utf-8")


# --------------------------------------------------------------------------- #
# Fail-closed verdict policy
# --------------------------------------------------------------------------- #

def test_empty_home_cannot_prove_up_so_degraded(health):
    report = health.health_check()
    assert report["verdict"] == "DEGRADED"           # unproven != OK
    assert report["pending_gates"] == 0
    statuses = {name: c["status"] for name, c in report["checks"].items()}
    assert set(statuses) == {"services", "agents", "gate_queue", "gauges"}
    assert all(s == "UNKNOWN" for s in statuses.values())


def test_healthy_home_reports_ok(health, servari_home):
    _seed_healthy(servari_home)
    report = health.health_check()
    assert report["verdict"] == "OK"
    assert report["checks"]["services"]["status"] == "OK"
    assert report["checks"]["agents"]["status"] == "OK"
    assert report["checks"]["gauges"]["status"] == "OK"
    # no gate queue yet: UNKNOWN, and it does NOT punish the healthy surface
    assert report["checks"]["gate_queue"]["status"] == "UNKNOWN"


def test_unknown_single_check_does_not_flip_healthy_surface(
        health, servari_home):
    _seed_healthy(servari_home)
    (servari_home / "demo-data" / "nervous-system.json").write_text(
        "{corrupt json", encoding="utf-8")
    report = health.health_check()
    assert report["checks"]["services"]["status"] == "UNKNOWN"
    assert report["verdict"] == "OK"                 # the rest still proves up


# --------------------------------------------------------------------------- #
# Pending gates: workflow state, never a red verdict
# --------------------------------------------------------------------------- #

def test_pending_gate_is_normal_operation_not_degradation(
        health, vq, servari_home):
    _seed_healthy(servari_home)
    vq.enqueue("agent", "deploy", "ship", "awaiting approval")
    report = health.health_check()
    assert report["verdict"] == "OK"                 # gate held != system fault
    assert report["pending_gates"] == 1
    gq = report["checks"]["gate_queue"]
    assert gq["status"] == "OK"
    assert gq["pending"] == 1
    assert "pending approval" in report["summary"]


def test_decided_gate_clears_pending_counter(health, vq, servari_home):
    _seed_healthy(servari_home)
    entry_id = vq.enqueue("agent", "deploy", "ship", "awaiting approval")
    vq.decide(entry_id, "approve")
    report = health.health_check()
    assert report["pending_gates"] == 0
    gq = report["checks"]["gate_queue"]
    assert gq["status"] == "OK"
    assert gq["total"] == 2          # enqueue + decision audit lines replayed


# --------------------------------------------------------------------------- #
# Each degraded condition flips the verdict
# --------------------------------------------------------------------------- #

def test_disconnected_service_degrades(health, servari_home):
    _seed_healthy(servari_home, nervous={
        "health": {"roster": {"services": 4},
                   "integration": {"connected": 3, "disconnected": 1,
                                   "verdict": "3 OF 4 CONNECTED"}},
        "channels": {"main": {}},
    })
    report = health.health_check()
    assert report["checks"]["services"]["status"] == "DEGRADED"
    assert report["verdict"] == "DEGRADED"


def test_zero_channels_degrades(health, servari_home):
    _seed_healthy(servari_home, nervous={
        "health": {"integration": {"connected": 4, "disconnected": 0,
                                   "verdict": "ALL CONNECTED"}},
        "channels": {},
    })
    report = health.health_check()
    assert report["checks"]["services"]["status"] == "DEGRADED"
    assert report["verdict"] == "DEGRADED"


def test_empty_agent_roster_degrades(health, servari_home):
    _seed_healthy(servari_home, agents={"agents": []})
    report = health.health_check()
    assert report["checks"]["agents"]["status"] == "DEGRADED"
    assert report["verdict"] == "DEGRADED"


def test_gauge_errors_degrade(health, servari_home):
    _seed_healthy(servari_home, self_state={
        "heartbeat": "REGISTERED", "gauge_errors": ["probe blew up"],
    })
    report = health.health_check()
    assert report["checks"]["gauges"]["status"] == "DEGRADED"
    assert report["verdict"] == "DEGRADED"


def test_dead_heartbeat_degrades(health, servari_home):
    _seed_healthy(servari_home, self_state={
        "heartbeat": "DEAD", "gauge_errors": [],
    })
    report = health.health_check()
    assert report["checks"]["gauges"]["status"] == "DEGRADED"
    assert report["verdict"] == "DEGRADED"


# --------------------------------------------------------------------------- #
# Shape + CLI contract
# --------------------------------------------------------------------------- #

def test_report_shape_and_summary(health, servari_home):
    _seed_healthy(servari_home)
    report = health.health_check()
    assert set(report) == {"verdict", "pending_gates", "ts_note",
                           "checks", "summary"}
    assert "OK" in report["summary"] and "checks" in report["summary"]
    json.dumps(report)                               # JSON-serializable


def test_cli_exit_zero_even_when_degraded(health, capsys):
    # empty home -> DEGRADED body, but the monitor contract is exit 0:
    # "the check ran" is never confused with "the system is OK".
    assert health.main([]) == 0
    body = json.loads(capsys.readouterr().out)
    assert body["verdict"] == "DEGRADED"
