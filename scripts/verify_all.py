#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SERVARI public verification harness.

This script is intentionally stdlib-only and network-free. It verifies the public
claims that can be checked on a fresh clone without API keys:

- autonomy hard gate queues high-risk work even at L5
- invalid autonomy scores fail closed to queue
- fast-verify queue records append-only pending + decision events
- BYOM reports honestly when no model config is present
- metric-gated retention KEEP/REVERT self-test passes
- allow-listed action runner refuses unknown actions
- selected HTTP API routes return HTTP 200 JSON
- secret config patterns are gitignored

Output:
  - human-readable checklist on stdout
  - machine-readable report at verification/last-run.json

Exit code:
  - 0 only when every required check passes
  - 1 if any required check fails
"""
from __future__ import annotations

import contextlib
import importlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List

ROOT = Path(__file__).resolve().parents[1]
SERVER_DIR = ROOT / "server"
REPORT_DIR = ROOT / "verification"
REPORT_PATH = REPORT_DIR / "last-run.json"
TEST_HOME = ROOT / "verification" / "_verify_home"
TEST_PORT = 8921

EXPECTED_ACTIONS = {
    "echo-hello",
    "list-demo-agents",
    "disk-free",
    "python-version",
}


def _ensure_paths() -> None:
    sys.path.insert(0, str(SERVER_DIR))
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    if TEST_HOME.exists():
        shutil.rmtree(TEST_HOME)
    shutil.copytree(ROOT / "demo-data", TEST_HOME / "demo-data")


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        return repr(value)


class CheckRunner:
    def __init__(self) -> None:
        self.checks: List[Dict[str, Any]] = []

    def check(self, cid: str, name: str, fn: Callable[[], Any]) -> None:
        try:
            evidence = fn()
            self.checks.append({
                "id": cid,
                "name": name,
                "status": "PASS",
                "evidence": _jsonable(evidence),
                "error": None,
            })
            print(f"PASS {cid} - {name}")
        except Exception as exc:  # noqa: BLE001 - harness must continue
            self.checks.append({
                "id": cid,
                "name": name,
                "status": "FAIL",
                "evidence": None,
                "error": f"{type(exc).__name__}: {exc}",
            })
            print(f"FAIL {cid} - {name}: {type(exc).__name__}: {exc}")

    def ok(self) -> bool:
        return all(c["status"] == "PASS" for c in self.checks)

    def write_report(self) -> None:
        payload = {
            "ok": self.ok(),
            "repo": "servari-open",
            "checks_total": len(self.checks),
            "checks_passed": sum(1 for c in self.checks if c["status"] == "PASS"),
            "checks_failed": sum(1 for c in self.checks if c["status"] == "FAIL"),
            "checks": self.checks,
        }
        REPORT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


@contextlib.contextmanager
def _env(**updates: str):
    old = {k: os.environ.get(k) for k in updates}
    try:
        for k, v in updates.items():
            os.environ[k] = v
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _reload(name: str):
    if name in sys.modules:
        return importlib.reload(sys.modules[name])
    return importlib.import_module(name)


def check_autonomy_l5_high_risk() -> Dict[str, Any]:
    with _env(SERVARI_HOME=str(TEST_HOME)):
        autonomy = _reload("autonomy")
        set_result = autonomy.set_level("verify-agent", 5)
        result = autonomy.decide("verify-agent", 20)
    assert set_result.get("ok") is True, set_result
    assert result.get("level") == 5, result
    assert result.get("verdict") == "queue", result
    return result


def check_autonomy_invalid_fails_closed() -> Dict[str, Any]:
    with _env(SERVARI_HOME=str(TEST_HOME)):
        autonomy = _reload("autonomy")
        result = autonomy.decide("verify-agent", "not-a-score")
    assert result.get("verdict") == "queue", result
    assert result.get("score_band") == "invalid", result
    return result


def check_verify_queue_append_only() -> Dict[str, Any]:
    with _env(SERVARI_HOME=str(TEST_HOME)):
        vq = _reload("verify_queue")
        before = len(vq.history(100000))
        entry_id = vq.enqueue(
            agent="verify-agent",
            gate="publish",
            action="publish-demo-artifact",
            summary="Synthetic verification action; must not execute.",
            detail="Created by scripts/verify_all.py",
            rollback="No-op; synthetic action was never executed.",
        )
        pending = vq.list_pending()
        assert any(e.get("id") == entry_id for e in pending), pending
        decided = vq.decide(entry_id, "approve", "verification approval event")
        assert decided.get("id") == entry_id, decided
        assert decided.get("status") == "approved", decided
        pending_after = vq.list_pending()
        assert not any(e.get("id") == entry_id for e in pending_after), pending_after
        hist = vq.history(100000)
        after = len(hist)
        related = [e for e in hist if e.get("id") == entry_id]
    assert after >= before + 2, {"before": before, "after": after, "related": related}
    assert len(related) >= 2, related
    assert related[0].get("status") == "pending", related
    assert related[-1].get("type") == "decision", related
    return {"id": entry_id, "events_added": after - before, "related_events": related}


def check_byom_no_config_honest() -> Dict[str, Any]:
    with _env(SERVARI_HOME=str(TEST_HOME)):
        cfg = TEST_HOME / "config.json"
        if cfg.exists():
            cfg.unlink()
        chat = _reload("chat_byom")
        status = chat.is_configured()
        reply = chat.reply([{"from": "user", "text": "hello"}])
    assert status.get("ok") is False, status
    assert reply.get("ok") is False, reply
    assert reply.get("error") == "not_configured", reply
    assert "No model is wired" in reply.get("text", ""), reply
    return {"status": status, "reply": reply}


def check_retention_self_test() -> Dict[str, Any]:
    with _env(SERVARI_HOME=str(TEST_HOME)):
        retention = _reload("retention")
        result = retention._self_test()  # public verification of this module's contract
    assert result.get("ok") is True, result
    assert result.get("passed") == result.get("total"), result
    names = {c.get("check") for c in result.get("checks", [])}
    required = {
        "S1.decide==KEEP",
        "S2.decide==REVERT",
        "S2.byte_exact_restore",
        "S3.double_decide_rejected",
    }
    assert required.issubset(names), result
    return result


def check_allow_list_runner() -> Dict[str, Any]:
    with _env(SERVARI_HOME=str(TEST_HOME), SERVARI_PORT=str(TEST_PORT)):
        server = _reload("servari_server")
        actions = set(server.ACTIONS.keys())
        refused = server._run_action("definitely-not-allowed")
    assert actions == EXPECTED_ACTIONS, actions
    assert refused.get("ok") is False, refused
    assert "refused" in refused.get("out", ""), refused
    assert set(refused.get("allowed", [])) == EXPECTED_ACTIONS, refused
    return {"actions": sorted(actions), "unknown_action": refused}


def _wait_for_port(port: int, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise TimeoutError(f"server did not open port {port}")


def _get_json(path: str) -> Dict[str, Any]:
    url = f"http://127.0.0.1:{TEST_PORT}{path}"
    with urllib.request.urlopen(url, timeout=5) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        status = resp.status
    assert status == 200, {"url": url, "status": status, "body": raw[:200]}
    return json.loads(raw)


def check_server_smoke() -> Dict[str, Any]:
    env = os.environ.copy()
    env["SERVARI_HOME"] = str(TEST_HOME)
    env["SERVARI_PORT"] = str(TEST_PORT)
    env["SERVARI_HOST"] = "127.0.0.1"
    env["SERVARI_NO_VOICE"] = "1"
    proc = subprocess.Popen(
        [sys.executable, str(SERVER_DIR / "servari_server.py")],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        _wait_for_port(TEST_PORT)
        payloads = {
            "/api/health": _get_json("/api/health"),
            "/api/autonomy": _get_json("/api/autonomy"),
            "/api/verify-queue": _get_json("/api/verify-queue"),
            "/api/byom-status": _get_json("/api/byom-status"),
            "/api/actions": _get_json("/api/actions"),
        }
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    assert "actions" in payloads["/api/actions"], payloads
    assert set(payloads["/api/actions"]["actions"]) == EXPECTED_ACTIONS, payloads["/api/actions"]
    return payloads


def check_gitignore_secrets() -> Dict[str, Any]:
    text = (ROOT / ".gitignore").read_text(encoding="utf-8", errors="replace")
    required = ["config.json", ".env", ".env.*", "*.env"]
    missing = [p for p in required if p not in text]
    assert not missing, {"missing": missing}
    return {"required_patterns": required}


def main() -> int:
    os.chdir(ROOT)
    _ensure_paths()
    runner = CheckRunner()

    print("SERVARI public verification")
    print("===========================")
    runner.check("V001", "L5 high-risk autonomy queues", check_autonomy_l5_high_risk)
    runner.check("V002", "invalid autonomy score fails closed", check_autonomy_invalid_fails_closed)
    runner.check("V003", "verify queue append-only pending + decision", check_verify_queue_append_only)
    runner.check("V004", "BYOM no-config behavior is honest", check_byom_no_config_honest)
    runner.check("V005", "retention KEEP/REVERT self-test", check_retention_self_test)
    runner.check("V006", "action runner is allow-listed", check_allow_list_runner)
    runner.check("V007", "server smoke routes return HTTP 200 JSON", check_server_smoke)
    runner.check("V008", "secret config patterns are gitignored", check_gitignore_secrets)

    runner.write_report()
    print("===========================")
    print(f"report: {REPORT_PATH.relative_to(ROOT)}")
    print(f"result: {'PASS' if runner.ok() else 'FAIL'} ({sum(1 for c in runner.checks if c['status'] == 'PASS')}/{len(runner.checks)})")
    return 0 if runner.ok() else 1


if __name__ == "__main__":
    raise SystemExit(main())
