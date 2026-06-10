# SERVARI Open Release — Runtime Controls

Date: 2026-06-10 (UTC+2, Europe/Warsaw)

Tag target: `v2.0.1-runtime-controls`

## Release scope

- Release name: `v2.0.1-runtime-controls`
- Target audience: public users and buyers of the desktop shell
- Distribution format: local, portable executable (`WINDOWS-x64`)
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
- `cd ui && npm install && npm run build` (success)
- `npm run build:exe` (portable artifact generated with `--config.compression=store` for stable local build)
- Release checks from `docs/RELEASE_CHECKLIST.md` were aligned before publish.

### Publication artifacts

- Windows portable artifact: `dist-exe/SERVARI-x64.exe`
- SHA-256 checksum file: `dist-exe/SERVARI-x64.sha256`

```text
SHA-256: 0ff7f99c9506268fb2b2da3a2ff8f9d8f21ada81d8fd1e4ffa47b9adf2483013
```

### Distribution behavior

- When customers run the shipped exe, the shell binds by default to `127.0.0.1:8911`.
- The executable points to that local shell URL only.
- Runtime control routes target local process lifecycle managed by the same local runtime manager.
