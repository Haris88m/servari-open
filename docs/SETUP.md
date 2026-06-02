# SETUP

This guide takes you from a fresh clone to a running SERVARI OS shell.

## Prerequisites

- **Node.js 18+** (for building the React UI and the optional Electron app)
- **Python 3.9+** (for the shell server — pure stdlib, no pip needed to run)

Check:

```bash
node --version
python --version    # or: python3 --version
```

## 1. Clone

```bash
git clone <your-fork-url> servari-open
cd servari-open
```

## 2. Build the UI

The server serves a **built** React app from `ui/dist/`. Build it once (and again
after any change in `ui/src/`):

```bash
cd ui
npm install
npm run build
cd ..
```

This produces `ui/dist/`. The server serves it at `/`.

> **Developing the UI?** Run `npm run dev` inside `ui/` for hot-reload at
> `http://localhost:5173`. The Vite dev server proxies `/api` to the shell on
> `127.0.0.1:8911`, so start the Python server too (step 4).

## 3. (Optional) Wire your model

Without this step the chat will record your messages but won't generate replies.

```bash
cp config.example.json config.json     # Windows: copy config.example.json config.json
```

Edit `config.json`:

```json
{
  "provider": "openai-compatible",
  "api_key": "",
  "model": "gpt-4o-mini",
  "base_url": "https://api.openai.com/v1"
}
```

`config.json` is gitignored — your key stays local.

**Common providers** (all OpenAI-compatible):

| provider | base_url | api_key |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | required |
| OpenRouter | `https://openrouter.ai/api/v1` | required |
| Together | `https://api.together.xyz/v1` | required |
| Ollama (local) | `http://127.0.0.1:11434/v1` | leave empty |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | leave empty |
| vLLM (local) | `http://127.0.0.1:8000/v1` | leave empty |

Confirm it's wired:

```bash
python server/chat_byom.py --check
```

## 4. Run the server

```bash
python server/servari_server.py
```

Open **http://127.0.0.1:8911/**. The dashboard, agent grid, org chart, gates, and
all panels render from the bundled demo data.

> The server binds `127.0.0.1:8911` by default (localhost only) and serves the
> built SPA plus a JSON API. Both are configurable via environment variables — no
> source edit needed:
>
> ```bash
> # bind a different port (and/or interface)
> SERVARI_PORT=9000 python server/servari_server.py
> # the desktop app reads the same vars (it inherits your environment)
> SERVARI_PORT=9000 npm start
> ```
>
> `SERVARI_HOST` / `SERVARI_PORT` override the defaults; the Electron window
> targets the same address the server binds to.

## 5. (Optional) Desktop app

```bash
npm install     # at the repo root — installs Electron + electron-builder
npm start       # opens the SERVARI window (it spawns the server for you)
```

Build a portable Windows `.exe`:

```bash
npm run build:exe      # -> dist-exe/SERVARI-x64.exe
```

The `.exe` is the window only; it spawns `server/servari_server.py` at runtime, so
Python must be on `PATH` (or set `SERVARI_PYTHON` to a specific interpreter).

## 6. (Optional) Local voice

The voice endpoints (`/api/voice-*`) need two extra Python packages:

```bash
# uncomment the lines in requirements.txt first, then:
pip install -r requirements.txt
```

- `faster-whisper` — local speech-to-text
- `piper-tts` — local neural text-to-speech (downloads a small voice model on first use into `_tts_models/`, which is gitignored)

The shell runs fine without them — voice routes simply report "unavailable".

To keep voice off entirely (e.g. on a low-memory machine), launch with
`SERVARI_NO_VOICE=1`.

## Pointing at your own data

Everything the panels render comes from `demo-data/`. Two ways to use your own:

1. **Edit the files in `demo-data/`** to match the shapes already there.
2. **Set `SERVARI_HOME`** to a directory that contains your own `demo-data/`
   (same layout), and the server reads from there instead.

Re-stamp the time-based demo seeds so the panes look active:

```bash
python demo-data/_seed.py
```

## Troubleshooting

- **"The UI has not been built yet."** — run step 2 (`cd ui && npm install && npm run build`).
- **Chat records my message but never replies.** — no model is wired; do step 3.
- **A panel shows an `error` / empty state.** — that's the honest fail-closed
  behavior when its backing file or module is missing. Everything else keeps working.
- **Port already in use.** — another process holds 8911; stop it or change the port.
