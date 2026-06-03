# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## Project overview

SERVARI OS is an open-source AI operating-system **shell**: a React desktop UI
served by a tiny, dependency-free Python server. It provides the operating-system
surface for an agent workforce — chat, an agent grid, an org chart, a fast-verify
gate queue, per-agent autonomy dials, and reliability/context/token panels — and
wires it to the user's own model (BYOM). The intelligence is brought by the user;
this repo is the shell they see and control.

## Session persona

When SERVARI runs as a terminal session (`servari.cmd cli`), the harness loads
the session persona in [`SERVARI.md`](./SERVARI.md) — who SERVARI is, its plain
operating style, the gates rule (irreversible actions are proposed, never
performed silently), the autonomy levels, and BYOM. Read it to understand the
voice and behavior an interactive SERVARI session is meant to have.

## Tech stack

- **UI:** React 18 + Vite 6 + TypeScript (under `ui/`). Built output is `ui/dist/`.
- **Server:** Python 3.9+ **standard library only** (under `server/`). No runtime
  pip dependencies. Serves the built SPA and a JSON API on `127.0.0.1:8911`.
- **Desktop (optional):** Electron + electron-builder (under `electron/`,
  configured in root `package.json`).
- **Data:** synthetic seed data under `demo-data/` so every panel renders day one.

## Setup, build, and run

```bash
# build the UI (required before first run, and after any ui/src change)
cd ui && npm install && npm run build && cd ..

# run the shell server
python server/servari_server.py        # -> http://127.0.0.1:8911/

# optional: desktop app (root package.json)
npm install && npm start               # starts the server, opens the window
npm run build:exe                      # -> dist-exe/SERVARI-x64.exe (Windows)
```

To wire a model, copy `config.example.json` to `config.json` and fill in
`base_url` + `model` (+ `api_key` for hosted providers). `config.json` is
gitignored.

## Architecture notes

- The server is the spine: `server/servari_server.py` is the stdlib HTTP entry
  point; it serves `ui/dist/` and routes `/api/*` to focused modules:
  `autonomy.py` (L0–L5 dial), `verify_queue.py` (gates), `health.py`,
  `retention.py`, `context_policy.py`, `tokens.py`, `chat_byom.py` (the BYOM
  proxy), and `providers/*` (panel data sources).
- **Same-origin** by design: the UI and API share `127.0.0.1:8911`, so there is
  no CORS layer to configure.
- **Fail-closed everywhere:** a missing module or data file returns a clean
  "unavailable" payload — it never crashes the server.
- Configuration is **environment-driven**: `SERVARI_HOST`, `SERVARI_PORT`,
  `SERVARI_HOME`, `SERVARI_PYTHON`, `SERVARI_NO_VOICE`. Prefer these over editing
  source.

## Things to avoid

- **Do not add a runtime `pip` dependency.** The server must run on a bare Python
  standard library. Optional integrations (voice) may declare extras in
  `requirements.txt`, kept commented out.
- **Do not introduce a raw shell or arbitrary command execution.** The action
  runner is allow-listed; keep it that way.
- **Do not break the cold-start path.** A fresh clone must build and render every
  panel from `demo-data/` with no backend wired. Test it before any PR.
- **Do not commit secrets.** No real API keys, tokens, or passwords anywhere —
  not even in examples. `config.json` is gitignored.
- **Do not hardcode absolute paths.** Resolve data dirs relative to the repo root
  or via `SERVARI_HOME`.
- **Do not weaken the gates.** High-risk actions (deploy, real-send, spend,
  publish) must always park in the fast-verify queue regardless of autonomy level.

## Where to look

- Full architecture: `docs/ARCHITECTURE.md`
- Setup details + troubleshooting: `docs/SETUP.md`
- How to contribute: `CONTRIBUTING.md`
- Reporting a vulnerability: `SECURITY.md`
