# Release Checklist

Use this checklist before tagging or announcing a public SERVARI release.

## Repository hygiene

- [ ] `README.md` states the shipped scope clearly.
- [ ] `LICENSE` is Apache-2.0.
- [ ] `NOTICE` is present and accurate.
- [ ] `SECURITY.md` is present.
- [ ] `CONTRIBUTING.md` is present.
- [ ] `AGENTS.md` is present.
- [ ] `SERVARI.md` is present and public-safe.
- [ ] `docs/LICENSE_MATRIX.md` is present.
- [ ] `docs/CLAIM_REGISTER.md` is present.
- [ ] `docs/REPRODUCIBILITY.md` is present.
- [ ] `docs/SECURITY_MODEL.md` is present.
- [ ] `docs/THREAT_MODEL.md` is present.
- [ ] `docs/THIRD_PARTY_REVIEW.md` is present.

## Verification

- [ ] `python scripts/verify_all.py` passes locally.
- [ ] The UI builds locally:
  - [ ] `cd ui`
  - [ ] `npm install`
  - [ ] `npm run build`
- [ ] GitHub Actions `python-verification` passes.
- [ ] GitHub Actions `ui-build` passes.
- [ ] `verification/last-run.json` is generated locally but not committed.

## Secret and data checks

- [ ] No `config.json` is committed.
- [ ] No `.env` file is committed.
- [ ] No API keys, access tokens, passwords, or private provider config are committed.
- [ ] No private transcripts or local logs are committed.
- [ ] Bundled `demo-data/` is synthetic or public-safe.
- [ ] Runtime-generated verification artifacts are ignored.

## Claim discipline

- [ ] README does not claim AGI.
- [ ] README does not claim the repo ships a frontier model.
- [ ] README does not claim third-party certification.
- [ ] README does not claim public internet hardening.
- [ ] README does not claim a shipped concurrent autonomous multi-agent execution engine.
- [ ] Roadmap items are labelled as roadmap, partial, or not shipped.
- [ ] Claim register statuses match the current code and tests.

## Security posture

- [ ] Server binds localhost by default.
- [ ] Action runner remains allow-listed.
- [ ] Unknown actions are refused.
- [ ] High-risk autonomy still queues at L5.
- [ ] Verify queue writes pending and decision events append-only.
- [ ] Retention self-test covers KEEP, REVERT, byte-exact restore, and double-decide rejection.

## Release actions

- [ ] Review PR diff.
- [ ] Merge only after CI is green.
- [ ] Create a signed or annotated release tag.
- [ ] Publish release notes stating shipped scope and non-claims.
- [ ] Link the audit repository.
- [ ] Invite one outside reviewer to run `docs/THIRD_PARTY_REVIEW.md`.
