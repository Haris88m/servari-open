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
| Retention metric registry | Defines local commands used by the metric-gated retention loop. |

## Threats and mitigations

| Threat | Mitigation in public shell | Remaining limit |
|---|---|---|
| Provider config committed by mistake | `.gitignore` excludes `config.json`, `.env`, `.env.*`, and `*.env`; docs warn not to commit credentials. | Operators can still override this manually. |
| Operator-supplied BYOM endpoint is mistyped or hostile | SERVARI has no relay; it sends requests only to the `base_url` configured by the operator, and the config is local/gitignored. | If the operator puts a credential next to a hostile endpoint, that endpoint can receive the bearer credential. Prefer local endpoints or HTTPS endpoints you control/trust. |
| Accidental public exposure | Server binds to `127.0.0.1` by default. | No built-in authentication layer for public deployment. |
| Arbitrary command execution through the action route | Action runner uses explicit allow-list; unknown actions are refused. | Contributors must not add unsafe actions. |
| Operator-local command surface in retention metrics | Retention metrics use list-form subprocess calls from an operator-local registry, not shell strings, and are not exposed as a generic HTTP execution endpoint. | A malicious or careless local registry entry can still run local commands. Treat metric registries as trusted configuration. |
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
6. **Retention metric boundary** — local metric commands are trusted operator configuration and must be reviewed like code.

## Hard limits

- SERVARI is not a sandbox for arbitrary untrusted code.
- SERVARI is not hardened for direct public internet exposure.
- SERVARI is not a replacement for code review, security review, or provider-side controls.
- The BYOM bridge trusts the operator's configured endpoint.
- The retention metric registry is trusted local configuration.
- The gate queue records approval decisions; downstream systems must still enforce those decisions.
- The public repo does not ship a full autonomous multi-agent execution engine.

## Review checklist

Before adding a new action, route, provider, metric, or integration:

1. Does it introduce side effects?
2. Can it touch credentials or private files?
3. Should it park in the gate queue first?
4. Can it fail gracefully?
5. Can it be verified by `scripts/verify_all.py` or a new deterministic check?
6. Does the README or claim register need a label change?
7. Is any operator-supplied endpoint or local command clearly documented as trusted configuration?
