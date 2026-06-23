---
agent_id: reviewer
group: delivery
role: review
runtime: claude
status: idle
tags:
  - servari/agent
---

# Review Agent

## Current Task
Review the builder's settings page diff.

## Latest Reply
Logic is clean. One note: the save handler should validate the model name before writing. Flagged it, not blocking.

## Connected Agents
- [[Agents/Orchestrator|Orchestrator]] (reports_to)
- [[Agents/Pursuit Agent|Pursuit Agent]] (workflow)
- [[Agents/Build Agent|Build Agent]] (workflow)
- [[Agents/Gatekeeper|Gatekeeper]] (workflow)

## Memory Files
- `demo-data\agents\reviewer\START.md` (START.md)
- `demo-data\agents\reviewer\channel.jsonl` (channel.jsonl)
