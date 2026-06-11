# -*- coding: utf-8 -*-
"""servari_server.py — the allow-listed action runner (no sockets bound).

The load-bearing claim under test: actions are a CLOSED allow-list. An
unknown action is refused with the allowed roster echoed back, and the
roster itself is pinned so an accidental widening of the list fails the
suite (mirrors verify_all V006).
"""
from __future__ import annotations

EXPECTED_ACTIONS = {
    "echo-hello",
    "list-demo-agents",
    "disk-free",
    "python-version",
}


def test_allow_list_is_exactly_the_published_roster(server_mod):
    assert set(server_mod.ACTIONS.keys()) == EXPECTED_ACTIONS


def test_unknown_action_is_refused_with_roster(server_mod):
    result = server_mod._run_action("definitely-not-allowed")
    assert result["ok"] is False
    assert "refused" in result["out"]
    assert set(result["allowed"]) == EXPECTED_ACTIONS


def test_allowed_pure_action_runs_and_is_labelled(server_mod):
    # echo-hello is the static allow-listed action: it exercises the dispatch
    # path (ok + labelled + output) without touching the OS. (python-version
    # would also work but relies on platform/WMI, which sandboxed CI
    # environments may block — the dispatch contract is the same.)
    result = server_mod._run_action("echo-hello")
    assert result["ok"] is True
    assert result["action"] == "echo-hello"
    assert "hello" in result["out"]
