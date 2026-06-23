# SERVARI Execution Engine

This is the engine SERVARI's `/api/engine/start` launches — the piece that
**closes the autonomy loop**. Until it existed, an approved gate-queue item went
nowhere; SERVARI could park and approve work but never _do_ it. The engine is the
executor that turns an approval into a (safe) action.

## What it does

The loop is `autonomy -> verify_queue -> execute`:

1. `server/verify_queue.py` parks gated actions; the operator approves/rejects.
2. `server/autonomy.py` turns `(agent level + risk score)` into `act | report | queue`.
3. `server/executor.py` (this engine's core) walks the **approved** entries and,
   for each one not run before, executes it **only if** the verdict is `act`
   **and** the action is in the executor allow-list. Everything else is recorded
   as `skipped` with a reason.

`engine/app.py` runs that core: on startup it spawns a daemon thread calling
`executor.run_once()` about every 3 seconds.

## How SERVARI launches it

`/api/engine/start` finds `app.py` under a candidate home (one candidate is
`<repo>/engine`) and runs either:

```
python -m uvicorn app:app --host 127.0.0.1 --port 7000   # if uvicorn is present
python app.py --host 127.0.0.1 --port 7000               # stdlib fallback
```

Both paths serve the same contract:

| Route                   | Response                                        |
| ----------------------- | ----------------------------------------------- |
| `GET /api/health`       | `200 {"ok": true, "service": "servari-engine"}` |
| `GET /api/ready`        | `200 {"ok": true, "service": "servari-engine"}` |
| `GET /api/engine-state` | `200` -> `executor.state()` (live counters)     |

## Safety stance

- **Allow-list only.** The executor runs read-only / diagnostic actions
  (`python-version`, `disk-free`, `workspace-health`, `public-verification`,
  `rss-refresh`). There is **no** deploy / spend / send / publish — those stay
  parked in the gate queue and are absent from the allow-list, so they can never
  execute autonomously. Hard-gate classes also map to the refuse risk band, so
  `autonomy.decide()` can never return `act` for them — defense in depth.
- **Exactly-once.** Executed ids are tracked in the append-only
  `demo-data/engine-executed.jsonl`; an item is never run twice. A re-run is a
  strict no-op.
- **Fail-closed.** Any error in a tick is recorded and swallowed; the loop and
  server never crash.
- **Stdlib only.** No runtime pip dependency (per `AGENTS.md`). The ASGI callable
  is a plain `async def` — no uvicorn/fastapi import.

## Verify the core

```
python server/executor.py --self-test     # -> PASS, exit 0
```
