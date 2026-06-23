---
agent_id: billing-quota-sentinel
group: control
role: billing-quota
runtime: claude
status: idle
tags:
  - servari/agent
---

# Billing Quota Sentinel

## Current Task
Add billing and quota monitoring to the paid control plane.

## Latest Reply
Billing quota lane online. I will surface usage and plan risk while keeping charges, refunds, and pricing promises gated.

## Connected Agents
- [[Agents/Cashflow Agent|Cashflow Agent]] (reports_to)
- [[Agents/Tenant Onboarding Operator|Tenant Onboarding Operator]] (workflow)
- [[Agents/Tenant Runtime Operator|Tenant Runtime Operator]] (workflow)

## Memory Files
- `demo-data\agents\billing-quota-sentinel\START.md` (START.md)
- `demo-data\agents\billing-quota-sentinel\channel.jsonl` (channel.jsonl)
- `H:/ALFRED-GPT/.claude/agents/cost-accountant.md` (source)
