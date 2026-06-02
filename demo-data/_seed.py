#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_seed.py — (re)generate the SERVARI demo data with FRESH timestamps.

The bundled demo-data/ ships ready to run. This script only matters if you want
the demo channels to look "just active" again: it rewrites the time-stamped seed
files (channel turns, agent channels, token history, context state) with
timestamps relative to NOW, so the live panes show "active" instead of "idle".

Static JSON seeds (org/team/ventures/launch/jobs/finance/...) are NOT touched —
they have no time dependency and ship as plain files.

Usage:  python demo-data/_seed.py
Stdlib only. cp1252-safe. Idempotent. Never reads anything outside demo-data/.
"""
from __future__ import annotations
import datetime
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def iso(minutes_ago=0, hours_ago=0):
    n = datetime.datetime.now(datetime.timezone.utc)
    n = n - datetime.timedelta(minutes=minutes_ago, hours=hours_ago)
    return n.isoformat(timespec="seconds")


def write_jsonl(rel, rows):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def write_json(rel, obj):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


# --- the center channel: you <-> SERVARI -------------------------------------
write_jsonl("channel.jsonl", [
    {"turn": 1, "from": "user", "text": "Hey SERVARI — what can you do?", "ts": iso(minutes_ago=6)},
    {"turn": 2, "from": "servari", "text": "I'm the operating-system shell. Bring your own model, set an autonomy level per agent, and I'll run the agent workspace. Ask me anything, or open the Agents view to watch them work.", "ts": iso(minutes_ago=6)},
    {"turn": 3, "from": "user", "text": "Show me the demo agents.", "ts": iso(minutes_ago=3)},
    {"turn": 4, "from": "servari", "text": "Four demo agents are online: builder, researcher, reviewer, and scheduler. Their channels are populated under demo-data/agents/. Open the grid to see each one's recent turns.", "ts": iso(minutes_ago=2)},
    {"turn": 5, "from": "user", "text": "Great. I'll wire my own model in config.json next.", "ts": iso(minutes_ago=1)},
])

# --- the four demo agents ----------------------------------------------------
write_jsonl("agents/builder/channel.jsonl", [
    {"turn": 1, "from": "user", "text": "Scaffold the new settings page.", "ts": iso(minutes_ago=5)},
    {"turn": 2, "from": "builder", "text": "Created the route, the form component, and a stub save handler. Running the typecheck now.", "ts": iso(minutes_ago=4)},
    {"turn": 3, "from": "builder", "text": "Typecheck passed. The page renders; the save handler is parked for your review (it writes to disk).", "ts": iso(minutes_ago=2)},
])
write_jsonl("agents/researcher/channel.jsonl", [
    {"turn": 1, "from": "user", "text": "Find three open-source TTS engines we could bundle.", "ts": iso(minutes_ago=8)},
    {"turn": 2, "from": "researcher", "text": "Shortlist: Piper (MIT, fast, neural), Coqui TTS (MPL), and eSpeak-NG (GPL — license-incompatible for bundling). Piper is the cleanest fit.", "ts": iso(minutes_ago=7)},
    {"turn": 3, "from": "researcher", "text": "Piper ships small ONNX voices and runs CPU-only. Drafted a one-paragraph comparison for the reviewer.", "ts": iso(minutes_ago=4)},
])
write_jsonl("agents/reviewer/channel.jsonl", [
    {"turn": 1, "from": "user", "text": "Review the builder's settings page diff.", "ts": iso(minutes_ago=3)},
    {"turn": 2, "from": "reviewer", "text": "Logic is clean. One note: the save handler should validate the model name before writing. Flagged it, not blocking.", "ts": iso(minutes_ago=1)},
])
write_jsonl("agents/scheduler/channel.jsonl", [
    {"turn": 1, "from": "user", "text": "What's queued for today?", "ts": iso(hours_ago=2)},
    {"turn": 2, "from": "scheduler", "text": "Two items: finish the settings page (in progress) and the weekly report (not started). Nothing is overdue.", "ts": iso(hours_ago=2)},
])

# --- demo agent briefs (START.md beside each channel) ------------------------
def write_text(rel, text):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)

write_text("agents/builder/START.md", "# builder\n\nThe build agent. Scaffolds and edits code, runs the typecheck, and parks any disk-writing action for review.\n")
write_text("agents/researcher/START.md", "# researcher\n\nThe research agent. Gathers options, checks licenses, and hands a short comparison to the reviewer.\n")
write_text("agents/reviewer/START.md", "# reviewer\n\nThe review agent. Reads diffs for correctness and flags risks without blocking unless a hard gate is crossed.\n")
write_text("agents/scheduler/START.md", "# scheduler\n\nThe scheduling agent. Tracks what's queued, in progress, and overdue.\n")

# --- token usage history (synthetic; replaces real transcripts) -------------
write_jsonl("token-history.jsonl", [
    {"session": "demo-session-01", "model": "sonnet", "timestamp": iso(hours_ago=5),
     "usage": {"input_tokens": 12000, "output_tokens": 3400, "cache_creation_input_tokens": 8000, "cache_read_input_tokens": 41000}},
    {"session": "demo-session-01", "model": "sonnet", "timestamp": iso(hours_ago=4),
     "usage": {"input_tokens": 9800, "output_tokens": 2600, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 52000}},
    {"session": "demo-session-02", "model": "haiku", "timestamp": iso(hours_ago=2),
     "usage": {"input_tokens": 4200, "output_tokens": 1100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 18000}},
    {"session": "demo-session-03", "model": "opus", "timestamp": iso(minutes_ago=20),
     "usage": {"input_tokens": 15400, "output_tokens": 5200, "cache_creation_input_tokens": 12000, "cache_read_input_tokens": 88000}},
    {"session": "demo-session-03", "model": "opus", "timestamp": iso(minutes_ago=5),
     "usage": {"input_tokens": 6100, "output_tokens": 2900, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 95000}},
])

# --- context state (active-work + a transcript so pressure() reads a signal) -
write_json("active-work.json", {
    "work_id": 7,
    "title": "Wire the BYOM chat backend",
    "status": "in progress — drafting the provider-agnostic call",
    "next_action": "validate the model name before the first request",
    "session": "S001",
})
# a small demo transcript so context_policy.pressure() finds a *.jsonl signal
write_jsonl("transcripts/demo-session.jsonl", [
    {"role": "user", "text": "let's keep going", "ts": iso(minutes_ago=10)},
    {"role": "assistant", "text": "on it", "ts": iso(minutes_ago=9)},
])

print("demo-data reseeded with fresh timestamps.")
