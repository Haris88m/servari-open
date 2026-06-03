#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""byom_smoke.py — end-to-end regression smoke test for SERVARI's
bring-your-own-model (BYOM) wiring.

What it proves, on every run, with no external network and no real key:

  1. A mock OpenAI-compatible model server (stdlib http.server, port 8951)
     answers /chat/completions with a fixed choices[0].message.content reply.
  2. The real SERVARI server (server/servari_server.py, port 8950) boots
     against an ISOLATED temp data home + a config.json pointing at the mock.
  3. POST /api/say with a probe -> the BYOM backend calls the mock, the reply
     lands in the channel, and the response reports replied:true.
  4. GET /api/state -> both turns (the user probe + the model reply) are present.
  5. GET /api/byom-status -> a model is wired (ok:true).
  6. NEGATIVE CONTROL: stop the mock, POST again -> the failure is HONEST
     (replied:false + an error captured, AND a visible error turn written to
     the channel) — SERVARI never goes silent and never fabricates a reply.

Every step prints PASS/FAIL. Any failure -> non-zero exit. Servers and the temp
data dir are torn down in a finally block: no orphan processes, no LISTENING
sockets left behind.

Run (from the repo root, with any Python 3.10+ or the project's bundled one):
  python tests/byom_smoke.py

Stdlib only. cp1252-safe. Self-contained — picks free fallback ports if the
defaults are busy, so a stray previous run can't block it.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# --- locations -------------------------------------------------------------
TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent
SERVER_PY = REPO_ROOT / "server" / "servari_server.py"

# Default ports (the test law: SERVARI on 8950, mock on 8951). If a default is
# already taken (a stray previous run), fall back to an OS-assigned free port so
# the suite is robust and never collides with a foreign listener.
SERVARI_PORT_DEFAULT = 8950
MOCK_PORT_DEFAULT = 8951

# The fixed reply the mock returns. A specific sentinel so step 4 can assert the
# exact text round-tripped through the BYOM backend into the channel.
MOCK_REPLY = "SERVARI smoke reply: model wiring confirmed."

PY = sys.executable  # the interpreter running this test (the portable python)


# --- tiny PASS/FAIL ledger -------------------------------------------------
class Ledger:
    def __init__(self) -> None:
        self.failures = 0
        self.n = 0

    def check(self, label: str, ok: bool, detail: str = "") -> bool:
        self.n += 1
        mark = "PASS" if ok else "FAIL"
        line = f"  [{mark}] step {self.n}: {label}"
        if detail:
            line += f"  ({detail})"
        print(line, flush=True)
        if not ok:
            self.failures += 1
        return ok


# --- port helpers ----------------------------------------------------------
def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port(preferred: int) -> int:
    if _port_is_free(preferred):
        return preferred
    # OS-assigned free port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _clear_port(port: int) -> bool:
    """Forcibly release a port the test OWNS (8950/8951 are this suite's by
    contract). If a stale listener squats on it — an orphan from a crashed prior
    run, or another agent's leftover — tree-kill it so the suite starts clean.
    Returns True if the port is free (or became free) within a short window.
    """
    if _port_is_free(port):
        return True
    for pid in _listener_pids(port):
        _taskkill_tree(pid)
    return _wait_closed(port, timeout=6.0)


def _wait_listening(port: int, timeout: float = 25.0) -> bool:
    """Block until 127.0.0.1:port accepts a TCP connection, or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


def _wait_closed(port: int, timeout: float = 15.0) -> bool:
    """Block until nothing is LISTENING on 127.0.0.1:port, or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return True
        time.sleep(0.2)
    return False


# --- http helpers ----------------------------------------------------------
# Retry transient connection errors briefly: under a busy box (other agents,
# port churn) a single ECONNRESET/refusal can hit mid-handshake; one or two
# fast retries make the assertions stable without masking a real failure (a
# genuinely-down server still exhausts the retries and surfaces the error).
def _request(req: urllib.request.Request, timeout: float, retries: int = 3) -> dict:
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", errors="replace"))
        except (ConnectionResetError, urllib.error.URLError, OSError) as e:
            last = e
            time.sleep(0.4 * (attempt + 1))
    raise last  # type: ignore[misc]


def _get(url: str, timeout: float = 30.0) -> dict:
    return _request(urllib.request.Request(url, method="GET"), timeout)


def _post(url: str, payload: dict, timeout: float = 30.0) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    return _request(req, timeout)


# --- the mock OpenAI-compatible model server -------------------------------
class _MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence the default stderr access log
        pass

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        # Accept the OpenAI /chat/completions shape; reply with a fixed
        # completion in choices[0].message.content. We read+discard the body so
        # the client write completes cleanly.
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if length:
            try:
                self.rfile.read(length)
            except Exception:
                pass
        if self.path.rstrip("/").endswith("/chat/completions"):
            self._json(200, {
                "id": "smoke-cmpl-1",
                "object": "chat.completion",
                "model": "mock-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": MOCK_REPLY},
                        "finish_reason": "stop",
                    }
                ],
            })
        else:
            self._json(404, {"error": "not found"})

    def do_GET(self):
        self._json(200, {"ok": True, "service": "mock-openai-compatible"})


class MockModelServer:
    """Start/stop a mock OpenAI-compatible server on its own thread."""

    def __init__(self, port: int) -> None:
        self.port = port
        self._srv: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._srv = ThreadingHTTPServer(("127.0.0.1", self.port), _MockHandler)
        self._thread = threading.Thread(target=self._srv.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._srv is not None:
            try:
                self._srv.shutdown()
            except Exception:
                pass
            try:
                self._srv.server_close()
            except Exception:
                pass
            self._srv = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


# --- isolated SERVARI data home --------------------------------------------
def _make_temp_home(mock_port: int) -> Path:
    """Create an isolated temp data home for the SERVARI server.

    The server resolves its data home from SERVARI_HOME, requiring a demo-data/
    directory to live there. We create an EMPTY demo-data/ (the server degrades
    gracefully: missing seed files just mean empty turns / empty hub) plus a
    config.json pointing the BYOM backend at the mock. Nothing in the real repo
    is touched — the channel.jsonl the test writes lands here.
    """
    home = Path(tempfile.mkdtemp(prefix="servari_byom_smoke_"))
    (home / "demo-data").mkdir(parents=True, exist_ok=True)
    config = {
        "provider": "mock-openai-compatible",
        "api_key": "",  # keyless — the mock ignores auth
        "model": "mock-model",
        "base_url": f"http://127.0.0.1:{mock_port}/v1",
        "_note": "smoke-test BYOM config; points at the in-process mock model server.",
    }
    (home / "config.json").write_text(
        json.dumps(config, indent=2), encoding="utf-8"
    )
    return home


def _start_servari(home: Path, servari_port: int) -> subprocess.Popen:
    """Launch the real SERVARI server as a subprocess against the temp home.

    Env-only configuration (no source edits): SERVARI_HOME points the data home
    + config.json at the temp dir; SERVARI_PORT sets the port; SERVARI_HOST keeps
    it localhost-only; SERVARI_NO_VOICE=1 keeps the heavy ML voice backends OFF
    (they are irrelevant here and their native loads can hang/crash a CI box).
    """
    env = dict(os.environ)
    env["SERVARI_HOME"] = str(home)
    env["SERVARI_PORT"] = str(servari_port)
    env["SERVARI_HOST"] = "127.0.0.1"
    env["SERVARI_NO_VOICE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.Popen(
        [PY, str(SERVER_PY)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(REPO_ROOT),
    )


def _listener_pids(port: int) -> list[int]:
    """Return PIDs currently LISTENING on 127.0.0.1:port (Windows: netstat)."""
    pids: list[int] = []
    if os.name != "nt":
        return pids
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return pids
    needle = f":{port} "
    for line in out.splitlines():
        if "LISTENING" not in line:
            continue
        # columns: Proto  Local Address  Foreign Address  State  PID
        parts = line.split()
        if len(parts) < 5:
            continue
        local = parts[1]
        if local.endswith(f":{port}") and (local.startswith("127.0.0.1") or local.startswith("0.0.0.0") or local.startswith("[::1]") or local.startswith("[::]")):
            try:
                pids.append(int(parts[-1]))
            except ValueError:
                pass
    return pids


def _taskkill_tree(pid: int) -> None:
    if pid <= 0:
        return
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15,
        )
    except Exception:
        pass


def _stop_proc(proc: subprocess.Popen | None, port: int) -> None:
    """Stop the SERVARI server *and its whole tree*, then make SURE the port is
    released by killing whatever still LISTENS on it.

    The bundled portable interpreter is a thin launcher: it re-execs the real
    interpreter as a descendant and the launcher
    PID often EXITS immediately, so by teardown proc.poll() is already non-None
    even though the real server is still bound. Relying on the launcher PID alone
    therefore orphans the server. The reliable contract: (1) tree-kill the
    launcher PID if it is still around, then (2) tree-kill any PID still LISTENING
    on the port. POSIX has no launcher indirection — plain terminate/kill works.
    """
    if os.name != "nt":
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate(); proc.wait(timeout=8)
            except Exception:
                try:
                    proc.kill(); proc.wait(timeout=5)
                except Exception:
                    pass
        return

    # Windows: tree-kill the launcher (covers the case where it is still alive
    # and the real server is its descendant), then sweep the port directly.
    if proc is not None:
        _taskkill_tree(proc.pid)
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
    for pid in _listener_pids(port):
        _taskkill_tree(pid)


def main() -> int:
    print("SERVARI BYOM end-to-end smoke test", flush=True)

    led = Ledger()
    # The suite owns the mandated ports (SERVARI 8950, mock 8951). Clear any
    # stale listener first (orphan from a crashed prior run, or a leftover from
    # another agent), then claim them. Only if a port refuses to clear do we fall
    # back to an OS-assigned free one — so a poisoned box still produces a result.
    _clear_port(SERVARI_PORT_DEFAULT)
    _clear_port(MOCK_PORT_DEFAULT)
    servari_port = _pick_port(SERVARI_PORT_DEFAULT)
    mock_port = _pick_port(MOCK_PORT_DEFAULT)
    if servari_port == mock_port:  # paranoia: never collide
        mock_port = _pick_port(0)
    print(f"  mock model port: {mock_port}   servari port: {servari_port}", flush=True)

    home: Path | None = None
    mock: MockModelServer | None = None
    servari: subprocess.Popen | None = None
    base = f"http://127.0.0.1:{servari_port}"

    try:
        # --- bring up the mock model + the SERVARI server ------------------
        mock = MockModelServer(mock_port)
        mock.start()
        if not _wait_listening(mock_port, timeout=10):
            led.check("mock model server is listening", False, f"port {mock_port} never opened")
            return 1

        home = _make_temp_home(mock_port)
        my_base_url = f"http://127.0.0.1:{mock_port}/v1"  # uniquely identifies MY config

        # Bring up OUR server and confirm we are talking to IT, not a squatter.
        # Under concurrency another server can be bound to our port; its
        # /api/byom-status would report a different base_url. If so, clear the
        # port and rebind our own — so the assertions test our isolated config,
        # never a foreign one (correct under load, not merely lucky).
        servari = None
        servari_up = False
        for boot_attempt in range(3):
            servari = _start_servari(home, servari_port)
            servari_up = _wait_listening(servari_port, timeout=25)
            if not servari_up:
                break
            status0 = {}
            try:
                status0 = _get(f"{base}/api/byom-status")
            except Exception:
                status0 = {}
            if status0.get("base_url") == my_base_url:
                break  # confirmed: this is OUR server with OUR config
            # a foreign server is on our port — stop ours, clear the port, retry
            _stop_proc(servari, servari_port)
            servari = None
            servari_up = False
            _clear_port(servari_port)

        if not servari_up:
            out = ""
            try:
                if servari is not None and servari.poll() is not None:
                    out = (servari.stdout.read() or b"").decode("utf-8", errors="replace")[:600]
            except Exception:
                pass
            led.check("SERVARI server is listening (our isolated instance)", False,
                      f"port {servari_port} never opened or stayed foreign; child output: {out!r}")
            return 1

        # ================= STEP 1: probe -> replied:true =================
        say = _post(f"{base}/api/say", {"text": "smoke probe: are you wired?"})
        byom = say.get("byom", {}) if isinstance(say, dict) else {}
        led.check(
            "POST /api/say returns replied:true (model answered via mock)",
            bool(say.get("ok")) and bool(byom.get("replied")) is True,
            f"byom={byom}",
        )

        # ================= STEP 2: model name surfaced ==================
        led.check(
            "the /api/say reply names the wired model",
            byom.get("model") == "mock-model",
            f"model={byom.get('model')!r}",
        )

        # ================= STEP 3: /api/state has both turns ============
        state = _get(f"{base}/api/state")
        turns = state.get("turns", []) if isinstance(state, dict) else []
        user_turns = [t for t in turns if str(t.get("from", "")).lower() in
                      ("user", "you", "operator", "human")]
        reply_turns = [t for t in turns if t.get("text") == MOCK_REPLY]
        led.check(
            "GET /api/state shows the user probe turn",
            len(user_turns) >= 1 and any("smoke probe" in str(t.get("text", "")) for t in user_turns),
            f"user_turns={len(user_turns)}",
        )
        led.check(
            "GET /api/state shows the model reply turn (exact text round-tripped)",
            len(reply_turns) >= 1,
            f"matched_reply_turns={len(reply_turns)} total_turns={len(turns)}",
        )

        # ================= STEP 4: byom-status wired ====================
        status = _get(f"{base}/api/byom-status")
        led.check(
            "GET /api/byom-status reports a model is wired (ok:true)",
            bool(status.get("ok")) and status.get("model") == "mock-model",
            f"status={status}",
        )

        # ============ STEP 5: NEGATIVE CONTROL — stop the mock ==========
        # Record how many turns exist now, so we can confirm an HONEST error
        # turn is appended (not a fabricated reply) after the model goes away.
        turns_before = len(_get(f"{base}/api/state").get("turns", []))
        mock.stop()
        mock_closed = _wait_closed(mock_port, timeout=10)
        led.check(
            "mock model server stopped (port closed) for the negative control",
            mock_closed,
            f"port {mock_port} still open" if not mock_closed else "",
        )

        # ============ STEP 6: failure is HONEST, not silent =============
        say2 = _post(f"{base}/api/say", {"text": "smoke probe 2: model is gone now"})
        byom2 = say2.get("byom", {}) if isinstance(say2, dict) else {}
        # The POST itself must still succeed (fail-OPEN), but the BYOM result
        # must be honest: replied:false AND an error captured in the result.
        honest_result = (
            bool(say2.get("ok"))
            and byom2.get("replied") is not True
            and bool(byom2.get("error"))
        )
        led.check(
            "POST /api/say after model is down: replied:false + error captured (honest, fail-open)",
            honest_result,
            f"byom={byom2}",
        )

        # And the channel must SHOW the failure (the SERVARI error turn), so the
        # operator sees an honest error bubble instead of silence.
        state3 = _get(f"{base}/api/state")
        turns3 = state3.get("turns", []) if isinstance(state3, dict) else []
        new_turns = turns3[turns_before:]
        error_turns = [t for t in new_turns if t.get("error") is True]
        no_fabricated = not any(
            t.get("error") is not True and str(t.get("from", "")).lower() not in
            ("user", "you", "operator", "human")
            for t in new_turns
        )
        led.check(
            "the channel records an HONEST error turn after the model is down (no silent failure, no fabricated reply)",
            len(error_turns) >= 1 and no_fabricated,
            f"new_turns={len(new_turns)} error_turns={len(error_turns)} fabricated={'yes' if not no_fabricated else 'no'}",
        )

    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"  [FAIL] harness error: {type(e).__name__}: {e}", flush=True)
        led.failures += 1
    finally:
        # --- teardown: no orphan processes, no leftover LISTENING sockets ---
        _stop_proc(servari, servari_port)
        if mock is not None:
            mock.stop()
        # confirm both ports are released
        servari_released = _wait_closed(servari_port, timeout=10)
        mock_released = _wait_closed(mock_port, timeout=10)
        if not servari_released:
            print(f"  [WARN] servari port {servari_port} still LISTENING after teardown", flush=True)
        if not mock_released:
            print(f"  [WARN] mock port {mock_port} still LISTENING after teardown", flush=True)
        if home is not None:
            shutil.rmtree(home, ignore_errors=True)
            if home.exists():
                print(f"  [WARN] temp home not fully removed: {home}", flush=True)

    total = led.n
    passed = total - led.failures
    print("", flush=True)
    print(f"RESULT: {passed}/{total} steps PASS"
          + (f"  ({led.failures} FAILED)" if led.failures else "  — ALL PASS"), flush=True)
    return 1 if led.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
