---
agent_id: release-manager
group: release
role: release
runtime: claude
status: idle
tags:
  - servari/agent
---

# Release Manager

## Current Task
Prepare the release-readiness check for the expanded local agent workspace.

## Latest Reply
Release-readiness checklist now includes agents/status shape, workflow lanes, process-table root key, UI build, API smoke, and browser route checks.

## Connected Agents
- [[Agents/Orchestrator|Orchestrator]] (reports_to)
- [[Agents/Release Platform|Release Platform]] (reports_to)
- [[Agents/Runtime Watch|Runtime Watch]] (workflow)
- [[Agents/Gatekeeper|Gatekeeper]] (workflow)

## Memory Files
- `demo-data\agents\release-manager\START.md` (START.md)
- `demo-data\agents\release-manager\channel.jsonl` (channel.jsonl)
