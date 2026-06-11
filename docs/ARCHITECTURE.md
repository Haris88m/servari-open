# ARCHITECTURE

SERVARI OS is a **shell**: a React desktop UI over a small Python server. The
intelligence (the model) is yours to bring; the shell is the surface you see and
control. This document describes the public architecture — the server, the UI,
the gates, BYOM, and voice.

```
 ┌──────────────────────────────────────────────┐
 │  React shell (ui/)            served by ↓     │   the FACE
 │  chat · agent grid · org · gates · panels     │
 └───────────────┬──────────────────────────────┘
                 │  same-origin /api/*  (no CORS)
 ┌───────────────▼──────────────────────────────┐
 │  Python server (server/servari_server.py)     │   the SPINE
 └───────────────┬──────────────────────────────┘
                 │  reads / writes
 ┌───────────────▼──────────────────────────────┐
 │  demo-data/   seed data so it renders day one  │   the DATA
 └───────────────────────────────────────────────┘
```

## The server (`server/`)

A single stdlib HTTP server (`servari_server.py`) on `127.0.0.1:8911` that:

- **serves the built SPA** from `ui/dist/` (with a path-traversal-guarded static
  file handler and a clear "build the UI first" page if `dist/` is absent),
- **exposes a JSON API** for every panel,
- **runs an allow-listed action runner** — `/api/run?action=...` can only invoke
  one of a few named, harmless demo actions (echo, list agents, disk-free, python
  version). It is **not** a raw shell; add your own safe actions to the `ACTIONS`
  dict.
- **degrades gracefully** — every backing module loads defensively. If one fails
  to import (or its data file is missing), its routes return a clean
  `{"error": "...", ...empty defaults}` payload with HTTP 200 instead of crashing
  the server. The whole surface is fail-closed.

### The modules

Each is a standalone, stdlib-only, importable + CLI-runnable module:

| module | route(s) | what it is |
|---|---|---|
| `autonomy.py` | `/api/autonomy`, `/api/set-autonomy` | the per-agent **L0–L5 autonomy dial** — composes an agent's level with a risk score into `act` / `report` / `queue`. Even at L5 a high-risk score always queues. |
| `verify_queue.py` | `/api/verify-queue`, `/api/verify-decision` | the **fast-verify gate queue** — parks gated actions (deploy / real-send / spend / publish / merge / secret) as an append-only audit; you approve or reject; nothing acts until approved. |
| `health.py` | `/api/health` | a **fail-closed health surface** — fast file reads only; any unreadable sub-check degrades to UNKNOWN, the whole call never crashes. |
| `retention.py` | `/api/retention`, `/api/retention-decide` | a **metric-gated KEEP/REVERT loop** — snapshots targets, runs a metric suite, and reverts byte-exact if quality degrades. |
| `context_policy.py` | `/api/context`, `/api/context-checkpoint` | the **context-pressure policy** — treats the LLM window as RAM, measures pressure, and verifies "survival pins" are on disk before a compaction is safe. |
| `tokens.py` | `/api/tokens`, `/api/tokens-sessions`, `/api/tokens-report` | a **proof-of-work token tracker** — reads a usage log and prices it at configurable per-million rates. |
| `chat_byom.py` | (via `/api/say`, `/api/byom-status`) | the **BYOM chat backend** — reads `config.json`, calls your model's OpenAI-compatible endpoint, returns the reply. |
| `voice.py` / `voice_neural.py` | `/api/voice-*` | optional **local STT + neural TTS** skeletons (faster-whisper + Piper). Load lazily in a background thread; the port binds first. |
| `providers/*.py` | `/api/jobs`, `/api/applications`, `/api/career`, `/api/inbox`, `/api/finance`, `/api/memory-surface`, `/api/reports` | the **personal-world panels** — each a fail-closed reader over a `demo-data/` file. |
| `hwfit/` | `/api/cookbook/scan`, `/api/cookbook/recommend` | the **Model Cookbook** — hardware-aware local-model recommendations: scans the machine profile (RAM, VRAM, CPU) and recommends open models that fit, from the bundled catalog `hwfit/data/hf_models.json`. MIT-licensed port from the Odysseus project (see `NOTICE`). |
| engine runtime (in `servari_server.py`) | `/api/engine/status`, `/api/engine/logs`, `/api/engine/start`, `/api/engine/stop`, `/api/engine/restart` | the **engine runtime manager** — starts, stops, restarts, and reports on a locally managed subprocess. `start` accepts an interpreter path and working directory from the caller; a trusted-operator surface (see `SECURITY_MODEL.md`). |
| `servari_cli.py` | (terminal entry, no HTTP route) | the **terminal session entry** — runs SERVARI as a persistent interactive CLI session; the public persona is loaded from `SERVARI.md`. |

### Home resolution

Every module resolves its data home the same way, drive-independently:

1. `SERVARI_HOME` environment variable, if set and a directory;
2. otherwise the repo root (the parent of `server/`);
3. otherwise the current working directory.

No drive letters, no hardcoded paths. Point `SERVARI_HOME` at your own data
directory to swap the demo data for real data.

## The UI (`ui/`)

A Vite + React 18 + TypeScript app, styled with Tailwind and shadcn/Radix
primitives, animated with Motion.

- **`src/app/lib/api.ts`** — the typed API client. Every method maps to one server
  route. In production the built app is served by the server (same-origin, no
  CORS); in dev, Vite proxies `/api` to the server.
- **`src/app/lib/display_seal.ts`** — the **display seal**. A small, configurable
  mechanism (`sealLabel` / `sealHide`) that maps internal labels to clean product
  words via a `DISPLAY_MAP` and hides any term in a `DENYLIST`. It seals **chrome**
  (labels, headers, structural text); live chat content is exempt. Configure the
  two arrays for your deployment.
- **`src/app/lib/voice.ts`** — browser-side voice loop (VAD, mic streaming) that
  talks to the server's voice endpoints.
- **`src/app/components/`** — the panels: the chat stage, the agent grid + org
  chart + process-table overlay, the autonomy dials, the fast-verify gates, the
  health / context / retention / tokens panels, the launch arc, and the
  personal-world view.

## BYOM (bring your own model)

The whole model wiring is one file: `chat_byom.py`, plus your `config.json`.

- The request is **transparent** — the conversation you see in the channel, plus
  one short neutral system line. No hidden prompt, no vendor lock-in.
- It speaks the **OpenAI-compatible `/chat/completions`** shape, so it works with
  hosted providers and local servers alike.
- `config.json` (gitignored) holds `provider` / `api_key` / `model` / `base_url`.
- `/api/say` appends your turn to the channel and, **if a model is configured**,
  calls it and appends the reply. With no model wired it simply records the turn —
  the chat still works as a log; replies start once you wire `config.json`.

## Gates & autonomy (the control model)

This is SERVARI's core stance: **autonomy is a dial, and irreversible actions
always pass a human gate.**

- The **autonomy dial** (`autonomy.py`) sets, per agent, how risky an action can be
  before the agent surfaces it. Higher levels widen the silent/auto band; they
  never remove the hard gate.
- The **gate queue** (`verify_queue.py`) is where gated actions (deploy, real-send,
  spend, publish, merge-to-main, secret) park for one-click human approval. Nothing
  executes until you approve. The audit is append-only.

Together they let an agent move fast on safe work while every consequential action
stays under your control.

## Reliability

- The server never crashes a request: per-route try/except + per-module defensive
  load.
- `health.py` is a fast, fail-closed surface that proves the operation is up.
- `retention.py` lets improvement loops run unattended without quality silently
  eroding (KEEP only if metrics hold; else byte-exact REVERT).
- `context_policy.py` makes the eviction/survival policy first-class so a context
  compaction never loses in-flight work or open gates.

## Demo data (`demo-data/`)

Synthetic seed data so every panel renders on first run with no backend wired.
See each module's docstring for the exact shape it expects. `python demo-data/_seed.py`
re-stamps the time-based seeds so the live panes look "just active".
