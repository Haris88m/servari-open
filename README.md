# SERVARI OS

**An open-source AI operating-system shell.** Bring your own model, dial in how
much autonomy each agent gets, talk to it by voice or text, and watch a live
agent workspace — all running locally on your machine.

SERVARI OS is the *shell*: a clean React desktop UI over a tiny, dependency-free
Python server. It gives you the operating-system surface for an agent workforce —
the chat, the agent grid, the org chart, the gate queue, the autonomy dials, the
health/context/token panels — and wires it to **your** model. The intelligence is
yours to plug in; the shell is what you see and control.

> Inspired by the emerging "agentic OS" pattern — sibling open projects include
> [OpenClaw](https://github.com/) and [Hermes](https://github.com/). SERVARI's
> angle is the **shell + the gates**: a polished workspace where autonomy is a
> dial you control and every irreversible action passes a human gate.

---

## Screenshots

See [`./docs/screenshots/`](./docs/screenshots/) for the full set.

| | |
|---|---|
| Boot sequence | ![boot](./docs/screenshots/00-boot.png) |
| Dashboard / agent grid | ![dashboard](./docs/screenshots/01-dashboard.png) |
| Chat | ![chat](./docs/screenshots/02-chat.png) |
| Org chart | ![org](./docs/screenshots/03-org-chart.png) |
| Autonomy dials | ![autonomy](./docs/screenshots/04-autonomy.png) |
| Fast-verify gates | ![gates](./docs/screenshots/05-gates.png) |
| Agent workspace | ![agents](./docs/screenshots/06-agents.png) |

---

## What you get

- **Bring your own model (BYOM).** Point SERVARI at any OpenAI-compatible chat
  endpoint — OpenAI, OpenRouter, Together, or a fully local server like Ollama,
  LM Studio, or vLLM. Your key lives in a gitignored `config.json`; SERVARI never
  ships or transmits a key anywhere but your chosen provider.
- **Gate-controlled autonomy.** A per-agent dial from **L0** (suggest only) to
  **L5** (full auto). The dial widens what an agent may do silently — but a
  high-risk action (deploy, real-send, spend, publish) *always* parks in the
  **fast-verify queue** for your one-click approval. The gates hold at every level.
- **A live agent workspace.** A multi-pane grid of agent channels, an org chart,
  a process-table overlay, and a launch ladder — populated from demo data out of
  the box, ready to point at your own.
- **Reliability + context panels.** A fail-closed health surface, a
  context-pressure policy (treats the LLM window as RAM and tracks "survival
  pins"), a metric-gated KEEP/REVERT retention loop, and a proof-of-work token
  tracker that prices usage at your provider's rates.
- **Voice (optional).** Local speech-to-text and neural text-to-speech skeletons
  (faster-whisper + Piper). The shell runs fine without them.
- **A display seal.** A small, configurable mechanism that maps internal labels
  to clean product words and hides any term you don't want rendered — so the UI
  always shows a professional face.
- **Runs out of the box.** The repo ships with `demo-data/` so every panel
  renders on first launch, with no backend wired.

---

## Quick start

You need **Node.js 18+** and **Python 3.9+**.

```bash
# 1. clone
git clone <your-fork-url> servari-open
cd servari-open

# 2. build the UI (one time, and after any UI change)
cd ui
npm install
npm run build
cd ..

# 3. (optional) wire your model — copy the template and fill it in
#    Without this, the chat records your messages but won't generate replies.
cp config.example.json config.json
#    edit config.json: set base_url + model (+ api_key if your provider is hosted)

# 4. run the server
python server/servari_server.py
#    -> open http://127.0.0.1:8911/
```

That's it. The dashboard, agent grid, org chart, gates, and every panel render
from the bundled demo data immediately.

### Run as a desktop app (optional)

```bash
npm install            # at the repo root (installs Electron)
npm start              # opens the SERVARI window (spawns the server for you)
# or build a portable Windows .exe:
npm run build:exe      # -> dist-exe/SERVARI-x64.exe   (Windows; needs Python on PATH)
```

On Windows you can also just double-click `START-SERVARI.cmd`.

---

## Wiring your own model

SERVARI speaks the OpenAI-compatible `/chat/completions` shape, which nearly every
provider exposes. Copy `config.example.json` to `config.json` and set:

| field | what it is | examples |
|---|---|---|
| `base_url` | the provider's API base | OpenAI `https://api.openai.com/v1` · Ollama `http://127.0.0.1:11434/v1` · OpenRouter `https://openrouter.ai/api/v1` · LM Studio `http://127.0.0.1:1234/v1` |
| `model` | the model id at that provider | `gpt-4o-mini` · `llama3.1:8b` · `meta-llama/llama-3.1-8b-instruct` |
| `api_key` | your key (empty for keyless local servers) | `sk-...` |
| `provider` | a free-text label for your own reference | `openai` · `ollama` · `openrouter` |

`config.json` is gitignored. Check `GET /api/byom-status` (or send a message in the
chat) to confirm the model is wired.

---

## Architecture (at a glance)

```
 ┌──────────────────────────────────────────────┐
 │  React shell (ui/)            served by ↓     │   the FACE
 │  chat · agent grid · org · gates · panels     │
 └───────────────┬──────────────────────────────┘
                 │  same-origin /api/*  (no CORS)
 ┌───────────────▼──────────────────────────────┐
 │  Python server (server/servari_server.py)     │   the SPINE
 │  stdlib HTTP · serves the SPA · JSON API      │
 │  ├─ autonomy.py      the L0–L5 dial           │
 │  ├─ verify_queue.py  the fast-verify gates    │
 │  ├─ health.py        fail-closed health       │
 │  ├─ retention.py     KEEP/REVERT metric loop  │
 │  ├─ context_policy.py context-pressure policy │
 │  ├─ tokens.py        proof-of-work tracker    │
 │  ├─ chat_byom.py     YOUR model (BYOM)         │
 │  └─ providers/*      personal-world panels    │
 └───────────────┬──────────────────────────────┘
                 │  reads / writes
 ┌───────────────▼──────────────────────────────┐
 │  demo-data/   seed data so it renders day one  │   the DATA
 └───────────────────────────────────────────────┘
```

The server is **pure stdlib** (no pip install needed to run), every route
**degrades gracefully** (a missing module returns a clean "unavailable" payload
instead of crashing), and the action runner is **allow-listed** (not a raw shell).
See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full picture and
[`docs/SETUP.md`](./docs/SETUP.md) for setup details.

---

## Demo data

Everything under `demo-data/` is synthetic seed data so the shell is alive on
first run. Re-stamp the time-based seeds (so the panes look "just active") with:

```bash
python demo-data/_seed.py
```

To wire your own data, edit the files in `demo-data/` or point `SERVARI_HOME` at
your own directory with the same shapes.

---

## License

[MIT](./LICENSE) © Haris Mekic
