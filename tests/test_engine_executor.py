#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_engine_executor.py — automated coverage for the SERVARI execution engine.

Exercises server/executor.py end-to-end and engine/app.py's ASGI contract, each
inside an ISOLATED temp SERVARI_HOME (the verify_all.py discipline) so nothing
touches the real demo-data/. STDLIB ONLY — no pytest. Prints PASS/FAIL per check
and a 'RESULT: n/n ... ALL PASS' summary line; exits 0 on success, 1 on failure.

What it proves (real product behaviour, not mocks of the unit under test):

  executor.py
    1. an APPROVED, allow-listed action under a safe gate executes EXACTLY ONCE;
    2. a second run_once() over the same item is a strict NO-OP (never twice);
    3. a HIGH-RISK gate (deploy) that is approved is QUEUED/skipped, not executed;
    4. an UNKNOWN gate that is approved is QUEUED/skipped (defaults to high risk);
    5. state().running is False when the last tick is stale;
    6. a malformed / empty executed-log does not crash run_once() or state().

  engine/app.py
    7. the ASGI 'app' callable answers /api/health with the health/ready shape
       (200 + {"ok": true, "service": "servari-engine"}) when driven with a tiny
       fake scope/receive/send.

Run (from the repo root):
    python tests/test_engine_executor.py
"""
from __future__ import annotations

import asyncio
import datetime
import importlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parent
SERVER_DIR = REPO_ROOT / "server"
ENGINE_DIR = REPO_ROOT / "engine"

for _p in (str(SERVER_DIR), str(ENGINE_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)


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


def _fresh_home() -> Path:
    """An isolated temp data home with an empty demo-data/ (mirrors verify_all)."""
    home = Path(tempfile.mkdtemp(prefix="servari_executor_test_"))
    (home / "demo-data").mkdir(parents=True, exist_ok=True)
    return home


def _point_modules_at(home: Path, executor, autonomy, verify_queue) -> None:
    """Repoint env + the cached module globals at the isolated home.

    verify_queue caches ROOT/QUEUE at import time from its own _home(); autonomy
    and executor re-resolve home per call from SERVARI_HOME, so setting the env
    plus verify_queue's two globals fully isolates all three modules.
    """
    os.environ["SERVARI_HOME"] = str(home)
    verify_queue.ROOT = home
    verify_queue.QUEUE = home / "demo-data" / "gate-queue.jsonl"


def main() -> int:
    print("SERVARI execution-engine test (executor.py + engine/app.py)", flush=True)
    led = Ledger()

    import executor          # noqa: E402
    import autonomy          # noqa: E402
    import verify_queue      # noqa: E402

    prev_home = os.environ.get("SERVARI_HOME")
    homes: list[Path] = []

    try:
        # ============ executor.py: exactly-once + gate barriers ============
        home = _fresh_home(); homes.append(home)
        _point_modules_at(home, executor, autonomy, verify_queue)

        # An approved, allow-listed action under a safe gate, with the agent at
        # L5 so the safe band returns verdict 'act'. read-only -> risk 4.
        eid = verify_queue.enqueue(agent="t-agent", gate="read-only",
                                   action="python-version", summary="exactly-once")
        led.check("enqueue returns an id", bool(eid), f"id={eid!r}")
        set_res = autonomy.set_level("t-agent", 5)
        led.check("autonomy.set_level(L5) ok", bool(set_res.get("ok")), f"{set_res}")

        # before approval -> nothing runs
        r0 = executor.run_once()
        led.check("run_once before approval executes nothing",
                  r0.get("executed") == 0, f"{r0}")

        upd = verify_queue.decide(eid, "approve", "approve")
        led.check("verify_queue.decide -> approved",
                  upd.get("status") == "approved", f"{upd}")

        # 1) approved + allow-listed -> EXACTLY ONCE
        r1 = executor.run_once()
        led.check("approved allow-listed action executes exactly once",
                  r1.get("executed") == 1, f"{r1}")
        st1 = executor.state()
        led.check("state().executed_count == 1 after first run",
                  st1.get("executed_count") == 1, f"{st1}")

        # 2) second run -> strict NO-OP
        r2 = executor.run_once()
        led.check("second run_once is a strict no-op (never executes twice)",
                  r2.get("executed") == 0 and r2.get("skipped") == 0, f"{r2}")
        st2 = executor.state()
        led.check("state().executed_count unchanged on re-run",
                  st2.get("executed_count") == 1, f"{st2}")

        # 3) HIGH-RISK gate (deploy), approved -> QUEUED/skipped, NOT executed
        eid2 = verify_queue.enqueue(agent="t-agent", gate="deploy",
                                    action="disk-free", summary="high-risk gate")
        verify_queue.decide(eid2, "approve", "approved but high-risk")
        r3 = executor.run_once()
        led.check("high-risk gate (deploy) is queued/skipped, not executed",
                  r3.get("executed") == 0 and r3.get("skipped") == 1, f"{r3}")

        # 4) UNKNOWN gate, approved -> QUEUED/skipped (defaults to high risk)
        eid3 = verify_queue.enqueue(agent="t-agent", gate="totally-unknown-gate",
                                    action="workspace-health", summary="unknown gate")
        verify_queue.decide(eid3, "approve", "approved but unknown gate")
        r4 = executor.run_once()
        led.check("unknown gate is queued/skipped, not executed",
                  r4.get("executed") == 0 and r4.get("skipped") == 1, f"{r4}")

        # 5) state().running is False when the last tick is stale
        from executor import _RUNNING_WINDOW_SECONDS, _append_event, _log_path
        old_ts = (datetime.datetime.now(datetime.timezone.utc)
                  - datetime.timedelta(seconds=_RUNNING_WINDOW_SECONDS + 120)
                  ).isoformat(timespec="seconds")
        _append_event({"id": "stale-probe", "action": "", "agent": "", "gate": "",
                       "verdict": "skipped", "status": "skipped", "ok": False,
                       "out_excerpt": "", "reason": "stale", "ts": old_ts})
        st_stale = executor.state()
        led.check("state().running is False when last tick is stale",
                  st_stale.get("running") is False, f"running={st_stale.get('running')}")

        # 6a) a MALFORMED executed-log does not crash run_once()/state()
        bad_home = _fresh_home(); homes.append(bad_home)
        _point_modules_at(bad_home, executor, autonomy, verify_queue)
        log = _log_path()
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text("{not json at all\n\n   \n{\"id\": \"x\"}\n}}}garbage\n",
                       encoding="utf-8")
        crashed = False
        try:
            executor.run_once()
            _ = executor.state()
        except Exception as e:  # pragma: no cover - failure path
            crashed = True
            led.check("malformed executed-log does not crash", False,
                      f"{type(e).__name__}: {e}")
        if not crashed:
            led.check("malformed executed-log does not crash run_once()/state()", True)

        # 6b) an EMPTY queue / empty log -> clean running=False, no crash.
        #
        # Two distinct properties are asserted, and they MUST be read in the
        # right order, because run_once() always writes a per-tick heartbeat
        # ({status:'tick'}) by design (that heartbeat is exactly what makes an
        # idle-but-alive engine report running=True — see executor.state()'s
        # contract and the executor self-test's idle-heartbeat case). So:
        #
        #   - state() on a GENUINELY empty log (before any run_once heartbeat)
        #     must be running=False with an empty last_tick; read it FIRST.
        #   - run_once() over an empty queue must still return ok with zero
        #     counters and not crash; read it AFTER (it writes the heartbeat).
        empty_home = _fresh_home(); homes.append(empty_home)
        _point_modules_at(empty_home, executor, autonomy, verify_queue)
        st_empty = executor.state()          # BEFORE any tick -> truly empty log
        led.check("empty log: state().running False and last_tick empty",
                  st_empty.get("running") is False and st_empty.get("last_tick") == "",
                  f"{st_empty}")
        r_empty = executor.run_once()        # writes the heartbeat tick line
        led.check("empty queue: run_once returns ok with zero counters and no crash",
                  r_empty.get("ok") is True and r_empty.get("executed") == 0,
                  f"{r_empty}")

        # ================= engine/app.py: ASGI health contract =================
        # Reload app under a fresh isolated home so its import-time executor loop
        # and state() target the temp dir, not real demo-data.
        asgi_home = _fresh_home(); homes.append(asgi_home)
        _point_modules_at(asgi_home, executor, autonomy, verify_queue)
        if "app" in sys.modules:
            del sys.modules["app"]
        app_mod = importlib.import_module("app")

        async def _drive(path: str) -> dict:
            """Call the ASGI app with a tiny fake scope/receive/send; collect the
            response start + body and return {status, json}."""
            sent: list = []

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message):
                sent.append(message)

            await app_mod.app({"type": "http", "path": path, "method": "GET"},
                              receive, send)
            status = None
            body = b""
            for m in sent:
                if m.get("type") == "http.response.start":
                    status = m.get("status")
                elif m.get("type") == "http.response.body":
                    body += m.get("body", b"")
            try:
                parsed = json.loads(body.decode("utf-8")) if body else {}
            except Exception:
                parsed = {}
            return {"status": status, "json": parsed}

        health = asyncio.run(_drive("/api/health"))
        led.check("ASGI app /api/health returns 200 + health/ready shape",
                  health["status"] == 200
                  and health["json"].get("ok") is True
                  and health["json"].get("service") == "servari-engine",
                  f"{health}")

        ready = asyncio.run(_drive("/api/ready"))
        led.check("ASGI app /api/ready returns 200 + same health shape",
                  ready["status"] == 200
                  and ready["json"].get("ok") is True
                  and ready["json"].get("service") == "servari-engine",
                  f"{ready}")

        notfound = asyncio.run(_drive("/nope"))
        led.check("ASGI app unknown path returns 404 JSON",
                  notfound["status"] == 404
                  and notfound["json"].get("ok") is False,
                  f"{notfound}")

    except Exception as e:  # harness-level failure
        import traceback
        print(f"  [FAIL] harness error: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        led.failures += 1
    finally:
        if prev_home is None:
            os.environ.pop("SERVARI_HOME", None)
        else:
            os.environ["SERVARI_HOME"] = prev_home
        # restore verify_queue globals to its real home
        try:
            verify_queue.ROOT = verify_queue._home()
            verify_queue.QUEUE = verify_queue.ROOT / "demo-data" / "gate-queue.jsonl"
        except Exception:
            pass
        for h in homes:
            shutil.rmtree(h, ignore_errors=True)

    total = led.n
    passed = total - led.failures
    print("", flush=True)
    print(f"RESULT: {passed}/{total} checks PASS"
          + (f"  ({led.failures} FAILED)" if led.failures else "  — ALL PASS"),
          flush=True)
    return 1 if led.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
