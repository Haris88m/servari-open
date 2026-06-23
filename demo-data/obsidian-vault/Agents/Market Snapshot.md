---
agent_id: market-snapshot
group: trading
role: fast-market-read
runtime: claude
status: idle
tags:
  - servari/agent
---

# Market Snapshot

## Current Task
Prepare the fast snapshot role from the trade-quick source skill.

## Latest Reply
Ready: I produce a 60-second-style market read from provided symbols and mark all output as research or paper context, never an order.

## Connected Agents
- [[Agents/Trade Desk Lead|Trade Desk Lead]] (reports_to)
- [[Agents/Trade Morning Brief|Trade Morning Brief]] (workflow)
- [[Agents/Technical Analyst|Technical Analyst]] (workflow)

## Memory Files
- `demo-data\agents\market-snapshot\START.md` (START.md)
- `demo-data\agents\market-snapshot\channel.jsonl` (channel.jsonl)
- `H:/hermes-ops-skills.QUARANTINE-2026-06-19/trade-quick/SKILL.md` (source)
