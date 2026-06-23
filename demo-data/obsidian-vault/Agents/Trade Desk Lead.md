---
agent_id: trade-desk-lead
group: trading
role: trade-orchestration
runtime: claude
status: idle
tags:
  - servari/agent
---

# Trade Desk Lead

## Current Task
Stand up the paid trade desk from the local trade-agent source pool. Keep it non-executing and gated.

## Latest Reply
Live order placement remains outside the shipped workspace and requires explicit human approval plus an external broker connector.

## Connected Agents
- [[Agents/Orchestrator|Orchestrator]] (reports_to)
- [[Agents/Market Snapshot|Market Snapshot]] (reports_to)
- [[Agents/Technical Analyst|Technical Analyst]] (reports_to)
- [[Agents/Fundamental Analyst|Fundamental Analyst]] (reports_to)
- [[Agents/Sentiment Analyst|Sentiment Analyst]] (reports_to)
- [[Agents/On-Chain Analyst|On-Chain Analyst]] (reports_to)
- [[Agents/Tokenomics Analyst|Tokenomics Analyst]] (reports_to)
- [[Agents/Alert Builder|Alert Builder]] (reports_to)
- [[Agents/Trade Journalist|Trade Journalist]] (reports_to)
- [[Agents/Trade Coach|Trade Coach]] (reports_to)
- [[Agents/Trade Morning Brief|Trade Morning Brief]] (reports_to)
- [[Agents/Trade Weekly Review|Trade Weekly Review]] (reports_to)
- [[Agents/Trade Report Packager|Trade Report Packager]] (reports_to)
- [[Agents/Tokenomics Analyst|Tokenomics Analyst]] (workflow)

## Memory Files
- `demo-data\agents\trade-desk-lead\START.md` (START.md)
- `demo-data\agents\trade-desk-lead\channel.jsonl` (channel.jsonl)
- `H:/hermes-ops-skills.QUARANTINE-2026-06-19/trade-analyze/SKILL.md` (source)
