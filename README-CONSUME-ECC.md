# consume-ecc — the CONSUME demo branch

**What this is:** the harness flagship as raw material. This opt-in branch
takes the agent definitions of [ECC](https://github.com/affaan-m/ECC) — the
213K-star MIT-licensed harness collection — and **consumes** them into
SERVARI's own agent shape. Mainline stays clean; if you want the consumed
fleet, you check out this branch.

The result: all **64** ECC agent definitions running as a SERVARI org —
visible in the agent grid, the org chart, the health surface, and the
per-agent brief panel — without adopting a single line of ECC's code.

## The thesis (one paragraph)

Consume, don't harness. A harness asks you to climb inside someone else's
shape: their hooks, their config dialects, their runtime assumptions. The
CONSUME architecture inverts that relationship — external ecosystems are raw
material, chewed and converted into our schema, never the reverse. ECC's 64
agents are excellent _data_: names, briefs, tool hints, instruction bodies.
So we ingest the data, tag its provenance, conform it to the shape our
server already loads, and prove the whole fleet boots behind our own API.
The harness becomes a feed; the shell stays sovereign.

## How to use it

```bash
git checkout consume-ecc

# Stage the consumed org as a SERVARI home (never point it at live data):
mkdir -p /tmp/servari-ecc-home
cp -r demo-data-ecc /tmp/servari-ecc-home/demo-data

# Boot on a throwaway port:
SERVARI_HOME=/tmp/servari-ecc-home SERVARI_PORT=8979 python server/servari_server.py
# -> http://127.0.0.1:8979  (API: /api/health, /api/agents/status, /api/org,
#    /api/agent-brief?name=planner)
```

On Windows (PowerShell):

```powershell
git checkout consume-ecc
New-Item -ItemType Directory -Force $env:TEMP\servari-ecc-home
Copy-Item -Recurse demo-data-ecc $env:TEMP\servari-ecc-home\demo-data
$env:SERVARI_HOME = "$env:TEMP\servari-ecc-home"; $env:SERVARI_PORT = "8979"
python server\servari_server.py
```

To regenerate `demo-data-ecc/` from a fresh ECC snapshot:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/affaan-m/ECC.git _consume_staging
git -C _consume_staging sparse-checkout set agents
python tools/consume_ecc.py          # reads _consume_staging/agents -> demo-data-ecc/
rm -rf _consume_staging              # staging is never committed
```

## Conversion mapping (lock-in: their content fits our schema)

| ECC field (agents/\*.md)     | SERVARI field                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| frontmatter `name`           | agent `id` (sanitized) — dir name under `demo-data-ecc/agents/<id>/`, roster `id` in `agents.json`, node `name` in `team.json`            |
| frontmatter `description`    | roster `description` in `agents.json` + lead paragraph of `START.md`                                                                      |
| frontmatter `tools`          | roster `source_tools` (metadata) + provenance line in `START.md`                                                                          |
| frontmatter `model`          | roster `source_model` (metadata only — SERVARI is BYOM)                                                                                   |
| frontmatter `color`          | dropped (presentation hint, not part of our schema)                                                                                       |
| markdown body (instructions) | `demo-data-ecc/agents/<id>/START.md` body — served by `/api/agent-brief`                                                                  |
| (n/a — generated)            | `demo-data-ecc/agents/<id>/channel.jsonl` — seed turn recording the consumption; required for the agent to appear in `/api/agents/status` |
| (n/a — generated)            | `demo-data-ecc/team.json` — Operator -> Orchestrator -> 64 agents (`/api/org`)                                                            |
| (n/a — generated)            | `demo-data-ecc/channel.jsonl` — center-channel announcement (pane 0)                                                                      |

Every converted artifact carries provenance tags: `source=ECC`,
`source_license=MIT`, `consumed_at=2026-06-12`,
`converter=tools/consume_ecc.py`.

## What was deliberately NOT consumed

Only agent **definitions** — data, not code — were converted:

- **No hooks** (ECC's trigger automations stay out)
- **No commands / slash workflows**
- **No skills, rules, plugin or MCP configurations**
- **No scripts or any executable content**
- **No multi-harness ports** (`.kiro/`, `.codex/`, `.cursor/`, etc. — we
  consume the canonical `agents/` set once, into one schema: ours)

ECC's code was not copied. See
[THIRD_PARTY_NOTICES-ECC.md](THIRD_PARTY_NOTICES-ECC.md) for the MIT
attribution and the full list of consumed definitions.

## Files on this branch

- `tools/consume_ecc.py` — the ingest adapter (pure stdlib, Python 3.10+)
- `demo-data-ecc/` — the converted org: `agents.json`, `team.json`,
  `channel.jsonl`, `agents/<id>/{START.md, channel.jsonl}` x 64
- `THIRD_PARTY_NOTICES-ECC.md` — MIT compliance + license verification record
- `README-CONSUME-ECC.md` — this file

Verified: server boots with the consumed org (`/api/health` -> 64 agents,
`/api/agents/status` -> 65 panes) and the full test suite stays green
(160 passed).
