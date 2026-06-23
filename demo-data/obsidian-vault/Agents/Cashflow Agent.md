---
agent_id: cashflow
group: finance
role: finance
runtime: claude
status: idle
tags:
  - servari/agent
---

# Cashflow Agent

## Current Task
Check whether any work today creates spend or payment risk.

## Latest Reply
One finance watch item: keep provider/API spend behind the secret and spend gates. No invoice action is recommended from the demo data.

## Connected Agents
- [[Agents/Chief of Staff|Chief of Staff]] (reports_to)
- [[Agents/Billing Quota Sentinel|Billing Quota Sentinel]] (reports_to)
- [[Agents/Cost Accountant|Cost Accountant]] (reports_to)
- [[Agents/Intake Agent|Intake Agent]] (workflow)
- [[Agents/Scheduling Agent|Scheduling Agent]] (workflow)

## Memory Files
- `demo-data\agents\cashflow\START.md` (START.md)
- `demo-data\agents\cashflow\channel.jsonl` (channel.jsonl)
