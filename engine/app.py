#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""engine/app.py — THE RUNNABLE SERVARI EXECUTION ENGINE.

SERVARI's /api/engine/start hunts for an app.py under a candidate home (one of
which is ``<repo>/engine``) and launches it either as:

    python -m uvicorn app:app --host H --port P     (preferred, if uvicorn present)
    python app.py --host H --port P                 (stdlib fallback, always works)

This file satisfies BOTH paths with the SAME health/ready contract, using the
standard library ONLY (no uvicorn/fastapi import at module top — the ASGI
callable is just a plain ``async def``).

What it serves (GET):
    /api/health        -> 200 {"ok": true, "service": "servari-engine"}
    /api/ready         -> 200 {"ok": true, "service": "servari-engine"}
    /api/engine-state  -> 200 executor.state()   (the live executor counters)

What it DOES (the point of the engine):
    On startup it spawns a daemon background thread that calls
    executor.run_once() every ~3 seconds — closing the loop
    autonomy -> verify_queue(approved) -> safe allow-listed execution. The
    executor is fail-closed: a bad tick never kills the thread or the server.

The executor lives in ``<repo>/server``. engine/ is a child of the repo root, so
server is ``../server`` relative to this file; we add it to sys.path and import
``executor``. STDLIB ONLY throughout.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# --- locate the repo's server/ dir and import the executor ------------------
# engine/ is a child of the repo root -> server is a sibling of engine.
_REPO_ROOT = Path(__file__).resolve().parent.parent
_SERVER_DIR = _REPO_ROOT / "server"
if str(_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVER_DIR))

try:
    import executor  # noqa: E402  (after sys.path setup, by design)
except Exception as _e:  # fail-closed: still serve health, just no executor loop
    executor = None  # type: ignore[assignment]
    _EXECUTOR_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"
else:
    _EXECUTOR_IMPORT_ERROR = ""


_HEALTH = {"ok": True, "service": "servari-engine"}

# loop cadence in seconds — "every ~3s" per the engine contract.
_TICK_SECONDS = 3.0


def _engine_state() -> dict:
    """The executor state, or a clean unavailable payload if the import failed."""
    if executor is None:
        return {"ok": False, "running": False,
                "error": f"executor_unavailable: {_EXECUTOR_IMPORT_ERROR}"}
    try:
        return executor.state()
    except Exception as e:  # fail-closed
        return {"ok": False, "running": False,
                "error": f"state_failed: {type(e).__name__}: {e}"}


# ---------------------------------------------------------------------------
# the background executor loop (daemon thread)
# ---------------------------------------------------------------------------
_LOOP_STARTED = threading.Event()


def _executor_loop() -> None:
    """Call executor.run_once() forever, ~every _TICK_SECONDS. Fail-closed: any
    exception in a tick is swallowed so the loop (and the server) keep running."""
    while True:
        try:
            if executor is not None:
                executor.run_once()
        except Exception:
            pass  # never let a bad tick kill the loop
        time.sleep(_TICK_SECONDS)


def _start_executor_loop() -> None:
    """Spawn the daemon loop exactly once."""
    if _LOOP_STARTED.is_set():
        return
    _LOOP_STARTED.set()
    t = threading.Thread(target=_executor_loop, name="servari-executor-loop",
                         daemon=True)
    t.start()


# ---------------------------------------------------------------------------
# ASGI callable — for the `python -m uvicorn app:app` path (no uvicorn import!)
# ---------------------------------------------------------------------------
async def app(scope, receive, send):
    """Plain ASGI app: returns the health/ready JSON. Imports nothing extra; it
    is a bare coroutine so it works under any ASGI server if one is present."""
    if scope.get("type") != "http":
        return
    request_path = scope.get("path", "")
    if request_path in ("/api/health", "/api/ready"):
        status = 200
        body = json.dumps(_HEALTH).encode("utf-8")
    elif request_path == "/api/engine-state":
        status = 200
        body = json.dumps(_engine_state()).encode("utf-8")
    else:
        status = 404
        body = json.dumps({"ok": False, "error": "not_found"}).encode("utf-8")

    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json; charset=utf-8")],
    })
    await send({"type": "http.response.body", "body": body})


# ---------------------------------------------------------------------------
# stdlib HTTPServer — for the `python app.py --host --port` path
# ---------------------------------------------------------------------------
class _Handler(BaseHTTPRequestHandler):
    def _payload(self, response, status=200):
        body = json.dumps(response).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/api/health", "/api/ready"):
            self._payload(_HEALTH)
        elif self.path == "/api/engine-state":
            self._payload(_engine_state())
        else:
            self._payload({"ok": False, "error": "not_found"}, status=404)

    def log_message(self, *_a, **_k):
        return  # silence access logs


def _cli() -> None:
    parser = argparse.ArgumentParser(description="SERVARI execution engine.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7000)
    args = parser.parse_args()

    _start_executor_loop()  # the real executor loop runs alongside the server
    server = HTTPServer((args.host, args.port), _Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


# Start the loop at import-time too, so the ASGI (uvicorn) path also gets a live
# executor without relying on a startup event. Idempotent via _LOOP_STARTED.
_start_executor_loop()


if __name__ == "__main__":
    _cli()
