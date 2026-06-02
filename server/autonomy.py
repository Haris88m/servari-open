#!/usr/bin/env python3
"""
autonomy.py — THE AUTONOMY DIAL.

A continuous autonomy dial, L0 -> L5, PER AGENT. The dial sets the THRESHOLD
at which an agent ACTS silently vs SURFACES for human approval. It composes:

  (a) the agent's autonomy LEVEL (L0-L5, the operator's dial), and
  (b) a risk SCORE (4-20; lower = safer — e.g. reversibility x blast-radius x
      data-loss x certainty)

...into one verdict: "act" | "report" | "queue".

The gates HOLD: this is the MECHANISM that decides act-vs-surface. It never
auto-crosses a hard human gate — even at L5, a high-risk score still queues.

State file: demo-data/autonomy-levels.json (per-agent level; default L2; the
operator owns the dial). Missing file -> sane defaults, NEVER crash
(fail-closed/graceful).

CLI:
    python autonomy.py --get <agent>
    python autonomy.py --set <agent> <0-5>
    python autonomy.py --list
    python autonomy.py --decide <agent> <score>

STDLIB only. cp1252-safe (stdout/stderr reconfigured to UTF-8).
"""

import argparse
import json
import os
import sys

# --- risk-score bands (total 4-20, lower = safer) -------------------------------
#   4-8   -> execute_silent
#   9-12  -> execute_notice
#   13-16 -> ask_first
#   17-20 -> refuse
SCORE_MIN = 4
SCORE_MAX = 20
BAND_SILENT_MAX = 8     # <= 8 : safe / silent
BAND_NOTICE_MAX = 12    # <= 12: low-risk / notice
BAND_ASK_MAX = 16       # <= 16: moderate / ask
# > 16 : high-risk / refuse

# --- the 6 autonomy levels (L0 suggest-only ... L5 full auto) -------------------
# Each level maps to the WORST score band at which the agent still ACTS silently.
# "act_silent_max"   : act silently for score <= this band ceiling
# "act_report_max"   : act-then-report for score <= this band ceiling (above
#                      act_silent_max). Above this -> queue for approval.
# The dial is monotonic: higher L = wider act-band, narrower queue-band.
LEVELS = {
    0: {
        "name": "suggest-only",
        "semantics": "Propose, never act. Everything queues for the operator.",
        "act_silent_max": 0,        # never act silently
        "act_report_max": 0,        # never act; always queue
    },
    1: {
        "name": "act-on-explicit-approval",
        "semantics": "Act only on items the operator explicitly approves. Default queues.",
        "act_silent_max": 0,        # nothing silent
        "act_report_max": 0,        # nothing auto-acted; all queue (approval gate upstream)
    },
    2: {
        "name": "act-then-report-each",
        "semantics": "Act on safe items and report EACH action; surface anything riskier.",
        "act_silent_max": 0,        # report, don't go silent
        "act_report_max": BAND_SILENT_MAX,   # act-then-report on safe (<=8); queue above
    },
    3: {
        "name": "act-then-report-batch",
        "semantics": "Act on safe+low-risk items, report them in a BATCH; surface moderate+.",
        "act_silent_max": 0,        # still report (batched), not silent
        "act_report_max": BAND_NOTICE_MAX,   # act-then-report up to low-risk (<=12); queue above
    },
    4: {
        "name": "act-silent-on-low-risk-report-high",
        "semantics": "Act SILENTLY on safe items, report low-risk, surface moderate+/high.",
        "act_silent_max": BAND_SILENT_MAX,   # silent on safe (<=8)
        "act_report_max": BAND_NOTICE_MAX,   # report low-risk (9-12); queue above
    },
    5: {
        "name": "act-silent-full-auto",
        "semantics": "Full auto: act silently up to moderate; surface only high-risk (the hard gate).",
        "act_silent_max": BAND_ASK_MAX,      # silent through moderate (<=16)
        "act_report_max": BAND_ASK_MAX,      # nothing extra to report; queue only high-risk (>16)
    },
}

DEFAULT_LEVEL = 2  # agents default to L2 (act-then-report-each); operator owns the dial.

STATE_REL = os.path.join("demo-data", "autonomy-levels.json")


# --- data-home resolution (SERVARI_HOME env, else repo root, else cwd) -----------
def _home():
    """Resolve the data home. Prefer SERVARI_HOME; else the repo root (parent of
    this server/ dir) when it contains demo-data/; else cwd. Never raises."""
    env = os.environ.get("SERVARI_HOME")
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    here = os.path.dirname(os.path.abspath(__file__))   # .../server
    repo = os.path.dirname(here)                         # repo root
    if os.path.isdir(os.path.join(repo, "demo-data")):
        return repo
    return os.getcwd()


def _state_path():
    return os.path.join(_home(), STATE_REL)


# --- state I/O (missing/corrupt file -> sane defaults, NEVER crash) --------------
def _load_state():
    """Load the per-agent level map. Missing or corrupt file -> {} (defaults
    apply per-agent at lookup time). NEVER raises."""
    path = _state_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    levels = data.get("levels")
    if not isinstance(levels, dict):
        return {}
    # sanitize: keep only int-coercible levels in [0,5]
    clean = {}
    for agent, lvl in levels.items():
        try:
            li = int(lvl)
        except (TypeError, ValueError):
            continue
        if 0 <= li <= 5:
            clean[str(agent)] = li
    return clean


def _save_state(levels):
    """Persist the per-agent level map. Creates the data dir if missing.
    Returns True on success, False on failure (never raises)."""
    path = _state_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        payload = {
            "_doc": "Per-agent autonomy levels (L0 suggest-only .. L5 full-auto). "
                    "The operator owns this dial. Default L2 when an agent is absent.",
            "default_level": DEFAULT_LEVEL,
            "levels": {k: int(v) for k, v in sorted(levels.items())},
        }
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, path)
        return True
    except OSError:
        return False


# --- public API -----------------------------------------------------------------
def get_level(agent):
    """Return the autonomy level (0-5) for an agent. Absent agent -> DEFAULT_LEVEL."""
    if not agent:
        return DEFAULT_LEVEL
    levels = _load_state()
    return levels.get(str(agent), DEFAULT_LEVEL)


def set_level(agent, level):
    """Set the autonomy level for an agent. Validates level in [0,5].
    Returns {"ok": bool, "agent", "level", "error"}.
    Invalid level -> ok=False, no write. Persist failure -> ok=False."""
    if not agent:
        return {"ok": False, "agent": agent, "level": None,
                "error": "empty_agent_name"}
    try:
        li = int(level)
    except (TypeError, ValueError):
        return {"ok": False, "agent": str(agent), "level": None,
                "error": "level_not_an_integer"}
    if li < 0 or li > 5:
        return {"ok": False, "agent": str(agent), "level": li,
                "error": "level_out_of_range_0_5"}
    levels = _load_state()
    levels[str(agent)] = li
    if not _save_state(levels):
        return {"ok": False, "agent": str(agent), "level": li,
                "error": "persist_failed"}
    return {"ok": True, "agent": str(agent), "level": li, "error": None}


def all_levels():
    """Return the full per-agent level map + the level definitions + default.
    Always returns a dict, never crashes."""
    levels = _load_state()
    return {
        "default_level": DEFAULT_LEVEL,
        "levels": levels,
        "definitions": level_definitions(),
    }


def level_definitions():
    """Return the L0-L5 definitions (name + semantics + act-band ceilings)."""
    out = {}
    for lvl, spec in LEVELS.items():
        out[str(lvl)] = {
            "level": lvl,
            "name": spec["name"],
            "semantics": spec["semantics"],
            "act_silent_max": spec["act_silent_max"],
            "act_report_max": spec["act_report_max"],
        }
    return out


def _score_band(score):
    """Map a risk score to its band label. Out-of-range clamps."""
    try:
        s = int(score)
    except (TypeError, ValueError):
        return "invalid"
    if s <= BAND_SILENT_MAX:
        return "silent"
    if s <= BAND_NOTICE_MAX:
        return "notice"
    if s <= BAND_ASK_MAX:
        return "ask"
    return "refuse"


def decide(agent, score):
    """Combine the agent's LEVEL + the risk SCORE into a verdict.

    Returns {"verdict": "act"|"report"|"queue", "agent", "level", "level_name",
             "score", "score_band", "reason"}.

    Logic (the dial): the level supplies two ceilings —
      score <= act_silent_max  -> act (silently)
      score <= act_report_max  -> report (act-then-report)
      else                     -> queue (surface for approval)

    Invariant the gates HOLD: even at L5 a high-risk score (>16, "refuse" band)
    is ABOVE every level's act_report_max, so it ALWAYS queues. The dial can
    widen the silent/report band but can NEVER auto-cross the hard human gate.

    Invalid/missing score -> queue (fail-closed)."""
    level = get_level(agent)
    spec = LEVELS.get(level, LEVELS[DEFAULT_LEVEL])
    band = _score_band(score)

    try:
        s = int(score)
    except (TypeError, ValueError):
        return {"verdict": "queue", "agent": str(agent), "level": level,
                "level_name": spec["name"], "score": score, "score_band": "invalid",
                "reason": "invalid_score_fail_closed_to_queue"}

    silent_ceiling = spec["act_silent_max"]
    report_ceiling = spec["act_report_max"]

    if silent_ceiling > 0 and s <= silent_ceiling:
        verdict = "act"
        reason = f"L{level} acts silently on score<={silent_ceiling} ({band} band)"
    elif report_ceiling > 0 and s <= report_ceiling:
        verdict = "report"
        reason = f"L{level} acts-then-reports on score<={report_ceiling} ({band} band)"
    else:
        verdict = "queue"
        reason = f"L{level} surfaces score {s} ({band} band) for human approval"

    return {
        "verdict": verdict,
        "agent": str(agent),
        "level": level,
        "level_name": spec["name"],
        "score": s,
        "score_band": band,
        "reason": reason,
    }


# --- CLI ------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="The autonomy dial — per-agent L0-L5 act-vs-surface threshold.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--get", metavar="AGENT", help="Get an agent's level.")
    group.add_argument("--set", nargs=2, metavar=("AGENT", "LEVEL"),
                       help="Set an agent's level (0-5).")
    group.add_argument("--list", action="store_true",
                       help="List all levels + definitions.")
    group.add_argument("--decide", nargs=2, metavar=("AGENT", "SCORE"),
                       help="Decide act/report/queue for an agent + score.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    args = parser.parse_args(argv)

    if args.get is not None:
        result = {"agent": args.get, "level": get_level(args.get),
                  "level_name": LEVELS[get_level(args.get)]["name"]}
        _emit(result, args.pretty)
        return 0

    if args.set is not None:
        agent, level = args.set
        result = set_level(agent, level)
        _emit(result, args.pretty)
        return 0 if result.get("ok") else 1

    if args.list:
        _emit(all_levels(), args.pretty)
        return 0

    if args.decide is not None:
        agent, score = args.decide
        result = decide(agent, score)
        _emit(result, args.pretty)
        # exit 0 for act/report (autonomous), exit 2 for queue (needs human) —
        # callers can branch on exit code without parsing JSON.
        return 0 if result["verdict"] in ("act", "report") else 2

    parser.print_help()
    return 1


def _emit(obj, pretty):
    if pretty:
        print(json.dumps(obj, indent=2))
    else:
        print(json.dumps(obj))


if __name__ == "__main__":
    # Windows consoles default to cp1252; force UTF-8 so any non-ASCII print()s survive.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, OSError, ValueError):
            pass
    sys.exit(main())
