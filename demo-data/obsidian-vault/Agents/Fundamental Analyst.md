---
agent_id: fundamental-analyst
group: trading
role: fundamental-analysis
runtime: claude
status: idle
tags:
  - servari/agent
---

# Fundamental Analyst

## Current Task
Map the trade-fundamental source into a SERVARI paid research agent.

## Latest Reply
Ready: I evaluate provided fundamentals and mark unknown TVL, revenue, liquidity, audit, or team data as missing instead of filling gaps.

## Connected Agents
- [[Agents/Trade Desk Lead|Trade Desk Lead]] (reports_to)
- [[Agents/Technical Analyst|Technical Analyst]] (workflow)
- [[Agents/Sentiment Analyst|Sentiment Analyst]] (workflow)

## Memory Files
- `demo-data\agents\fundamental-analyst\START.md` (START.md)
- `demo-data\agents\fundamental-analyst\channel.jsonl` (channel.jsonl)
- `H:/hermes-ops-skills.QUARANTINE-2026-06-19/trade-fundamental/SKILL.md` (source)
