#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tokens.py — the proof-of-work token usage tracker.

The PROOF-OF-WORK layer: reads usage records from a JSONL source, prices them at
configurable per-million rates, and generates per-session / per-day / all-time
proof-of-work reports. The counts are ground truth (logged per message); the cost
is the API-equivalent at the configured rates.

Data source: demo-data/token-history.jsonl (a synthetic seed). Each line is one
usage record:
    {"session": "<id>", "model": "<name>", "timestamp": "<ISO>",
     "usage": {"input_tokens": N, "output_tokens": N,
               "cache_creation_input_tokens": N, "cache_read_input_tokens": N}}
(the `usage` block may also be nested under a "message" key, matching common
transcript formats.) This reader NEVER touches a real session transcript or any
path outside demo-data/.

Functions: live() / sessions(limit) / summary() / report(scope, session_id).
CLI: --live / --sessions [--limit N] / --summary / --report session|today|all [--session-id ID] / --self-test
Stdlib only. cp1252-safe. READ-ONLY against the source; writes only reports.
"""
from __future__ import annotations
import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _home() -> Path:
    """Resolve the data home (SERVARI_HOME env, else repo root, else cwd)."""
    env = os.environ.get("SERVARI_HOME")
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p.resolve()
    here = Path(__file__).resolve().parent      # .../server
    repo = here.parent                          # repo root
    if (repo / "demo-data").is_dir():
        return repo
    return Path.cwd()


ROOT = _home()
DEMO = ROOT / "demo-data"
TOKEN_SOURCE = DEMO / "token-history.jsonl"     # the synthetic usage seed
REPORTS_DIR = DEMO / "reports"                   # generated proof-of-work reports land here

# --- price table (USD per 1M tokens) ----------------------------------------------------------
# These are example rates; set them to your provider's actual pricing.
# cache_write = 1.25x input; cache_read = 0.1x input.
PRICING = {
    "opus":   {"in": 5.00, "out": 25.00, "cache_write": 6.25, "cache_read": 0.50},
    "sonnet": {"in": 3.00, "out": 15.00, "cache_write": 3.75, "cache_read": 0.30},
    "haiku":  {"in": 1.00, "out": 5.00,  "cache_write": 1.25, "cache_read": 0.10},
}
DEFAULT_RATE = PRICING["opus"]  # unknown model -> price at the most conservative rate


def _rate_for(model):
    m = (model or "").lower()
    for key, rate in PRICING.items():
        if key in m:
            return rate
    return DEFAULT_RATE


def _parse_usage_line(line):
    """Extract (model, usage-dict, timestamp, session) from one JSONL line, or None."""
    try:
        rec = json.loads(line)
    except Exception:
        return None
    msg = rec.get("message") or {}
    usage = msg.get("usage") or rec.get("usage")
    if not isinstance(usage, dict) or not usage:
        return None
    model = msg.get("model") or rec.get("model") or ""
    ts = rec.get("timestamp") or rec.get("ts") or ""
    session = rec.get("session") or rec.get("session_id") or "default"
    return (model, {
        "in": int(usage.get("input_tokens") or 0),
        "out": int(usage.get("output_tokens") or 0),
        "cache_write": int(usage.get("cache_creation_input_tokens") or 0),
        "cache_read": int(usage.get("cache_read_input_tokens") or 0),
    }, ts, str(session))


def _cost(tot, rate):
    return (tot.get("in", 0) * rate["in"] + tot.get("out", 0) * rate["out"]
            + tot.get("cache_write", 0) * rate["cache_write"]
            + tot.get("cache_read", 0) * rate["cache_read"]) / 1_000_000.0


def _zero():
    return {"in": 0, "out": 0, "cache_write": 0, "cache_read": 0}


def _add(a, b):
    for k in a:
        a[k] += b.get(k, 0)


def _all_records():
    """Read every usage record from the source. Returns a list of
    (model, usage, ts, session). Missing/unreadable source -> []. Never raises."""
    out = []
    try:
        if not TOKEN_SOURCE.is_file():
            return out
        with open(TOKEN_SOURCE, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                parsed = _parse_usage_line(line)
                if parsed is not None:
                    out.append(parsed)
    except OSError:
        return out
    return out


def _group_by_session(records):
    """Group records by session id. Returns {session: {totals, msgs, cost, first_ts, last_ts, model}}."""
    groups = {}
    for model, usage, ts, session in records:
        g = groups.setdefault(session, {"totals": _zero(), "msgs": 0, "cost": 0.0,
                                        "first_ts": "", "last_ts": "", "model": ""})
        _add(g["totals"], usage)
        g["msgs"] += 1
        g["cost"] += _cost(usage, _rate_for(model))
        if model:
            g["model"] = model
        if ts:
            if not g["first_ts"]:
                g["first_ts"] = ts
            g["last_ts"] = ts
    return groups


def _newest_session(groups):
    """The session id whose last_ts is the latest (the 'live' one), or None."""
    if not groups:
        return None
    return max(groups, key=lambda s: groups[s].get("last_ts") or "")


def live():
    """Usage of the CURRENT (newest) session. Returns totals + API-equivalent cost
    + rate-per-hour. Reads the synthetic seed (no live transcript is touched)."""
    groups = _group_by_session(_all_records())
    if not groups:
        return {"ok": False, "error": "no_token_source", "hint": str(TOKEN_SOURCE)}
    sid = _newest_session(groups)
    g = groups[sid]

    dur_min = None
    try:
        if g["first_ts"] and g["last_ts"]:
            t0 = datetime.fromisoformat(g["first_ts"].replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(g["last_ts"].replace("Z", "+00:00"))
            dur_min = round((t1 - t0).total_seconds() / 60.0, 1)
    except Exception:
        pass

    t = g["totals"]
    total_tokens = t["in"] + t["out"] + t["cache_write"] + t["cache_read"]
    return {"ok": True, "session": sid, "model": g["model"],
            "msgs": g["msgs"], "tokens": dict(t), "total_tokens": total_tokens,
            "cost_usd": round(g["cost"], 4), "duration_min": dur_min,
            "cost_per_hour": (round(g["cost"] / (dur_min / 60.0), 2)
                              if dur_min and dur_min > 1 else None),
            "note": "counts are ground-truth; cost is the API-EQUIVALENT at the configured rates."}


def sessions(limit=20):
    """Per-session breakdown, newest first (by last_ts)."""
    groups = _group_by_session(_all_records())
    rows = []
    for sid, g in groups.items():
        total_tokens = sum(g["totals"].values())
        if g["msgs"] == 0 and total_tokens == 0:
            continue
        rows.append({"session": sid,
                     "last_ts": g.get("last_ts") or "",
                     "last_activity": g.get("last_ts") or "",
                     "msgs": g["msgs"],
                     "tokens": g["totals"], "total_tokens": total_tokens,
                     "cost_usd": round(g["cost"], 4)})
    rows.sort(key=lambda r: r["last_ts"], reverse=True)
    return rows[:max(1, int(limit))]


def summary():
    """All-time + today totals across every record."""
    records = _all_records()
    all_tot, all_cost, all_msgs = _zero(), 0.0, 0
    today_tot, today_cost = _zero(), 0.0
    today = datetime.now(timezone.utc).date()
    groups = _group_by_session(records)
    for model, usage, ts, session in records:
        _add(all_tot, usage)
        all_cost += _cost(usage, _rate_for(model))
        all_msgs += 1
        # today bucket by record timestamp
        try:
            if ts:
                d = datetime.fromisoformat(ts.replace("Z", "+00:00")).date()
                if d == today:
                    _add(today_tot, usage)
                    today_cost += _cost(usage, _rate_for(model))
        except Exception:
            pass
    return {"ok": True,
            "all_time": {"tokens": all_tot, "total_tokens": sum(all_tot.values()),
                         "cost_usd": round(all_cost, 2), "msgs": all_msgs,
                         "sessions": len(groups)},
            "today": {"tokens": today_tot, "total_tokens": sum(today_tot.values()),
                      "cost_usd": round(today_cost, 2)},
            "pricing": PRICING,
            "note": "API-equivalent at the configured rates. Proof-of-work: counts are ground-truth.",
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def _markdown_report(scope, session_id, now, stamp):
    """Write a markdown proof-of-work report. Returns {ok, path, scope, markdown}."""
    lines = ["# SERVARI — Proof of Work Report",
             f"**Generated:** {now.isoformat(timespec='seconds')}  ",
             f"**Scope:** {scope}" + (f" ({session_id})" if session_id else ""), ""]

    if scope == "session":
        if session_id:
            rows = [r for r in sessions(limit=500) if r["session"] == session_id]
            data = rows[0] if rows else None
        else:
            lv = live()
            data = lv if lv.get("ok") else None
        if not data:
            return {"ok": False, "error": "session_not_found", "session_id": session_id}
        t = data["tokens"]
        lines += [f"## Session `{data.get('session', '?')}`", "",
                  "| Metric | Value |", "|---|---|",
                  f"| Messages | {data.get('msgs', '?')} |",
                  f"| Input tokens | {t['in']:,} |",
                  f"| Output tokens | {t['out']:,} |",
                  f"| Cache write | {t['cache_write']:,} |",
                  f"| Cache read | {t['cache_read']:,} |",
                  f"| **Total tokens** | **{data.get('total_tokens', 0):,}** |",
                  f"| **API-equivalent cost** | **${data.get('cost_usd', 0):,.2f}** |"]
        if data.get("duration_min"):
            lines.append(f"| Duration | {data['duration_min']} min |")
        if data.get("cost_per_hour"):
            lines.append(f"| Cost per hour | ${data['cost_per_hour']}/h |")
        fname = f"{stamp}_session_{(data.get('session') or 'live')[:12]}.md"
    elif scope == "today":
        s = summary()
        t = s["today"]["tokens"]
        rows = [r for r in sessions(limit=500)
                if (r["last_activity"][:10] == now.date().isoformat())]
        lines += ["## Today", "",
                  "| Metric | Value |", "|---|---|",
                  f"| Sessions active | {len(rows)} |",
                  f"| Total tokens | {s['today']['total_tokens']:,} |",
                  f"| Input / Output | {t['in']:,} / {t['out']:,} |",
                  f"| Cache write / read | {t['cache_write']:,} / {t['cache_read']:,} |",
                  f"| **API-equivalent cost** | **${s['today']['cost_usd']:,.2f}** |", "",
                  "## Sessions today", "", "| Session | Msgs | Tokens | Cost |", "|---|---|---|---|"]
        for r in rows:
            lines.append(f"| `{r['session'][:12]}` | {r['msgs']} | {r['total_tokens']:,} | ${r['cost_usd']:,.2f} |")
        fname = f"{stamp}_today.md"
    else:  # all
        s = summary()
        t = s["all_time"]["tokens"]
        lines += ["## All time", "",
                  "| Metric | Value |", "|---|---|",
                  f"| Sessions | {s['all_time']['sessions']} |",
                  f"| Messages | {s['all_time']['msgs']:,} |",
                  f"| Total tokens | {s['all_time']['total_tokens']:,} |",
                  f"| Input / Output | {t['in']:,} / {t['out']:,} |",
                  f"| Cache write / read | {t['cache_write']:,} / {t['cache_read']:,} |",
                  f"| **API-equivalent cost** | **${s['all_time']['cost_usd']:,.2f}** |"]
        fname = f"{stamp}_all_time.md"

    lines += ["", "---",
              "*Counts are ground-truth (logged per message). Cost is the API-equivalent at the "
              "configured rates (set them to your provider's pricing).*", ""]
    md = "\n".join(lines)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = REPORTS_DIR / fname
    out_path.write_text(md, encoding="utf-8", newline="\n")
    return {"ok": True, "path": str(out_path), "scope": scope, "format": "md", "markdown": md}


def report(scope="session", session_id=None, format="md", destination="reports"):
    """Generate a SERVARI proof-of-work report.

    scope:  'session' (live/current or a named one) | 'today' | 'all'.
    format: 'md' (markdown, the bundled format).
    The report lands under demo-data/reports/.

    Returns {ok, path, format, scope, [markdown]}.
    """
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%d_%H%M")
    fmt = (format or "md").lower()

    if fmt != "md":
        return {"ok": False, "error": f"unsupported_format: {format}",
                "supported": ["md"]}

    return _markdown_report(scope, session_id, now, stamp)


def self_test():
    """Deterministic self-test against the demo source (read-only)."""
    checks = []

    def chk(name, ok, detail=""):
        checks.append({"check": name, "ok": bool(ok), "detail": str(detail)[:200]})

    lv = live()
    # live() ok depends on the seed being present; the contract checks below
    # still hold whether or not the seed exists.
    chk("live_returns_dict", isinstance(lv, dict), lv.get("error", ""))
    if lv.get("ok"):
        chk("live_has_tokens", isinstance(lv.get("tokens"), dict), lv.get("total_tokens"))
        chk("live_cost_is_number", isinstance(lv.get("cost_usd"), (int, float)), lv.get("cost_usd"))
    rows = sessions(limit=5)
    chk("sessions_returns_list", isinstance(rows, list), f"count={len(rows)}")
    if rows:
        chk("sessions_have_cost", all("cost_usd" in r for r in rows))
    s = summary()
    chk("summary_ok", s.get("ok"))
    chk("summary_has_pricing", isinstance(s.get("pricing"), dict))
    # markdown report path (deterministic). Skips cleanly when there is no data.
    rep = report(scope="all", format="md")
    chk("report_generates", rep.get("ok"), rep.get("path", rep.get("error", "")))
    if rep.get("ok"):
        chk("report_file_exists", os.path.isfile(rep["path"]), rep["path"])
    ok = all(c["ok"] for c in checks)
    return {"ok": ok, "summary": f"{sum(1 for c in checks if c['ok'])}/{len(checks)} checks passed",
            "checks": checks}


def main(argv=None):
    ap = argparse.ArgumentParser(add_help=False)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--live", action="store_true")
    g.add_argument("--sessions", action="store_true")
    g.add_argument("--summary", action="store_true")
    g.add_argument("--report", choices=["session", "today", "all"])
    g.add_argument("--self-test", action="store_true")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--session-id", default=None)
    ap.add_argument("--format", choices=["md"], default="md")
    args, _ = ap.parse_known_args(argv)

    if args.live:
        out = live()
    elif args.sessions:
        out = {"ok": True, "sessions": sessions(args.limit)}
    elif args.summary:
        out = summary()
    elif args.report:
        out = report(scope=args.report, session_id=args.session_id, format=args.format)
    elif args.self_test:
        out = self_test()
    else:
        out = live()
    print(json.dumps(out, indent=1))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
