# Threat Model

This document lists the main assets, threats, mitigations, and limits for the public SERVARI OS shell.

## Assets

| Asset | Why it matters |
|---|---|
| Local provider configuration | May contain provider URL, model name, and credential material if the operator adds it locally. |
| Local files under SERVARI_HOME | Used by panels, memory surfaces, gate queues, reports, and retention runs. |
| Gate queue | Records proposed high-risk actions and human decisions. |
| Conversation/channel history | May contain user work context. |
| Demo/custom data | Bundled demo data is synthetic; operator-provided data may be sensitive. |
| Allow-listed actions | Any added action can become a side-effect boundary. |

## Threats and mitigations

| Threat | Mitigation in public shell | Remaining limit |
|---|---|---|
| Provider config committed by mistake | `.gitignore` excludes `config.json`, `.env`, `.env.*`, and `*.env`; docs warn not to commit credentials. | Operators can still override this manually. |
| Accidental public exposure | Server binds to `127.0.0.1` by default. | No built-in authentication layer for public deployment. |
| Arbitrary command execution | Action runner uses explicit allow-list; unknown actions are refused. | Contributors must not add unsafe actions. |
| Gate bypass by autonomy level | Autonomy decision logic queues high-risk scores even at L5. | External executors must respect the verdict. |
| Silent quality regression | Retention loop snapshots files and reverts when gating metrics degrade. | Only protects targets enrolled in a retention run with meaningful metrics. |
| Missing module or data crashes the shell | Server routes are designed to return clean unavailable payloads. | Not every route/failure combination is exhaustively tested. |
| Prompt injection or malicious model output | Human gate and allow-listed actions limit direct side effects. | Model output remains untrusted; users must review outputs. |
| Weak leak/redaction checks | Display seal exists for UI chrome and labels. | Live chat content is not fully sealed by this mechanism. |

## Trust boundaries

1. **Browser/UI boundary** — the React shell displays state and calls same-origin API routes.
2. **Server boundary** — the Python server reads/writes local data and exposes controlled routes.
3. **Model boundary** — the BYOM endpoint is external or local, selected by the operator.
4. **Human gate boundary** — high-risk work should stop at the queue until approved.
5. **Action boundary** — only allow-listed server actions should run.

## Hard limits

- SERVARI is not a sandbox for arbitrary untrusted code.
- SERVARI is not hardened for direct public internet exposure.
- SERVARI is not a replacement for code review, security review, or provider-side controls.
- The gate queue records approval decisions; downstream systems must still enforce those decisions.
- The public repo does not ship a full autonomous multi-agent execution engine.

## Review checklist

Before adding a new action, route, provider, or integration:

1. Does it introduce side effects?
2. Can it touch credentials or private files?
3. Should it park in the gate queue first?
4. Can it fail gracefully?
5. Can it be verified by `scripts/verify_all.py` or a new deterministic check?
6. Does the README or claim register need a label change?
