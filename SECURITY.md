# Security Policy

SERVARI OS is an AI operating-system shell that runs on your machine, binds to
`127.0.0.1` by default, and can be wired to your own model provider. We take
security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Instead, report it privately through GitHub's **private vulnerability reporting**:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability** to open a private advisory.

If private reporting is unavailable, open a minimal public issue that says only
"requesting a private security contact" — without details — and we will follow up.

Please include, where possible:

- A description of the issue and its impact.
- The exact steps or proof-of-concept to reproduce it.
- The affected version / commit and your environment (OS, Node, Python).

## What to expect

- We aim to **acknowledge** a report within a few business days.
- We will work with you on a fix and a coordinated disclosure timeline.
- We will credit reporters who wish to be named, once a fix is available.

## Scope

In scope:

- The shell server (`server/`) — request handling, the allow-listed action
  runner, path handling, the BYOM proxy, and any route that reads or writes files.
- The desktop shell (`electron/`) — process launching and window configuration.

Out of scope:

- Vulnerabilities in third-party model providers you choose to wire in.
- Vulnerabilities in dependencies that are already publicly tracked upstream
  (report those to the upstream project; we will pick up the patched release).
- Misconfiguration on the operator's side (e.g. binding the server to a public
  interface via `SERVARI_HOST` without a firewall) — though documentation
  improvements to prevent such footguns are welcome.

## Hardening notes for operators

- The server binds **localhost only** by default. Do not expose it to a public
  network without an authenticating reverse proxy in front of it.
- Your model key lives in `config.json`, which is **gitignored**. Keep it that way;
  never commit a key.
- The action runner is **allow-listed** and high-risk actions park in a human gate.
  Review the gate queue before approving anything irreversible.
