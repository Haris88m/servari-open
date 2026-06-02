#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SERVARI server — the open agent-OS shell.

A small stdlib HTTP server that:
  - serves the built React (Vite) SPA from ui/dist/,
  - exposes a JSON API for the shell panels (channel, agents, gates, health,
    autonomy dial, retention, context, tokens, voice),
  - runs an ALLOW-LISTED action runner (NOT a raw shell — only the named demo
    actions below can run),
  - degrades gracefully: any backing module that fails to import leaves its
    routes returning a clean "unavailable" payload instead of crashing the server.

All data is read from the bundled `demo-data/` directory so the shell renders on
first run with no live backend. Point SERVARI_HOME at your own data dir to wire
real providers.

Run: python server/servari_server.py  ->  http://127.0.0.1:8911/
localhost only. Safe DOM in the SPA (no innerHTML). Stdlib. cp1252-safe.
"""
from __future__ import annotations
import json, os, sys, glob, subprocess, datetime, platform, shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass


def _home() -> Path:
    """Resolve the data home: SERVARI_HOME env var, else the repo root (the
    parent of this server/ dir), else cwd. Drive-independent, no hardcoded paths."""
    env = os.environ.get("SERVARI_HOME")
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p.resolve()
    here = Path(__file__).resolve().parent      # .../server
    repo = here.parent                          # repo root (parent of server/)
    if (repo / "demo-data").is_dir():
        return repo
    return Path.cwd()


ROOT = _home()
DEMO = ROOT / "demo-data"
CHAN = DEMO / "channel.jsonl"                 # you <-> SERVARI (the center channel)
HUB = DEMO / "nervous-system.json"            # health + channel index
TEAM = DEMO / "team.json"                     # org chart + comms-matrix
LAUNCH = DEMO / "launch.md"                   # optional staged-rollout ladder
AGENTS_DIR = DEMO / "agents"                  # demo-data/agents/<name>/channel.jsonl

# Bind address is configurable via env (no source edit needed):
#   SERVARI_HOST  — interface to bind (default 127.0.0.1, localhost-only)
#   SERVARI_PORT  — TCP port (default 8911)
def _port() -> int:
    raw = os.environ.get("SERVARI_PORT", "").strip()
    if raw:
        try:
            p = int(raw)
            if 1 <= p <= 65535:
                return p
        except ValueError:
            pass
    return 8911

HOST = os.environ.get("SERVARI_HOST", "").strip() or "127.0.0.1"
PORT = _port()

# --- the four shell modules (autonomy dial / verify gate queue / health /
# retention / context / tokens). Load them defensively: a module-load failure
# (missing file, import error) must NEVER crash the server — the routes degrade
# gracefully. ---
try:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import autonomy                       # the per-agent L0-L5 autonomy dial
    import verify_queue as _vq            # the fast-verify gate queue
    import health                         # the health surface
    import retention                      # the metric-gated retention loop
    import context_policy                 # the context-pressure policy
    import tokens as _tokens              # the proof-of-work token tracker
    import chat_byom as _chat             # the bring-your-own-model chat backend
    _MODULES_ERR = None
except Exception as _e:                   # pragma: no cover - defensive boot guard
    autonomy = None
    _vq = None
    health = None
    retention = None
    context_policy = None
    _tokens = None
    _chat = None
    _MODULES_ERR = f"{type(_e).__name__}: {_e}"

# --- Voice backends load LAZILY in a background thread ---
# Their ML imports (faster-whisper/CTranslate2 + piper/onnxruntime) can hang for
# minutes under system load. If they sat in the top-level import block, that hang
# would prevent the server from ever binding the port. Now: the port binds FIRST,
# voice loads after in a daemon thread. Every voice endpoint already degrades
# gracefully on `voice is None` / `voice_neural is None`, so nothing else changes.
voice = None
voice_neural = None
_VOICE_LOAD_STATE = "pending"


def _load_voice_backends():
    """Import the heavy ML voice backends. Runs in a daemon thread started AFTER the port binds."""
    global voice, voice_neural, _VOICE_LOAD_STATE
    _VOICE_LOAD_STATE = "loading"
    errs = []
    try:
        import voice as _v
        voice = _v
    except Exception as _e:  # noqa: BLE001 - degradation, never crash
        errs.append(f"voice: {type(_e).__name__}")
    try:
        import voice_neural as _vn
        voice_neural = _vn
    except Exception as _e:  # noqa: BLE001
        errs.append(f"voice_neural: {type(_e).__name__}")
    _VOICE_LOAD_STATE = ("loaded" if not errs else "failed: " + ", ".join(errs))


# --- the allow-listed action runner -------------------------------------------
# A small set of HARMLESS, read-only demo actions. This is NOT a raw shell: only
# a named action in this dict can run, in the repo cwd, with a 120s cap. Replace
# or extend these with your own safe actions; never put a destructive command here.
def _act_echo_hello():
    return {"ok": True, "out": "hello from the SERVARI shell"}


def _act_list_demo_agents():
    names = sorted(_agent_channels().keys())
    return {"ok": True, "out": "\n".join(names) if names else "(no demo agents found in demo-data/agents/)"}


def _act_disk_free():
    try:
        total, used, free = shutil.disk_usage(str(ROOT))
        gb = 1024 ** 3
        return {"ok": True, "out": f"disk free: {free/gb:.1f} GB of {total/gb:.1f} GB (home={ROOT})"}
    except Exception as e:
        return {"ok": False, "out": f"error: {e}"}


def _act_python_version():
    return {"ok": True, "out": f"Python {platform.python_version()} on {platform.system()} {platform.release()}"}


ACTIONS = {
    "echo-hello": _act_echo_hello,
    "list-demo-agents": _act_list_demo_agents,
    "disk-free": _act_disk_free,
    "python-version": _act_python_version,
}


def _turns(p: Path):
    out = []
    if p and p.is_file():
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try: out.append(json.loads(line))
            except Exception: pass
    return out


def _hub():
    try:
        return json.loads(HUB.read_text(encoding="utf-8")) if HUB.is_file() else {}
    except Exception:
        return {}


def _agent_channels():
    """name -> channel.jsonl Path for every demo agent under demo-data/agents/."""
    out = {}
    try:
        if AGENTS_DIR.is_dir():
            for ch in glob.glob(str(AGENTS_DIR / "*" / "channel.jsonl")):
                p = Path(ch)
                name = p.parent.name
                out[name] = p
    except Exception:
        pass
    return out


def _append(p: Path, who: str, text: str):
    text = (text or "").strip()
    if not text:
        return False
    turns = _turns(p)
    turn = {"turn": len(turns) + 1, "from": who, "text": text,
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(turn) + "\n")
    return True


def _run_action(name: str):
    fn = ACTIONS.get(name)
    if not fn:
        return {"ok": False, "action": name, "out": f"refused: '{name}' is not an allow-listed action.",
                "allowed": sorted(ACTIONS)}
    try:
        result = fn()
        result.setdefault("action", name)
        return result
    except Exception as e:
        return {"ok": False, "action": name, "out": f"error: {e}"}


def _org():
    """The org chart + comms-matrix + chain (demo-data/team.json). Fail-safe if absent."""
    if not TEAM.is_file():
        return {"_note": "demo-data/team.json not present — org view will populate when it lands."}
    try:
        d = json.loads(TEAM.read_text(encoding="utf-8"))
        d["_source"] = "demo-data/team.json"
        return d
    except Exception as e:
        return {"_note": f"demo-data/team.json present but unreadable: {e}"}


def _agent_brief(name: str):
    """The clicked agent's brief (a START.md beside its channel). Fail-safe if absent."""
    p = _agent_channels().get(name)
    if not p:
        return {"name": name, "found": False, "brief": "", "note": "unknown agent (not in the channel glob)."}
    brief = p.parent / "START.md"   # <agent-dir>/START.md
    if not brief.is_file():
        return {"name": name, "found": False, "brief": "",
                "note": f"START.md not present for {name}.",
                "path": str(brief.relative_to(ROOT)) if ROOT in brief.parents else str(brief)}
    try:
        return {"name": name, "found": True, "brief": brief.read_text(encoding="utf-8", errors="replace")[:40000],
                "path": str(brief.relative_to(ROOT)) if ROOT in brief.parents else str(brief)}
    except Exception as e:
        return {"name": name, "found": False, "brief": "", "note": f"unreadable: {e}"}


def _launch():
    """The staged-rollout ladder + current stage-status (demo-data/launch.md). Fail-safe."""
    if not LAUNCH.is_file():
        return {"stages": [], "note": "launch.md not found — launch panel will populate when it lands."}
    try:
        txt = LAUNCH.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return {"stages": [], "note": f"launch.md unreadable: {e}"}
    stages = []
    for line in txt.splitlines():
        ln = line.strip()
        if not ln.startswith("|"):
            continue
        cells = [c.strip() for c in ln.strip("|").split("|")]
        if len(cells) < 3:
            continue
        head = cells[0].lower()
        if head.startswith("stage") or set(cells[0]) <= set("-: "):   # header / separator rows
            continue
        stage = cells[0].replace("**", "").strip()
        goal = cells[1].replace("**", "").strip()
        status = cells[2].replace("**", "").strip()
        gate = cells[3].strip() if len(cells) > 3 else ""
        # classify for the dot color (DONE/PARTIAL/UNMET/not-started)
        s = status.upper()
        cls = "done" if "DONE" in s else "partial" if "PARTIAL" in s else \
              "bad" if ("UNMET" in s or "BLOCK" in s) else "idle"
        stages.append({"stage": stage, "goal": goal, "status": status, "gate": gate, "cls": cls})
    return {"stages": stages, "source": "demo-data/launch.md"}


def _parse_ts(s):
    """Best-effort parse of an ISO turn timestamp -> aware UTC datetime, or None."""
    if not s or not isinstance(s, str):
        return None
    raw = s.strip().replace("Z", "+00:00")
    try:
        dt = datetime.datetime.fromisoformat(raw)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def _pane_meta(turns):
    """Derive last_ts (ISO), status (active/idle), and activity (recent epoch-secs for a sparkline)
    from a channel's turn list. Active = last turn within ACTIVE_WINDOW_SEC. Stdlib + fast."""
    ACTIVE_WINDOW_SEC = 180  # ~3 min
    now = datetime.datetime.now(datetime.timezone.utc)
    last_ts, last_dt = "", None
    activity = []
    for t in turns or []:
        dt = _parse_ts((t or {}).get("ts", ""))
        if dt is None:
            continue
        activity.append(int(dt.timestamp()))
        if last_dt is None or dt > last_dt:
            last_dt, last_ts = dt, (t or {}).get("ts", "")
    status = "idle"
    if last_dt is not None and (now - last_dt).total_seconds() <= ACTIVE_WINDOW_SEC:
        status = "active"
    return {"last_ts": last_ts, "status": status, "activity": activity[-24:]}


def _grid(limit=6):
    """The live multi-pane grid — every agent channel + its last few turns, in one call.
    "Watch them all at once". The center channel is pane 0.
    Each pane carries last_ts + status + activity so the UI renders a live operations tracker."""
    panes = []
    at = _turns(CHAN)
    center = {"name": "you <-> SERVARI", "key": "center", "total": len(at), "turns": at[-limit:], "owes": ""}
    center.update(_pane_meta(at))
    panes.append(center)
    hubch = _hub().get("channels", {})
    for name, p in sorted(_agent_channels().items()):
        ts = _turns(p)
        owes = (hubch.get(name, {}) or {}).get("owes", "")
        pane = {"name": name, "key": name, "total": len(ts), "turns": ts[-limit:], "owes": owes}
        pane.update(_pane_meta(ts))
        panes.append(pane)
    return {"panes": panes, "count": len(panes)}


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def log_message(self, *a):
        pass

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    # -------------------------------------------------------------------------
    # Serve the React (Vite) dist at "/" and SPA sub-routes + static assets.
    # Returns a clear "build the UI first" message if dist hasn't been built yet.
    # -------------------------------------------------------------------------
    _DIST = Path(__file__).resolve().parent.parent / "ui" / "dist"
    _MIME = {
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".wav": "audio/wav",
        ".webm": "audio/webm",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".ttf": "font/ttf",
    }
    _NO_DIST_PAGE = (
        "<!doctype html><meta charset='utf-8'><title>SERVARI</title>"
        "<body style='font:16px system-ui;background:#0a0a12;color:#eee;padding:40px'>"
        "<h1>SERVARI</h1><p>The UI has not been built yet.</p>"
        "<p>Run <code>cd ui &amp;&amp; npm install &amp;&amp; npm run build</code>, "
        "then reload.</p></body>"
    )

    def _serve_dist_file(self, rel: str) -> bool:
        """Try to serve rel (relative to dist). Return True if served."""
        target = (self._DIST / rel.lstrip("/")).resolve()
        # Security: must stay inside _DIST (path-traversal guard)
        try:
            target.relative_to(self._DIST)
        except ValueError:
            return False
        if not target.is_file():
            return False
        ctype = self._MIME.get(target.suffix, "application/octet-stream")
        try:
            data = target.read_bytes()
        except OSError:
            return False
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return True

    def _serve_spa(self) -> bool:
        """Serve dist/index.html (the SPA shell) if the dist is present."""
        idx = self._DIST / "index.html"
        if not idx.is_file():
            return False
        try:
            data = idx.read_bytes()
        except OSError:
            return False
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return True

    def do_GET(self):
        u = urlparse(self.path)
        # Static assets: /assets/*, /raven.png, /favicon.ico
        if u.path.startswith("/assets/") or u.path in ("/raven.png", "/favicon.ico", "/favicon.png"):
            if self._serve_dist_file(u.path):
                return
        # SPA routes: "/", "/shell", "/shell/*", "/ai", "/ai/*"
        if u.path in ("/",) or u.path.startswith(("/shell", "/ai")):
            # Serve dist index; if not built, return a friendly "build first" page.
            if not self._serve_spa():
                self._send(200, self._NO_DIST_PAGE, "text/html; charset=utf-8")
            return
        elif u.path == "/api/state":
            hub = _hub()
            self._send(200, json.dumps({"turns": _turns(CHAN), "health": hub.get("health", {}),
                                        "channels": hub.get("channels", {}),
                                        "open_gates": hub.get("open_gates", [])}))
        elif u.path == "/api/actions":
            self._send(200, json.dumps({"actions": sorted(ACTIONS)}))
        elif u.path == "/api/byom-status":
            # whether a model is wired (config.json present + valid). Never crash.
            try:
                if _chat is None:
                    self._send(200, json.dumps({"ok": False, "reason": "chat backend unavailable",
                                                "detail": _MODULES_ERR}))
                else:
                    self._send(200, json.dumps(_chat.is_configured()))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "reason": f"byom-status failed: {type(e).__name__}"}))
        elif u.path == "/api/agents":
            self._send(200, json.dumps({"agents": sorted(_agent_channels())}))
        elif u.path == "/api/agent-channel":
            name = (parse_qs(u.query).get("name") or [""])[0]
            p = _agent_channels().get(name)
            self._send(200, json.dumps({"name": name, "turns": _turns(p)}))
        elif u.path == "/api/org":
            self._send(200, json.dumps(_org()))
        elif u.path == "/api/agent-brief":
            name = (parse_qs(u.query).get("name") or [""])[0]
            self._send(200, json.dumps(_agent_brief(name)))
        elif u.path == "/api/launch":
            self._send(200, json.dumps(_launch()))
        elif u.path == "/api/grid":
            self._send(200, json.dumps(_grid()))
        elif u.path == "/api/autonomy":
            # the per-agent autonomy dial (autonomy.all_levels) — own try/except, never crash.
            try:
                if autonomy is None:
                    self._send(200, json.dumps({"error": "autonomy module unavailable",
                                                "detail": _MODULES_ERR, "levels": {}, "definitions": {}}))
                else:
                    self._send(200, json.dumps(autonomy.all_levels()))
            except Exception as e:
                self._send(200, json.dumps({"error": f"autonomy read failed: {type(e).__name__}",
                                            "levels": {}, "definitions": {}}))
        elif u.path == "/api/verify-queue":
            # the fast-verify gate queue (verify_queue.list_pending) — own try/except.
            try:
                if _vq is None:
                    self._send(200, json.dumps({"error": "verify_queue module unavailable",
                                                "detail": _MODULES_ERR, "pending": []}))
                else:
                    self._send(200, json.dumps({"pending": _vq.list_pending()}))
            except Exception as e:
                self._send(200, json.dumps({"error": f"verify-queue read failed: {type(e).__name__}",
                                            "pending": []}))
        elif u.path == "/api/health":
            # the health surface (health.health_check) — own try/except.
            try:
                if health is None:
                    self._send(200, json.dumps({"verdict": "DEGRADED", "checks": {},
                                                "summary": "health module unavailable", "detail": _MODULES_ERR}))
                else:
                    self._send(200, json.dumps(health.health_check()))
            except Exception as e:
                self._send(200, json.dumps({"verdict": "DEGRADED", "checks": {},
                                            "summary": f"health check failed: {type(e).__name__}"}))
        elif u.path == "/api/retention":
            # the metric-gated retention loop (retention.pending + history) — own try/except.
            try:
                if retention is None:
                    self._send(200, json.dumps({"error": "retention module unavailable",
                                                "detail": _MODULES_ERR, "pending": [], "history": []}))
                else:
                    self._send(200, json.dumps({"pending": retention.pending(),
                                                "history": retention.history(20)}))
            except Exception as e:
                self._send(200, json.dumps({"error": f"retention read failed: {type(e).__name__}",
                                            "pending": [], "history": []}))
        elif u.path == "/api/context":
            # the context-pressure policy surface (pressure + survival pins) — own try/except.
            try:
                if context_policy is None:
                    self._send(200, json.dumps({"error": "context_policy module unavailable",
                                                "detail": _MODULES_ERR, "pressure": {}, "survival": {}}))
                else:
                    self._send(200, json.dumps({"pressure": context_policy.pressure(),
                                                "survival": context_policy.survival_check(),
                                                "policy": context_policy.policy()}))
            except Exception as e:
                self._send(200, json.dumps({"error": f"context read failed: {type(e).__name__}",
                                            "pressure": {}, "survival": {}}))
        elif u.path == "/api/voice-speak-config":
            # the NEURAL TTS surface: engine + default voice + on-disk availability
            # (voice_neural.list_voices()). Own try/except, unavailable-degradation. Never crash.
            try:
                if voice_neural is None:
                    self._send(200, json.dumps({"ok": False, "error": "voice_neural module unavailable",
                                                "detail": _MODULES_ERR, "engine": "piper-tts",
                                                "available": False, "voices": []}))
                else:
                    self._send(200, json.dumps(voice_neural.list_voices()))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"voice-speak-config read failed: {type(e).__name__}",
                                            "available": False, "voices": []}))
        elif u.path.startswith("/tts-cache/"):
            # stream a previously-synthesized neural WAV from the cache. Path-traversal
            # guarded: basename only, must end .wav, must resolve inside CACHE_DIR. Never crash.
            try:
                if voice_neural is None:
                    self._send(404, json.dumps({"error": "voice_neural unavailable"}))
                else:
                    import os as _os
                    raw = u.path[len("/tts-cache/"):]
                    name = _os.path.basename(raw)  # strip any path components
                    if not name.endswith(".wav"):
                        self._send(404, json.dumps({"error": "not found"}))
                    else:
                        cache_dir = _os.path.realpath(voice_neural.CACHE_DIR)
                        fpath = _os.path.realpath(_os.path.join(cache_dir, name))
                        if not fpath.startswith(cache_dir + _os.sep) or not _os.path.isfile(fpath):
                            self._send(404, json.dumps({"error": "not found"}))
                        else:
                            with open(fpath, "rb") as _f:
                                self._send(200, _f.read(), ctype="audio/wav")
            except Exception as e:
                self._send(200, json.dumps({"error": f"tts-cache read failed: {type(e).__name__}"}))
        elif u.path == "/api/voice-config":
            # the local voice surface: TTS voices + STT model/device readiness (voice.voices())
            # — own try/except, unavailable-degradation pattern. Never crash.
            try:
                if voice is None:
                    self._send(200, json.dumps({"ok": False, "error": "voice module unavailable",
                                                "detail": _MODULES_ERR, "tts_voices": [],
                                                "stt_ready": False}))
                else:
                    self._send(200, json.dumps(voice.voices()))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"voice-config read failed: {type(e).__name__}",
                                            "tts_voices": [], "stt_ready": False}))
        elif u.path == "/api/tokens":
            # proof-of-work: live session usage + summary (tokens.live + summary).
            try:
                if _tokens is None:
                    self._send(200, json.dumps({"error": "tokens module unavailable",
                                                "detail": _MODULES_ERR, "live": {}, "summary": {}}))
                else:
                    self._send(200, json.dumps({"live": _tokens.live(), "summary": _tokens.summary()}))
            except Exception as e:
                self._send(200, json.dumps({"error": f"tokens read failed: {type(e).__name__}",
                                            "live": {}, "summary": {}}))
        elif u.path == "/api/tokens-sessions":
            # per-session proof-of-work breakdown.
            try:
                if _tokens is None:
                    self._send(200, json.dumps({"error": "tokens module unavailable", "sessions": []}))
                else:
                    limit = int((parse_qs(u.query).get("limit") or ["20"])[0])
                    self._send(200, json.dumps({"sessions": _tokens.sessions(limit)}))
            except Exception as e:
                self._send(200, json.dumps({"error": f"tokens-sessions failed: {type(e).__name__}",
                                            "sessions": []}))
        elif u.path == "/api/run":
            name = (parse_qs(u.query).get("action") or [""])[0]
            self._send(200, json.dumps(_run_action(name)))
        # ------------------------------------------------------------------
        # AGENT STATUS — /api/agents/status + /api/orchestrator
        # Returns the live agent-grid data from the demo channels.
        # ------------------------------------------------------------------
        elif u.path in ("/api/agents/status", "/api/orchestrator"):
            try:
                self._send(200, json.dumps({"status": "ok", "agents": _grid()["panes"]}))
            except Exception as e:
                self._send(200, json.dumps({"status": "error", "error": str(e), "agents": []}))
        # ------------------------------------------------------------------
        # PERSONAL-WORLD ENDPOINTS (provider modules in server/providers/).
        # All degrade to {error, empty list/shape} when backing file absent.
        # ------------------------------------------------------------------
        elif u.path == "/api/jobs":
            try:
                from providers import jobs as jobs_mod
                self._send(200, json.dumps(jobs_mod.read_jobs()))
            except ModuleNotFoundError:
                self._send(200, json.dumps({"jobs": [], "error": "providers/jobs.py not available"}))
            except Exception as e:
                self._send(200, json.dumps({"jobs": [], "error": str(e)}))
        elif u.path == "/api/applications":
            try:
                from providers import applications as apps_mod
                self._send(200, json.dumps(apps_mod.read_applications()))
            except ModuleNotFoundError:
                self._send(200, json.dumps({"applications": [], "error": "providers/applications.py not available"}))
            except Exception as e:
                self._send(200, json.dumps({"applications": [], "error": str(e)}))
        elif u.path == "/api/career":
            try:
                from providers import career as career_mod
                self._send(200, json.dumps(career_mod.read_career()))
            except ModuleNotFoundError:
                self._send(200, json.dumps({"error": "providers/career.py not available"}))
            except Exception as e:
                self._send(200, json.dumps({"error": str(e)}))
        elif u.path == "/api/inbox":
            try:
                from providers import inbox as inbox_mod
                self._send(200, json.dumps(inbox_mod.read_inbox()))
            except ModuleNotFoundError:
                self._send(200, json.dumps({"threads": [], "error": "providers/inbox.py not available"}))
            except Exception as e:
                self._send(200, json.dumps({"threads": [], "error": str(e)}))
        elif u.path == "/api/finance":
            try:
                from providers import finance as finance_mod
                self._send(200, json.dumps(finance_mod.read_finance()))
            except ModuleNotFoundError:
                self._send(200, json.dumps({"error": "providers/finance.py not available"}))
            except Exception as e:
                self._send(200, json.dumps({"error": str(e)}))
        elif u.path == "/api/memory-surface":
            try:
                from providers import memory_surface as mem_mod
                self._send(200, json.dumps(mem_mod.read_memory_surface()))
            except ModuleNotFoundError:
                self._send(200, json.dumps({"files": [], "error": "providers/memory_surface.py not available"}))
            except Exception as e:
                self._send(200, json.dumps({"files": [], "error": str(e)}))
        elif u.path == "/api/reports":
            try:
                from providers import reports as reports_mod
                self._send(200, json.dumps(reports_mod.read_reports()))
            except ModuleNotFoundError:
                self._send(200, json.dumps({"reports": [], "error": "providers/reports.py not available"}))
            except Exception as e:
                self._send(200, json.dumps({"reports": [], "error": str(e)}))
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/say":
            text = self._body().get("text", "")
            _append(CHAN, "user", text)
            # If a model is wired (config.json present + valid), answer for real
            # via the BYOM backend and append the reply to the channel. With no
            # model configured the channel simply records the user turn; the next
            # /api/state poll renders it. Fail-OPEN: a chat error never breaks the
            # POST — the user turn is already saved.
            reply_info = {"replied": False}
            try:
                if _chat is not None and text and text.strip():
                    status = _chat.is_configured()
                    if status.get("ok"):
                        r = _chat.reply(_turns(CHAN))
                        if r.get("ok") and r.get("text"):
                            _append(CHAN, "servari", r["text"])
                            reply_info = {"replied": True, "model": r.get("model", "")}
                        else:
                            reply_info = {"replied": False, "error": r.get("error", "")}
                    else:
                        reply_info = {"replied": False, "configured": False,
                                      "reason": status.get("reason", "")}
            except Exception as e:
                reply_info = {"replied": False, "error": f"{type(e).__name__}"}
            self._send(200, json.dumps({"ok": True, "byom": reply_info}))
        elif u.path == "/api/agent-say":
            name = (parse_qs(u.query).get("name") or [""])[0]
            p = _agent_channels().get(name)
            if not p:
                self._send(200, json.dumps({"ok": False, "error": "unknown agent"}))
            else:
                ok = _append(p, "user", "[direct message] " + self._body().get("text", ""))
                self._send(200, json.dumps({"ok": ok}))
        elif u.path == "/api/set-autonomy":
            # set an agent's autonomy level (autonomy.set_level) — own try/except, never crash.
            try:
                body = self._body()
                if autonomy is None:
                    self._send(200, json.dumps({"ok": False, "error": "autonomy module unavailable",
                                                "detail": _MODULES_ERR}))
                else:
                    self._send(200, json.dumps(autonomy.set_level(body.get("agent", ""),
                                                                  body.get("level", ""))))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"set-autonomy failed: {type(e).__name__}"}))
        elif u.path == "/api/verify-decision":
            # approve/reject a parked gated action (verify_queue.decide) — own try/except.
            try:
                body = self._body()
                if _vq is None:
                    self._send(200, json.dumps({"ok": False, "error": "verify_queue module unavailable",
                                                "detail": _MODULES_ERR}))
                else:
                    entry = _vq.decide(body.get("id", ""), body.get("decision", ""),
                                       body.get("note", ""))
                    self._send(200, json.dumps({"ok": bool(entry), "entry": entry}))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"verify-decision failed: {type(e).__name__}"}))
        elif u.path == "/api/retention-decide":
            # decide a pending retention run: KEEP or auto-REVERT (retention.decide) — own try/except.
            try:
                body = self._body()
                if retention is None:
                    self._send(200, json.dumps({"ok": False, "error": "retention module unavailable",
                                                "detail": _MODULES_ERR}))
                else:
                    self._send(200, json.dumps(retention.decide(body.get("run_id", ""))))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"retention-decide failed: {type(e).__name__}"}))
        elif u.path == "/api/tokens-report":
            # generate a proof-of-work report (per session / today / all) -> markdown file + content.
            try:
                body = self._body()
                if _tokens is None:
                    self._send(200, json.dumps({"ok": False, "error": "tokens module unavailable"}))
                else:
                    self._send(200, json.dumps(_tokens.report(scope=body.get("scope", "session"),
                                                              session_id=body.get("session_id"))))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"tokens-report failed: {type(e).__name__}"}))
        elif u.path == "/api/context-checkpoint":
            # write the swap-file checkpoint (context_policy.checkpoint) — own try/except.
            try:
                body = self._body()
                if context_policy is None:
                    self._send(200, json.dumps({"ok": False, "error": "context_policy module unavailable",
                                                "detail": _MODULES_ERR}))
                else:
                    self._send(200, json.dumps(context_policy.checkpoint(body.get("note", "via SERVARI shell"))))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"context-checkpoint failed: {type(e).__name__}"}))
        elif u.path == "/api/voice-debug":
            # voice diagnostics sink: the browser voice client POSTs one JSON event per moment
            # {event, detail, ts}; append it as a single JSON line so the shell can see what
            # happened (getUserMedia / VAD / amplitude / transcribe / TTS / stop).
            # Fail-OPEN: a logging failure must NEVER break the voice loop — always return ok.
            try:
                body = self._body()
                rec = {
                    "event": str(body.get("event", ""))[:120],
                    "detail": body.get("detail", ""),
                    "ts": body.get("ts") or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"),
                    "server_ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"),
                }
                log = DEMO / "_voice_debug.jsonl"
                log.parent.mkdir(parents=True, exist_ok=True)
                with log.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                self._send(200, json.dumps({"ok": True}))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"voice-debug failed: {type(e).__name__}"}))
        elif u.path == "/api/voice-transcribe":
            # local STT: read RAW audio bytes off the wire (NOT _body() — this is binary, not JSON),
            # transcribe via faster-whisper. language hint from ?language= (default 'en').
            # ?partial=1 skips brand-word corrections for interim speed.
            try:
                if voice is None:
                    self._send(200, json.dumps({"ok": False, "error": "voice module unavailable",
                                                "detail": _MODULES_ERR, "text": ""}))
                else:
                    n = int(self.headers.get("Content-Length", 0) or 0)
                    data = self.rfile.read(n) if n > 0 else b""
                    qs_params = parse_qs(u.query)
                    lang = (qs_params.get("language") or ["en"])[0] or "en"
                    is_partial = (qs_params.get("partial") or ["0"])[0] in ("1", "true", "yes")
                    self._send(200, json.dumps(voice.transcribe(data, language=lang, partial=is_partial)))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"voice-transcribe failed: {type(e).__name__}",
                                            "text": ""}))
        elif u.path == "/api/voice-speak":
            # local NEURAL TTS: {text[, voice]} -> synthesize a WAV -> return the WAV
            # BYTES directly (Content-Type audio/wav) so the browser plays real neural
            # audio. On any failure, return a JSON {ok:false} body instead. Never crash.
            try:
                if voice_neural is None:
                    self._send(200, json.dumps({"ok": False, "error": "voice_neural module unavailable",
                                                "detail": _MODULES_ERR}))
                else:
                    body = self._body()
                    text = (body.get("text") or "").strip()
                    vid = body.get("voice") or voice_neural.DEFAULT_VOICE
                    if not text:
                        self._send(200, json.dumps({"ok": False, "error": "empty_text"}))
                    else:
                        r = voice_neural.synthesize(text, voice=vid)
                        if r.get("ok") and r.get("audio_path"):
                            with open(r["audio_path"], "rb") as _f:
                                self._send(200, _f.read(), ctype="audio/wav")
                        else:
                            self._send(200, json.dumps(r))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"voice-speak failed: {type(e).__name__}"}))
        else:
            self._send(404, json.dumps({"error": "not found"}))


def main():
    import threading
    # Bind the port FIRST — the server is reachable within seconds of launch,
    # regardless of how long the ML voice imports take. Voice endpoints report
    # "unavailable" until the background loader finishes, then come live.
    server = ThreadingHTTPServer((HOST, PORT), H)
    print(f"SERVARI serving on http://{HOST}:{PORT}/  (home={ROOT})")
    # SERVARI_NO_VOICE=1 keeps the ML voice backends OFF entirely: under a degraded
    # OS state their native DLL loads can CRASH the process (not just hang) — a crash
    # in any thread kills the whole server. Voice endpoints degrade gracefully; flip
    # the env var off and restart to bring voice back when the machine is healthy.
    global _VOICE_LOAD_STATE
    if os.environ.get("SERVARI_NO_VOICE") == "1":
        _VOICE_LOAD_STATE = "disabled (SERVARI_NO_VOICE=1)"
    else:
        threading.Thread(target=_load_voice_backends, daemon=True, name="voice-loader").start()
    server.serve_forever()


if __name__ == "__main__":
    main()
