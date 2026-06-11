# -*- coding: utf-8 -*-
"""servari_server.py — the engine-control guard rails (no sockets, no spawns).

The load-bearing claims under test:

1. POST /api/engine/start no longer launches whatever executable the JSON body
   names. The interpreter value is validated against a CLOSED policy — bare
   python basenames (PATH-resolved), the server's own interpreter, the
   operator's SERVARI_ENGINE_PYTHON, or absolute paths pre-declared in
   config.json "engine_allowed_pythons" — and everything else fails CLOSED
   (engine_python_rejected) BEFORE any process is spawned. The basename roster
   is pinned so an accidental widening fails the suite (mirrors the action
   allow-list contract in test_server_actions.py).

2. The engine control POST routes demand the X-Servari-Engine header. A
   cross-site browser request cannot attach a custom header without a CORS
   preflight this server never grants, so requiring one defeats CSRF-shaped
   launches while staying a one-line addition for legitimate local clients.
"""
from __future__ import annotations

import json
import sys

EXPECTED_PYTHON_BASENAMES = {
    "python",
    "python3",
    "python.exe",
    "python3.exe",
}


# --- the interpreter policy (claim 1) ----------------------------------------

def test_python_basename_roster_is_pinned(server_mod):
    assert set(server_mod._ENGINE_PYTHON_BASENAMES) == EXPECTED_PYTHON_BASENAMES


def test_bare_python_basename_is_allowed(server_mod):
    # Policy verdict must not depend on whether PATH actually resolves the
    # basename on this machine — resolution failures surface later as
    # engine_python_not_found, not as a policy rejection.
    resolved, err = server_mod._engine_python_policy("python")
    assert err is None
    assert resolved


def test_own_interpreter_is_allowed(server_mod):
    resolved, err = server_mod._engine_python_policy(sys.executable)
    assert err is None
    assert resolved == sys.executable


def test_absolute_path_to_arbitrary_executable_is_rejected(server_mod, tmp_path):
    evil = tmp_path / "evil.exe"
    evil.write_text("not a python", encoding="utf-8")
    resolved, err = server_mod._engine_python_policy(str(evil))
    assert resolved is None
    assert err is not None
    assert "engine_allowed_pythons" in err  # the message must say how to opt in


def test_masquerading_python_basename_is_rejected(server_mod, tmp_path):
    # An allow-listed BASENAME does not bless an arbitrary PATHED executable:
    # anyone able to plant a file can name it python.exe.
    fake = tmp_path / "python.exe"
    fake.write_text("not a python", encoding="utf-8")
    resolved, err = server_mod._engine_python_policy(str(fake))
    assert resolved is None
    assert err is not None


def test_relative_path_with_separator_is_rejected(server_mod):
    resolved, err = server_mod._engine_python_policy("tools/python")
    assert resolved is None
    assert err is not None


def test_env_declared_interpreter_is_allowed(server_mod, tmp_path, monkeypatch):
    declared = tmp_path / "venv-python.exe"
    declared.write_text("operator-declared", encoding="utf-8")
    monkeypatch.setenv("SERVARI_ENGINE_PYTHON", str(declared))
    resolved, err = server_mod._engine_python_policy(str(declared))
    assert err is None
    assert resolved == str(declared)


def test_config_declared_interpreter_is_allowed(server_mod, servari_home, tmp_path):
    declared = tmp_path / "project-python.exe"
    declared.write_text("operator-declared", encoding="utf-8")
    (servari_home / "config.json").write_text(
        json.dumps({"engine_allowed_pythons": [str(declared)]}), encoding="utf-8"
    )
    resolved, err = server_mod._engine_python_policy(str(declared))
    assert err is None
    assert resolved == str(declared)


def test_malformed_config_fails_closed(server_mod, servari_home, tmp_path):
    declared = tmp_path / "project-python.exe"
    declared.write_text("operator-declared", encoding="utf-8")
    (servari_home / "config.json").write_text("{ not json", encoding="utf-8")
    resolved, err = server_mod._engine_python_policy(str(declared))
    assert resolved is None
    assert err is not None


def test_config_allowlist_must_be_a_list(server_mod, servari_home, tmp_path):
    declared = tmp_path / "project-python.exe"
    declared.write_text("operator-declared", encoding="utf-8")
    (servari_home / "config.json").write_text(
        json.dumps({"engine_allowed_pythons": str(declared)}), encoding="utf-8"
    )
    resolved, err = server_mod._engine_python_policy(str(declared))
    assert resolved is None
    assert err is not None


def test_engine_start_rejects_disallowed_interpreter_before_spawn(server_mod, tmp_path):
    home = tmp_path / "engine-home"
    home.mkdir()
    (home / "app.py").write_text("raise SystemExit(0)\n", encoding="utf-8")
    evil = tmp_path / "evil.exe"
    evil.write_text("not a python", encoding="utf-8")

    result = server_mod._engine_start({"home": str(home), "python": str(evil)})

    assert result["ok"] is False
    assert result["error"] == "engine_python_rejected"
    assert server_mod._ENGINE_PROC is None  # fail-closed: nothing was spawned


def test_engine_start_still_requires_interpreter_to_exist(server_mod, tmp_path, monkeypatch):
    # A declared-but-missing interpreter passes policy and then fails the
    # existing existence gate — the second fail-closed layer stays intact.
    home = tmp_path / "engine-home"
    home.mkdir()
    (home / "app.py").write_text("raise SystemExit(0)\n", encoding="utf-8")
    ghost = tmp_path / "ghost-python.exe"  # never created
    monkeypatch.setenv("SERVARI_ENGINE_PYTHON", str(ghost))

    result = server_mod._engine_start({"home": str(home), "python": str(ghost)})

    assert result["ok"] is False
    assert result["error"] == "engine_python_not_found"
    assert server_mod._ENGINE_PROC is None


# --- the anti-CSRF header (claim 2) ------------------------------------------

def test_missing_control_header_is_blocked(server_mod):
    blocked = server_mod._engine_csrf_error({})
    assert blocked is not None
    assert blocked["ok"] is False
    assert blocked["error"] == "engine_header_required"
    assert server_mod._ENGINE_CONTROL_HEADER in blocked["message"]


def test_blank_control_header_is_blocked(server_mod):
    blocked = server_mod._engine_csrf_error({server_mod._ENGINE_CONTROL_HEADER: "   "})
    assert blocked is not None
    assert blocked["error"] == "engine_header_required"


def test_present_control_header_passes(server_mod):
    assert server_mod._engine_csrf_error({server_mod._ENGINE_CONTROL_HEADER: "1"}) is None
