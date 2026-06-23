#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_security_guard.py — automated coverage for SERVARI's local-trust guard.

Spins the REAL servari_server on a temp port against an ISOLATED temp
SERVARI_HOME (mirroring byom_smoke's server-launch + verify_all's loopback POST
discipline), then asserts the CSRF / DNS-rebinding guard on a state-changing
route behaves correctly:

  1. POST with Origin: http://evil.example            -> REJECTED (403 untrusted)
  2. POST with Sec-Fetch-Site: cross-site             -> REJECTED (403 untrusted)
  3. POST with a NON-loopback Host header             -> REJECTED (403 untrusted)
  4. same-origin / loopback POST (no Origin, JSON)    -> ACCEPTED (200)

It also exercises the engine-spawn input validation directly (in-process import,
no subprocess) — the highest-value RCE/LAN-exposure guards:

  5. _engine_start rejects a NON-loopback host        (engine_input_rejected)
  6. _engine_start rejects a NON-python binary        (engine_input_rejected)

STDLIB ONLY — no pytest. Prints PASS/FAIL per check + a 'RESULT: n/n ... ALL PASS'
line; exits 0 on success, 1 on failure. Servers and the temp home are torn down
in a finally block (no orphan processes, no leftover LISTENING sockets).

Run (from the repo root):
    python tests/test_security_guard.py
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent
SERVER_DIR = REPO_ROOT / "server"
SERVER_PY = SERVER_DIR / "servari_server.py"
ENGINE_DIR = REPO_ROOT / "engine"

PY = sys.executable
GUARDED_ROUTE = "/api/set-autonomy"  # a state-changing route on _GUARDED_POST_PATHS


class Ledger:
    def __init__(self) -> None:
        self.failures = 0
        self.n = 0

    def check(self, label: str, ok: bool, detail: str = "") -> bool:
        self.n += 1
        mark = "PASS" if ok else "FAIL"
        line = f"  [{mark}] check {self.n}: {label}"
        if detail:
            line += f"  ({detail})"
        print(line, flush=True)
        if not ok:
            self.failures += 1
        return ok


# --- port helpers (byom_smoke pattern) -------------------------------------
def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_listening(port: int, timeout: float = 25.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


def _wait_closed(port: int, timeout: float = 12.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return True
        time.sleep(0.2)
    return False


# --- raw HTTP POST so we control every header (incl. Host) precisely --------
def _raw_post(port: int, path: str, body: dict, headers: dict | None = None,
              timeout: float = 10.0) -> tuple[int, str]:
    """Send a raw HTTP/1.1 POST over a socket and return (status_code, body_text).

    Raw sockets (not urllib) so the test can set an arbitrary Host / Origin /
    Sec-Fetch-Site — urllib would overwrite Host with the connect address and
    strip our control over the rebinding case.
    """
    payload = json.dumps(body).encode("utf-8")
    hdrs = {
        "Host": "127.0.0.1:%d" % port,
        "Content-Type": "application/json",
        "Content-Length": str(len(payload)),
        "Connection": "close",
    }
    if headers:
        hdrs.update(headers)
    head = "POST %s HTTP/1.1\r\n" % path
    head += "".join(f"{k}: {v}\r\n" for k, v in hdrs.items())
    head += "\r\n"
    raw = head.encode("utf-8") + payload

    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.settimeout(timeout)
        s.sendall(raw)
        chunks = []
        while True:
            try:
                b = s.recv(65536)
            except socket.timeout:
                break
            if not b:
                break
            chunks.append(b)
    data = b"".join(chunks).decode("utf-8", errors="replace")
    status = 0
    if data.startswith("HTTP/"):
        try:
            status = int(data.split(" ", 2)[1])
        except Exception:
            status = 0
    body_text = data.split("\r\n\r\n", 1)[1] if "\r\n\r\n" in data else ""
    return status, body_text


def _make_temp_home() -> Path:
    home = Path(tempfile.mkdtemp(prefix="servari_secguard_test_"))
    (home / "demo-data").mkdir(parents=True, exist_ok=True)
    return home


def _start_servari(home: Path, port: int) -> subprocess.Popen:
    env = dict(os.environ)
    env["SERVARI_HOME"] = str(home)
    env["SERVARI_PORT"] = str(port)
    env["SERVARI_HOST"] = "127.0.0.1"
    env["SERVARI_NO_VOICE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.Popen(
        [PY, str(SERVER_PY)], env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(REPO_ROOT),
    )


def _listener_pids(port: int) -> list[int]:
    pids: list[int] = []
    if os.name != "nt":
        return pids
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return pids
    for line in out.splitlines():
        if "LISTENING" not in line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        local = parts[1]
        if local.endswith(f":{port}") and (
            local.startswith("127.0.0.1") or local.startswith("0.0.0.0")
            or local.startswith("[::1]") or local.startswith("[::]")
        ):
            try:
                pids.append(int(parts[-1]))
            except ValueError:
                pass
    return pids


def _taskkill_tree(pid: int) -> None:
    if pid <= 0:
        return
    try:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=15)
    except Exception:
        pass


def _stop_proc(proc: subprocess.Popen | None, port: int) -> None:
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
    if proc is not None:
        _taskkill_tree(proc.pid)
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
    for pid in _listener_pids(port):
        _taskkill_tree(pid)


def main() -> int:
    print("SERVARI security-guard test (CSRF/rebinding guard + engine input)",
          flush=True)
    led = Ledger()

    home: Path | None = None
    servari: subprocess.Popen | None = None
    port = _pick_port()

    try:
        # ============ engine input validation (in-process, no subprocess) ====
        # Import the server module to call _engine_start directly. These guards
        # are the RCE / LAN-exposure barriers; cheapest to test in-process.
        if str(SERVER_DIR) not in sys.path:
            sys.path.insert(0, str(SERVER_DIR))
        os.environ.setdefault("SERVARI_NO_VOICE", "1")
        import servari_server as ss  # noqa: E402

        # 5) non-loopback host rejected. Use a valid engine home (engine/ has
        # app.py) so the rejection is provably the HOST check, not a missing app.
        bad_host = ss._engine_start({"home": str(ENGINE_DIR),
                                     "host": "0.0.0.0", "port": 0})
        led.check("_engine_start rejects a non-loopback host",
                  bad_host.get("ok") is False
                  and bad_host.get("error") == "engine_input_rejected",
                  f"{bad_host.get('error')}: {bad_host.get('message')}")

        # 6) non-python binary rejected. Drop a real non-python file and point the
        # python interpreter at it; loopback host so HOST check passes first.
        tmp_bin = Path(tempfile.mkdtemp(prefix="servari_secguard_bin_"))
        fake = tmp_bin / "calc.exe"
        fake.write_bytes(b"MZ not really an interpreter")
        try:
            bad_py = ss._engine_start({"home": str(ENGINE_DIR),
                                       "host": "127.0.0.1", "port": 0,
                                       "python": str(fake)})
            led.check("_engine_start rejects a non-python binary",
                      bad_py.get("ok") is False
                      and bad_py.get("error") == "engine_input_rejected",
                      f"{bad_py.get('error')}: {bad_py.get('message')}")
        finally:
            shutil.rmtree(tmp_bin, ignore_errors=True)

        # ============ spin the real server for the HTTP guard checks =========
        home = _make_temp_home()
        servari = _start_servari(home, port)
        if not _wait_listening(port, timeout=25):
            out = ""
            try:
                if servari.poll() is not None:
                    out = (servari.stdout.read() or b"").decode(
                        "utf-8", errors="replace")[:600]
            except Exception:
                pass
            led.check("SERVARI server is listening", False,
                      f"port {port} never opened; child output: {out!r}")
            return 1
        led.check("SERVARI server is listening (isolated temp home)", True,
                  f"port={port}")

        approve_body = {"agent": "secguard-agent", "level": 3}

        # 1) cross-origin Origin -> REJECTED
        st, _ = _raw_post(port, GUARDED_ROUTE, approve_body,
                          headers={"Origin": "http://evil.example"})
        led.check("POST with Origin: http://evil.example is REJECTED (403)",
                  st == 403, f"status={st}")

        # 2) Sec-Fetch-Site: cross-site -> REJECTED
        st, _ = _raw_post(port, GUARDED_ROUTE, approve_body,
                          headers={"Sec-Fetch-Site": "cross-site"})
        led.check("POST with Sec-Fetch-Site: cross-site is REJECTED (403)",
                  st == 403, f"status={st}")

        # 3) non-loopback Host header (DNS-rebinding) -> REJECTED
        st, _ = _raw_post(port, GUARDED_ROUTE, approve_body,
                          headers={"Host": "evil.example"})
        led.check("POST with a non-loopback Host header is REJECTED (403)",
                  st == 403, f"status={st}")

        # 4) same-origin / loopback (no Origin, loopback Host, JSON) -> ACCEPTED
        st, body_text = _raw_post(port, GUARDED_ROUTE, approve_body)
        accepted = st == 200
        # extra signal: an accepted request reaches the handler (not a 403 body)
        try:
            parsed = json.loads(body_text) if body_text else {}
        except Exception:
            parsed = {}
        not_untrusted = parsed.get("error") != "untrusted_origin"
        led.check("same-origin/loopback POST is ACCEPTED (200, reached handler)",
                  accepted and not_untrusted,
                  f"status={st} body={parsed}")

    except Exception as e:
        import traceback
        print(f"  [FAIL] harness error: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        led.failures += 1
    finally:
        _stop_proc(servari, port)
        released = _wait_closed(port, timeout=10)
        if not released:
            print(f"  [WARN] port {port} still LISTENING after teardown",
                  flush=True)
        if home is not None:
            shutil.rmtree(home, ignore_errors=True)

    total = led.n
    passed = total - led.failures
    print("", flush=True)
    print(f"RESULT: {passed}/{total} checks PASS"
          + (f"  ({led.failures} FAILED)" if led.failures else "  — ALL PASS"),
          flush=True)
    return 1 if led.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
