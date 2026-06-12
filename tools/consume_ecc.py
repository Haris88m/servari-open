#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""consume_ecc.py — the CONSUME ingest adapter for ECC agent definitions.

CONSUME thesis: harnesses are raw material. This adapter reads agent
DEFINITIONS (data, not code) from ECC (github.com/affaan-m/ECC, MIT) and
converts each one into SERVARI's own agent shape. ECC's content conforms to
OUR schema — never the reverse.

ECC agent shape (input, one markdown file per agent):
    ---
    name: planner
    description: Expert planning specialist ...
    tools: ["Read", "Grep", "Glob"]        # or bare YAML flow: [Read, Grep]
    model: opus
    color: pink                            # optional, ignored
    ---
    <markdown body = the agent's system instructions>

SERVARI agent shape (output, the schema this repo's server already loads):
    demo-data/agents.json                  -> roster: {"agents": [{id, name}]}
    demo-data/agents/<id>/START.md         -> the agent brief (/api/agent-brief)
    demo-data/agents/<id>/channel.jsonl    -> turn log; required for the agent
                                              to appear in /api/agents/status
    demo-data/team.json                    -> org chart (/api/org)
    demo-data/channel.jsonl                -> the center channel (pane 0)

Every converted artifact is tagged with provenance metadata:
    source=ECC, source_license=MIT, consumed_at=<date>,
    converter=tools/consume_ecc.py

Pure stdlib (Python 3.10+). No third-party imports. cp1252-safe output.

Usage:
    python tools/consume_ecc.py                       # defaults
    python tools/consume_ecc.py --source DIR --out DIR
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

SOURCE_NAME = "ECC"
SOURCE_REPO = "https://github.com/affaan-m/ECC"
SOURCE_LICENSE = "MIT"
CONVERTER = "tools/consume_ecc.py"

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = REPO_ROOT / "_consume_staging" / "agents"
DEFAULT_OUT = REPO_ROOT / "demo-data-ecc"

ID_SAFE = re.compile(r"[^a-z0-9._-]+")


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def parse_frontmatter(text: str) -> tuple[dict, str] | None:
    """Split an ECC agent file into (frontmatter dict, body).

    Only the four known scalar/flow-list keys are interpreted; unknown keys
    are carried through verbatim as strings. Returns None when the file has
    no leading `---` frontmatter block (such a file is not an agent
    definition and is skipped by the caller).
    """
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if not m:
        return None
    raw_fm, body = m.group(1), m.group(2)
    fm: dict = {}
    for line in raw_fm.splitlines():
        if not line.strip() or line.lstrip() != line:  # skip blank / indented
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        fm[key.strip()] = val.strip()
    if "tools" in fm:
        fm["tools"] = parse_tools(fm["tools"])
    return fm, body.strip()


def parse_tools(raw: str) -> list[str]:
    """Parse the tools field: JSON array OR bare YAML flow list."""
    raw = raw.strip()
    if not raw:
        return []
    try:
        val = json.loads(raw)
        if isinstance(val, list):
            return [str(x).strip() for x in val]
    except (ValueError, TypeError):
        pass
    # bare YAML flow: [Read, Grep, Glob]
    inner = raw.strip("[]")
    return [t.strip().strip("\"'") for t in inner.split(",") if t.strip()]


def safe_id(name: str) -> str:
    """ECC names are already lowercase-hyphen; enforce it anyway (our schema)."""
    return ID_SAFE.sub("-", name.strip().lower()).strip("-")


def display_name(agent_id: str) -> str:
    return " ".join(w.capitalize() for w in agent_id.replace("_", "-").split("-"))


def build_start_md(agent_id: str, fm: dict, body: str, consumed_at: str) -> str:
    """The SERVARI brief: H1 = agent id (matches demo-data/agents/*/START.md),
    provenance block, then the converted system instructions."""
    tools = fm.get("tools") or []
    lines = [
        f"# {agent_id}",
        "",
        f"> Consumed from {SOURCE_NAME} ({SOURCE_REPO}) under the {SOURCE_LICENSE} license.",
        f"> consumed_at={consumed_at} | converter={CONVERTER}",
        f"> source fields: model={fm.get('model', '?')} | tools={', '.join(tools) if tools else '(none)'}",
        "",
        fm.get("description", "").strip(),
        "",
        "## System instructions (converted from the ECC definition)",
        "",
        body,
        "",
    ]
    return "\n".join(lines)


def seed_channel_turn(agent_id: str, consumed_at: str, ts: str) -> str:
    """One JSONL turn in the exact shape servari_server._append writes."""
    turn = {
        "turn": 1,
        "from": "servari",
        "text": (
            f"Agent '{agent_id}' consumed from {SOURCE_NAME} ({SOURCE_REPO}, "
            f"{SOURCE_LICENSE}) on {consumed_at} via {CONVERTER}."
        ),
        "ts": ts,
    }
    return json.dumps(turn) + "\n"


def convert(source: Path, out: Path, consumed_at: str) -> dict:
    ts = _utc_now_iso()
    agents_out = out / "agents"
    agents_out.mkdir(parents=True, exist_ok=True)

    roster = []
    skipped = []
    for f in sorted(source.glob("*.md")):
        text = f.read_text(encoding="utf-8", errors="replace")
        parsed = parse_frontmatter(text)
        if parsed is None:
            skipped.append({"file": f.name, "reason": "no frontmatter"})
            continue
        fm, body = parsed
        raw_name = fm.get("name", "")
        if not raw_name:
            skipped.append({"file": f.name, "reason": "no name in frontmatter"})
            continue
        agent_id = safe_id(raw_name)
        if not agent_id:
            skipped.append({"file": f.name, "reason": "name sanitized to empty"})
            continue

        adir = agents_out / agent_id
        adir.mkdir(parents=True, exist_ok=True)
        (adir / "START.md").write_text(
            build_start_md(agent_id, fm, body, consumed_at),
            encoding="utf-8", newline="\n",
        )
        (adir / "channel.jsonl").write_text(
            seed_channel_turn(agent_id, consumed_at, ts),
            encoding="utf-8", newline="\n",
        )

        roster.append({
            "id": agent_id,
            "name": display_name(agent_id),
            "description": fm.get("description", ""),
            "source": SOURCE_NAME,
            "source_license": SOURCE_LICENSE,
            "source_model": fm.get("model", ""),
            "source_tools": fm.get("tools") or [],
            "consumed_at": consumed_at,
            "converter": CONVERTER,
        })

    meta = {
        "source": SOURCE_NAME,
        "source_repo": SOURCE_REPO,
        "source_license": SOURCE_LICENSE,
        "consumed_at": consumed_at,
        "converter": CONVERTER,
        "count": len(roster),
    }

    # agents.json — the roster the health surface counts.
    agents_json = {
        "_doc": (
            "ECC agent roster consumed into SERVARI's agent shape. "
            "Definitions transformed (not copied) by tools/consume_ecc.py."
        ),
        "_meta": meta,
        "agents": roster,
    }
    (out / "agents.json").write_text(
        json.dumps(agents_json, indent=2) + "\n", encoding="utf-8", newline="\n",
    )

    # team.json — the org chart /api/org renders: Operator -> Orchestrator -> all.
    org_chart = [
        {"name": "Operator", "role": "Operator", "reports_to": None,
         "is_human": True, "manages": ["Orchestrator"]},
        {"name": "Orchestrator", "role": "Orchestrator", "reports_to": "Operator",
         "manages": [a["id"] for a in roster]},
    ]
    for a in roster:
        org_chart.append({"name": a["id"], "role": a["name"], "reports_to": "Orchestrator"})
    team_json = {
        "_doc": "Org chart for the consumed ECC agent fleet (/api/org).",
        "_meta": meta,
        "org_chart": org_chart,
        "comms_matrix": {"Orchestrator": {"talks_to": [a["id"] for a in roster]}},
        "reporting_chain": {
            "rule": "The Operator speaks to the Orchestrator; the Orchestrator runs the consumed fleet."
        },
    }
    (out / "team.json").write_text(
        json.dumps(team_json, indent=2) + "\n", encoding="utf-8", newline="\n",
    )

    # center channel — pane 0 of the grid announces the consumption.
    center = {
        "turn": 1,
        "from": "servari",
        "text": (
            f"CONSUME demo: {len(roster)} agent definitions from {SOURCE_NAME} "
            f"({SOURCE_REPO}, {SOURCE_LICENSE}) converted into SERVARI's agent "
            f"shape on {consumed_at} by {CONVERTER}. Harnesses are raw material."
        ),
        "ts": ts,
    }
    (out / "channel.jsonl").write_text(
        json.dumps(center) + "\n", encoding="utf-8", newline="\n",
    )

    return {"ok": True, "consumed": len(roster), "skipped": skipped,
            "out": str(out), "meta": meta}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Consume ECC agent definitions into SERVARI's agent shape.")
    ap.add_argument("--source", default=str(DEFAULT_SOURCE),
                    help="dir of ECC agent .md files (default: _consume_staging/agents)")
    ap.add_argument("--out", default=str(DEFAULT_OUT),
                    help="output demo-data dir (default: demo-data-ecc)")
    ap.add_argument("--consumed-at", default=datetime.date.today().isoformat(),
                    help="provenance date stamp (default: today)")
    args = ap.parse_args(argv)

    source = Path(args.source)
    if not source.is_dir():
        print(json.dumps({"ok": False, "error": f"source dir not found: {source}"}))
        return 1
    result = convert(source, Path(args.out), args.consumed_at)
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] and result["consumed"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
