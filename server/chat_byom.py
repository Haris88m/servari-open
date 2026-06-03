#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""chat_byom.py — the BRING-YOUR-OWN-MODEL chat backend.

A minimal, provider-agnostic chat handler. It reads config.json (provider /
api_key / model / base_url), sends the conversation to the model's
OpenAI-compatible /chat/completions endpoint, and returns the assistant's reply.
Most providers expose this shape — OpenAI, OpenRouter, Together, Fireworks,
and local servers like Ollama, LM Studio, and vLLM.

There is no hidden prompt and no vendor lock-in: the request is the conversation
you see in the channel plus one short system line. Swap the model by editing
config.json; nothing else changes.

Config file: config.json at the repo root (copy from config.example.json).
            config.json is gitignored — your key never enters the repo.

Functions (importable for the server):
  reply(history)  -> {"ok": bool, "text": str, "model": str, "error": str}
      history is a list of channel turns [{from, text}, ...]; the newest user
      turn is answered. Missing/empty config -> an honest "configure your model"
      message (ok=False), never a crash and never a fabricated answer.

CLI:
  python chat_byom.py --say "hello"     # one-shot, reads config.json
  python chat_byom.py --check           # report whether a model is configured

Stdlib only (urllib). cp1252-safe. Fail-closed: any error degrades to an honest
message; never raises.
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Keep the system line short and neutral — this is the WHOLE hidden prompt.
SYSTEM_LINE = (
    "You are SERVARI, a concise, helpful operating-system assistant. "
    "Answer plainly. If you are unsure, say so."
)
TIMEOUT_SEC = 60


def _home() -> Path:
    """Resolve the repo root (SERVARI_HOME env, else parent of server/, else cwd)."""
    env = os.environ.get("SERVARI_HOME")
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p.resolve()
    here = Path(__file__).resolve().parent      # .../server
    repo = here.parent                          # repo root
    if (repo / "demo-data").is_dir() or (repo / "config.json").is_file():
        return repo
    return Path.cwd()


CONFIG = _home() / "config.json"


def load_config() -> dict:
    """Read config.json. Missing/unreadable/malformed -> {}. Never raises."""
    try:
        if not CONFIG.is_file():
            return {}
        data = json.loads(CONFIG.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError, OSError):
        return {}


def is_configured() -> dict:
    """Report whether a model is wired. {ok, model, base_url, has_key, reason}."""
    cfg = load_config()
    model = (cfg.get("model") or "").strip()
    base = (cfg.get("base_url") or "").strip()
    key = (cfg.get("api_key") or "").strip()
    if not CONFIG.is_file():
        return {"ok": False, "model": "", "base_url": "", "has_key": False,
                "reason": "config.json not found — copy config.example.json to config.json and fill it in."}
    if not base or not model:
        return {"ok": False, "model": model, "base_url": base, "has_key": bool(key),
                "reason": "config.json is missing base_url and/or model."}
    return {"ok": True, "model": model, "base_url": base, "has_key": bool(key),
            "reason": "configured"}


def _newest_user_text(history) -> str:
    """The text of the newest turn whose author is the user. '' if none."""
    if not isinstance(history, list):
        return ""
    for turn in reversed(history):
        if not isinstance(turn, dict):
            continue
        who = str(turn.get("from", "")).lower()
        if who in ("user", "you", "operator", "human"):
            return str(turn.get("text", "")).strip()
    return ""


def _to_messages(history, system: str | None = None) -> list:
    """Map channel turns -> OpenAI chat messages. user -> user; anyone else ->
    assistant. The system line is prepended (caller may override it)."""
    sys_line = (system or "").strip() or SYSTEM_LINE
    msgs = [{"role": "system", "content": sys_line}]
    if isinstance(history, list):
        for turn in history[-20:]:  # cap context to the last 20 turns
            if not isinstance(turn, dict):
                continue
            text = str(turn.get("text", "")).strip()
            if not text:
                continue
            who = str(turn.get("from", "")).lower()
            role = "user" if who in ("user", "you", "operator", "human") else "assistant"
            msgs.append({"role": role, "content": text})
    return msgs


def reply(history, system: str | None = None) -> dict:
    """Answer the newest user turn via the configured model.

    Returns {"ok", "text", "model", "error"}. No config/key -> ok=False with an
    honest message in `text` (the UI shows it like any reply). Never raises.

    `system` optionally overrides the default SYSTEM_LINE (e.g. a SERVARI.md
    persona). When None/blank, the built-in SYSTEM_LINE is used — so existing
    callers (the server) keep their exact behaviour.
    """
    status = is_configured()
    cfg = load_config()
    if not status["ok"]:
        return {"ok": False, "model": status.get("model", ""),
                "text": (
                    "No model is wired yet. Copy config.example.json to "
                    "config.json, set your provider's base_url + model (+ api_key "
                    "if hosted), and I'll answer for real. " + status["reason"]
                ),
                "error": "not_configured"}

    base = status["base_url"].rstrip("/")
    model = status["model"]
    key = (cfg.get("api_key") or "").strip()
    url = base + "/chat/completions"

    payload = json.dumps({
        "model": model,
        "messages": _to_messages(history, system=system),
        "stream": False,
    }).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw)
        # OpenAI-compatible shape: choices[0].message.content
        text = ""
        choices = data.get("choices")
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message") or {}
            text = str(msg.get("content") or "").strip()
        if not text:
            return {"ok": False, "model": model, "text": "",
                    "error": "empty response from the model"}
        return {"ok": True, "model": model, "text": text, "error": None}
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return {"ok": False, "model": model, "text": "",
                "error": f"HTTP {e.code} from {url}: {body}"}
    except urllib.error.URLError as e:
        return {"ok": False, "model": model, "text": "",
                "error": f"could not reach {url}: {e.reason}"}
    except (json.JSONDecodeError, ValueError) as e:
        return {"ok": False, "model": model, "text": "",
                "error": f"bad response from the model: {type(e).__name__}"}
    except Exception as e:  # noqa: BLE001 - fail-closed
        return {"ok": False, "model": model, "text": "",
                "error": f"chat failed: {type(e).__name__}"}


def main(argv=None):
    ap = argparse.ArgumentParser(description="The BYOM chat backend (OpenAI-compatible).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--say", metavar="TEXT", help="One-shot: answer this user message.")
    g.add_argument("--check", action="store_true", help="Report whether a model is configured.")
    args = ap.parse_args(argv)

    if args.check:
        print(json.dumps(is_configured(), indent=2))
        return 0
    out = reply([{"from": "user", "text": args.say}])
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
