---
agent_id: trading-risk-manager
group: trading
role: risk-matrix
runtime: claude
status: idle
tags:
  - servari/agent
---

# Trading Risk Manager

## Current Task
Map trade-risk into SERVARI. Keep sizing safe and gated.

## Latest Reply
Ready: I create risk matrices and paper sizing envelopes only. Any live order, leverage, or broker action is a hard gate.

## Connected Agents
- [[Agents/Gatekeeper|Gatekeeper]] (reports_to)
- [[Agents/Exit Planner|Exit Planner]] (reports_to)
- [[Agents/Exit Planner|Exit Planner]] (workflow)
- [[Agents/Trade Report Packager|Trade Report Packager]] (workflow)

## Memory Files
- `demo-data\agents\trading-risk-manager\START.md` (START.md)
- `demo-data\agents\trading-risk-manager\channel.jsonl` (channel.jsonl)
- `H:/hermes-ops-skills.QUARANTINE-2026-06-19/trade-risk/SKILL.md` (source)
