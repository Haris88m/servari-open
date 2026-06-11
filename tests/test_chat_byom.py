# -*- coding: utf-8 -*-
"""chat_byom.py — the bring-your-own-model bridge.

The load-bearing claim under test is HONESTY: with no config (or a broken
model) SERVARI says so plainly — it NEVER fabricates an answer and NEVER
crashes. No network is touched anywhere in this file: the missing-config
paths return before any request is built, and the configured paths run
against a monkeypatched urllib transport.
"""
from __future__ import annotations

import io
import json
import urllib.error

import pytest


# --------------------------------------------------------------------------- #
# Transport doubles (no sockets, ever)
# --------------------------------------------------------------------------- #

class _FakeResponse:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Transport:
    """Recording stand-in for urllib.request.urlopen."""

    def __init__(self, result=None, raises=None):
        self.result = result
        self.raises = raises
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        if self.raises is not None:
            raise self.raises
        return _FakeResponse(self.result)


def _forbid_network(monkeypatch):
    def _explode(*args, **kwargs):
        raise AssertionError("urlopen called — this path must never touch the network")
    monkeypatch.setattr("urllib.request.urlopen", _explode)


def _write_config(home, cfg):
    (home / "config.json").write_text(json.dumps(cfg), encoding="utf-8")


def _configured(home):
    _write_config(home, {
        "provider": "test-openai-compatible",
        "api_key": "test-key-not-real",
        "model": "test-model",
        "base_url": "http://127.0.0.1:9/v1",
    })


# --------------------------------------------------------------------------- #
# Missing / broken config -> honest "configure your model", no network
# --------------------------------------------------------------------------- #

def test_no_config_reply_is_honest_and_offline(chat, monkeypatch):
    """Mirrors verify_all V004 — the headline honesty claim."""
    _forbid_network(monkeypatch)
    status = chat.is_configured()
    assert status["ok"] is False
    assert "config.json not found" in status["reason"]

    result = chat.reply([{"from": "user", "text": "hello"}])
    assert result["ok"] is False
    assert result["error"] == "not_configured"
    assert "No model is wired" in result["text"]
    assert "config.example.json" in result["text"]   # tells the user HOW to fix it


def test_config_missing_model_or_base_url_is_honest(chat, servari_home,
                                                    monkeypatch):
    _forbid_network(monkeypatch)
    _write_config(servari_home, {"api_key": "test-key-not-real",
                                 "model": "test-model"})  # no base_url
    status = chat.is_configured()
    assert status["ok"] is False
    assert "missing base_url and/or model" in status["reason"]
    result = chat.reply([{"from": "user", "text": "hi"}])
    assert result["ok"] is False
    assert result["error"] == "not_configured"


@pytest.mark.parametrize("content", ["{not valid json", '["a", "list"]', ""])
def test_malformed_config_degrades_to_unconfigured(chat, servari_home,
                                                   monkeypatch, content):
    _forbid_network(monkeypatch)
    (servari_home / "config.json").write_text(content, encoding="utf-8")
    assert chat.load_config() == {}
    assert chat.is_configured()["ok"] is False
    assert chat.reply([{"from": "user", "text": "hi"}])["error"] == "not_configured"


def test_garbage_history_never_crashes_unconfigured(chat, monkeypatch):
    _forbid_network(monkeypatch)
    for history in (None, "a string", [None, 42, {"no": "text"}], []):
        result = chat.reply(history)
        assert result["ok"] is False
        assert result["error"] == "not_configured"


# --------------------------------------------------------------------------- #
# Configured + mocked transport: round-trip and honest failures
# --------------------------------------------------------------------------- #

def test_configured_reply_round_trip(chat, servari_home, monkeypatch):
    _configured(servari_home)
    transport = _Transport(result={
        "choices": [{"message": {"role": "assistant",
                                 "content": "the wired answer"}}],
    })
    monkeypatch.setattr("urllib.request.urlopen", transport)

    result = chat.reply([{"from": "user", "text": "ping"}])
    assert result == {"ok": True, "model": "test-model",
                      "text": "the wired answer", "error": None}

    req = transport.requests[0]
    assert req.full_url == "http://127.0.0.1:9/v1/chat/completions"
    assert req.get_header("Authorization") == "Bearer test-key-not-real"
    payload = json.loads(req.data.decode("utf-8"))
    assert payload["model"] == "test-model"
    assert payload["stream"] is False
    assert payload["messages"][0]["role"] == "system"
    assert payload["messages"][-1] == {"role": "user", "content": "ping"}


def test_keyless_config_sends_no_auth_header(chat, servari_home, monkeypatch):
    _write_config(servari_home, {"api_key": "", "model": "local-model",
                                 "base_url": "http://127.0.0.1:9/v1"})
    transport = _Transport(result={
        "choices": [{"message": {"content": "local says hi"}}]})
    monkeypatch.setattr("urllib.request.urlopen", transport)
    assert chat.reply([{"from": "user", "text": "hi"}])["ok"] is True
    assert transport.requests[0].get_header("Authorization") is None


def test_empty_model_response_is_never_fabricated(chat, servari_home,
                                                  monkeypatch):
    _configured(servari_home)
    transport = _Transport(result={"choices": [{"message": {"content": ""}}]})
    monkeypatch.setattr("urllib.request.urlopen", transport)
    result = chat.reply([{"from": "user", "text": "say something"}])
    assert result["ok"] is False
    assert result["text"] == ""                       # nothing invented
    assert "empty response" in result["error"]


def test_unreachable_model_is_honest(chat, servari_home, monkeypatch):
    _configured(servari_home)
    transport = _Transport(raises=urllib.error.URLError("connection refused"))
    monkeypatch.setattr("urllib.request.urlopen", transport)
    result = chat.reply([{"from": "user", "text": "anyone there?"}])
    assert result["ok"] is False
    assert result["text"] == ""
    assert "could not reach" in result["error"]


def test_http_error_is_reported_with_status(chat, servari_home, monkeypatch):
    _configured(servari_home)
    err = urllib.error.HTTPError(
        "http://127.0.0.1:9/v1/chat/completions", 401, "Unauthorized",
        {}, io.BytesIO(b'{"error": "bad key"}'))
    transport = _Transport(raises=err)
    monkeypatch.setattr("urllib.request.urlopen", transport)
    result = chat.reply([{"from": "user", "text": "auth?"}])
    assert result["ok"] is False
    assert "HTTP 401" in result["error"]


def test_non_json_model_response_is_honest(chat, servari_home, monkeypatch):
    _configured(servari_home)

    class _Junk(_FakeResponse):
        def __init__(self):
            self._body = b"<html>this is not a completions payload</html>"

    monkeypatch.setattr("urllib.request.urlopen",
                        lambda req, timeout=None: _Junk())
    result = chat.reply([{"from": "user", "text": "hi"}])
    assert result["ok"] is False
    assert "bad response from the model" in result["error"]


# --------------------------------------------------------------------------- #
# Conversation mapping helpers
# --------------------------------------------------------------------------- #

def test_to_messages_roles_cap_and_system_line(chat):
    history = [{"from": "user", "text": f"turn {i}"} for i in range(30)]
    history.append({"from": "servari", "text": "an assistant turn"})
    history.append({"from": "user", "text": "   "})      # blank: skipped
    history.append("not a dict")                          # junk: skipped
    msgs = chat._to_messages(history)
    assert msgs[0] == {"role": "system", "content": chat.SYSTEM_LINE}
    # the last-20 window holds 17 user turns + 1 assistant + 2 skipped items
    assert len(msgs) == 1 + 17 + 1
    assert msgs[1] == {"role": "user", "content": "turn 13"}  # cap from the tail
    assert msgs[-1] == {"role": "assistant", "content": "an assistant turn"}
    assert all(m["role"] in ("system", "user", "assistant") for m in msgs)


def test_system_override_reaches_the_wire(chat, servari_home, monkeypatch):
    _configured(servari_home)
    transport = _Transport(result={
        "choices": [{"message": {"content": "persona reply"}}]})
    monkeypatch.setattr("urllib.request.urlopen", transport)
    chat.reply([{"from": "user", "text": "hi"}], system="You are TESTBOT.")
    payload = json.loads(transport.requests[0].data.decode("utf-8"))
    assert payload["messages"][0] == {"role": "system",
                                      "content": "You are TESTBOT."}


def test_newest_user_text_picks_latest_user_turn(chat):
    history = [
        {"from": "user", "text": "first"},
        {"from": "servari", "text": "reply"},
        {"from": "operator", "text": "second"},
    ]
    assert chat._newest_user_text(history) == "second"
    assert chat._newest_user_text([{"from": "servari", "text": "x"}]) == ""
    assert chat._newest_user_text("junk") == ""
