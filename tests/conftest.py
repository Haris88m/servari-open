# -*- coding: utf-8 -*-
"""Shared pytest fixtures for the SERVARI server-core suite.

Conventions (mirroring scripts/verify_all.py):
  - stdlib + pytest only; NO network; NO real API keys.
  - every test runs against an ISOLATED temp data home (SERVARI_HOME) so the
    real repo demo-data/ and config.json are never touched.
  - server modules resolve their data home from SERVARI_HOME — some cache it at
    import time (verify_queue.QUEUE, health.ROOT), so fixtures RELOAD the module
    after pointing SERVARI_HOME at the temp home.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent
SERVER_DIR = REPO_ROOT / "server"

# Make server/ modules importable as top-level names (autonomy, health, ...).
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))


def _fresh(name: str):
    """Import-or-reload a server module so module-level paths re-resolve
    against the CURRENT SERVARI_HOME. importlib.reload mutates the existing
    module object in place, so references held by other fixtures stay valid."""
    if name in sys.modules:
        return importlib.reload(sys.modules[name])
    return importlib.import_module(name)


@pytest.fixture
def servari_home(tmp_path, monkeypatch):
    """An isolated SERVARI data home: <tmp>/home with an empty demo-data/.
    SERVARI_HOME points here for the duration of the test (monkeypatch undoes)."""
    home = tmp_path / "home"
    (home / "demo-data").mkdir(parents=True)
    monkeypatch.setenv("SERVARI_HOME", str(home))
    return home


@pytest.fixture
def autonomy(servari_home):
    """server/autonomy.py loaded against the isolated home."""
    return _fresh("autonomy")


@pytest.fixture
def vq(servari_home):
    """server/verify_queue.py reloaded so QUEUE points at the isolated home."""
    return _fresh("verify_queue")


@pytest.fixture
def retention(servari_home):
    """server/retention.py loaded against the isolated home."""
    return _fresh("retention")


@pytest.fixture
def health(servari_home):
    """server/health.py reloaded against the isolated home. verify_queue is
    reloaded FIRST because health._check_gate_queue() delegates pending-count
    reconciliation to the (possibly already-imported) verify_queue module."""
    _fresh("verify_queue")
    return _fresh("health")


@pytest.fixture
def chat(servari_home):
    """server/chat_byom.py loaded against the isolated home (no config.json)."""
    return _fresh("chat_byom")


@pytest.fixture
def server_mod(servari_home, monkeypatch):
    """server/servari_server.py imported (NOT started) against the isolated
    home. Import is side-effect-light: no socket is bound until main() runs."""
    monkeypatch.setenv("SERVARI_PORT", "8999")  # parsed at import; never bound
    return _fresh("servari_server")
