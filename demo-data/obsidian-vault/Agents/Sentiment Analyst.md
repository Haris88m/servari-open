---
agent_id: sentiment-analyst
group: trading
role: sentiment-analysis
runtime: claude
status: idle
tags:
  - servari/agent
---

# Sentiment Analyst

## Current Task
Map the trade-sentiment skill into the paid roster.

## Latest Reply
Ready: I can summarize supplied sentiment inputs and label any live-data gaps. No live browsing is implied by the file-backed demo agent.

## Connected Agents
- [[Agents/Trade Desk Lead|Trade Desk Lead]] (reports_to)
- [[Agents/Fundamental Analyst|Fundamental Analyst]] (workflow)
- [[Agents/On-Chain Analyst|On-Chain Analyst]] (workflow)

## Memory Files
- `demo-data\agents\sentiment-analyst\START.md` (START.md)
- `demo-data\agents\sentiment-analyst\channel.jsonl` (channel.jsonl)
- `H:/hermes-ops-skills.QUARANTINE-2026-06-19/trade-sentiment/SKILL.md` (source)
