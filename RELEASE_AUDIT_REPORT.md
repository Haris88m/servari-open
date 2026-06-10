# Release Audit Report

Branch: `release/reproducibility-pack`

## Summary

This branch turns the public SERVARI source repo from a readable shell into a more reproducible release candidate. It adds a one-command verification harness, CI, a public claim register, reproducibility guide, security model, threat model, license matrix, release checklist, and third-party review guide.

The release posture remains intentionally scoped:

> SERVARI is an open-source, local-first BYOM agentic OS shell with mechanical autonomy gates, an append-only human verification queue, file-backed state, fail-closed health surfaces, and a metric-gated retention loop.

No claim is made that this repository ships AGI, a new foundation model, public internet hardening, third-party certification, or a full concurrent autonomous multi-agent execution engine.

## Files added

- `.github/workflows/ci.yml`
- `scripts/verify_all.py`
- `docs/CLAIM_REGISTER.md`
- `docs/REPRODUCIBILITY.md`
- `docs/SECURITY_MODEL.md`
- `docs/THREAT_MODEL.md`
- `docs/LICENSE_MATRIX.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/THIRD_PARTY_REVIEW.md`
- `RELEASE_AUDIT_REPORT.md`

## Files modified

- `README.md`
- `.gitignore`

## Claims upgraded or strengthened

These claims now have an explicit public verification path through `scripts/verify_all.py` and CI:

1. L5 high-risk autonomy queues.
2. Invalid autonomy scores fail closed to queue.
3. Verify queue appends pending and decision events.
4. BYOM without config gives an honest not-configured response.
5. Retention self-test covers KEEP, REVERT, byte-exact restore, and double-decide rejection.
6. Action runner is allow-listed and refuses unknown actions.
7. Selected server routes return HTTP 200 JSON.
8. Secret config patterns are gitignored.

## Claims remaining PARTIAL

These are present but not fully proven by the public verification harness:

- Full UI visual behavior across all panels.
- Optional local STT/TTS inference.
- Every possible fail-graceful route/data failure.
- Live provider calls against hosted model APIs.
- Production deployment security.

## Claims remaining UNVERIFIED / NOT SHIPPED

These are explicitly not claimed as shipped in this repo:

- Concurrent autonomous multi-agent execution engine.
- AGI or frontier-model superiority.
- New foundation model or own-weights model.
- Third-party certification.
- Public internet hardening without an external auth layer.

## Commands to run locally

```bash
python scripts/verify_all.py
cd ui
npm install
npm run build
cd ..
python server/servari_server.py
```

## CI

The new workflow runs on push and pull request:

- `python-verification` runs `python scripts/verify_all.py`.
- `ui-build` installs UI dependencies and runs `npm run build`.

The workflow does not require provider credentials and does not call model APIs.

## Next human actions

1. Review the PR diff.
2. Wait for CI to run.
3. If CI fails, inspect the verification report artifact and workflow logs.
4. Run `python scripts/verify_all.py` locally if possible.
5. Merge only after CI is green or failures are understood and fixed.
6. Create a release tag.
7. Ask one outside reviewer to follow `docs/THIRD_PARTY_REVIEW.md`.

## Reviewer note

The most important release discipline is claim discipline. Keep the README and public materials aligned with `docs/CLAIM_REGISTER.md`. If new capabilities are added later, add deterministic verification before upgrading a claim to VERIFIED.
