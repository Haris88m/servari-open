# Third-Party Review Guide

This guide is for an outside engineer reviewing SERVARI OS from a fresh clone.

## Reviewer metadata

```text
Reviewer:
Date:
Commit:
OS:
Node version:
Python version:
Commands run:
Verification result:
Claims confirmed:
Claims not confirmed:
Security concerns:
Recommendation:
```

## What to inspect first

1. `README.md` — public scope and non-claims.
2. `docs/CLAIM_REGISTER.md` — claim labels.
3. `scripts/verify_all.py` — reproducibility harness.
4. `server/autonomy.py` — L0-L5 gate decision logic.
5. `server/verify_queue.py` — append-only human verification queue.
6. `server/retention.py` — metric-gated KEEP/REVERT loop.
7. `server/chat_byom.py` — BYOM OpenAI-compatible bridge.
8. `server/servari_server.py` — local server and allow-listed actions.
9. `.gitignore` — local config and secret exclusions.
10. `docs/SECURITY_MODEL.md` and `docs/THREAT_MODEL.md`.
11. `server/hwfit/` — the Model Cookbook (MIT-licensed port; see `NOTICE`) — and `tests/` — the pytest unit suite.

## What to run first

```bash
python scripts/verify_all.py
```

Expected: all checks pass and `verification/last-run.json` is written.

Then run the pytest unit suite (install once with `python -m pip install pytest`):

```bash
python -m pytest tests/ -q
```

Expected: 145 passed.

Then build the UI:

```bash
cd ui
npm install
npm run build
cd ..
```

Then start the server:

```bash
python server/servari_server.py
```

Open:

```text
http://127.0.0.1:8911/
```

## Claims that should pass

- L5 high-risk autonomy queues.
- Invalid risk score queues.
- Gate queue records pending and decision events as separate audit lines.
- BYOM without config gives a clear not-configured response.
- Retention self-test proves KEEP/REVERT and byte-exact restore.
- Unknown actions are refused by the allow-listed action runner.
- Selected API routes return HTTP 200 JSON.
- Secret config patterns are gitignored.
- UI builds.

## Claims intentionally not made

The reviewer should not treat this repo as proving:

- AGI,
- a new model,
- frontier-model superiority,
- public internet hardening,
- third-party certification,
- full concurrent autonomous multi-agent execution.

## Manual gate reproduction

```bash
python server/autonomy.py --set reviewer 5
python server/autonomy.py --decide reviewer 20 --pretty
```

Expected: `verdict` is `queue`.

## Manual retention reproduction

```bash
python server/retention.py --self-test
```

Expected: `ok` is `true`.

## Manual BYOM no-config reproduction

Ensure `config.json` is absent, then run:

```bash
python server/chat_byom.py --check
python server/chat_byom.py --say "hello"
```

Expected: clear not-configured response, no fabricated model reply.

## Optional local model reproduction

A reviewer may configure any local OpenAI-compatible server by copying `config.example.json` to `config.json` and setting the local `base_url` and `model`. This is optional and not required for the core public verification.

## Reporting issues

- For normal bugs, open a GitHub issue with exact commands, expected result, actual result, OS, Node version, Python version, and screenshots/logs if useful.
- For sensitive security issues, follow `SECURITY.md` and do not publish details in a public issue.

## Reviewer verdict template

```text
I reviewed commit <sha> of Haris88m/servari-open.

Environment:
- OS:
- Python:
- Node:

Commands run:
- python scripts/verify_all.py
- cd ui && npm install && npm run build
- python server/servari_server.py

Confirmed:
- ...

Not confirmed:
- ...

Security notes:
- ...

Verdict:
- Recommend merge / request changes / needs more evidence.
```
