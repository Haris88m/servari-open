# Reproducibility Guide

This guide lets an outside reviewer confirm the public claims of `servari-open` without private data or provider credentials.

## Reproducible scope

The public repository can reproduce:

- local stdlib Python server startup,
- selected API routes returning HTTP 200 JSON,
- honest BYOM behavior when no model is configured,
- L5 high-risk autonomy queueing,
- invalid risk scores failing closed,
- append-only verify queue events,
- allow-listed action runner behavior,
- retention KEEP/REVERT self-test,
- cookbook scan/recommend routes over the bundled model catalog,
- the pytest unit suite (`python -m pytest tests/ -q`, 145 tests),
- UI build from source.

It does not reproduce a production multi-agent execution engine, AGI, frontier-model performance, or third-party certification.

## Prerequisites

- Python 3.9+
- Node.js 18+
- Git

No provider credential is required for demo mode or verification.

## Fresh clone

```bash
git clone https://github.com/Haris88m/servari-open.git
cd servari-open
```

## One-command verification

```bash
python scripts/verify_all.py
```

Expected summary:

```text
PASS V001 - L5 high-risk autonomy queues
PASS V002 - invalid autonomy score fails closed
PASS V003 - verify queue append-only pending + decision
PASS V004 - BYOM no-config behavior is honest
PASS V005 - retention KEEP/REVERT self-test
PASS V006 - action runner is allow-listed
PASS V007 - server smoke routes return HTTP 200 JSON
PASS V008 - secret config patterns are gitignored
result: PASS (8/8)
```

The script writes a machine-readable report to:

```text
verification/last-run.json
```

## Build the UI

```bash
cd ui
npm install
npm run build
cd ..
```

Expected: Vite creates `ui/dist/` without build errors.

## Start the shell

```bash
python server/servari_server.py
```

Open:

```text
http://127.0.0.1:8911/
```

The dashboard, agent grid, org chart, gates, and panels should render from bundled synthetic demo data.

## Manual checks

Autonomy hard gate:

```bash
python server/autonomy.py --set reviewer 5
python server/autonomy.py --decide reviewer 20 --pretty
```

Expected: `verdict` is `queue`.

Retention self-test:

```bash
python server/retention.py --self-test
```

Expected: `ok` is `true`; checks include KEEP, REVERT, byte-exact restore, and double-decide rejection.

BYOM status without a configured provider:

```bash
python server/chat_byom.py --check
```

Expected: `ok` is `false` with a clear reason when `config.json` is absent.

## Optional model wiring

Copy the example config:

```bash
cp config.example.json config.json
```

For a keyless local provider, set `base_url` to the local OpenAI-compatible endpoint, leave the credential field empty, and set the model name used by that local server.

Hosted providers require credentials from that provider. Do not commit `config.json`; it is gitignored.

## CI

GitHub Actions runs:

1. `python-verification` — runs `python scripts/verify_all.py`.
2. `python-tests` — runs the pytest unit suite (`python -m pytest tests/ -q`).
3. `ui-build` — installs UI dependencies and builds the React app.

The CI does not require secrets and does not call model providers.

## Boundary

Reproducible now:

- shell/server control plane,
- autonomy gate policy,
- append-only verify queue,
- BYOM no-config behavior,
- allow-listed action runner,
- retention self-test,
- selected API route smoke checks,
- cookbook scan/recommend routes,
- the pytest unit suite,
- UI build.

Partial or not shipped:

- live hosted-provider calls in CI,
- full local STT/TTS inference,
- concurrent multi-agent execution engine,
- third-party certification,
- production deployment security.
