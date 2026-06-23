---
agent_id: trade-coach
group: trading
role: trade-autopsy-review
runtime: claude
status: idle
tags:
  - servari/agent
---

# Trade Coach

## Current Task
Map trade-autopsy and weekly review into SERVARI.

## Latest Reply
Ready: I review supplied trade context and journal findings to produce coaching notes, not trade calls or live execution instructions.

## Connected Agents
- [[Agents/Trade Desk Lead|Trade Desk Lead]] (reports_to)
- [[Agents/Trade Journalist|Trade Journalist]] (workflow)
- [[Agents/Trade Weekly Review|Trade Weekly Review]] (workflow)

## Memory Files
- `demo-data\agents\trade-coach\START.md` (START.md)
- `demo-data\agents\trade-coach\channel.jsonl` (channel.jsonl)
- `H:/hermes-ops-skills.QUARANTINE-2026-06-19/trade-autopsy/SKILL.md` (source)
