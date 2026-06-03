# License Matrix

This repository separates source code, documentation, generated artifacts, local configuration, optional integrations, and third-party dependencies.

| Area | Content | License / status | Notes |
|---|---|---|---|
| `servari-open` source | Python server, React UI source, Electron wrapper, scripts, project docs | Apache-2.0 | Covered by this repository's `LICENSE`. |
| `agentic-os-audit` | Audit publication and written research docs | CC-BY-4.0 | Separate repository. It documents and audits the project; it is not the runnable source repo. |
| `config.example.json` | Non-secret template | Apache-2.0 | Contains no real credentials. |
| `config.json` | Operator-local provider config | Not committed | Gitignored. May contain local provider settings or credentials. |
| `.env`, `.env.*`, `*.env` | Operator-local environment files | Not committed | Gitignored. |
| `demo-data/` | Synthetic seed/demo data | Apache-2.0 unless otherwise stated | Intended to let the shell render on first launch. Replace locally with your own data if needed. |
| `ui/` dependencies | React, Vite, Radix, MUI, Motion, Recharts, and related packages | Upstream package licenses | Installed by npm. Check upstream package metadata after install. |
| `electron/` dependencies | Electron and electron-builder | Upstream package licenses | Optional desktop wrapper. |
| Optional voice packages | faster-whisper and Piper-related tooling | Upstream package licenses | Not bundled by default; installed by the operator if enabled. |
| Model providers / model weights | OpenAI-compatible hosted or local models selected by the operator | Provider/model-specific | Not bundled. The BYOM router only calls the endpoint configured by the operator. |
| `verification/last-run.json` | Local verification output | Generated artifact | Produced by `scripts/verify_all.py`; not a source-of-truth claim unless attached to a specific commit/run. |

## Practical rule

- Source repo: **Apache-2.0**.
- Audit/publication repo: **CC-BY-4.0**.
- Provider keys and local configuration: **never committed**.
- Third-party dependencies: **their own upstream licenses**.

## Before release

A public release should confirm:

1. `LICENSE` is Apache-2.0.
2. `NOTICE` is present and accurate.
3. No `config.json` or environment files are committed.
4. Optional dependencies are not presented as bundled capabilities unless actually bundled and tested.
5. The audit repository clearly links back to this source repository.
