#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SERVARI server — the open agent-OS shell.

A small stdlib HTTP server that:
  - serves the built React (Vite) SPA from ui/dist/,
  - exposes a JSON API for the shell panels (channel, agents, gates, health,
    autonomy dial, retention, context, tokens, voice),
  - runs an ALLOW-LISTED action runner (NOT a raw shell - only the named local
    actions below can run),
  - degrades gracefully: any backing module that fails to import leaves its
    routes returning a clean "unavailable" payload instead of crashing the server.

All mutable product state is read from the local SERVARI data directory. Point
SERVARI_HOME at your own data dir to separate app state from the repo.

Run: python server/servari_server.py  ->  http://127.0.0.1:8911/
localhost only. Safe DOM in the SPA (no innerHTML). Stdlib. cp1252-safe.
"""
from __future__ import annotations
import json, os, sys, glob, subprocess, datetime, platform, shutil, tempfile, hashlib, socket
from typing import Optional
import threading, time
from collections import deque
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote
import xml.etree.ElementTree as ET

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
AGENTS_DIR = DEMO / "agents"                  # local agents/<name>/channel.jsonl
WORKFLOWS = DEMO / "agent-workflows.json"     # local agent workflow lanes
AGENT_REGISTRY = DEMO / "agents.json"         # local agent identity registry
RSS_FEEDS = DEMO / "rss-feeds.json"           # local datafeed subscriptions
CAREER_PROFILE = DEMO / "career.json"         # local CV Builder profile
JOBS_DATA = DEMO / "jobs.json"                # local CV Builder opportunities
APPLICATIONS_DATA = DEMO / "applications.json" # local CV Builder applications
TRADING_WORKBENCH = DEMO / "trading-workbench.json"
STANDING_ORDERS = DEMO / "standing-orders.json"
OBSIDIAN_VAULT = DEMO / "obsidian-vault"
CONFIG = ROOT / "config.json"                 # gitignored local model/runtime config
VALID_THEMES = {"default", "graphite", "ember"}

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


def _read_json_object(path: Path, default: Optional[dict] = None) -> dict:
    """Read a local JSON object. Missing/bad files return a copy of default."""
    base = dict(default or {})
    try:
        if not path.is_file():
            return base
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return base


def _write_json_object(path: Path, data: dict) -> None:
    """Atomic local JSON write inside the SERVARI data directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except Exception:
            pass


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _as_text(value: object, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _as_list_of_dicts(value: object, limit: int = 500) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value[:limit] if isinstance(item, dict)]


def _normalize_theme(raw: object) -> str:
    theme = str(raw or "default").strip().lower()
    return theme if theme in VALID_THEMES else "default"


# --- SERVARI local engine lifecycle (managed subprocess) ---------------------
_ENGINE_LOCK = threading.Lock()
_ENGINE_PROC: Optional[subprocess.Popen] = None
_ENGINE_STARTED_AT: Optional[str] = None
_ENGINE_CONFIG: Optional[dict[str, object]] = None
_ENGINE_LOG_BUFFER = deque(maxlen=500)


def _engine_default_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on", "enable", "enabled"}


def _engine_parse_port(raw: str, default: int) -> int:
    if not raw:
        return default
    try:
        p = int(raw.strip())
        if 1 <= p <= 65535:
            return p
    except Exception:
        pass
    return default


def _engine_default_home() -> str:
    """Resolve initial local-engine home.

    Resolve from SERVARI_ENGINE_HOME when present, otherwise scan likely local
    workspace locations and then return ROOT as a final fallback.
    """
    candidates: list[Path] = []
    raw = (os.environ.get("SERVARI_ENGINE_HOME", "") or "").strip()
    if raw:
        candidates.append(Path(raw))
    # Prefer the REAL executor engine (engine/app.py) so "Start" in the Runtime
    # panel launches the actual executor by default. Explicit posted home (used by
    # the tests) still overrides this via _engine_start's payload.get("home").
    candidates.extend(
        [
            ROOT / "engine",
            ROOT / "workspace",
            ROOT / "servari-engine",
            Path.cwd() / "engine",
            Path.cwd() / "workspace",
            Path.cwd() / "servari-engine",
        ]
    )

    for c in candidates:
        p = c.expanduser()
        if not p.is_absolute():
            p = p.resolve()
        if (p / "app.py").is_file():
            return str(p)
    return str(ROOT)


def _engine_default_config() -> dict[str, object]:
    return {
        "home": _engine_default_home(),
        "host": (os.environ.get("SERVARI_ENGINE_HOST", "") or "127.0.0.1").strip(),
        "port": _engine_parse_port((os.environ.get("SERVARI_ENGINE_PORT", "") or "").strip(), 7000),
        "python": (os.environ.get("SERVARI_ENGINE_PYTHON", "") or sys.executable),
        "auth_enabled": _engine_default_bool("SERVARI_ENGINE_AUTH_ENABLED", False),
    }


def _engine_append_log(line: str) -> None:
    if not line:
        return
    line = str(line).rstrip("\r\n")
    if not line:
        return
    with _ENGINE_LOCK:
        _ENGINE_LOG_BUFFER.append(f"{datetime.datetime.now().isoformat(timespec='seconds')} | {line}")


def _engine_tail_logs(lines: Optional[int]) -> list[str]:
    with _ENGINE_LOCK:
        if not _ENGINE_LOG_BUFFER:
            return []
        if lines is None or lines <= 0 or lines >= len(_ENGINE_LOG_BUFFER):
            return list(_ENGINE_LOG_BUFFER)
        return list(_ENGINE_LOG_BUFFER)[-lines:]


def _engine_log_reader(p: subprocess.Popen) -> None:
    stream = p.stdout
    if stream is None:
        return
    try:
        for raw in iter(stream.readline, ""):
            _engine_append_log(raw)
    except Exception:
        pass
    finally:
        _engine_append_log("[engine stdout reader ended]")


def _engine_resolve_home(raw: str) -> Path:
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    return p.resolve()


def _engine_status_probe(base_url: str, path: str) -> dict[str, object]:
    url = base_url.rstrip("/") + path
    start = time.perf_counter()
    try:
        with urlopen(url, timeout=1.5) as r:
            raw = r.read(64 * 1024)
            try:
                body = json.loads(raw.decode("utf-8", errors="replace"))
            except Exception:
                body = raw.decode("utf-8", errors="replace")
            return {
                "ok": True,
                "status_code": r.status,
                "url": url,
                "response_ms": round((time.perf_counter() - start) * 1000, 1),
                "body": body,
            }
    except HTTPError as e:
        try:
            detail = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            detail = ""
        return {
            "ok": False,
            "error": f"http {e.code}",
            "status_code": e.code,
            "url": url,
            "response_ms": round((time.perf_counter() - start) * 1000, 1),
            "detail": detail,
        }
    except URLError as e:
        return {
            "ok": False,
            "error": f"urlopen:{type(e).__name__}",
            "url": url,
            "response_ms": round((time.perf_counter() - start) * 1000, 1),
            "detail": str(e),
        }
    except Exception as e:
        return {
            "ok": False,
            "error": f"probe_failed:{type(e).__name__}",
            "url": url,
            "response_ms": round((time.perf_counter() - start) * 1000, 1),
            "detail": str(e),
        }


def _engine_base_url(cfg: dict[str, object]) -> str:
    host = str(cfg.get("host", "127.0.0.1"))
    try:
        port = int(cfg.get("port", 7000))
    except Exception:
        port = 7000
    return f"http://{host}:{port}"


def _engine_live_state() -> dict[str, object]:
    with _ENGINE_LOCK:
        proc = _ENGINE_PROC
        cfg = dict(_ENGINE_CONFIG or {})
        started_at = _ENGINE_STARTED_AT
    running = proc is not None and proc.poll() is None
    return {
        "running": bool(running),
        "managed": proc is not None,
        "pid": proc.pid if proc else None,
        "started_at": started_at,
        "config": cfg,
        "returncode": None if running else (proc.poll() if proc else None),
    }


def _engine_start(body: Optional[dict[str, object]] = None) -> dict[str, object]:
    global _ENGINE_PROC, _ENGINE_CONFIG, _ENGINE_STARTED_AT
    cfg = _engine_default_config()
    payload = dict(body or {})

    if payload.get("home"):
        cfg["home"] = str(_engine_resolve_home(str(payload.get("home"))))
    else:
        cfg["home"] = str(_engine_resolve_home(str(cfg["home"])))
    if payload.get("host"):
        cfg["host"] = str(payload.get("host", cfg["host"])).strip() or str(cfg["host"])
    if payload.get("python"):
        cfg["python"] = str(payload.get("python", cfg["python"])).strip() or str(cfg["python"])
    if "auth_enabled" in payload:
        cfg["auth_enabled"] = bool(payload.get("auth_enabled"))
    if payload.get("port") is not None:
        cfg["port"] = _engine_parse_port(str(payload.get("port", cfg["port"])), int(cfg["port"]))  # type: ignore[arg-type]

    home = Path(str(cfg["home"]))
    if not home.is_dir() or not (home / "app.py").is_file():
        return {
            "ok": False,
            "error": "engine_home_invalid",
            "message": f"No app.py found under {home}",
            "config": cfg,
            "status": _engine_live_state(),
        }

    # --- host validation: only loopback (stops binding the spawned engine to
    # 0.0.0.0 / a routable address, which would expose the executor on the LAN).
    host_only = str(cfg["host"]).strip()
    if host_only.startswith("[") and "]" in host_only:
        host_only = host_only[1 : host_only.index("]")]
    if host_only.lower() not in {"127.0.0.1", "localhost", "::1"}:
        return {
            "ok": False,
            "error": "engine_input_rejected",
            "message": f"engine host must be loopback (127.0.0.1/localhost/::1), got: {cfg['host']!r}",
            "config": cfg,
            "status": _engine_live_state(),
        }

    # --- python validation: this string is exec'd as the interpreter for the
    # spawned engine, so it is an RCE vector. Accept ONLY sys.executable, or a
    # real file whose name looks like a python interpreter. Reject arbitrary
    # binaries (calc.exe, powershell, a dropped payload, ...).
    py = str(cfg["python"]).strip() or sys.executable
    try:
        same_as_self = Path(py).resolve() == Path(sys.executable).resolve()
    except Exception:
        same_as_self = (py == sys.executable)
    if not same_as_self:
        py_path = Path(py)
        if not py_path.is_file():
            return {
                "ok": False,
                "error": "engine_input_rejected",
                "message": f"Configured Python executable not found: {py}",
                "config": cfg,
                "status": _engine_live_state(),
            }
        stem = py_path.stem.lower()  # filename without extension
        suffix = py_path.suffix.lower()
        allowed_stems = {"python", "python3", "py"}
        # also accept versioned names like python3.12 -> stem "python3.12"
        looks_python = (
            stem in allowed_stems
            or stem.startswith("python")
            or (stem == "py")
        )
        allowed_suffix = suffix in {"", ".exe"}
        if not (looks_python and allowed_suffix):
            return {
                "ok": False,
                "error": "engine_input_rejected",
                "message": (
                    f"refused non-python interpreter: {py!r} "
                    "(must be sys.executable or a python/python3/py binary)"
                ),
                "config": cfg,
                "status": _engine_live_state(),
            }
    cfg["python"] = py

    running_pid = None
    with _ENGINE_LOCK:
        if _ENGINE_PROC is not None and _ENGINE_PROC.poll() is None:
            running_pid = _ENGINE_PROC.pid
    if running_pid is not None:
        return {
            "ok": False,
            "error": "already_running",
            "message": f"Local engine already running (pid={running_pid})",
            "config": cfg,
            "status": _engine_live_state(),
        }

    env = os.environ.copy()
    env["APP_BIND"] = str(cfg["host"])
    env["APP_PORT"] = str(cfg["port"])
    env["AUTH_ENABLED"] = "true" if bool(cfg["auth_enabled"]) else "false"

    uvicorn_cmd = [py, "-m", "uvicorn", "app:app", "--host", str(cfg["host"]), "--port", str(cfg["port"])]
    cli_cmd = [py, "app.py", "--host", str(cfg["host"]), "--port", str(cfg["port"])]

    def _spawn(cmd: list[str], mode: str) -> Optional[subprocess.Popen]:
        _engine_append_log(
            f"launch attempt ({mode}): {' '.join(cmd)} in {home} (auth={env['AUTH_ENABLED']})"
        )
        return subprocess.Popen(
            cmd,
            cwd=str(home),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            text=True,
            bufsize=1,
        )

    proc: Optional[subprocess.Popen] = None
    launch_mode = "uvicorn"
    try:
        proc = _spawn(uvicorn_cmd, launch_mode)
    except Exception as e:
        proc = None
        _engine_append_log(f"uvicorn launch failed to spawn ({type(e).__name__}): {e}")

    if proc is None or proc.poll() is not None:
        if proc is not None and proc.poll() is not None:
            _engine_append_log(f"uvicorn exited quickly with code {proc.returncode}")
            try:
                proc.terminate()
            except Exception:
                pass
            try:
                with _ENGINE_LOCK:
                    if _ENGINE_PROC is proc:
                        _ENGINE_PROC = None
            except Exception:
                pass
        launch_mode = "cli"
        _engine_append_log("falling back to local app.py CLI")
        try:
            proc = _spawn(cli_cmd, launch_mode)
        except Exception as e:
            return {
                "ok": False,
                "error": "spawn_failed",
                "message": f"uvicorn unavailable and CLI fallback failed: {e}",
                "config": cfg,
                "status": _engine_live_state(),
            }

    if proc is None:
        return {
            "ok": False,
            "error": "spawn_failed",
            "message": "engine launch produced no process",
            "config": cfg,
            "status": _engine_live_state(),
        }

    threading.Thread(target=_engine_log_reader, args=(proc,), daemon=True).start()

    time.sleep(0.15)
    if proc.poll() is not None:
        with _ENGINE_LOCK:
            _ENGINE_PROC = None
            _ENGINE_CONFIG = None
            _ENGINE_STARTED_AT = None
        return {
            "ok": False,
            "error": "process_exit",
            "message": f"engine process exited immediately (mode={launch_mode}, code={proc.returncode})",
            "config": cfg,
            "status": _engine_live_state(),
        }

    with _ENGINE_LOCK:
        _ENGINE_PROC = proc
        _ENGINE_STARTED_AT = datetime.datetime.now(datetime.timezone.utc).isoformat()
        _ENGINE_CONFIG = cfg

    time.sleep(0.1)
    _engine_append_log(f"started: pid={proc.pid}")
    status = _engine_live_state()
    base = _engine_base_url(cfg)
    status["probe_health"] = _engine_status_probe(base, "/api/health")
    status["probe_ready"] = _engine_status_probe(base, "/api/ready")
    return {"ok": True, "message": "Local engine launch initiated", "status": status, "config": cfg}


def _engine_stop() -> dict[str, object]:
    global _ENGINE_PROC, _ENGINE_CONFIG, _ENGINE_STARTED_AT
    with _ENGINE_LOCK:
        proc = _ENGINE_PROC

    if proc is None:
        return {"ok": False, "error": "not_running", "status": _engine_live_state()}

    if proc.poll() is not None:
        with _ENGINE_LOCK:
            _ENGINE_PROC = None
            _ENGINE_CONFIG = None
            _ENGINE_STARTED_AT = None
        return {"ok": False, "error": "not_running", "status": _engine_live_state()}

    _engine_append_log(f"stopping pid={proc.pid}")
    try:
        proc.terminate()
    except Exception as e:
        return {"ok": False, "error": "terminate_failed", "message": str(e), "status": _engine_live_state()}

    try:
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            return {
                "ok": False,
                "error": "kill_failed",
                "status": _engine_live_state(),
            }

    with _ENGINE_LOCK:
        rc = proc.returncode
        _ENGINE_PROC = None
        _ENGINE_CONFIG = None
        _ENGINE_STARTED_AT = None
    _engine_append_log(f"stopped pid={proc.pid} rc={rc}")
    return {"ok": True, "message": f"stopped pid={proc.pid}", "status": _engine_live_state()}


def _engine_restart(body: Optional[dict[str, object]] = None) -> dict[str, object]:
    stop = _engine_stop()
    if stop.get("ok") is False and stop.get("error") not in ("not_running",):
        return stop
    return _engine_start(body)

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
# This is NOT a raw shell. Only named local operations in ACTIONS can run.
# Keep actions read-only or bounded, and surface what they inspected.
def _act_workspace_health():
    registry = _agent_registry()
    agents = registry.get("agents", []) if isinstance(registry.get("agents"), list) else []
    channels = _agent_channels()
    missing_start = []
    missing_channel = []
    for raw in agents:
        if not isinstance(raw, dict):
            continue
        channel = str(raw.get("channel") or raw.get("id") or "").strip()
        if not channel:
            continue
        if channel not in channels:
            missing_channel.append(channel)
        elif not (channels[channel].parent / "START.md").is_file():
            missing_start.append(channel)
    stores = _local_stores().get("stores", [])
    out = [
        f"home: {ROOT}",
        f"agents registered: {len(agents)}",
        f"agent channels: {len(channels)}",
        f"local stores indexed: {len(stores)}",
        f"missing START.md: {len(missing_start)}",
        f"missing channel: {len(missing_channel)}",
    ]
    if missing_start:
        out.append("missing START.md ids: " + ", ".join(missing_start[:20]))
    if missing_channel:
        out.append("missing channel ids: " + ", ".join(missing_channel[:20]))
    return {"ok": not missing_channel, "out": "\n".join(out)}


def _act_agent_registry_audit():
    amap = _agent_map()
    node_ids = {str(node.get("id")) for node in amap.get("agents", []) if isinstance(node, dict)}
    bad_edges = [
        edge for edge in amap.get("edges", [])
        if isinstance(edge, dict) and (edge.get("source") not in node_ids or edge.get("target") not in node_ids)
    ]
    groups = amap.get("groups", [])
    out = [
        f"nodes: {len(node_ids)}",
        f"edges: {len(amap.get('edges', []))}",
        f"groups: {len(groups)}",
        f"bad edges: {len(bad_edges)}",
    ]
    if bad_edges:
        out.append(json.dumps(bad_edges[:8], ensure_ascii=False))
    return {"ok": not bad_edges, "out": "\n".join(out)}


def _act_model_gateway_status():
    status = _model_backend_status()
    gateways = _gateways_status()
    lines = [
        f"selected backend: {status.get('selected_backend')}",
        f"effective backend: {status.get('effective_backend')}",
        f"ready: {status.get('ready')}",
        f"api configured: {bool((status.get('api') or {}).get('ok')) if isinstance(status.get('api'), dict) else False}",
        f"gateways live: {gateways.get('running')}/{len(gateways.get('gateways', []))}",
    ]
    for item in gateways.get("gateways", []):
        if isinstance(item, dict):
            lines.append(f"- {item.get('id')}: installed={item.get('installed')} running={item.get('running')} pid={item.get('pid')}")
    ok = bool(status.get("ready")) or bool(gateways.get("running"))
    return {"ok": ok, "out": "\n".join(lines), "model_backend": status, "gateways": gateways}


def _act_refresh_rss():
    _RSS_CACHE["payload"] = None
    _RSS_CACHE["ts"] = 0.0
    feeds = _rss_datafeeds()
    lines = [
        f"items: {len(feeds.get('items', []))}",
        f"feeds: {len(feeds.get('feeds', []))}",
        f"errors: {len(feeds.get('errors', []))}",
        f"last_sync: {feeds.get('last_sync', '')}",
    ]
    for item in feeds.get("items", [])[:8]:
        if isinstance(item, dict):
            lines.append(f"- {item.get('source')}: {item.get('title')}")
    return {"ok": True, "out": "\n".join(lines), "feeds": feeds}


def _act_disk_free():
    try:
        total, used, free = shutil.disk_usage(str(ROOT))
        gb = 1024 ** 3
        return {"ok": True, "out": f"disk free: {free/gb:.1f} GB of {total/gb:.1f} GB (home={ROOT})"}
    except Exception as e:
        return {"ok": False, "out": f"error: {e}"}


def _act_python_version():
    return {"ok": True, "out": f"Python {platform.python_version()} on {platform.system()} {platform.release()}"}


def _act_public_verification():
    script = ROOT / "scripts" / "verify_all.py"
    if not script.is_file():
        return {"ok": False, "out": "scripts/verify_all.py not found"}
    try:
        proc = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(ROOT),
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=180,
        )
        return {"ok": proc.returncode == 0, "exit": proc.returncode, "out": (proc.stdout or "")[-12000:]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "out": "public verification timed out after 180s"}
    except Exception as e:
        return {"ok": False, "out": f"verification failed: {type(e).__name__}: {e}"}


ACTIONS = {
    "agent-registry-audit": _act_agent_registry_audit,
    "disk-free": _act_disk_free,
    "model-gateway-status": _act_model_gateway_status,
    "python-version": _act_python_version,
    "public-verification": _act_public_verification,
    "rss-refresh": _act_refresh_rss,
    "workspace-health": _act_workspace_health,
}

ACTION_META = {
    "agent-registry-audit": {
        "title": "Agent Registry Audit",
        "purpose": "Verify graph edges, profile ids, and local agent registry consistency.",
        "owner": "Staff Architect",
        "gate": "read-only local audit",
    },
    "disk-free": {
        "title": "Disk Capacity Check",
        "purpose": "Check available storage for local models, voice caches, builds, and exports.",
        "owner": "Runtime Watch",
        "gate": "read-only filesystem stat",
    },
    "model-gateway-status": {
        "title": "Model And Gateway Status",
        "purpose": "Inspect selected backend, CLI availability, and Hermes/OpenClaw gateway reachability.",
        "owner": "Runtime Watch",
        "gate": "read-only readiness probes",
    },
    "python-version": {
        "title": "Python Runtime Check",
        "purpose": "Confirm the Python interpreter used by SERVARI server-side tools.",
        "owner": "Runtime Watch",
        "gate": "read-only runtime introspection",
    },
    "public-verification": {
        "title": "Run Public Verification",
        "purpose": "Execute SERVARI's bundled regression harness and print the report tail.",
        "owner": "QA Security Sentinel",
        "gate": "bounded local verification script",
    },
    "rss-refresh": {
        "title": "Refresh RSS Datafeeds",
        "purpose": "Clear the RSS cache and fetch the current dashboard signal feeds.",
        "owner": "Communications Agent",
        "gate": "network read only",
    },
    "workspace-health": {
        "title": "Workspace Health Snapshot",
        "purpose": "Summarize registered agents, channels, START.md files, and local stores.",
        "owner": "Chief of Staff",
        "gate": "read-only local audit",
    },
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


def _state_channels():
    """Channel summary map for /api/state, derived from registry + live files."""
    hubch = _hub().get("channels", {})
    if not isinstance(hubch, dict):
        hubch = {}
    channels = {}
    registry = _agent_registry()
    agents = registry.get("agents", [])
    if not isinstance(agents, list):
        agents = []
    disk_channels = _agent_channels()

    seen = set()
    for raw in agents:
        if not isinstance(raw, dict):
            continue
        channel = str(raw.get("channel") or raw.get("id") or "").strip()
        if not channel:
            continue
        turns = _turns(disk_channels.get(channel))
        summary = dict((hubch.get(channel, {}) or {}) if isinstance(hubch.get(channel, {}), dict) else {})
        summary["turns"] = len(turns)
        summary.setdefault("owes", "")
        channels[channel] = summary
        seen.add(channel)

    for channel, path in sorted(disk_channels.items()):
        if channel in seen:
            continue
        turns = _turns(path)
        summary = dict((hubch.get(channel, {}) or {}) if isinstance(hubch.get(channel, {}), dict) else {})
        summary["turns"] = len(turns)
        summary.setdefault("owes", "")
        channels[channel] = summary

    if channels:
        return channels
    return hubch


def _agent_registry():
    """Read demo-data/agents.json. Identity metadata only; channels stay live source."""
    if not AGENT_REGISTRY.is_file():
        return {"agents": [], "groups": [], "workflows": []}
    try:
        data = json.loads(AGENT_REGISTRY.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else {"agents": [], "groups": [], "workflows": []}
    except Exception:
        return {"agents": [], "groups": [], "workflows": []}


def _agent_status_from_turns(agent_id: str, meta: dict, turns: list[dict], channel_exists: bool):
    """Map file-backed channel turns to the UI's AgentStatusCell contract."""
    current_task = ""
    latest_reply = ""
    latest_reply_ts = None
    latest_reply_status = ""
    latest_reply_error = False

    for t in reversed(turns or []):
        who = str((t or {}).get("from", "")).lower()
        text = str((t or {}).get("text", "")).strip()
        if not current_task and who in ("user", "operator") and text:
            current_task = text
        if not latest_reply and who not in ("user", "operator") and text:
            latest_reply = text
            latest_reply_ts = (t or {}).get("ts")
            latest_reply_status = str((t or {}).get("status", "")).lower()
            latest_reply_error = bool((t or {}).get("error"))
        if current_task and latest_reply:
            break

    pane = _pane_meta(turns)
    status = "not_started"
    if channel_exists:
        status = pane.get("status", "idle") or "idle"
        marker = latest_reply.upper()
        if latest_reply_error:
            status = "error"
        elif latest_reply_status in ("done", "blocked", "error"):
            status = latest_reply_status
        elif "[[DONE]]" in marker:
            status = "done"
        elif "[[BLOCKED]]" in marker:
            status = "blocked"
        elif status == "active":
            status = "live"
        elif turns:
            status = "working" if status != "idle" else "idle"

    name = str(meta.get("name") or agent_id)
    role = str(meta.get("role") or "").strip()
    display = f"{name} ({agent_id})" if role else name
    return {
        "id": agent_id,
        "display_name": display,
        "status": status,
        "current_task": current_task,
        "latest_reply": latest_reply,
        "latest_reply_ts": latest_reply_ts,
        "channel_exists": bool(channel_exists),
        "role": role,
        "group": meta.get("group", ""),
        "workflow": meta.get("workflow", ""),
        "turns": len(turns or []),
    }


def _agents_status():
    registry = _agent_registry()
    channels = _agent_channels()
    agents = registry.get("agents", [])
    if not isinstance(agents, list):
        agents = []

    seen = set()
    rows = []
    for raw in agents:
        if not isinstance(raw, dict):
            continue
        agent_id = str(raw.get("id") or raw.get("channel") or "").strip()
        if not agent_id:
            continue
        channel_name = str(raw.get("channel") or agent_id)
        path = channels.get(channel_name)
        turns = _turns(path) if path else []
        rows.append(_agent_status_from_turns(agent_id, raw, turns, path is not None))
        seen.add(channel_name)

    for channel_name, path in sorted(channels.items()):
        if channel_name in seen:
            continue
        turns = _turns(path)
        rows.append(_agent_status_from_turns(channel_name, {"name": channel_name}, turns, True))

    return {"status": "ok", "agents": rows, "groups": registry.get("groups", [])}


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


def _append_error(p: Path, text: str):
    """Append a SERVARI turn flagged as an error so the chat UI renders it
    visibly distinct (amber). Same shape as _append + 'error': True. Keeps the
    'from' as 'servari' so BYOM role-mapping treats it as an assistant turn."""
    text = (text or "").strip()
    if not text:
        return False
    turns = _turns(p)
    turn = {"turn": len(turns) + 1, "from": "servari", "text": text, "error": True,
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
        _record_standing_order_run(name, result)
        return result
    except Exception as e:
        return {"ok": False, "action": name, "out": f"error: {e}"}


def _standing_orders() -> dict:
    """Return allow-listed standing orders with editable local metadata."""
    stored = _read_json_object(STANDING_ORDERS, {"orders": []})
    stored_rows = stored.get("orders", []) if isinstance(stored.get("orders"), list) else []
    by_id = {str(row.get("id")): row for row in stored_rows if isinstance(row, dict) and row.get("id")}
    orders = []
    for action in sorted(ACTIONS):
        meta = dict(ACTION_META.get(action, {}))
        custom = by_id.get(action, {})
        row = {
            "id": action,
            "action": action,
            "title": custom.get("title") or meta.get("title") or action.replace("-", " ").title(),
            "purpose": custom.get("purpose") or meta.get("purpose") or "Local allow-listed SERVARI operation.",
            "owner": custom.get("owner") or meta.get("owner") or "Operator",
            "trigger": custom.get("trigger") or "manual",
            "gate": custom.get("gate") or meta.get("gate") or "allow-listed action",
            "enabled": custom.get("enabled", True) is not False,
            "last_run": custom.get("last_run") or "",
            "last_ok": custom.get("last_ok") if "last_ok" in custom else None,
        }
        orders.append(row)
    return {"ok": True, "actions": sorted(ACTIONS), "orders": orders, "source": str(STANDING_ORDERS)}


def _record_standing_order_run(action: str, result: dict) -> None:
    try:
        current = _standing_orders()
        rows = current.get("orders", [])
        for row in rows:
            if isinstance(row, dict) and row.get("id") == action:
                row["last_run"] = _utc_now()
                row["last_ok"] = bool(result.get("ok"))
        _write_json_object(STANDING_ORDERS, {"orders": rows, "updated_at": _utc_now()})
    except Exception:
        pass


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


def _agent_workflows():
    """Local workflow lanes for the agent workspace. Pure demo-data; fail-safe."""
    if not WORKFLOWS.is_file():
        return {"workflows": [], "note": "demo-data/agent-workflows.json not present."}
    try:
        data = json.loads(WORKFLOWS.read_text(encoding="utf-8", errors="replace"))
        workflows = data.get("workflows", [])
        if not isinstance(workflows, list):
            workflows = []
        return {"workflows": workflows, "source": "demo-data/agent-workflows.json"}
    except Exception as e:
        return {"workflows": [], "note": f"agent workflow registry unreadable: {e}"}


MODEL_BACKENDS = ("auto", "api", "codex", "claude", "hermes", "openclaw")
CLI_BACKENDS = ("codex", "claude", "hermes", "openclaw")
CLI_LABELS = {
    "codex": "OpenAI Codex CLI",
    "claude": "Claude CLI",
    "hermes": "Hermes CLI",
    "openclaw": "OpenClaw CLI",
}
CLI_DEFAULT_BINARIES = {
    "codex": "codex",
    "claude": "claude",
    "hermes": "hermes",
    "openclaw": "openclaw",
}
CLI_DEFAULT_ONESHOT_ARGS = {
    "hermes": ["--oneshot", "{prompt}"],
    "openclaw": ["agent", "--local", "--json", "--agent", "main", "--message", "{prompt}"],
}
_RSS_CACHE: dict[str, object] = {"ts": 0.0, "payload": None}
_GATEWAY_LOCK = threading.Lock()
_GATEWAY_PROCS: dict[str, subprocess.Popen] = {}


GATEWAY_CONFIG = {
    "hermes": {
        "label": "Hermes Gateway",
        "binary": "hermes",
        "run": ["gateway", "run", "--accept-hooks"],
        "status": ["gateway", "status"],
        "stop": ["gateway", "stop"],
        "port": None,
    },
    "openclaw": {
        "label": "OpenClaw Gateway",
        "binary": "openclaw",
        "run": ["gateway", "run", "--bind", "loopback", "--auth", "none", "--port", "18789", "--force"],
        "status": ["gateway", "status", "--json", "--timeout", "5000"],
        "stop": ["gateway", "stop"],
        "port": 18789,
    },
}


def _config_load() -> dict:
    try:
        if not CONFIG.is_file():
            return {}
        data = json.loads(CONFIG.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _config_write(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="config.", suffix=".tmp", dir=str(CONFIG.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
        os.replace(tmp, CONFIG)
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except Exception:
            pass


def _safe_cfg(cfg: dict) -> dict:
    out = {}
    for key in ("provider", "base_url", "model", "backend", "workspace_home", "api_key_env", "theme"):
        if key in cfg:
            out[key] = _normalize_theme(cfg.get(key)) if key == "theme" else cfg.get(key)
    cli = cfg.get("cli")
    if isinstance(cli, dict):
        safe_cli = {}
        for name, raw in cli.items():
            if not isinstance(raw, dict):
                continue
            safe_cli[name] = {
                "enabled": bool(raw.get("enabled", True)),
                "binary": str(raw.get("binary") or CLI_DEFAULT_BINARIES.get(str(name), str(name))),
            }
            if isinstance(raw.get("one_shot_args"), list) and str(name) in ("hermes", "openclaw"):
                safe_cli[name]["one_shot_args"] = [str(item) for item in raw.get("one_shot_args", [])]
                safe_cli[name]["custom_one_shot"] = True
        out["cli"] = safe_cli
    out["config_exists"] = CONFIG.is_file()
    out["has_key"] = bool((cfg.get("api_key") or "").strip())
    out["key_source"] = "config.json" if out["has_key"] else ""
    env_name = str(cfg.get("api_key_env") or "").strip()
    if env_name and os.environ.get(env_name, "").strip():
        out["has_key"] = True
        out["key_source"] = f"env:{env_name}"
    return out


def _api_status() -> dict:
    if _chat is None:
        return {"ok": False, "reason": "chat backend unavailable", "detail": _MODULES_ERR}
    try:
        return _chat.is_configured()
    except Exception as e:
        return {"ok": False, "reason": f"api status failed: {type(e).__name__}"}


def _cli_cfg(cfg: dict, backend: str) -> dict:
    raw_cli = cfg.get("cli") if isinstance(cfg.get("cli"), dict) else {}
    raw = raw_cli.get(backend) if isinstance(raw_cli.get(backend), dict) else {}
    custom_args = raw.get("one_shot_args") if isinstance(raw.get("one_shot_args"), list) else None
    return {
        "enabled": bool(raw.get("enabled", True)),
        "binary": str(raw.get("binary") or CLI_DEFAULT_BINARIES.get(backend, backend)),
        "one_shot_args": custom_args if custom_args else CLI_DEFAULT_ONESHOT_ARGS.get(backend),
        "custom_one_shot": bool(custom_args),
    }


def _which_cli_binary(binary: str) -> Optional[str]:
    path = shutil.which(binary)
    if path:
        return path
    if platform.system().lower() == "windows":
        appdata = os.environ.get("APPDATA", "")
        localappdata = os.environ.get("LOCALAPPDATA", "")
        candidates = [
            Path(appdata) / "npm" / f"{binary}.cmd",
            Path(appdata) / "npm" / binary,
            Path(localappdata) / "hermes" / "hermes-agent" / "venv" / "Scripts" / f"{binary}.exe",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
    return None


def _cli_status(cfg: dict, backend: str) -> dict:
    ccfg = _cli_cfg(cfg, backend)
    binary = ccfg["binary"]
    path = _which_cli_binary(binary)
    enabled = bool(ccfg.get("enabled"))
    has_runner = backend in ("codex", "claude") or bool(ccfg.get("one_shot_args"))
    available = bool(path) and enabled
    return {
        "id": backend,
        "label": CLI_LABELS.get(backend, backend),
        "enabled": enabled,
        "binary": binary,
        "available": available,
        "path": path,
        "runnable": available and has_runner,
        "custom_one_shot": bool(ccfg.get("custom_one_shot")),
    }


def _workspace_home_from_config(cfg: dict) -> Path:
    raw = str(
        os.environ.get("SERVARI_WORKSPACE_HOME")
        or os.environ.get("SERVARI_HARNESS_HOME")
        or cfg.get("workspace_home")
        or cfg.get("harness_home")
        or ""
    ).strip()
    if raw:
        p = Path(raw).expanduser()
        if p.is_dir():
            return p.resolve()
    return ROOT


def _select_backend(cfg: dict, api_status: dict, cli: dict[str, dict]) -> str:
    selected = str(cfg.get("backend") or "auto").strip().lower()
    if selected not in MODEL_BACKENDS:
        selected = "auto"
    if selected != "auto":
        if selected == "api":
            return "api" if api_status.get("ok") else "none"
        if selected in CLI_BACKENDS:
            return selected if cli.get(selected, {}).get("runnable") else "none"
        return "none"
    if api_status.get("ok"):
        return "api"
    for name in ("claude", "codex", "hermes", "openclaw"):
        if cli.get(name, {}).get("runnable"):
            return name
    return "none"


def _model_backend_status() -> dict:
    cfg = _config_load()
    api = _api_status()
    cli = {name: _cli_status(cfg, name) for name in CLI_BACKENDS}
    effective = _select_backend(cfg, api, cli)
    selected = str(cfg.get("backend") or "auto").strip().lower()
    if selected not in MODEL_BACKENDS:
        selected = "auto"
    providers = [
        {"id": "auto", "label": "Auto", "available": api.get("ok") or any(c.get("runnable") for c in cli.values()),
         "runnable": True},
        {"id": "api", "label": "OpenAI-compatible API", "available": bool(api.get("ok")),
         "runnable": bool(api.get("ok")), "status": api},
    ] + [cli[name] for name in CLI_BACKENDS]
    safe = _safe_cfg(cfg)
    safe.setdefault("backend", selected)
    safe.setdefault("provider", "openai-compatible")
    safe.setdefault("base_url", "")
    safe.setdefault("model", "")
    safe.setdefault("workspace_home", str(ROOT))
    safe["theme"] = _normalize_theme(safe.get("theme", "default"))
    selected_ready = effective != "none"
    return {
        "ok": True,
        "config": safe,
        "selected_backend": selected,
        "effective_backend": effective,
        "ready": selected_ready,
        "selected_ready": selected_ready,
        "readiness_reason": "" if selected_ready else "No selected backend can currently produce replies. Configure API credentials/model or choose an installed CLI provider.",
        "api": api,
        "cli": cli,
        "providers": providers,
        "workspace_home": str(_workspace_home_from_config(cfg)),
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }


def _save_model_backend(body: dict) -> dict:
    if not isinstance(body, dict):
        return {"ok": False, "error": "invalid_body"}
    if "api_key" in body:
        return {"ok": False, "error": "api_key is write-only; use /api/settings/model-backend/secret"}
    cfg = _config_load()
    for key in ("provider", "base_url", "model", "api_key_env", "workspace_home"):
        if key in body:
            cfg[key] = str(body.get(key) or "").strip()
    if "theme" in body:
        cfg["theme"] = _normalize_theme(body.get("theme"))
    if "backend" in body:
        backend = str(body.get("backend") or "auto").strip().lower()
        if backend not in MODEL_BACKENDS:
            return {"ok": False, "error": "unknown_backend", "allowed": list(MODEL_BACKENDS)}
        cfg["backend"] = backend
    if isinstance(body.get("cli"), dict):
        cfg_cli = cfg.get("cli") if isinstance(cfg.get("cli"), dict) else {}
        for name in CLI_BACKENDS:
            raw = body["cli"].get(name)
            if not isinstance(raw, dict):
                continue
            next_raw = cfg_cli.get(name) if isinstance(cfg_cli.get(name), dict) else {}
            if "enabled" in raw:
                next_raw["enabled"] = bool(raw.get("enabled"))
            if "binary" in raw:
                next_raw["binary"] = str(raw.get("binary") or CLI_DEFAULT_BINARIES[name]).strip()
            if "one_shot_args" in raw and name in ("hermes", "openclaw"):
                args = raw.get("one_shot_args")
                if isinstance(args, list):
                    next_raw["one_shot_args"] = [str(item) for item in args if str(item).strip()]
                else:
                    next_raw.pop("one_shot_args", None)
            cfg_cli[name] = next_raw
        cfg["cli"] = cfg_cli
    _config_write(cfg)
    out = _model_backend_status()
    out["saved"] = True
    return out


def _save_model_secret(body: dict) -> dict:
    if not isinstance(body, dict):
        return {"ok": False, "error": "invalid_body"}
    action = str(body.get("action") or "").strip().lower()
    cfg = _config_load()
    if action == "clear":
        cfg.pop("api_key", None)
    elif action == "set":
        key = str(body.get("api_key") or "").strip()
        if not key:
            return {"ok": False, "error": "empty_api_key"}
        cfg["api_key"] = key
    else:
        return {"ok": False, "error": "unknown_action"}
    _config_write(cfg)
    safe = _safe_cfg(cfg)
    return {"ok": True, "has_key": safe.get("has_key", False), "key_source": safe.get("key_source", "")}


def _conversation_prompt(history: list[dict], system: str = "") -> str:
    lines = [
        "You are SERVARI inside the SERVARI desktop app.",
        "Answer the operator plainly and concisely.",
        "Do not edit files, run shell commands, deploy, spend, publish, or send external messages.",
        "If an action is needed, describe the next step and the safety gate.",
    ]
    if system.strip():
        lines.extend(["", "Active profile:", system.strip()[:6000]])
    lines.extend(["", "Conversation:"])
    for turn in (history or [])[-12:]:
        who = str((turn or {}).get("from", "operator")).strip() or "operator"
        text = str((turn or {}).get("text", "")).strip()
        if text:
            lines.append(f"{who}: {text}")
    lines.append("servari:")
    return "\n".join(lines)


def _extract_cli_reply_text(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    try:
        data = json.loads(text)
    except Exception:
        return text

    def walk(value):
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, dict):
            for key in ("text", "reply", "response", "message", "content", "output", "final", "result"):
                found = walk(value.get(key))
                if found:
                    return found
            for item in value.values():
                found = walk(item)
                if found:
                    return found
        if isinstance(value, list):
            for item in value:
                found = walk(item)
                if found:
                    return found
        return ""

    return walk(data) or text


def _run_cli_reply(backend: str, history: list[dict], system: str = "") -> dict:
    cfg = _config_load()
    status = _cli_status(cfg, backend)
    if not status.get("available"):
        return {"ok": False, "model": backend, "text": "", "error": f"{backend} CLI is not available on PATH"}
    if not status.get("runnable"):
        return {
            "ok": False,
            "model": backend,
            "text": "",
            "error": f"{backend} is detected but no one-shot command is configured",
        }
    binary = str(status.get("path") or status.get("binary"))
    workspace = _workspace_home_from_config(cfg)
    prompt = _conversation_prompt(history, system=system)
    out_path = None
    try:
        if backend == "codex":
            fd, out_path = tempfile.mkstemp(prefix="servari-codex-", suffix=".txt")
            os.close(fd)
            cmd = [
                binary,
                "exec",
                "--cd", str(workspace),
                "--sandbox", "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color", "never",
                "--output-last-message", out_path,
                prompt,
            ]
        elif backend == "claude":
            cmd = [binary, "-p", prompt]
        else:
            ccfg = _cli_cfg(cfg, backend)
            args = []
            for arg in ccfg.get("one_shot_args") or []:
                args.append(str(arg).replace("{prompt}", prompt))
            if not args:
                return {"ok": False, "model": backend, "text": "", "error": f"{backend} one-shot args missing"}
            cmd = [binary] + args
        proc = subprocess.run(
            cmd,
            cwd=str(workspace),
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
        text = ""
        if out_path and Path(out_path).is_file():
            text = Path(out_path).read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            text = _extract_cli_reply_text(proc.stdout or "")
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or f"{backend} exited {proc.returncode}")[:800]
            return {"ok": False, "model": backend, "text": "", "error": err}
        if not text:
            return {"ok": False, "model": backend, "text": "", "error": f"{backend} returned no text"}
        return {"ok": True, "model": backend, "text": text, "error": None}
    except subprocess.TimeoutExpired:
        return {"ok": False, "model": backend, "text": "", "error": f"{backend} timed out"}
    except Exception as e:
        return {"ok": False, "model": backend, "text": "", "error": f"{backend} failed: {type(e).__name__}"}
    finally:
        if out_path:
            try:
                os.unlink(out_path)
            except Exception:
                pass


def _reply_via_selected_backend(history: list[dict], system: str = "") -> dict:
    status = _model_backend_status()
    backend = str(status.get("effective_backend") or "api")
    if backend == "none":
        return {"ok": False, "model": "none", "text": "", "error": status.get("readiness_reason", "no model backend is ready")}
    if backend == "api":
        if _chat is None:
            return {"ok": False, "model": "api", "text": "", "error": "chat backend unavailable"}
        return _chat.reply(history, system=system or None)
    if backend in CLI_BACKENDS:
        return _run_cli_reply(backend, history, system=system)
    return {"ok": False, "model": backend, "text": "", "error": f"unsupported backend: {backend}"}


def _gateway_log_dir() -> Path:
    p = ROOT / "logs" / "gateways"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _gateway_cli_path(name: str) -> Optional[str]:
    cfg = GATEWAY_CONFIG.get(name) or {}
    return _which_cli_binary(str(cfg.get("binary") or name))


def _gateway_proc_state(name: str) -> dict:
    with _GATEWAY_LOCK:
        proc = _GATEWAY_PROCS.get(name)
    if proc is None:
        return {"managed": False, "running": False, "pid": None, "returncode": None}
    rc = proc.poll()
    return {"managed": True, "running": rc is None, "pid": proc.pid, "returncode": rc}


def _tcp_port_open(port: object, host: str = "127.0.0.1", timeout: float = 0.25) -> bool:
    try:
        p = int(port)
        if p < 1 or p > 65535:
            return False
        with socket.create_connection((host, p), timeout=timeout):
            return True
    except Exception:
        return False


def _gateway_run_status(name: str, timeout: int = 12) -> dict:
    cfg = GATEWAY_CONFIG.get(name)
    binary = _gateway_cli_path(name)
    if not cfg:
        return {"ok": False, "error": "unknown_gateway"}
    if not binary:
        return {"ok": False, "error": f"{name} CLI not found"}
    try:
        proc = subprocess.run(
            [binary] + list(cfg["status"]),
            cwd=str(ROOT),
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        raw = (proc.stdout or proc.stderr or "").strip()
        parsed = None
        if raw.startswith("{"):
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = None
        reachable = False
        running_text = raw.lower()
        if parsed is not None:
            gateway = parsed.get("gateway") if isinstance(parsed.get("gateway"), dict) else {}
            port = parsed.get("port") if isinstance(parsed.get("port"), dict) else {}
            rpc = parsed.get("rpc") if isinstance(parsed.get("rpc"), dict) else {}
            listeners = port.get("listeners") if isinstance(port.get("listeners"), list) else []
            port_busy = str(port.get("status") or "").lower() == "busy" and bool(listeners)
            reachable = bool(
                gateway.get("reachable")
                or parsed.get("reachable")
                or rpc.get("ok")
                or port_busy
            )
        else:
            reachable = "gateway is running" in running_text or "running" in running_text and "not running" not in running_text
        return {
            "ok": proc.returncode == 0 or bool(parsed),
            "exit_code": proc.returncode,
            "reachable": reachable,
            "raw": raw[:4000],
            "parsed": parsed,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "status_timeout", "reachable": False}
    except Exception as e:
        return {"ok": False, "error": f"status_failed:{type(e).__name__}", "reachable": False}


def _gateway_status_one(name: str, deep: bool = False) -> dict:
    cfg = GATEWAY_CONFIG.get(name) or {}
    proc_state = _gateway_proc_state(name)
    cli_path = _gateway_cli_path(name)
    port_reachable = _tcp_port_open(cfg.get("port")) if cfg.get("port") else False
    if deep:
        status = _gateway_run_status(name) if cli_path else {"ok": False, "error": "cli_missing", "reachable": False}
    else:
        status = {
            "ok": bool(cli_path) or bool(proc_state.get("managed")) or port_reachable,
            "reachable": bool(proc_state.get("running")) or port_reachable,
            "mode": "fast",
            "note": "fast local status; run gateway status for a deep CLI probe",
        }
    reachable = bool(status.get("reachable")) or bool(proc_state.get("running"))
    return {
        "id": name,
        "label": cfg.get("label", name),
        "binary": cfg.get("binary", name),
        "path": cli_path,
        "installed": bool(cli_path),
        "running": reachable,
        "managed": proc_state.get("managed", False),
        "pid": proc_state.get("pid"),
        "returncode": proc_state.get("returncode"),
        "port": cfg.get("port"),
        "status": status,
        "log": str(_gateway_log_dir() / f"{name}.log"),
    }


def _gateways_status(deep: bool = False) -> dict:
    gateways = [_gateway_status_one(name, deep=deep) for name in GATEWAY_CONFIG]
    return {
        "ok": True,
        "mode": "deep" if deep else "fast",
        "gateways": gateways,
        "running": sum(1 for item in gateways if item.get("running")),
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }


def _gateway_start(name: str) -> dict:
    cfg = GATEWAY_CONFIG.get(name)
    binary = _gateway_cli_path(name)
    if not cfg:
        return {"ok": False, "error": "unknown_gateway"}
    if not binary:
        return {"ok": False, "error": f"{name} CLI not found"}
    status = _gateway_status_one(name)
    if status.get("running"):
        return {"ok": True, "already_running": True, "gateway": status}
    proc_state = _gateway_proc_state(name)
    if proc_state.get("running"):
        return {"ok": True, "already_running": True, "gateway": status}
    log_path = _gateway_log_dir() / f"{name}.log"
    log = open(log_path, "a", encoding="utf-8", errors="replace")
    log.write(f"\n--- start {datetime.datetime.now().isoformat(timespec='seconds')} ---\n")
    log.flush()
    creationflags = 0
    if platform.system().lower() == "windows":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.Popen(
            [binary] + list(cfg["run"]),
            cwd=str(ROOT),
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            creationflags=creationflags,
        )
        try:
            log.close()
        except Exception:
            pass
        with _GATEWAY_LOCK:
            _GATEWAY_PROCS[name] = proc
        deadline = time.time() + 45
        status = _gateway_status_one(name)
        while time.time() < deadline:
            probe = status.get("status") if isinstance(status.get("status"), dict) else {}
            if probe.get("reachable"):
                return {"ok": True, "started": True, "gateway": status}
            if proc.poll() is not None:
                break
            time.sleep(1)
            status = _gateway_status_one(name)
        probe = status.get("status") if isinstance(status.get("status"), dict) else {}
        if probe.get("reachable"):
            return {"ok": True, "started": True, "gateway": status}
        return {
            "ok": False,
            "started": False,
            "error": "gateway_not_running",
            "gateway": status,
        }
    except Exception as e:
        try:
            log.close()
        except Exception:
            pass
        return {"ok": False, "error": f"start_failed:{type(e).__name__}"}


def _gateway_stop(name: str) -> dict:
    cfg = GATEWAY_CONFIG.get(name)
    binary = _gateway_cli_path(name)
    if not cfg:
        return {"ok": False, "error": "unknown_gateway"}
    result = {"ok": True, "stopped": False}
    if binary:
        try:
            subprocess.run([binary] + list(cfg["stop"]), cwd=str(ROOT), timeout=20, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            result["stopped"] = True
        except Exception:
            pass
    with _GATEWAY_LOCK:
        proc = _GATEWAY_PROCS.get(name)
    if proc and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        result["stopped"] = True
    return {**result, "gateway": _gateway_status_one(name)}


def _gateway_action(body: dict) -> dict:
    if not isinstance(body, dict):
        return {"ok": False, "error": "invalid_body"}
    name = str(body.get("gateway") or body.get("id") or "").strip().lower()
    action = str(body.get("action") or "status").strip().lower()
    if name not in GATEWAY_CONFIG:
        return {"ok": False, "error": "unknown_gateway", "allowed": list(GATEWAY_CONFIG)}
    if action == "start":
        return _gateway_start(name)
    if action == "stop":
        return _gateway_stop(name)
    if action == "restart":
        _gateway_stop(name)
        return _gateway_start(name)
    if action == "status":
        return {"ok": True, "gateway": _gateway_status_one(name, deep=True)}
    return {"ok": False, "error": "unknown_action", "allowed": ["status", "start", "stop", "restart"]}


def _ps_quote(value: object) -> str:
    return "'" + str(value or "").replace("'", "''") + "'"


def _launch_visible_terminal(title: str, binary: str, args: list[str], workspace: Optional[str] = None) -> dict:
    work = workspace or str(ROOT)
    if platform.system().lower() == "windows":
        arg_text = " ".join(_ps_quote(item) for item in args)
        command = (
            f"$Host.UI.RawUI.WindowTitle = {_ps_quote(title)}; "
            f"Set-Location -LiteralPath {_ps_quote(work)}; "
            f"& {_ps_quote(binary)} {arg_text}"
        )
        subprocess.Popen(
            ["powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", command],
            cwd=str(ROOT),
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )
    else:
        terminal = shutil.which("x-terminal-emulator") or shutil.which("gnome-terminal") or shutil.which("konsole")
        if terminal:
            subprocess.Popen([terminal, "--", binary, *args], cwd=work)
        else:
            subprocess.Popen([binary, *args], cwd=work)
    return {"ok": True, "launched": True, "title": title, "binary": binary, "args": args, "workspace": work}


def _cli_provider_action(body: dict) -> dict:
    if not isinstance(body, dict):
        return {"ok": False, "error": "invalid_body"}
    provider = str(body.get("provider") or body.get("id") or "").strip().lower()
    action = str(body.get("action") or "session").strip().lower()
    if provider not in CLI_BACKENDS:
        return {"ok": False, "error": "unknown_provider", "allowed": list(CLI_BACKENDS)}
    cfg = _safe_cfg(_config_load())
    cli_status = _cli_status(cfg, provider)
    binary = str(cli_status.get("path") or "")
    if not binary:
        return {"ok": False, "error": f"{provider} CLI not found"}
    workspace = str(cfg.get("workspace_home") or ROOT)
    commands: dict[str, dict[str, list[str]]] = {
        "codex": {
            "session": [],
            "login": ["login"],
            "doctor": ["doctor"],
        },
        "claude": {
            "session": [],
            "login": [],
        },
        "hermes": {
            "session": [],
        },
        "openclaw": {
            "session": ["chat"],
            "login": ["configure"],
            "configure": ["configure"],
            "dashboard": ["dashboard"],
            "doctor": ["doctor"],
        },
    }
    provider_commands = commands.get(provider, {})
    if action not in provider_commands:
        return {"ok": False, "error": "unknown_action", "allowed": sorted(provider_commands)}
    title = f"SERVARI {CLI_LABELS.get(provider, provider)} - {action}"
    try:
        return _launch_visible_terminal(title, binary, provider_commands[action], workspace=workspace)
    except Exception as e:
        return {"ok": False, "error": f"launch_failed: {type(e).__name__}", "detail": str(e)[:500]}


def _slug_note_name(value: object) -> str:
    text = str(value or "Untitled").strip()
    keep = []
    for ch in text:
        if ch.isalnum() or ch in {" ", "-", "_"}:
            keep.append(ch)
    out = " ".join("".join(keep).split()).strip()
    return out or "Untitled"


def _obsidian_uri() -> str:
    return "obsidian://open?path=" + quote(str(OBSIDIAN_VAULT.resolve()))


def _obsidian_vault_status() -> dict:
    notes = list(OBSIDIAN_VAULT.rglob("*.md")) if OBSIDIAN_VAULT.is_dir() else []
    return {
        "ok": True,
        "path": str(OBSIDIAN_VAULT),
        "exists": OBSIDIAN_VAULT.is_dir(),
        "notes": len(notes),
        "uri": _obsidian_uri(),
        "updated_at": _utc_now(),
    }


def _sync_obsidian_vault() -> dict:
    OBSIDIAN_VAULT.mkdir(parents=True, exist_ok=True)
    (OBSIDIAN_VAULT / ".obsidian").mkdir(parents=True, exist_ok=True)
    (OBSIDIAN_VAULT / "Agents").mkdir(parents=True, exist_ok=True)
    (OBSIDIAN_VAULT / "Memory").mkdir(parents=True, exist_ok=True)
    _write_json_object(OBSIDIAN_VAULT / ".obsidian" / "app.json", {})
    _write_json_object(
        OBSIDIAN_VAULT / ".obsidian" / "graph.json",
        {
            "collapse-filter": False,
            "search": "",
            "showTags": True,
            "showAttachments": False,
            "hideUnresolved": False,
            "showOrphans": True,
        },
    )

    agents = [item for item in _agent_map().get("agents", []) if isinstance(item, dict) and item.get("type") != "memory"]
    note_names: dict[str, str] = {}
    for agent in agents:
        note_names[str(agent.get("id") or "")] = _slug_note_name(agent.get("name") or agent.get("id"))
    edges = [item for item in _agent_map().get("edges", []) if isinstance(item, dict)]

    for agent in agents:
        agent_id = str(agent.get("id") or "")
        note_name = note_names.get(agent_id) or _slug_note_name(agent_id)
        related = []
        for edge in edges:
            source = str(edge.get("source") or "")
            target = str(edge.get("target") or "")
            if source == agent_id and target in note_names:
                related.append(f"- [[Agents/{note_names[target]}|{note_names[target]}]] ({edge.get('kind')})")
            elif target == agent_id and source in note_names:
                related.append(f"- [[Agents/{note_names[source]}|{note_names[source]}]] ({edge.get('kind')})")
        memory_links = []
        for memory in agent.get("memory_files", []) if isinstance(agent.get("memory_files"), list) else []:
            if isinstance(memory, dict):
                label = _as_text(memory.get("label"), 200) or "memory"
                path = _as_text(memory.get("path"), 1000)
                memory_links.append(f"- `{path}` ({label})")
        body = "\n".join(
            [
                "---",
                f"agent_id: {agent_id}",
                f"group: {_as_text(agent.get('group'), 100)}",
                f"role: {_as_text(agent.get('role'), 100)}",
                f"runtime: {_as_text(agent.get('runtime_backend'), 100)}",
                f"status: {_as_text(agent.get('status'), 100)}",
                "tags:",
                "  - servari/agent",
                "---",
                "",
                f"# {agent.get('name') or agent_id}",
                "",
                "## Current Task",
                _as_text(agent.get("current_task"), 2000) or "No current task.",
                "",
                "## Latest Reply",
                _as_text(agent.get("latest_reply"), 3000) or "No reply recorded.",
                "",
                "## Connected Agents",
                "\n".join(related) if related else "- None",
                "",
                "## Memory Files",
                "\n".join(memory_links) if memory_links else "- None",
                "",
            ]
        )
        (OBSIDIAN_VAULT / "Agents" / f"{note_name}.md").write_text(body, encoding="utf-8")

    memory_index = [
        "---",
        "tags:",
        "  - servari/memory-graph",
        "---",
        "",
        "# SERVARI Agent Memory Graph",
        "",
        "## Agents",
        *[f"- [[Agents/{name}|{name}]]" for _, name in sorted(note_names.items())],
        "",
        "## Source Files",
        "- `demo-data/agents.json`",
        "- `demo-data/agent-workflows.json`",
        "- `demo-data/memory-registry.json`",
        "",
    ]
    (OBSIDIAN_VAULT / "SERVARI Agent Memory Graph.md").write_text("\n".join(memory_index), encoding="utf-8")
    return {"ok": True, "synced": True, **_obsidian_vault_status()}


def _obsidian_vault_action(body: dict) -> dict:
    action = str((body or {}).get("action") or "status").strip().lower()
    if action == "status":
        return _obsidian_vault_status()
    if action == "sync":
        return _sync_obsidian_vault()
    if action == "open-folder":
        OBSIDIAN_VAULT.mkdir(parents=True, exist_ok=True)
        if platform.system().lower() == "windows":
            os.startfile(str(OBSIDIAN_VAULT))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", str(OBSIDIAN_VAULT)])
        return {"ok": True, "opened": "folder", **_obsidian_vault_status()}
    if action == "open-obsidian":
        _sync_obsidian_vault()
        if platform.system().lower() == "windows":
            os.startfile(_obsidian_uri())  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", _obsidian_uri()])
        return {"ok": True, "opened": "obsidian", **_obsidian_vault_status()}
    return {"ok": False, "error": "unknown_action", "allowed": ["status", "sync", "open-folder", "open-obsidian"]}


def _registry_agents() -> list[dict]:
    agents = _agent_registry().get("agents", [])
    return agents if isinstance(agents, list) else []


def _agent_meta(name: str) -> Optional[dict]:
    wanted = str(name or "").strip()
    if not wanted:
        return None
    for raw in _registry_agents():
        if not isinstance(raw, dict):
            continue
        ids = {str(raw.get("id") or ""), str(raw.get("channel") or ""), str(raw.get("name") or "")}
        if wanted in ids:
            return raw
    return None


def _dashboard_ids_for_agent(raw: dict) -> list[str]:
    group = str(raw.get("group") or "").lower()
    workflow = str(raw.get("workflow") or "").lower()
    ids = ["agent-apps"]
    if group == "trading" or workflow.startswith("trade"):
        ids.append("trading")
    if group == "career" or "career" in workflow:
        ids.append("cv-builder")
    if group in {"delivery", "platform", "domain", "product", "growth", "control", "release"}:
        ids.append("projects")
    return ids


def _safe_node_id(prefix: str, raw: str) -> str:
    text = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(raw or ""))
    text = "-".join(part for part in text.split("-") if part)
    return f"{prefix}:{text[:80] or 'item'}"


def _memory_registry_rows() -> list[dict]:
    try:
        from providers import memory_surface as mem_mod
        data = mem_mod.read_memory_surface()
        rows = data.get("files", []) if isinstance(data, dict) else []
        return [row for row in rows if isinstance(row, dict)]
    except Exception:
        return []


def _agent_memory_files(raw: dict) -> list[dict]:
    files = []
    channel = str(raw.get("channel") or raw.get("id") or "").strip()
    if channel:
        base = AGENTS_DIR / channel
        for label, path in (("START.md", base / "START.md"), ("channel.jsonl", base / "channel.jsonl")):
            files.append({
                "label": label,
                "path": str(path.relative_to(ROOT)) if ROOT in path.parents else str(path),
                "exists": path.is_file(),
            })
    source = str(raw.get("source") or "").strip()
    if source:
        p = Path(source)
        files.append({"label": "source", "path": source, "exists": p.exists()})
    return files


def _agent_map() -> dict:
    registry = _agent_registry()
    rows = {a.get("id"): a for a in _agents_status().get("agents", []) if isinstance(a, dict)}
    backend_status = _model_backend_status()
    effective_backend = backend_status.get("effective_backend", "none")
    agents = []
    agents.append({
        "id": "orchestrator",
        "type": "agent",
        "label": "Orchestrator",
        "name": "Orchestrator",
        "role": "control-plane",
        "group": "command",
        "workflow": "",
        "reports_to": None,
        "status": "live",
        "current_task": "Coordinate local agents and operator commands.",
        "latest_reply": "",
        "latest_reply_ts": None,
        "turns": len(_turns(CHAN)),
        "channel_exists": True,
        "runtime_backend": effective_backend,
        "dashboard_ids": ["agent-apps", "projects", "settings"],
        "editable": False,
        "source_label": "local control plane",
        "memory_files": [{"label": "main channel", "path": str(CHAN.relative_to(ROOT)) if ROOT in CHAN.parents else str(CHAN), "exists": CHAN.is_file()}],
    })
    name_to_id = {"orchestrator": "orchestrator", "chief of staff": "chief-of-staff"}
    for raw in _registry_agents():
        if not isinstance(raw, dict):
            continue
        agent_id = str(raw.get("id") or raw.get("channel") or "").strip()
        if not agent_id:
            continue
        name_to_id[agent_id.lower()] = agent_id
        name_to_id[str(raw.get("name") or "").strip().lower()] = agent_id

    for raw in _registry_agents():
        if not isinstance(raw, dict):
            continue
        agent_id = str(raw.get("id") or raw.get("channel") or "").strip()
        if not agent_id:
            continue
        live = rows.get(agent_id, {})
        agents.append({
            "id": agent_id,
            "type": "agent",
            "label": raw.get("name") or live.get("display_name") or agent_id,
            "name": raw.get("name") or agent_id,
            "role": raw.get("role") or live.get("role") or "",
            "group": raw.get("group") or live.get("group") or "",
            "workflow": raw.get("workflow") or live.get("workflow") or "",
            "reports_to": raw.get("reports_to") or "Orchestrator",
            "status": live.get("status", "not_started"),
            "current_task": live.get("current_task", ""),
            "latest_reply": live.get("latest_reply", ""),
            "latest_reply_ts": live.get("latest_reply_ts"),
            "turns": live.get("turns", 0),
            "channel_exists": bool(live.get("channel_exists")),
            "runtime_backend": raw.get("runtime_backend") or raw.get("engine") or effective_backend,
            "dashboard_ids": raw.get("dashboard_ids") if isinstance(raw.get("dashboard_ids"), list) else _dashboard_ids_for_agent(raw),
            "editable": True,
            "source_label": "imported local profile" if raw.get("source") else "local profile",
            "has_source": bool(raw.get("source")),
            "memory_files": _agent_memory_files(raw),
        })

    edges = []
    for agent in agents:
        if agent["id"] == "orchestrator":
            continue
        parent_raw = str(agent.get("reports_to") or "Orchestrator").strip().lower()
        parent = name_to_id.get(parent_raw) or "orchestrator"
        if parent != agent["id"]:
            edges.append({"id": f"reports:{parent}:{agent['id']}", "source": parent, "target": agent["id"], "kind": "reports_to"})

    for wf in registry.get("workflows", []) if isinstance(registry.get("workflows"), list) else []:
        stages = wf.get("stages") if isinstance(wf, dict) else None
        if not isinstance(stages, list):
            continue
        prev = None
        for stage in stages:
            sid = str(stage)
            if prev and prev != sid:
                edges.append({"id": f"workflow:{wf.get('id')}:{prev}:{sid}", "source": prev, "target": sid, "kind": "workflow"})
            prev = sid

    for row in _memory_registry_rows():
        path = str(row.get("path") or row.get("file") or "")
        node_id = _safe_node_id("memory", path)
        agents.append({
            "id": node_id,
            "type": "memory",
            "label": row.get("file") or path,
            "name": row.get("file") or path,
            "role": "memory-file",
            "group": "memory",
            "workflow": "memory-surface",
            "reports_to": "Archivist",
            "status": "live" if row.get("updated") != "missing" else "blocked",
            "current_task": row.get("path") or "",
            "latest_reply": f"{row.get('entries')} entries / updated {row.get('updated')}",
            "latest_reply_ts": None,
            "turns": row.get("entries") or 0,
            "channel_exists": False,
            "runtime_backend": "file",
            "dashboard_ids": ["agent-apps", "projects"],
            "editable": False,
            "source_label": "memory registry",
            "has_source": True,
            "memory_files": [{
                "label": row.get("file") or path,
                "path": path,
                "exists": row.get("updated") != "missing",
            }],
        })
        edges.append({"id": f"memory:archivist:{node_id}", "source": name_to_id.get("archivist", "orchestrator"), "target": node_id, "kind": "memory"})

    counts: dict[str, int] = {}
    for agent in agents:
        group = str(agent.get("group") or "ungrouped")
        counts[group] = counts.get(group, 0) + 1
    groups = []
    for group in registry.get("groups", []) if isinstance(registry.get("groups"), list) else []:
        if isinstance(group, dict):
            groups.append({"id": group.get("id"), "label": group.get("label"), "count": counts.get(str(group.get("id")), 0)})
    if counts.get("memory"):
        groups.append({"id": "memory", "label": "Memory", "count": counts.get("memory", 0)})
    return {
        "agents": agents,
        "edges": edges,
        "groups": groups,
        "workflows": registry.get("workflows", []),
        "dashboards": [
            {"id": "agent-apps", "label": "Agent Apps"},
            {"id": "trading", "label": "Trading Desk"},
            {"id": "cv-builder", "label": "CV Builder"},
            {"id": "projects", "label": "Projects"},
            {"id": "settings", "label": "Settings"},
        ],
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }


def _agent_profile(name: str) -> dict:
    raw = _agent_meta(name)
    if raw is None:
        if str(name or "").startswith("memory:"):
            for node in _agent_map().get("agents", []):
                if isinstance(node, dict) and node.get("id") == name:
                    text = "\n".join(
                        f"- {item.get('label')}: {item.get('path')} ({'present' if item.get('exists') else 'missing'})"
                        for item in node.get("memory_files", []) if isinstance(item, dict)
                    )
                    return {
                        "ok": True,
                        "profile": node,
                        "brief": {"name": name, "found": True, "brief": "# Memory file\n\n" + text, "path": node.get("current_task", "")},
                    }
        return {"ok": False, "error": "unknown_agent", "profile": None}
    agent_id = str(raw.get("id") or raw.get("channel"))
    brief = _agent_brief(str(raw.get("channel") or agent_id))
    safe = {k: raw.get(k) for k in ("id", "name", "role", "group", "channel", "reports_to", "workflow", "runtime_backend", "dashboard_ids", "enabled")}
    safe["source_label"] = "imported local profile" if raw.get("source") else "local profile"
    safe["has_source"] = bool(raw.get("source"))
    return {"ok": True, "profile": safe, "brief": brief}


def _agent_runtime_prompt(name: str) -> str:
    raw = _agent_meta(name) or {}
    brief = _agent_brief(str(raw.get("channel") or raw.get("id") or name))
    lines = [
        f"Agent id: {raw.get('id') or name}",
        f"Agent name: {raw.get('name') or name}",
        f"Role: {raw.get('role') or 'agent'}",
        f"Group: {raw.get('group') or ''}",
        f"Workflow: {raw.get('workflow') or ''}",
        "Stay inside this agent profile. Use the START.md instructions as operating context.",
    ]
    if brief.get("found") and brief.get("brief"):
        lines.extend(["", "START.md:", str(brief.get("brief"))[:6000]])
    return "\n".join(lines)


def _reply_to_agent_channel(name: str, path: Path) -> dict:
    history = _turns(path)
    runtime = _agent_runtime_prompt(name)
    result = _reply_via_selected_backend(history, system=runtime)
    if result.get("ok") and result.get("text"):
        _append(path, name, str(result.get("text")))
        return {"ok": True, "replied": True, "model": result.get("model", "")}
    err = str(result.get("error") or "selected backend returned no reply")
    _append_error(path, "Agent backend failed: " + err + ". Open Settings to choose API, Codex, Claude, Hermes, or OpenClaw.")
    return {"ok": False, "replied": False, "error": err, "model": result.get("model", "")}


def _brief_path_for_agent(name: str) -> Optional[Path]:
    raw = _agent_meta(name)
    if raw:
        channel = str(raw.get("channel") or raw.get("id") or "").strip()
    else:
        channel = str(name or "").strip()
    if not channel:
        return None
    path = (AGENTS_DIR / channel / "START.md").resolve()
    try:
        path.relative_to(AGENTS_DIR.resolve())
    except Exception:
        return None
    return path


def _save_agent_brief(body: dict) -> dict:
    name = str(body.get("name") or body.get("agent") or "").strip()
    text = str(body.get("brief") or "")
    if not name:
        return {"ok": False, "error": "missing_agent"}
    if len(text) > 200000:
        return {"ok": False, "error": "brief_too_large"}
    path = _brief_path_for_agent(name)
    if path is None:
        return {"ok": False, "error": "invalid_agent_path"}
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        backup = path.with_suffix(path.suffix + "." + datetime.datetime.now().strftime("%Y%m%d%H%M%S") + ".bak")
        try:
            shutil.copy2(path, backup)
        except Exception:
            pass
    path.write_text(text, encoding="utf-8")
    return {"ok": True, "path": str(path.relative_to(ROOT)) if ROOT in path.parents else str(path), "found": True}


def _save_agent_profile(body: dict) -> dict:
    name = str(body.get("id") or body.get("name") or body.get("agent") or "").strip()
    if not name:
        return {"ok": False, "error": "missing_agent"}
    registry = _agent_registry()
    agents = registry.get("agents", [])
    if not isinstance(agents, list):
        return {"ok": False, "error": "registry_invalid"}
    allowed = {"name", "role", "group", "reports_to", "workflow", "runtime_backend", "enabled"}
    valid_backends = set(MODEL_BACKENDS) - {"auto"}
    changed = False
    for raw in agents:
        if not isinstance(raw, dict):
            continue
        ids = {str(raw.get("id") or ""), str(raw.get("channel") or ""), str(raw.get("name") or "")}
        if name not in ids:
            continue
        for key in allowed:
            if key not in body:
                continue
            if key == "runtime_backend":
                val = str(body.get(key) or "").strip().lower()
                if val and val not in valid_backends:
                    return {"ok": False, "error": "unknown_runtime_backend", "allowed": sorted(valid_backends)}
                raw[key] = val
            elif key == "enabled":
                raw[key] = bool(body.get(key))
            else:
                raw[key] = str(body.get(key) or "").strip()
            changed = True
        if isinstance(body.get("dashboard_ids"), list):
            raw["dashboard_ids"] = [str(x) for x in body["dashboard_ids"] if str(x).strip()]
            changed = True
        break
    if not changed:
        return {"ok": False, "error": "agent_not_found_or_no_changes"}
    AGENT_REGISTRY.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"ok": True, "profile": _agent_profile(name).get("profile")}


def _save_career_profile(body: dict) -> dict:
    if not isinstance(body, dict):
        return {"ok": False, "error": "invalid_body"}
    current = _read_json_object(CAREER_PROFILE, {})
    allowed = ("name", "headline", "summary", "location", "languages", "portfolio_path")
    for key in allowed:
        if key in body:
            current[key] = _as_text(body.get(key), 12000 if key == "summary" else 2000)
    if "skills" in body:
        skills = body.get("skills")
        if isinstance(skills, list):
            current["skills"] = [_as_text(item, 120) for item in skills if _as_text(item, 120)][:80]
        else:
            current["skills"] = [_as_text(item, 120) for item in str(skills or "").split(",") if _as_text(item, 120)][:80]
    current["_schema"] = "servari.career_profile.v1"
    current["updated_at"] = _utc_now()
    _write_json_object(CAREER_PROFILE, current)
    try:
        from providers import career as career_mod
        return {"ok": True, "profile": career_mod.read_career()}
    except Exception:
        return {"ok": True, "profile": current}


def _normalize_job_row(raw: dict) -> dict:
    return {
        "title": _as_text(raw.get("title"), 400),
        "company": _as_text(raw.get("company"), 300),
        "source": _as_text(raw.get("source"), 300),
        "location": _as_text(raw.get("location"), 300),
        "score": int(raw.get("score") or 0) if str(raw.get("score") or "").strip().lstrip("-").isdigit() else 0,
        "posted": _as_text(raw.get("posted"), 100),
        "tailored": bool(raw.get("tailored")),
        "url": _as_text(raw.get("url"), 2000),
        "notes": _as_text(raw.get("notes"), 4000),
    }


def _save_jobs(body: dict) -> dict:
    if not isinstance(body, dict):
        return {"ok": False, "error": "invalid_body"}
    jobs = [_normalize_job_row(row) for row in _as_list_of_dicts(body.get("jobs"), limit=300)]
    payload = {"_schema": "servari.jobs.v1", "last_scan": _utc_now(), "jobs": jobs}
    _write_json_object(JOBS_DATA, payload)
    return {"ok": True, **payload}


def _normalize_application_row(raw: dict) -> dict:
    return {
        "company": _as_text(raw.get("company"), 300),
        "role": _as_text(raw.get("role"), 400),
        "status": _as_text(raw.get("status"), 100) or "draft",
        "date": _as_text(raw.get("date"), 100) or datetime.date.today().isoformat(),
        "url": _as_text(raw.get("url"), 2000),
        "notes": _as_text(raw.get("notes"), 4000),
    }


def _save_applications(body: dict) -> dict:
    if not isinstance(body, dict):
        return {"ok": False, "error": "invalid_body"}
    rows = [_normalize_application_row(row) for row in _as_list_of_dicts(body.get("applications"), limit=300)]
    payload = {"_schema": "servari.applications.v1", "updated_at": _utc_now(), "applications": rows}
    _write_json_object(APPLICATIONS_DATA, payload)
    return {"ok": True, **payload}


def _trading_workbench() -> dict:
    default = {
        "_schema": "servari.trading_workbench.v1",
        "active_symbol": "BTCUSD",
        "timeframe": "1D",
        "position_plan": {"account": 10000, "risk_pct": 1, "entry": 0, "stop": 0, "target": 0},
        "watchlist": [],
        "alerts": [],
        "risk_rules": [],
        "research_queue": [],
        "journal": [],
        "updated_at": "",
    }
    payload = _read_json_object(TRADING_WORKBENCH, default)
    for key in ("watchlist", "alerts", "risk_rules", "research_queue", "journal"):
        if not isinstance(payload.get(key), list):
            payload[key] = []
    payload["active_symbol"] = _as_text(payload.get("active_symbol"), 40).upper() or (payload["watchlist"][0] if payload.get("watchlist") else "BTCUSD")
    payload["timeframe"] = _as_text(payload.get("timeframe"), 20).upper() or "1D"
    if not isinstance(payload.get("position_plan"), dict):
        payload["position_plan"] = {"account": 10000, "risk_pct": 1, "entry": 0, "stop": 0, "target": 0}
    payload["ok"] = True
    return payload


def _save_trading_workbench(body: dict) -> dict:
    if not isinstance(body, dict):
        return {"ok": False, "error": "invalid_body"}
    current = _trading_workbench()
    if "active_symbol" in body:
        current["active_symbol"] = _as_text(body.get("active_symbol"), 40).upper() or current.get("active_symbol") or "BTCUSD"
    if "timeframe" in body:
        current["timeframe"] = _as_text(body.get("timeframe"), 20).upper() or current.get("timeframe") or "1D"
    if isinstance(body.get("position_plan"), dict):
        raw_plan = dict(body.get("position_plan") or {})
        current["position_plan"] = {
            "account": float(raw_plan.get("account") or 0),
            "risk_pct": float(raw_plan.get("risk_pct") or 0),
            "entry": float(raw_plan.get("entry") or 0),
            "stop": float(raw_plan.get("stop") or 0),
            "target": float(raw_plan.get("target") or 0),
        }
    for key in ("watchlist", "alerts", "risk_rules", "research_queue", "journal"):
        if key in body:
            if key == "watchlist":
                raw_items = body.get(key) if isinstance(body.get(key), list) else []
                current[key] = [_as_text(item, 40).upper() for item in raw_items if _as_text(item, 40)][:200]
            else:
                current[key] = _as_list_of_dicts(body.get(key), limit=300)
    current["_schema"] = "servari.trading_workbench.v1"
    current["updated_at"] = _utc_now()
    current.pop("ok", None)
    _write_json_object(TRADING_WORKBENCH, current)
    current["ok"] = True
    return current


def _default_rss_sources() -> list[dict]:
    if RSS_FEEDS.is_file():
        try:
            data = json.loads(RSS_FEEDS.read_text(encoding="utf-8", errors="replace"))
            feeds = data.get("feeds", [])
            if isinstance(feeds, list) and feeds:
                return [f for f in feeds if isinstance(f, dict)]
        except Exception:
            pass
    return [
        {"id": "hn", "label": "Hacker News", "url": "https://hnrss.org/frontpage", "category": "technology"},
        {"id": "openai", "label": "OpenAI", "url": "https://openai.com/news/rss.xml", "category": "ai"},
        {"id": "coindesk", "label": "CoinDesk", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/", "category": "markets"},
    ]


def _node_text(node: Optional[ET.Element], *names: str) -> str:
    if node is None:
        return ""
    for name in names:
        found = node.find(name)
        if found is not None and found.text:
            return found.text.strip()
        for child in list(node):
            tag = child.tag.split("}", 1)[-1]
            if tag == name and child.text:
                return child.text.strip()
    return ""


def _rss_datafeeds() -> dict:
    now = time.time()
    cached = _RSS_CACHE.get("payload")
    if cached and now - float(_RSS_CACHE.get("ts") or 0) < 300:
        return cached  # type: ignore[return-value]
    buckets = []
    errors = []
    for source in _default_rss_sources():
        url = str(source.get("url") or "").strip()
        if not url:
            continue
        try:
            req = Request(
                url,
                headers={
                    "User-Agent": "SERVARI-OS/1.0 (+https://localhost)",
                    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
                },
            )
            with urlopen(req, timeout=4) as resp:
                raw = resp.read(2 * 1024 * 1024)
            root = ET.fromstring(raw)
            entries = root.findall(".//item")
            if not entries:
                entries = root.findall(".//{http://www.w3.org/2005/Atom}entry")
            source_items = []
            for index, entry in enumerate(entries[:5]):
                title = _node_text(entry, "title") or "Untitled item"
                link = _node_text(entry, "link")
                if not link:
                    for child in list(entry):
                        if child.tag.split("}", 1)[-1] == "link":
                            link = child.attrib.get("href", "")
                            break
                published = _node_text(entry, "pubDate", "published", "updated")
                summary = _node_text(entry, "description", "summary")
                stable = hashlib.sha1(
                    f"{source.get('id')}|{title}|{link}".encode("utf-8", errors="replace")
                ).hexdigest()[:16]
                source_items.append({
                    "id": f"{source.get('id')}-{index}-{stable}",
                    "title": title[:240],
                    "source": source.get("label") or source.get("id") or "RSS",
                    "url": link,
                    "published_at": published,
                    "category": source.get("category", ""),
                    "summary": summary[:500],
                    "priority": source.get("priority", "medium"),
                })
            if source_items:
                buckets.append(source_items)
        except Exception as e:
            errors.append({"source": source.get("label") or url, "error": type(e).__name__})
    items = []
    for index in range(5):
        for bucket in buckets:
            if index < len(bucket):
                items.append(bucket[index])
    payload = {
        "ok": True,
        "items": items[:24],
        "feeds": _default_rss_sources(),
        "errors": errors,
        "last_sync": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }
    _RSS_CACHE["payload"] = payload
    _RSS_CACHE["ts"] = now
    return payload


def _local_stores() -> dict:
    stores = []
    targets = []
    for p in DEMO.glob("*"):
        if p.is_file() and p.suffix.lower() in {".json", ".jsonl", ".md", ".sqlite", ".db", ".csv"}:
            targets.append(p)
    for p in (ROOT / "server").glob("*.py"):
        targets.append(p)
    for p in sorted(targets, key=lambda x: x.name.lower()):
        try:
            size = p.stat().st_size
            rows = None
            if p.suffix.lower() == ".jsonl":
                rows = len(p.read_text(encoding="utf-8", errors="replace").splitlines())
            elif p.suffix.lower() == ".json":
                data = json.loads(p.read_text(encoding="utf-8", errors="replace"))
                if isinstance(data, list):
                    rows = len(data)
                elif isinstance(data, dict):
                    rows = len(data.get("agents") or data.get("workflows") or data.keys())
            stores.append({
                "id": p.stem,
                "name": p.name,
                "kind": p.suffix.lower().lstrip(".") or "file",
                "path": str(p.relative_to(ROOT)) if ROOT in p.parents else str(p),
                "rows": rows,
                "size_mb": round(size / (1024 * 1024), 3),
                "updated": datetime.datetime.fromtimestamp(p.stat().st_mtime, datetime.timezone.utc).isoformat(timespec="seconds"),
                "status": "ready",
                "description": "local file-backed store",
            })
        except Exception:
            continue
    return {
        "ok": True,
        "stores": stores[:80],
        "last_scan": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }


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
    center = {"name": "you <-> SERVARI", "key": "root", "total": len(at), "turns": at[-limit:], "owes": ""}
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
    def _send(self, code, body, ctype="application/json", cache_control="no-store"):
        b = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code); self.send_header("Content-Type", ctype)
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def log_message(self, *a):
        pass

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    # Hosts we treat as "this machine". HOST is included so a custom
    # SERVARI_HOST bind (still operator-chosen, loopback by default) is trusted.
    _LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}

    @classmethod
    def _is_loopback_host(cls, host: str) -> bool:
        h = (host or "").strip().lower()
        if not h:
            return False
        # strip an [ipv6] bracket form / a trailing :port if one slipped in
        if h.startswith("[") and "]" in h:
            h = h[1 : h.index("]")]
        return h in cls._LOOPBACK_HOSTS or h == HOST.lower()

    def _trust_origin(self):
        """Robust local-trust check for state-changing requests. TEST-SAFE.

        This is a single-user, local-first tool. The threat model is a malicious
        WEBSITE in the operator's browser trying to drive these endpoints (CSRF)
        or a DNS-rebinding attack pointing a hostile name at 127.0.0.1. We block
        both using browser-set, unforgeable signals:

          - Origin / Referer present with a NON-loopback host  -> reject (CSRF).
          - Sec-Fetch-Site == 'cross-site'                     -> reject (browser-set).
          - Host header present with a NON-loopback host        -> reject (rebinding).

        ALLOW when none of Origin/Referer/Sec-Fetch-Site indicate cross-origin
        AND Host is loopback (or absent). A non-browser local client (curl /
        urllib / the test harness) that sends only a loopback Host and no Origin
        is ALLOWED. We cannot distinguish such a client from the legitimate local
        UI, and requiring a custom header would break simple local automation;
        this is the accepted residual risk for a single-user local tool.

        Returns (trusted: bool, reason: str).
        """
        # Sec-Fetch-Site is set by the browser and cannot be forged by JS.
        sfs = str(self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if sfs == "cross-site":
            return False, "untrusted_origin"

        # Origin / Referer: if present and cross-origin, it's a foreign page.
        for header in ("Origin", "Referer"):
            raw = str(self.headers.get(header) or "").strip()
            if not raw or raw.lower() == "null":
                continue
            try:
                host = (urlparse(raw).hostname or "").lower()
            except Exception:
                return False, "untrusted_origin"
            if not self._is_loopback_host(host):
                return False, "untrusted_origin"

        # Host header: blocks DNS-rebinding (a hostile name resolving to 127.0.0.1).
        host_hdr = str(self.headers.get("Host") or "").strip()
        if host_hdr:
            host_only = host_hdr
            if host_only.startswith("[") and "]" in host_only:
                host_only = host_only[: host_only.index("]") + 1]
            elif ":" in host_only:
                host_only = host_only.rsplit(":", 1)[0]
            if not self._is_loopback_host(host_only):
                return False, "untrusted_origin"

        return True, ""

    def _trusted_local_json_post(self):
        ctype = str(self.headers.get("Content-Type") or "").lower()
        if "application/json" not in ctype:
            return False, "application/json required"
        return self._trust_origin()

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
        if rel.lstrip("/").startswith("assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
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
        self.send_header("Cache-Control", "no-cache")
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
                                        "channels": _state_channels(),
                                        "open_gates": hub.get("open_gates", [])}))
        elif u.path == "/api/actions":
            self._send(200, json.dumps(_standing_orders()))
        elif u.path == "/api/byom-status":
            # whether a model is wired (config.json present + valid). Never crash.
            try:
                out = _api_status()
                out["model_backend"] = _model_backend_status()
                self._send(200, json.dumps(out))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "reason": f"byom-status failed: {type(e).__name__}"}))
        elif u.path in ("/api/model-config", "/api/settings/model-backend"):
            try:
                self._send(200, json.dumps(_model_backend_status()))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"model-config failed: {type(e).__name__}"}))
        elif u.path == "/api/gateways":
            try:
                deep = (parse_qs(u.query).get("deep", [""])[0] or "").strip().lower() in {"1", "true", "yes", "deep"}
                self._send(200, json.dumps(_gateways_status(deep=deep)))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"gateways failed: {type(e).__name__}"}))
        elif u.path == "/api/obsidian-vault":
            self._send(200, json.dumps(_obsidian_vault_status()))
        elif u.path == "/api/agents":
            self._send(200, json.dumps({"agents": sorted(_agent_channels())}))
        elif u.path == "/api/agent-channel":
            name = (parse_qs(u.query).get("name") or [""])[0]
            p = _agent_channels().get(name)
            self._send(200, json.dumps({"name": name, "turns": _turns(p)}))
        elif u.path == "/api/org":
            self._send(200, json.dumps(_org()))
        elif u.path == "/api/agent-map":
            try:
                self._send(200, json.dumps(_agent_map()))
            except Exception as e:
                self._send(200, json.dumps({"agents": [], "edges": [], "groups": [], "error": f"agent-map failed: {type(e).__name__}"}))
        elif u.path == "/api/agent-profile":
            name = (parse_qs(u.query).get("name") or parse_qs(u.query).get("agent") or [""])[0]
            self._send(200, json.dumps(_agent_profile(name)))
        elif u.path == "/api/agent-brief":
            name = (parse_qs(u.query).get("name") or [""])[0]
            self._send(200, json.dumps(_agent_brief(name)))
        elif u.path == "/api/agent-workflows":
            self._send(200, json.dumps(_agent_workflows()))
        elif u.path in ("/api/rss-feeds", "/api/data-feeds"):
            self._send(200, json.dumps(_rss_datafeeds()))
        elif u.path == "/api/trading-workbench":
            self._send(200, json.dumps(_trading_workbench()))
        elif u.path in ("/api/local-stores", "/api/local-databases"):
            self._send(200, json.dumps(_local_stores()))
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
        elif u.path == "/api/engine/status":
            # Local engine lifecycle status (managed process + probes when running).
            try:
                state = _engine_live_state()
                cfg = state.get("config", {}) if isinstance(state.get("config"), dict) else {}
                if state.get("running") and isinstance(cfg, dict):
                    base = _engine_base_url(cfg)
                    state["probe_health"] = _engine_status_probe(base, "/api/health")
                    state["probe_ready"] = _engine_status_probe(base, "/api/ready")
                self._send(200, json.dumps({"ok": True, "status": state}))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"engine-status failed: {type(e).__name__}"}))
        elif u.path == "/api/engine/logs":
            # Local engine log feed from managed stdout ring buffer.
            try:
                query = parse_qs(u.query)
                raw_lines = query.get("lines", [None])[0]
                lines = int(raw_lines) if raw_lines is not None else None
                logs = _engine_tail_logs(lines)
                self._send(200, json.dumps({"ok": True, "logs": logs, "count": len(logs)}))
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "error": f"engine-logs failed: {type(e).__name__}", "logs": []}))
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
            # GET runs allow-listed actions. A foreign page can trigger top-level
            # GET navigations, so reject the browser-set cross-site signal. We do
            # NOT require an Origin here (GETs from the local UI may omit it).
            if str(self.headers.get("Sec-Fetch-Site") or "").strip().lower() == "cross-site":
                self._send(403, json.dumps({"ok": False, "error": "untrusted_origin"}))
                return
            name = (parse_qs(u.query).get("action") or [""])[0]
            self._send(200, json.dumps(_run_action(name)))
        # ------------------------------------------------------------------
        # AGENT STATUS — /api/agents/status + /api/orchestrator
        # Returns the live agent-grid data from the demo channels.
        # ------------------------------------------------------------------
        elif u.path in ("/api/agents/status", "/api/orchestrator"):
            try:
                self._send(200, json.dumps(_agents_status()))
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

    def _reject_untrusted(self) -> bool:
        """Guard a state-changing route. Returns True (and sends 403) when the
        request is NOT a trusted local request, so the caller can bail out."""
        trusted, _reason = self._trust_origin()
        if not trusted:
            self._send(403, json.dumps({"ok": False, "error": "untrusted_origin"}))
            return True
        return False

    # State-changing POST routes guarded by _trust_origin (local-trust check).
    _GUARDED_POST_PATHS = {
        "/api/engine/start",
        "/api/engine/stop",
        "/api/engine/restart",
        "/api/say",
        "/api/agent-say",
        "/api/model-config",
        "/api/settings/model-backend",
        "/api/settings/model-backend/secret",
        "/api/settings/model-backend/test",
        "/api/set-autonomy",
        "/api/verify-decision",
        "/api/retention-decide",
        "/api/context-checkpoint",
        "/api/tokens-report",
        "/api/agent-brief",
        "/api/agent-profile",
        "/api/career",
        "/api/jobs",
        "/api/applications",
        "/api/trading-workbench",
    }

    def do_POST(self):
        u = urlparse(self.path)
        # Single chokepoint: reject untrusted cross-origin requests to any
        # state-changing route before it runs. /api/gateways, /api/cli-provider
        # and /api/obsidian-vault keep their own inline guard below.
        if u.path in self._GUARDED_POST_PATHS and self._reject_untrusted():
            return
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
                if text and str(text).strip():
                    r = _reply_via_selected_backend(_turns(CHAN))
                    if r.get("ok") and r.get("text"):
                        _append(CHAN, "servari", r["text"])
                        reply_info = {"replied": True, "model": r.get("model", ""), "backend": r.get("model", "")}
                    else:
                        err = r.get("error", "") or "the selected backend returned no reply"
                        _append_error(CHAN, "Model backend failed: " + str(err) +
                                      ". Open Settings to choose API, Codex, Claude, Hermes, or OpenClaw.")
                        reply_info = {"replied": False, "error": err, "backend": r.get("model", "")}
            except Exception as e:
                _append_error(CHAN, "Model backend failed: " + type(e).__name__ +
                              ". Open Settings to choose API, Codex, Claude, Hermes, or OpenClaw.")
                reply_info = {"replied": False, "error": f"{type(e).__name__}"}
            self._send(200, json.dumps({"ok": True, "byom": reply_info}))
        elif u.path == "/api/agent-say":
            name = (parse_qs(u.query).get("name") or [""])[0]
            p = _agent_channels().get(name)
            if not p:
                self._send(200, json.dumps({"ok": False, "error": "unknown agent"}))
            else:
                ok = _append(p, "operator", "[direct message] " + self._body().get("text", ""))
                reply_info = {"replied": False}
                if ok:
                    reply_info = _reply_to_agent_channel(name, p)
                self._send(200, json.dumps({"ok": ok, "byom": reply_info}))
        elif u.path in ("/api/model-config", "/api/settings/model-backend"):
            self._send(200, json.dumps(_save_model_backend(self._body())))
        elif u.path == "/api/settings/model-backend/secret":
            self._send(200, json.dumps(_save_model_secret(self._body())))
        elif u.path == "/api/settings/model-backend/check":
            self._send(200, json.dumps(_model_backend_status()))
        elif u.path == "/api/settings/model-backend/test":
            body = self._body()
            probe = body.get("text", "Reply with exactly: SERVARI_BACKEND_OK")
            backend = str(body.get("backend") or "").strip().lower()
            history = [{"from": "user", "text": str(probe)}]
            if backend and backend != "auto":
                if backend == "api":
                    result = _chat.reply(history) if _chat is not None else {"ok": False, "model": "api", "text": "", "error": "chat backend unavailable"}
                elif backend in CLI_BACKENDS:
                    result = _run_cli_reply(backend, history)
                else:
                    result = {"ok": False, "model": backend, "text": "", "error": "unsupported backend"}
            else:
                result = _reply_via_selected_backend(history)
            self._send(200, json.dumps({"ok": bool(result.get("ok")), "result": result}))
        elif u.path == "/api/gateways/action":
            trusted, reason = self._trusted_local_json_post()
            if not trusted:
                self._send(403, json.dumps({"ok": False, "error": reason}))
            else:
                self._send(200, json.dumps(_gateway_action(self._body())))
        elif u.path == "/api/cli-provider/action":
            trusted, reason = self._trusted_local_json_post()
            if not trusted:
                self._send(403, json.dumps({"ok": False, "error": reason}))
            else:
                self._send(200, json.dumps(_cli_provider_action(self._body())))
        elif u.path == "/api/obsidian-vault/action":
            trusted, reason = self._trusted_local_json_post()
            if not trusted:
                self._send(403, json.dumps({"ok": False, "error": reason}))
            else:
                self._send(200, json.dumps(_obsidian_vault_action(self._body())))
        elif u.path == "/api/agent-brief":
            self._send(200, json.dumps(_save_agent_brief(self._body())))
        elif u.path == "/api/agent-profile":
            self._send(200, json.dumps(_save_agent_profile(self._body())))
        elif u.path == "/api/career":
            self._send(200, json.dumps(_save_career_profile(self._body())))
        elif u.path == "/api/jobs":
            self._send(200, json.dumps(_save_jobs(self._body())))
        elif u.path == "/api/applications":
            self._send(200, json.dumps(_save_applications(self._body())))
        elif u.path == "/api/trading-workbench":
            self._send(200, json.dumps(_save_trading_workbench(self._body())))
        elif u.path == "/api/engine/start":
            self._send(200, json.dumps(_engine_start(self._body())))
        elif u.path == "/api/engine/stop":
            self._send(200, json.dumps(_engine_stop()))
        elif u.path == "/api/engine/restart":
            self._send(200, json.dumps(_engine_restart(self._body())))
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
