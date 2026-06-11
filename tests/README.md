# SERVARI tests

Regression tests for the SERVARI server, in two layers:

1. **`test_*.py` — the pytest unit suite** for the server core modules
   (autonomy, verify_queue, retention, health, chat_byom, the action
   allow-list). Stdlib + pytest only; no network, no real API keys; every test
   runs against an isolated temp data home (`SERVARI_HOME`), so the repo's own
   `demo-data/` and `config.json` are never touched.
2. **`byom_smoke.py` — the stdlib-only end-to-end smoke test** that boots the
   real server and drives it over HTTP (no pytest needed).

## Run the pytest suite

From the repo root (install once with `python -m pip install pytest`):

```
python -m pytest tests/ -q
```

What it covers, at minimum:

- **autonomy hard gate** — high-risk scores (>16) queue for a human at EVERY
  level, even L5 full-auto; invalid scores fail closed to queue.
- **verify queue** — the gate-queue audit is append-only (prior bytes are a
  byte-prefix of the file after every decision); pending resolves by replay;
  double-decide never re-decides.
- **retention** — KEEP on improvement/tie, REVERT with byte-exact restore on
  degradation, fail-closed REVERT when a metric cannot run, decide-once.
- **health** — fail-closed verdict (unproven != OK), a pending gate is workflow
  state (never flips the verdict red), CLI exits 0 and reports in the body.
- **BYOM honesty** — missing/broken config produces an honest "configure your
  model" reply (never fabricated, never a crash, never a network call); model
  failures surface as captured errors with empty text.
- **action runner** — the allow-list is closed; unknown actions are refused.

## byom_smoke.py — bring-your-own-model end-to-end smoke test

Proves the BYOM (bring-your-own-model) chat path works end to end, with no real
network call and no real API key, so it can run anywhere on every change.

What it does:

1. Starts a **mock OpenAI-compatible model server** (port 8951) that answers
   `/chat/completions` with a fixed `choices[0].message.content` reply.
2. Boots the **real SERVARI server** (`server/servari_server.py`, port 8950)
   against an **isolated temporary data home** and a `config.json` that points
   the chat backend at the mock. Nothing in the repo's own data is touched.
3. Runs the assertion sequence:
   - `POST /api/say` with a probe -> the response reports `replied: true` and
     names the wired model.
   - `GET /api/state` -> both the user probe turn and the exact model reply turn
     are present in the channel.
   - `GET /api/byom-status` -> a model is wired (`ok: true`).
   - **Negative control:** stop the mock model, `POST /api/say` again -> the
     failure is **honest** — `replied: false`, the error is captured, and a
     visible error turn is written to the channel. The server never goes silent
     and never fabricates a reply.
4. Prints `PASS`/`FAIL` per step and exits non-zero on any failure.
5. Cleans up its servers and the temp data home in a `finally` block — no orphan
   processes and no leftover listening sockets.

### Run it

(Excluded from pytest collection by name on purpose — run it directly.)

From the repo root, with any Python 3.10+ on your PATH:

```
python tests/byom_smoke.py
```

No project-specific interpreter is required — any Python 3.9+ interpreter with
pytest installed can also run the full unit suite:

```
python -m pytest tests/ -q
```

Exit code `0` = all steps passed. Non-zero = at least one step failed (the
failing step prints why).

### Notes

- The test prefers ports **8950** (SERVARI) and **8951** (mock). It clears a
  stale listener it finds on those ports at startup, and falls back to an
  OS-assigned free port if one cannot be cleared, so a previous crashed run never
  blocks it.
- The bundled interpreter is a thin launcher that re-execs the real interpreter
  as a child process; teardown therefore kills the whole process tree (and any
  leftover listener on the test port) rather than just the launched PID.
- No real provider key is needed — the mock is keyless.
