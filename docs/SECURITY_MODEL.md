# Security Model

This document describes the security posture of the public SERVARI OS shell. It is not a certification.

## Default posture

SERVARI is local-first. The server binds to `127.0.0.1` by default and is intended to run on the operator's own machine.

Core controls:

1. **Localhost default** — the server uses `127.0.0.1` unless the operator changes the host setting.
2. **No raw shell** — the action route uses a small allow-list. Unknown actions are refused.
3. **Human gate** — high-risk work is parked in the fast-verify queue. The autonomy dial does not remove this gate.
4. **Append-only queue** — pending events and decision events are written as separate JSONL lines.
5. **Local model config** — `config.json` and environment files are excluded from the repository by `.gitignore`.
6. **BYOM boundary** — provider settings stay local to the operator.
7. **Fail-graceful routes** — missing modules or missing data should return clean unavailable payloads instead of crashing the server.
8. **Metric-gated retention** — enrolled files can be snapshotted, measured, and reverted byte-exactly if a gating metric degrades.
9. **Synthetic demo data** — bundled data is seed/demo data.

## Operator responsibilities

Operators should:

- keep local provider config out of commits,
- review the gate queue before approving consequential work,
- avoid changing the bind host unless they know what they are doing,
- review any new action added to the allow-list,
- treat model output as untrusted until checked.

## Not provided by default

The public shell does not provide:

- built-in user authentication,
- public deployment hardening,
- sandbox isolation for arbitrary tools,
- formal verification,
- third-party security certification,
- a guarantee that downstream executors obey gate decisions.

## Verification

Run:

```bash
python scripts/verify_all.py
```

The verification harness checks the public safety contracts that can be tested without external provider credentials: gate queue behavior, autonomy queueing, allow-listed actions, BYOM no-config honesty, retention self-test, HTTP smoke routes, and gitignore patterns.
