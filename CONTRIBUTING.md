# Contributing to SERVARI OS

Thanks for your interest. SERVARI OS is an open-source AI operating-system shell,
and it gets better when people who actually run it tell us what broke and what
they wish it did.

## The one rule that matters

**Keep it runnable for a stranger.** The whole value of this shell is that someone
can clone it, build the UI, run one Python command, and see every panel render on
first launch — with no backend wired. Any change that breaks that cold-start path
will be sent back. Before opening a pull request, do a fresh-clone test:

```bash
cd ui && npm install && npm run build && cd ..
python server/servari_server.py
# open http://127.0.0.1:8911/ and confirm the dashboard still renders
```

## Filing a bug

Open a GitHub issue and include:

1. **What you did** — the exact commands or clicks.
2. **What you expected** vs **what happened**.
3. **Environment** — OS, Node version (`node --version`), Python version
   (`python --version`), and whether a model was wired (`config.json` present?).
4. **Logs / screenshots** — the terminal output of the server and the browser
   console (DevTools → Console) are the highest-signal evidence. Redact any keys.

## Proposing a feature

Open an issue first describing the use case before writing code. A short
"here's the problem, here's roughly how I'd solve it" saves everyone a wasted PR.

## Submitting a pull request

1. **Fork** the repo and branch from the default branch.
2. **Keep the change focused** — one concern per PR. Small PRs get reviewed; large
   sweeping ones stall.
3. **Match the existing style.**
   - The server is **pure Python standard library** — do not add a `pip` dependency
     to the runtime path. (Optional integrations like voice may declare extras in
     `requirements.txt`, kept commented out by default.)
   - Every route must **degrade gracefully**: a missing module or file returns a
     clean "unavailable" payload, never a crash.
   - The action runner is **allow-listed**, not a raw shell. Do not introduce
     arbitrary command execution.
4. **Build the UI** if you touched `ui/src/` (`cd ui && npm run build`). The server
   serves the built `ui/dist/`.
5. **Do not commit secrets.** `config.json` is gitignored for a reason. Never put a
   real API key, token, or password anywhere in the tree — not even in an example.
6. **Run the fresh-clone test above** and confirm the shell still boots.

## What we are looking for

- Bug fixes that keep the cold-start path working.
- New panels or providers that follow the existing fail-closed, demo-data-first
  pattern.
- Documentation improvements — especially anything that made *your* first run
  confusing.
- Honest issues. "This claim in the README doesn't match what I see" is welcome.

## Code of conduct

Be decent. Assume good faith, keep feedback technical, and help newcomers get
their first run working.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE), the same license that covers the project.
