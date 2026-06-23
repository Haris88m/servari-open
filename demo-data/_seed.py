#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regenerate SERVARI demo data with fresh timestamps.

The bundled demo-data/ ships ready to run. This script only matters if you want
the demo channels to look active again: it rewrites the time-stamped seed files
with timestamps relative to now.

Static JSON seeds that have no time dependency are left alone.

Usage: python demo-data/_seed.py
Stdlib only. Idempotent. Never reads anything outside demo-data/.
"""
from __future__ import annotations

import datetime
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def iso(minutes_ago=0, hours_ago=0):
    now = datetime.datetime.now(datetime.timezone.utc)
    now = now - datetime.timedelta(minutes=minutes_ago, hours=hours_ago)
    return now.isoformat(timespec="seconds")


def write_jsonl(rel, rows):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_json(rel, obj):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def write_text(rel, text):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


# --- the center channel: you <-> SERVARI -----------------------------------
write_jsonl(
    "channel.jsonl",
    [
        {"turn": 1, "from": "user", "text": "Hey SERVARI - what can you do?", "ts": iso(minutes_ago=6)},
        {
            "turn": 2,
            "from": "servari",
            "text": (
                "I'm the operating-system shell. Bring your own model, set an autonomy "
                "level per agent, and I'll run the local agent workspace. Ask me anything, "
                "or open the Agents view to watch the roster."
            ),
            "ts": iso(minutes_ago=6),
        },
        {"turn": 3, "from": "user", "text": "Show me the demo agents.", "ts": iso(minutes_ago=3)},
        {
            "turn": 4,
            "from": "servari",
            "text": (
                "Fifty-one local paid-ready agents are registered across command, "
                "delivery, control-plane, product, customer, trade, domain, platform, "
                "finance, release, and runtime lanes. Their channels live under "
                "demo-data/agents/."
            ),
            "ts": iso(minutes_ago=2),
        },
        {
            "turn": 5,
            "from": "user",
            "text": "Great. I'll wire my own model in config.json next.",
            "ts": iso(minutes_ago=1),
        },
    ],
)


# --- demo agents ------------------------------------------------------------
AGENT_CHANNELS = {
    "chief-of-staff": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Run the daily local agent loop and route anything that needs an owner.",
            "ts": iso(minutes_ago=4),
        },
        {
            "turn": 2,
            "from": "chief-of-staff",
            "text": (
                "Daily loop is active. Intake, cashflow, schedule, and archive checks are "
                "assigned; release watch stays with Runtime Watch and Release Manager."
            ),
            "ts": iso(minutes_ago=2),
        },
        {
            "turn": 3,
            "from": "chief-of-staff",
            "text": (
                "Current focus: keep approval-gated work visible and make the expanded "
                "roster easy to inspect from the Agents view."
            ),
            "ts": iso(minutes_ago=1),
        },
    ],
    "intake": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Classify the newest work and call out anything ambiguous.",
            "ts": iso(minutes_ago=5),
        },
        {
            "turn": 2,
            "from": "intake",
            "text": "Three items tagged: release verification, workflow roster cleanup, and documentation refresh. No ambiguous blockers found.",
            "ts": iso(minutes_ago=1),
        },
    ],
    "opportunity-scout": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Scan for useful opportunities that match the current SERVARI positioning.",
            "ts": iso(minutes_ago=6),
        },
        {
            "turn": 2,
            "from": "opportunity-scout",
            "text": (
                "Shortlist started: local-first AI tooling, workflow automation consulting, "
                "and release-readiness audits look like the best match. Passing ranked "
                "notes to Pursuit."
            ),
            "ts": iso(minutes_ago=2),
        },
    ],
    "pursuit": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Prepare next actions for the opportunity shortlist. Do not send anything.",
            "ts": iso(minutes_ago=5),
        },
        {
            "turn": 2,
            "from": "pursuit",
            "text": "Drafted follow-up angles for the top three leads and marked all outbound messages as real-send gated.",
            "ts": iso(minutes_ago=1),
        },
    ],
    "cashflow": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Check whether any work today creates spend or payment risk.",
            "ts": iso(minutes_ago=5),
        },
        {
            "turn": 2,
            "from": "cashflow",
            "text": "One finance watch item: keep provider/API spend behind the secret and spend gates. No invoice action is recommended from the demo data.",
            "ts": iso(minutes_ago=1),
        },
    ],
    "builder": [
        {"turn": 1, "from": "operator", "text": "Scaffold the new settings page.", "ts": iso(minutes_ago=5)},
        {
            "turn": 2,
            "from": "builder",
            "text": "Created the route, the form component, and a stub save handler. Running the typecheck now.",
            "ts": iso(minutes_ago=4),
        },
        {
            "turn": 3,
            "from": "builder",
            "text": "Typecheck passed. The page renders; the save handler is parked for your review because it writes to disk.",
            "ts": iso(minutes_ago=2),
        },
    ],
    "researcher": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Find three open-source TTS engines we could bundle.",
            "ts": iso(minutes_ago=8),
        },
        {
            "turn": 2,
            "from": "researcher",
            "text": (
                "Shortlist: Piper (MIT, fast, neural), Coqui TTS (MPL), and "
                "eSpeak-NG (GPL; not suitable for this bundle). Piper is the cleanest fit."
            ),
            "ts": iso(minutes_ago=7),
        },
        {
            "turn": 3,
            "from": "researcher",
            "text": "Piper ships small ONNX voices and runs CPU-only. Drafted a one-paragraph comparison for the reviewer.",
            "ts": iso(minutes_ago=4),
        },
    ],
    "reviewer": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Review the builder's settings page diff.",
            "ts": iso(minutes_ago=3),
        },
        {
            "turn": 2,
            "from": "reviewer",
            "text": "Logic is clean. One note: the save handler should validate the model name before writing. Flagged it, not blocking.",
            "ts": iso(minutes_ago=1),
        },
    ],
    "scheduler": [
        {"turn": 1, "from": "operator", "text": "What's queued for today?", "ts": iso(hours_ago=2)},
        {
            "turn": 2,
            "from": "scheduler",
            "text": "Two items: finish the settings page and the weekly report. Nothing is overdue.",
            "ts": iso(hours_ago=2),
        },
    ],
    "gatekeeper": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Review the expanded workflow plan for hard-gate risks.",
            "ts": iso(minutes_ago=5),
        },
        {
            "turn": 2,
            "from": "gatekeeper",
            "text": "No external action is approved by the roster change. Publish, deploy, merge, spend, real-send, and secret work remain gated.",
            "ts": iso(minutes_ago=1),
        },
    ],
    "archivist": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Record the local roster expansion as demo workspace state.",
            "ts": iso(minutes_ago=5),
        },
        {
            "turn": 2,
            "from": "archivist",
            "text": "Prepared a memory note: the roster is a file-backed workspace surface with synthetic channels and no shipped autonomous execution claim.",
            "ts": iso(minutes_ago=1),
        },
    ],
    "release-manager": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Prepare the release-readiness check for the expanded local agent workspace.",
            "ts": iso(minutes_ago=5),
        },
        {
            "turn": 2,
            "from": "release-manager",
            "text": "Release-readiness checklist now includes agents/status shape, workflow lanes, process-table root key, UI build, API smoke, and browser route checks.",
            "ts": iso(minutes_ago=1),
        },
    ],
    "runtime-watch": [
        {
            "turn": 1,
            "from": "operator",
            "text": "Watch the server and browser route health during final verification.",
            "ts": iso(minutes_ago=5),
        },
        {
            "turn": 2,
            "from": "runtime-watch",
            "text": "Runtime watch is queued for final smoke: /api/agents/status, /api/agent-workflows, /shell/agents, /shell/chat, and /shell/runtime.",
            "ts": iso(minutes_ago=1),
        },
    ],
}

for agent, rows in AGENT_CHANNELS.items():
    write_jsonl(f"agents/{agent}/channel.jsonl", rows)


# --- demo agent briefs (START.md beside each channel) -----------------------
AGENT_BRIEFS = {
    "chief-of-staff": "Mission: keep the local agent workspace coherent.\nReads: main channel, active work, agent workflow lanes, and the gate queue.\nOutputs: routed next actions, owners, due dates, and short status summaries.\nHard gates: never approve spend, publish, real-send, merge, deploy, or secret work.\nDone means: every active item has an owner, a channel, and a visible next step.\n",
    "intake": "Mission: triage new local work into actionable buckets.\nReads: inbox-like data, main channel requests, and pending gate summaries.\nOutputs: priority, category, owner recommendation, and missing context.\nHard gates: never send messages externally or change source data.\nDone means: every item is tagged with urgency, owner, and next action.\n",
    "opportunity-scout": "Mission: find useful opportunities from local data and research notes.\nReads: jobs, applications, career profile, ventures, and reports.\nOutputs: ranked opportunities with evidence, fit, risk, and suggested pursuit.\nHard gates: do not contact anyone or submit anything.\nDone means: the Pursuit Agent receives a short ranked shortlist.\n",
    "pursuit": "Mission: turn qualified opportunities into concrete next steps.\nReads: Opportunity Scout shortlists, career data, and application status.\nOutputs: follow-up drafts, preparation checklists, and next-action plans.\nHard gates: all real-send actions must park in the verify queue.\nDone means: each lead has a recommended message, owner, and timing.\n",
    "cashflow": "Mission: watch cash, invoices, and spend risk from local finance data.\nReads: finance panel data, active work, and any proposed paid action.\nOutputs: due-now notes, spend warnings, and safe next steps.\nHard gates: never spend, pay, invoice, or change financial records.\nDone means: money-related work is visible before it can surprise the operator.\n",
    "builder": "Mission: scaffold and edit code in small reviewable slices.\nReads: source tree, tests, and requested implementation notes.\nOutputs: patches, build output, and any risk that needs review.\nHard gates: park destructive writes, secrets, deploys, and merges for approval.\nDone means: the change is implemented and locally checked.\n",
    "researcher": "Mission: gather options, sources, and constraints.\nReads: local docs, public references when requested, and project context.\nOutputs: concise comparisons and source-backed recommendations.\nHard gates: do not invent citations or alter code.\nDone means: the reviewer and builder have enough context to act.\n",
    "reviewer": "Mission: review behavior, risk, and missing tests.\nReads: diffs, test output, contracts, and release notes.\nOutputs: blocking findings first, then residual risk.\nHard gates: never approve its own unchecked assumption.\nDone means: the release manager knows what is safe to ship.\n",
    "scheduler": "Mission: track queued, in-progress, and overdue work.\nReads: active work, workflow lanes, and channel status.\nOutputs: next-up list, stale items, and timing risks.\nHard gates: do not commit the operator to external meetings.\nDone means: the work queue is ordered and visible.\n",
    "gatekeeper": "Mission: keep consequential actions behind explicit human approval.\nReads: verify queue, proposed actions, risk scores, and autonomy levels.\nOutputs: gate explanations, risk notes, and approval-ready summaries.\nHard gates: never approve its own gate and never execute gated work.\nDone means: each risky action says why it is queued and what rollback exists.\n",
    "archivist": "Mission: turn local decisions into durable memory.\nReads: main channel, gate decisions, reports, and completed workflow notes.\nOutputs: concise decision records and memory-surface updates.\nHard gates: do not rewrite source history or hide rejected decisions.\nDone means: a future operator can understand what changed and why.\n",
    "release-manager": "Mission: keep release readiness visible and test-backed.\nReads: release checklist, verification output, browser route smoke, and docs.\nOutputs: final readiness notes, missing checks, and artifact status.\nHard gates: never publish, tag, push, or merge without approval.\nDone means: tests, browser routes, docs, and release caveats are accounted for.\n",
    "runtime-watch": "Mission: watch the local runtime and route health while work is underway.\nReads: health, engine status, logs, context pressure, and token panels.\nOutputs: runtime status, failures, and recovery hints.\nHard gates: never expose the server publicly or change runtime host settings.\nDone means: local routes are reachable and failures are visible to the operator.\n",
}

for agent, body in AGENT_BRIEFS.items():
    title = agent.replace("-", " ").title()
    write_text(f"agents/{agent}/START.md", f"# {title}\n\n{body}")


# --- token usage history (synthetic; replaces real transcripts) -------------
write_jsonl(
    "token-history.jsonl",
    [
        {
            "session": "demo-session-01",
            "model": "sonnet",
            "timestamp": iso(hours_ago=5),
            "usage": {
                "input_tokens": 12000,
                "output_tokens": 3400,
                "cache_creation_input_tokens": 8000,
                "cache_read_input_tokens": 41000,
            },
        },
        {
            "session": "demo-session-01",
            "model": "sonnet",
            "timestamp": iso(hours_ago=4),
            "usage": {
                "input_tokens": 9800,
                "output_tokens": 2600,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 52000,
            },
        },
        {
            "session": "demo-session-02",
            "model": "haiku",
            "timestamp": iso(hours_ago=2),
            "usage": {
                "input_tokens": 4200,
                "output_tokens": 1100,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 18000,
            },
        },
        {
            "session": "demo-session-03",
            "model": "opus",
            "timestamp": iso(minutes_ago=20),
            "usage": {
                "input_tokens": 15400,
                "output_tokens": 5200,
                "cache_creation_input_tokens": 12000,
                "cache_read_input_tokens": 88000,
            },
        },
        {
            "session": "demo-session-03",
            "model": "opus",
            "timestamp": iso(minutes_ago=5),
            "usage": {
                "input_tokens": 6100,
                "output_tokens": 2900,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 95000,
            },
        },
    ],
)


# --- context state ----------------------------------------------------------
write_json(
    "active-work.json",
    {
        "work_id": 7,
        "title": "Wire the BYOM chat backend",
        "status": "in progress - drafting the provider-agnostic call",
        "next_action": "validate the model name before the first request",
        "session": "S001",
    },
)

write_jsonl(
    "transcripts/demo-session.jsonl",
    [
        {"role": "user", "text": "let's keep going", "ts": iso(minutes_ago=10)},
        {"role": "assistant", "text": "on it", "ts": iso(minutes_ago=9)},
    ],
)

print("demo-data reseeded with fresh timestamps.")
