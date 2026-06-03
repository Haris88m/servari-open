#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""servari_cli.py - the SERVARI terminal program (the custom-CMD front door).

SERVARI runs two ways:

  1. The app    - a desktop window / web shell  (servari.cmd app)
  2. The CLI    - this terminal program         (servari.cmd cli)

The CLI is a FULL INTERACTIVE SERVARI session in your terminal - the same way a
power user runs an agent OS. You bring the harness; SERVARI is the boot persona.
Pick the backend that matches your workflow:

  claude   a live interactive Claude Code CLI session, booted as SERVARI
  codex    a live interactive OpenAI Codex CLI session, booted as SERVARI
  api      SERVARI's own interactive chat over your BYOM endpoint (no harness needed)

When you launch the CLI with no -p/--print, you get an interactive SESSION:
  - claude / codex: SERVARI hands control to the harness, in the repo dir, with an
    opening instruction to read SERVARI.md and operate as SERVARI. From there it is
    a normal interactive session in that tool - exit it to return.
  - api: there is no third-party TUI, so SERVARI's own terminal chat loop IS the
    session. It loads SERVARI.md as the system line when present (else a short
    built-in line).

The CLI auto-detects what is available. If you have the Claude CLI installed it
uses that; otherwise it falls back to the direct BYOM API. A missing binary is
reported plainly with how to install it, and the other backends are offered.

Stdlib only. No new dependencies. Fail-closed and honest: a backend error is
reported as an error - never a fabricated reply.

Usage:
  python servari_cli.py                       interactive SERVARI session (auto)
  python servari_cli.py --detect              just print backend availability
  python servari_cli.py --backend claude      interactive Claude CLI session as SERVARI
  python servari_cli.py --backend codex       interactive Codex CLI session as SERVARI
  python servari_cli.py --backend api         interactive BYOM chat as SERVARI
  python servari_cli.py --backend api -p "..." one-shot: send, print, exit
  python servari_cli.py --print-cmd           show the session launch command, don't run
  python servari_cli.py --app                 launch the desktop / web app instead

Flags:
  --backend {claude,codex,api}   force a backend (else auto-detected)
  -p, --print TEXT               one-shot prompt (no interactive loop)
  --detect                       print the detection table and exit
  --print-cmd                    print the exact session launch argv and exit (no launch)
  --app                          launch the app (START-SERVARI.cmd / npm start)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Make stdout/stderr tolerant of non-ascii on Windows (cp1252 consoles).
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Import the BYOM chat backend as a library (chat_byom.py is a sibling).
_HERE = Path(__file__).resolve().parent  # .../server
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
try:
    import chat_byom as _chat  # the bring-your-own-model chat backend
except Exception:  # noqa: BLE001 - degrade gracefully if the import breaks
    _chat = None

BACKENDS = ("claude", "codex", "api")

INSTALL_HINTS = {
    "claude": (
        "The Claude Code CLI is not on PATH. Install it from "
        "https://docs.claude.com/claude-code , then run `claude` once to sign in."
    ),
    "codex": (
        "The OpenAI Codex CLI is not on PATH. Install it (e.g. "
        "`npm install -g @openai/codex`), then run `codex` once to sign in."
    ),
}


# --------------------------------------------------------------------------- #
# Home / config resolution (mirrors chat_byom._home so the two agree).
# --------------------------------------------------------------------------- #
def _home() -> Path:
    """Resolve the repo root: SERVARI_HOME env, else parent of server/, else cwd."""
    env = os.environ.get("SERVARI_HOME")
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p.resolve()
    repo = _HERE.parent  # repo root (parent of server/)
    if (repo / "config.json").is_file() or (repo / "demo-data").is_dir():
        return repo
    return Path.cwd()


def _load_config() -> dict:
    """Read config.json from the resolved home. Missing/bad -> {}. Never raises."""
    cfg_path = _home() / "config.json"
    try:
        if not cfg_path.is_file():
            return {}
        data = json.loads(cfg_path.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError, OSError):
        return {}


# --------------------------------------------------------------------------- #
# The SERVARI boot persona.
# --------------------------------------------------------------------------- #
# This is what turns a vanilla harness into SERVARI: the session opens by
# pointing the harness at SERVARI.md (the public persona file at the repo root)
# and telling it to operate as SERVARI from there on.
SERVARI_PERSONA_FILE = "SERVARI.md"

# The opening instruction handed to claude/codex when SERVARI.md exists. It asks
# the harness to read the persona file and adopt it for the session.
SESSION_BOOT_PROMPT = (
    "Read SERVARI.md in this directory and operate as SERVARI for this entire "
    "session - adopt its identity, its honest plain operating style, and its "
    "human-gate rules for any irreversible action. Then greet me briefly as "
    "SERVARI and wait for my first instruction."
)

# A short fallback boot prompt for when SERVARI.md is not present yet, so the
# session still boots with the SERVARI identity rather than the bare harness.
SESSION_BOOT_PROMPT_NO_FILE = (
    "Operate as SERVARI for this entire session: a concise, honest "
    "operating-system assistant. Bring-your-own-model, plain answers, and a "
    "human gate before any irreversible action (deploy, real-send, spend, "
    "publish). Greet me briefly as SERVARI and wait for my first instruction."
)


def _persona_path() -> Path:
    """Absolute path to the SERVARI.md persona file at the repo root."""
    return _home() / SERVARI_PERSONA_FILE


def _persona_exists() -> bool:
    """True when SERVARI.md is present at the repo root."""
    try:
        return _persona_path().is_file()
    except OSError:
        return False


def _read_persona() -> str | None:
    """Read SERVARI.md text if present (for the API session's system line).

    Returns the file text, or None when the file is absent/unreadable so the
    caller can fall back to the built-in SYSTEM_LINE.
    """
    p = _persona_path()
    try:
        if not p.is_file():
            return None
        text = p.read_text(encoding="utf-8", errors="replace").strip()
        return text or None
    except OSError:
        return None


def build_session_cmd(backend: str, binary: str) -> list[str]:
    """Build the exact argv that launches an interactive harness session as SERVARI.

    backend == "claude":  claude "<boot prompt>"   (claude reads SERVARI.md/AGENTS.md
                          from the cwd and the positional arg is the opening turn,
                          then the normal interactive TUI continues)
    backend == "codex":   codex "<boot prompt>"    (codex reads AGENTS.md from the cwd;
                          the positional arg is the opening turn, interactive after)

    The boot prompt asks the harness to read SERVARI.md and operate as SERVARI.
    When SERVARI.md is absent, a self-contained fallback prompt carries the
    identity so the session still boots as SERVARI.
    """
    prompt = SESSION_BOOT_PROMPT if _persona_exists() else SESSION_BOOT_PROMPT_NO_FILE
    return [binary, prompt]


# --------------------------------------------------------------------------- #
# Backend detection.
# --------------------------------------------------------------------------- #
def detect() -> dict:
    """Report what each backend can do right now.

    Returns a dict:
      {
        "claude": {"available": bool, "path": str|None},
        "codex":  {"available": bool, "path": str|None},
        "api":    {"available": bool, "model": str, "base_url": str, "reason": str},
        "configured_backend": str|None,   # from config.json "backend" key, if set
        "recommended": "claude"|"codex"|"api",
      }
    """
    claude_path = shutil.which("claude")
    codex_path = shutil.which("codex")

    cfg = _load_config()
    configured = cfg.get("backend")
    if configured not in BACKENDS:
        configured = None

    # API availability: ask the BYOM backend if it's wired.
    if _chat is not None:
        try:
            st = _chat.is_configured()
        except Exception:  # noqa: BLE001
            st = {"ok": False, "model": "", "base_url": "", "reason": "chat backend error"}
    else:
        st = {"ok": False, "model": "", "base_url": "",
              "reason": "chat_byom backend could not be imported."}

    api_info = {
        "available": bool(st.get("ok")),
        "model": st.get("model", ""),
        "base_url": st.get("base_url", ""),
        "reason": st.get("reason", ""),
    }

    # Recommendation: explicit config wins; else claude > codex > api by PATH.
    if configured and _backend_ready(configured, claude_path, codex_path, api_info):
        recommended = configured
    elif claude_path:
        recommended = "claude"
    elif codex_path:
        recommended = "codex"
    else:
        recommended = "api"

    return {
        "claude": {"available": bool(claude_path), "path": claude_path},
        "codex": {"available": bool(codex_path), "path": codex_path},
        "api": api_info,
        "configured_backend": configured,
        "recommended": recommended,
    }


def _backend_ready(name: str, claude_path, codex_path, api_info: dict) -> bool:
    """Is this backend actually usable right now?"""
    if name == "claude":
        return bool(claude_path)
    if name == "codex":
        return bool(codex_path)
    if name == "api":
        return bool(api_info.get("available"))
    return False


def print_detection(d: dict) -> None:
    """Print a human-readable backend-availability table."""
    print()
    print("  SERVARI - backend detection")
    print("  " + "-" * 48)

    c = d["claude"]
    if c["available"]:
        print(f"  [claude]  available  ({c['path']})")
    else:
        print("  [claude]  not installed  (Claude Code CLI not on PATH)")

    x = d["codex"]
    if x["available"]:
        print(f"  [codex]   available  ({x['path']})")
    else:
        print("  [codex]   not installed  (OpenAI Codex CLI not on PATH)")

    a = d["api"]
    if a["available"]:
        print(f"  [api]     available  (model: {a['model']}  base_url: {a['base_url']})")
    else:
        print(f"  [api]     not configured  ({a['reason']})")

    print("  " + "-" * 48)
    if d["configured_backend"]:
        print(f"  config.json default backend: {d['configured_backend']}")
    print(f"  recommended now: {d['recommended']}")
    print()


# --------------------------------------------------------------------------- #
# Run-loops.
# --------------------------------------------------------------------------- #
def run_loop_api(one_shot: str | None = None) -> int:
    """SERVARI's own REPL over the BYOM API (chat_byom.reply).

    Does NOT start the HTTP server - calls the chat backend directly as a
    library, so there is never a port conflict.
    """
    if _chat is None:
        print("  SERVARI: the chat backend (chat_byom) could not be loaded. "
              "Run this from inside the repo so server/chat_byom.py is importable.",
              file=sys.stderr)
        return 1

    st = _chat.is_configured()
    if not st.get("ok"):
        print(f"  SERVARI: no model is wired. {st.get('reason', '')}", file=sys.stderr)
        print("  Copy config.example.json to config.json and set base_url + model "
              "(+ api_key if hosted).", file=sys.stderr)
        return 1

    # The API session IS the interactive SERVARI session for the BYOM path (no
    # third-party TUI exists). Load SERVARI.md as the system line when present;
    # else chat_byom falls back to its built-in SYSTEM_LINE.
    persona = _read_persona()

    if one_shot is not None:
        r = _chat.reply([{"from": "user", "text": one_shot}], system=persona)
        if r.get("ok"):
            print(r.get("text", ""))
            return 0
        # Honest: report the error plainly, never fabricate a reply.
        print(f"  SERVARI: the model returned an error: {r.get('error')}", file=sys.stderr)
        return 1

    print()
    print(f"  SERVARI session (API)  -  model: {st.get('model')}")
    if persona:
        print(f"  Booted as SERVARI from {SERVARI_PERSONA_FILE}.")
    print("  Type your message. Ctrl-C or an empty line + Ctrl-D to exit.")
    print()
    history: list[dict] = []
    while True:
        try:
            text = input("you > ").strip()
        except (KeyboardInterrupt, EOFError):
            print()
            break
        if not text:
            continue
        if text.lower() in ("/exit", "/quit", "exit", "quit"):
            break
        history.append({"from": "user", "text": text})
        r = _chat.reply(history, system=persona)
        if r.get("ok"):
            reply_text = r.get("text", "")
            print(f"SERVARI > {reply_text}")
            if reply_text:
                history.append({"from": "servari", "text": reply_text})
        else:
            # Honest failure - don't append a fake turn, just report.
            print(f"SERVARI > [error: {r.get('error')}]", file=sys.stderr)
    return 0


def run_loop_cli(backend: str, binary: str, one_shot: str | None = None) -> int:
    """Run a child CLI harness (claude / codex) as SERVARI.

    Interactive SESSION (default): hand control to the harness with an opening
        instruction to read SERVARI.md and operate as SERVARI, in the repo dir
        so it picks up SERVARI.md / AGENTS.md. stdin/stdout/stderr are inherited
        so the user gets the real interactive TUI - the "like the architect runs
        it" path.
    One-shot (-p): map to the harness's non-interactive flag
        (claude -p "..." / codex exec "...").
    """
    home = _home()
    try:
        if one_shot is not None:
            if backend == "claude":
                cmd = [binary, "-p", one_shot]
            elif backend == "codex":
                cmd = [binary, "exec", one_shot]
            else:
                cmd = [binary, one_shot]
            print(f"  SERVARI: running one-shot via {backend} ({binary})")
            proc = subprocess.run(cmd, cwd=str(home))
            return proc.returncode
        # Interactive session: boot the harness as SERVARI.
        cmd = build_session_cmd(backend, binary)
        if _persona_exists():
            print(f"  SERVARI: opening an interactive {backend} session as SERVARI "
                  f"(booting from {SERVARI_PERSONA_FILE}). Exit the session to return.")
        else:
            print(f"  SERVARI: opening an interactive {backend} session as SERVARI "
                  f"({SERVARI_PERSONA_FILE} not found - using the built-in boot). "
                  f"Exit the session to return.")
        # Inherit stdio so the user drives the real interactive TUI.
        proc = subprocess.run(cmd, cwd=str(home))
        return proc.returncode
    except FileNotFoundError:
        print(f"  SERVARI: '{binary}' could not be launched - is {backend} installed?",
              file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print()
        return 0
    except Exception as e:  # noqa: BLE001 - fail-closed
        print(f"  SERVARI: {backend} failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


# --------------------------------------------------------------------------- #
# The app launcher.
# --------------------------------------------------------------------------- #
def run_app() -> int:
    """Launch the desktop / web app (Option 1)."""
    home = _home()
    if os.name == "nt":
        starter = home / "START-SERVARI.cmd"
        if starter.is_file():
            print(f"  SERVARI: launching the app via {starter.name} ...")
            try:
                proc = subprocess.run([str(starter)], cwd=str(home), shell=True)
                return proc.returncode
            except Exception as e:  # noqa: BLE001
                print(f"  SERVARI: could not launch START-SERVARI.cmd: "
                      f"{type(e).__name__}: {e}", file=sys.stderr)
                return 1
    # Cross-platform / fallback: npm start (launches Electron over the server).
    npm = shutil.which("npm")
    if npm:
        print("  SERVARI: launching the app via `npm start` ...")
        try:
            proc = subprocess.run([npm, "start"], cwd=str(home))
            return proc.returncode
        except Exception as e:  # noqa: BLE001
            print(f"  SERVARI: `npm start` failed: {type(e).__name__}: {e}",
                  file=sys.stderr)
            return 1
    print("  SERVARI: cannot launch the app - neither START-SERVARI.cmd nor npm "
          "was found. Run the server directly: python server/servari_server.py",
          file=sys.stderr)
    return 1


# --------------------------------------------------------------------------- #
# Backend selection.
# --------------------------------------------------------------------------- #
def choose_backend(d: dict, override: str | None) -> str | None:
    """Resolve which backend to run. None means 'no usable backend'."""
    if override:
        if _backend_ready(override, d["claude"]["path"], d["codex"]["path"], d["api"]):
            return override
        # Requested backend not usable - explain, then offer alternatives.
        if override in INSTALL_HINTS and not d[override]["available"]:
            print(f"  SERVARI: {INSTALL_HINTS[override]}", file=sys.stderr)
        elif override == "api":
            print(f"  SERVARI: the API backend is not configured "
                  f"({d['api'].get('reason', '')}).", file=sys.stderr)
        _offer_alternatives(d, exclude=override)
        return None
    # No override - use the recommendation if it is usable.
    rec = d["recommended"]
    if _backend_ready(rec, d["claude"]["path"], d["codex"]["path"], d["api"]):
        return rec
    return None


def _offer_alternatives(d: dict, exclude: str) -> None:
    """Print the backends that ARE usable, so the user can switch."""
    usable = []
    if d["claude"]["available"] and exclude != "claude":
        usable.append("claude")
    if d["codex"]["available"] and exclude != "codex":
        usable.append("codex")
    if d["api"]["available"] and exclude != "api":
        usable.append("api")
    if usable:
        opts = " ".join(f"--backend {b}" for b in usable)
        print(f"  SERVARI: available instead -> {opts}", file=sys.stderr)
    else:
        print("  SERVARI: no other backend is ready. Install the Claude or Codex "
              "CLI, or wire config.json for the API backend.", file=sys.stderr)


def interactive_pick(d: dict) -> str | None:
    """When no backend flag is given and stdin is a TTY, let the user pick."""
    usable = [b for b in BACKENDS
              if _backend_ready(b, d["claude"]["path"], d["codex"]["path"], d["api"])]
    if not usable:
        return None
    if len(usable) == 1:
        return usable[0]
    print("  Choose a backend:")
    labels = {
        "claude": "Claude Code CLI",
        "codex": "OpenAI Codex CLI",
        "api": f"BYOM API ({d['api'].get('model', 'configured')})",
    }
    for i, b in enumerate(usable, 1):
        mark = "  (recommended)" if b == d["recommended"] else ""
        print(f"    {i}) {b:<7} - {labels[b]}{mark}")
    try:
        raw = input("  > ").strip()
    except (KeyboardInterrupt, EOFError):
        print()
        return None
    if not raw:
        return d["recommended"] if d["recommended"] in usable else usable[0]
    if raw.isdigit() and 1 <= int(raw) <= len(usable):
        return usable[int(raw) - 1]
    if raw in usable:
        return raw
    print(f"  SERVARI: '{raw}' is not one of {usable}.", file=sys.stderr)
    return None


# --------------------------------------------------------------------------- #
# Dry-run: show the session launch command without starting a TUI.
# --------------------------------------------------------------------------- #
def _print_session_cmd(d: dict, backend: str | None) -> int:
    """Print the exact interactive-session launch command for `backend`.

    Constructs and prints the argv WITHOUT launching anything (safe for tests /
    scripting). Returns 0 when a command was shown, 1 when no usable backend.
    """
    if backend is None:
        print("  SERVARI: no usable backend - nothing to launch.", file=sys.stderr)
        print_detection(d)
        return 1
    home = _home()
    if backend == "api":
        persona = _read_persona()
        src = SERVARI_PERSONA_FILE if persona else "built-in SYSTEM_LINE"
        print(f"  session backend : api (SERVARI's own terminal chat loop)")
        print(f"  cwd             : {home}")
        print(f"  system line     : {src}")
        print(f"  launch          : python server/servari_cli.py --backend api")
        return 0
    binary = d[backend]["path"]
    if not binary:
        print(f"  SERVARI: {backend} is not on PATH - cannot build a session command.",
              file=sys.stderr)
        if backend in INSTALL_HINTS:
            print(f"  {INSTALL_HINTS[backend]}", file=sys.stderr)
        return 1
    cmd = build_session_cmd(backend, binary)
    boot_src = SERVARI_PERSONA_FILE if _persona_exists() else "built-in boot prompt"
    print(f"  session backend : {backend}")
    print(f"  cwd             : {home}")
    print(f"  boots from      : {boot_src}")
    # Print argv plainly; quote the prompt so the boundary is visible.
    shown = [cmd[0]] + [f'"{a}"' if " " in a else a for a in cmd[1:]]
    print(f"  launch          : {' '.join(shown)}")
    return 0


# --------------------------------------------------------------------------- #
# Entry.
# --------------------------------------------------------------------------- #
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="servari_cli",
        description="SERVARI terminal program - chat via Claude CLI, Codex CLI, "
                    "or the BYOM API.",
    )
    ap.add_argument("--backend", choices=BACKENDS,
                    help="Force a backend (else auto-detected).")
    ap.add_argument("-p", "--print", dest="one_shot", metavar="TEXT",
                    help="One-shot: send TEXT, print the reply, exit (no loop).")
    ap.add_argument("--detect", action="store_true",
                    help="Print backend availability and exit.")
    ap.add_argument("--print-cmd", dest="print_cmd", action="store_true",
                    help="Print the exact session launch command and exit (no launch).")
    ap.add_argument("--app", action="store_true",
                    help="Launch the desktop / web app instead of the CLI.")
    args = ap.parse_args(argv)

    if args.app:
        return run_app()

    d = detect()

    if args.detect:
        print_detection(d)
        return 0

    backend = choose_backend(d, args.backend)

    # --print-cmd: show what the interactive session WOULD launch, without
    # starting a TUI. Useful for scripting and for understanding the boot.
    if args.print_cmd:
        return _print_session_cmd(d, backend)

    # No usable backend yet (and none was forced) - offer an interactive pick
    # when we have a terminal, otherwise show the detection table honestly.
    if backend is None and not args.backend:
        if sys.stdin.isatty():
            print_detection(d)
            backend = interactive_pick(d)
        if backend is None:
            if not sys.stdin.isatty():
                print_detection(d)
            print("  SERVARI: no backend is ready. See the table above.",
                  file=sys.stderr)
            return 1

    if backend is None:
        # A backend was forced but is not usable; choose_backend already
        # explained and offered alternatives.
        return 1

    if backend == "api":
        return run_loop_api(one_shot=args.one_shot)
    # claude / codex - shell out to the child binary.
    binary = d[backend]["path"]
    if not binary:
        print(f"  SERVARI: {backend} is not on PATH.", file=sys.stderr)
        if backend in INSTALL_HINTS:
            print(f"  {INSTALL_HINTS[backend]}", file=sys.stderr)
        return 1
    return run_loop_cli(backend, binary, one_shot=args.one_shot)


if __name__ == "__main__":
    raise SystemExit(main())
