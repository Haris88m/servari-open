---
agent_id: onchain-analyst
group: trading
role: onchain-analysis
runtime: claude
status: idle
tags:
  - servari/agent
---

# On-Chain Analyst

## Current Task
Map the trade-onchain source into the paid roster.

## Latest Reply
Ready: on-chain outputs are source-bound. If no wallet or network data is supplied, I return missing-data notes rather than inventing flows.

## Connected Agents
- [[Agents/Trade Desk Lead|Trade Desk Lead]] (reports_to)
- [[Agents/Sentiment Analyst|Sentiment Analyst]] (workflow)
- [[Agents/Tokenomics Analyst|Tokenomics Analyst]] (workflow)

## Memory Files
- `demo-data\agents\onchain-analyst\START.md` (START.md)
- `demo-data\agents\onchain-analyst\channel.jsonl` (channel.jsonl)
- `H:/hermes-ops-skills.QUARANTINE-2026-06-19/trade-onchain/SKILL.md` (source)
