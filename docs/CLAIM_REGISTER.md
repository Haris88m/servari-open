# SERVARI Public Claim Register

This register is the public boundary for what the `servari-open` repository proves. It is intentionally conservative.

Labels:

- **VERIFIED** — inspectable in this repository and/or exercised by `python scripts/verify_all.py`, the pytest suite (`python -m pytest tests/ -q`, 145 tests), or CI.
- **PARTIAL** — present as a surface, skeleton, or documented pathway, but not fully proven by the public verification harness.
- **UNVERIFIED / NOT SHIPPED** — not present as runnable behavior in this repository.

## Claims

| ID | Public claim | Status | Evidence in repo | How to verify | Limit / caveat | Allowed wording | Forbidden wording |
|---|---|---|---|---|---|---|---|
| C01 | SERVARI runs as a local server on localhost by default. | VERIFIED | `server/servari_server.py`; `docs/SETUP.md`; `docs/ARCHITECTURE.md` | `python server/servari_server.py`; open `http://127.0.0.1:8911/`; CI smoke routes | Binding can be changed with env vars; exposing publicly needs auth proxy | "Localhost-first server" | "Internet-safe by default" |
| C02 | The React UI renders from demo data. | VERIFIED when UI build passes | `ui/`; `demo-data/`; CI `ui-build` job | `cd ui && npm install && npm run build`; start server | Verification checks build, not every visual state | "Demo-data-first UI shell" | "Production backend included" |
| C03 | BYOM router supports OpenAI-compatible chat endpoints. | VERIFIED structurally | `server/chat_byom.py`; `config.example.json` | Configure `config.json`; call `/api/say` or `python server/chat_byom.py --say` | CI does not call hosted providers or require keys | "OpenAI-compatible BYOM interface" | "Works with every provider automatically" |
| C04 | Missing model config produces an honest no-config response, not a fabricated answer. | VERIFIED | `server/chat_byom.py`; `scripts/verify_all.py` | `python scripts/verify_all.py` | Does not test live provider quality | "No config means no fabricated model reply" | "Always answers without a model" |
| C05 | Per-agent L0-L5 autonomy decision logic exists. | VERIFIED | `server/autonomy.py` | `python server/autonomy.py --list`; `python scripts/verify_all.py` | The decision function is a gate policy, not a full agent executor | "Autonomy decision policy" | "Fully autonomous agent engine" |
| C06 | At L5, high-risk actions still queue. | VERIFIED | `server/autonomy.py`; `scripts/verify_all.py` | `python scripts/verify_all.py` | Requires external executors to respect the verdict | "High-risk work queues even at max autonomy" | "Agents can safely do anything at L5" |
| C07 | Verify queue records pending and decision events append-only. | VERIFIED | `server/verify_queue.py`; `scripts/verify_all.py` | `python scripts/verify_all.py`; inspect `demo-data/gate-queue.jsonl` or test home audit | It records decisions; it does not by itself execute the external action | "Append-only human verification queue" | "Approval automatically makes every external action safe" |
| C08 | Action runner is allow-listed, not a raw shell. | VERIFIED | `server/servari_server.py`; `scripts/verify_all.py` | `python scripts/verify_all.py`; call `/api/actions` | Contributors could weaken it if they edit code; review required | "Allow-listed demo actions" | "Arbitrary command runner" |
| C09 | Retention loop can KEEP or REVERT based on metric results. | VERIFIED | `server/retention.py`; `scripts/verify_all.py` | `python server/retention.py --self-test`; `python scripts/verify_all.py` | Only protects files/metrics enrolled in a retention run | "Metric-gated KEEP/REVERT loop" | "All regressions are impossible" |
| C10 | Retention self-test verifies byte-exact restore and double-decide rejection. | VERIFIED | `server/retention.py`; `scripts/verify_all.py` | `python scripts/verify_all.py` | Self-test uses isolated probe files | "Byte-exact restore self-test" | "Formal verification" |
| C11 | Server routes degrade gracefully instead of crashing on missing modules/data. | PARTIAL | `server/servari_server.py`; route try/except blocks | HTTP smoke tests in `scripts/verify_all.py`; manual route testing | Smoke test covers selected routes, not every possible failure | "Fail-closed/fail-graceful surfaces" | "Cannot crash" |
| C12 | Bundled demo data is synthetic seed data. | VERIFIED by repository contents | `demo-data/`; `README.md` | Inspect `demo-data/` | Users may replace it with real data locally | "Synthetic demo data included" | "Real customer data included" |
| C13 | Voice is optional and not required for shell operation. | PARTIAL | `server/voice.py`; `server/voice_neural.py`; `requirements.txt`; docs | Start server without voice packages; routes report unavailable | CI does not validate STT/TTS inference | "Optional local voice skeleton" | "Full local voice production proof" |
| C14 | Multi-agent workspace surface is present. | VERIFIED as UI/data surface | `ui/`; `demo-data/agents`; `server/servari_server.py` grid/org routes | Build UI; inspect `/api/grid`, `/api/agents`, `/api/org` | Surface/demo channels are not the same as a concurrent execution engine | "Agent workspace surface" | "Public repo ships autonomous swarm execution" |
| C15 | Concurrent multi-agent execution engine is shipped in this repo. | UNVERIFIED / NOT SHIPPED | None | Not applicable | Roadmap/separate auditable component if added later | "Not shipped in this repo" | "Full swarm engine is public and verified" |
| C16 | SERVARI is a model. | UNVERIFIED / NOT SHIPPED | None | Not applicable | SERVARI is a shell over a user-chosen model | "BYOM shell" | "New foundation model" |
| C17 | SERVARI is AGI or beats frontier systems. | UNVERIFIED / NOT CLAIMED | None | Not applicable | Outside project scope | "Agentic OS shell" | "AGI", "beats frontier", "fully sovereign" |
| C18 | SERVARI can start/stop/restart a local managed runtime subprocess from the dashboard and API. | VERIFIED | `server/servari_server.py` route handlers and `ui/src/app/components/EngineRuntimeView.tsx` controls | `python scripts/verify_all.py`; manual runtime control smoke + `/api/engine/*` requests from the dashboard | Works for local process lifecycle control with fallback-aware launcher behavior; does not claim production remote orchestration. | "LOCAL runtime control surface for start/stop/restart" | "Cloud scheduler", "remote fleet control" |
| C19 | Runtime control is local by default (no automatic remote pairing/targeting). | VERIFIED | `server/servari_server.py` host/port defaults + docs statements | `python scripts/verify_all.py`, `py server/servari_server.py`, README and setup docs | Requires explicit host rewrite to control a remote host. With defaults, `127.0.0.1:8911` serves all primary surfaces. | "Runtime management stays local by default" | "Downloaded exe connects to your PC without intent" |
| C20 | Model Cookbook provides hardware-aware local-model recommendations. | VERIFIED | `server/hwfit/`; `tests/test_cookbook.py` (25 tests); `/api/cookbook/scan` + `/api/cookbook/recommend` routes | `python -m pytest tests/test_cookbook.py -q`; `python -m pytest tests/ -q` | Recommendation math runs locally over the bundled catalog; it does not download models or call external services | "Hardware-aware local-model recommendations" | "Automatic model downloader/installer" |

## Current public claim

The strongest accurate public claim is:

> SERVARI is an open-source, local-first BYOM agentic OS shell with mechanical autonomy gates, a local runtime control surface, an append-only human verification queue, file-backed state, fail-closed health surfaces, and a metric-gated retention loop.

## Current public non-claim

The repository does not claim to ship a fully autonomous multi-agent execution engine, a new foundation model, AGI, or third-party certification.
