# SERVARI Open Release — Runtime Controls

Date: 2026-06-10 (UTC+2, Europe/Warsaw)

Tag target: `v2.0.1-runtime-controls`

## Release scope

- Release name: `v2.0.1-runtime-controls`
- Target audience: public users and buyers of the desktop shell
- Distribution format: local Electron launcher (`WINDOWS-x64`) built from repository source
- Architecture posture: **local-first, BYOM, open-source control-plane shell**

### What is shipped

- Local-open-source desktop shell (`electron/main.cjs`) and web shell (`ui/`) over the same Python stdlib server (`server/servari_server.py`).
- New local engine management surface at:
  - `GET /api/engine/status`
  - `GET /api/engine/logs`
  - `POST /api/engine/start`
  - `POST /api/engine/stop`
  - `POST /api/engine/restart`
- Runtime control workspace at `/shell/runtime` in the shell UI.
- Route-scoped chat behavior:
  - `/shell` keeps the floating mini chat + voice launcher.
  - `/shell/chat` uses the dedicated chat route and hides the floating mini-chat launcher to avoid duplicate chat/voice entry points.
- Windows portable executable creation support from repository source:
  - `npm run build:exe` -> `dist-exe/SERVARI-x64.exe`
- Release documentation and public claim alignment updates (runtime behavior, non-claims, release checklist updates).

### What is explicitly not shipped

- No remote orchestration of another machine by default.
- No distributed swarm execution engine in this repo.
- No included foundation model and no AGI claim.
- No internet-exposed hardening posture as shipped; production internet deployment remains a separate hardening task.

### Why publish this open source

- The shell is meant to be inspectable. The source claims are bound to reproducible checks (`scripts/verify_all.py` and CI).
- The value is in the architecture and the operating disciplines, not in a hidden model:
  - open verification path,
  - local-first default,
  - auditable action gates,
  - append-only decisions.
- Open publishing allows external review and external review pressure without proprietary lock-in.

### Verification performed before release

- `python scripts/verify_all.py` (8 checks, PASS)
- `python tests/byom_smoke.py` (8 checks, PASS)
- `python server/retention.py --self-test` (7 checks, PASS)
- `python server/chat_byom.py --check` (expected public no-config result)
- `cd ui && npm ci && npm run build` (success)
- `npm ci` at repo root (success)
- `npm audit --omit=dev` at repo root and under `ui/` (0 vulnerabilities)
- `npm run build:exe` (portable artifact generated with `--config.compression=store` for stable local build)
- Packaged launcher smoke from `dist-exe/` without `SERVARI_HOME` on `SERVARI_PORT=8992`:
  - `GET /api/health` -> HTTP 200
  - `GET /api/engine/status` -> HTTP 200
- Release checks from `docs/RELEASE_CHECKLIST.md` were aligned before publish.

### Publication artifacts

- Windows portable artifact: `dist-exe/SERVARI-x64.exe`
- SHA-256 checksum file: `dist-exe/SERVARI-x64.sha256`

```text
SHA-256: d2159af32a4fbaf67b715e27c81a06765e709564bca564c84be0d8931ecb493e
Size: 372257271 bytes
Built: 2026-06-20 05:02:35 +02:00
```

### Distribution behavior

- The executable is an Electron launcher, not a standalone Python/server bundle.
- It resolves its project home from `SERVARI_HOME`, the portable executable location, or the current working directory.
- When run from the repo distribution folder, the shell binds by default to `127.0.0.1:8911`.
- The executable points to that local shell URL only.
- Runtime control routes target local process lifecycle managed by the same local runtime manager.
- If the executable is moved away from the repo/distribution folder, set `SERVARI_HOME` to the folder containing `server/servari_server.py`.
