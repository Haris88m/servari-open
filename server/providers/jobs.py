#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jobs.py - SERVARI: the Jobs surface.

Route served:
    GET /api/jobs  ->  read_jobs()

Data source:
    demo-data/jobs.json  (a synthetic seed; in your own deploy, write real crawl
    results here). When the file is absent the CORRECT first-run behavior is the
    honest empty-state, NOT a fabricated row.

Contract (fail-closed, NEVER raises):
    A missing or malformed data file degrades to:
        {"jobs": [], "error": "no data file yet - demo-data/jobs.json absent"}
    The server's try/except is a backstop, not the primary guard - the guard is here.

Response shape (matches the UI JobsResponse + JobRow):
    {
      "jobs": [
        { "title": str, "company": str, "source": str, "location": str,
          "score": int, "posted": str (relative, e.g. "2d"), "tailored": bool }
      ],
      "last_scan": "ISO-8601 or omitted",
      "error": "present only on failure / empty"
    }
  - score is an int the UI color-codes -> coerced to int here.
  - posted is a RELATIVE STRING (e.g. "2d", "6h"), NOT an ISO date. If the source
    stores ISO, it is converted to a relative string; otherwise passed through.
  - tailored is an optional bool.

STDLIB only. cp1252-safe (utf-8 reads with errors='replace'; stdout/stderr
reconfigured to utf-8). Drive-independent home via SERVARI_HOME env + cwd; never
hardcodes a drive.
"""

import datetime
import json
import os
import sys
from pathlib import Path

# never die on a non-cp1252 byte when printing on Windows.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _home() -> Path:
    """Resolve the data home (SERVARI_HOME env, else repo root, else cwd).

    Drive-independent; never hardcodes a drive. providers/ lives under server/,
    so the repo root is two levels up.
    """
    env = os.environ.get("SERVARI_HOME")
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p.resolve()
    here = Path(__file__).resolve().parent          # .../server/providers
    repo = here.parent.parent                        # repo root
    if (repo / "demo-data").is_dir():
        return repo
    return Path.cwd()


ROOT = _home()
BOARD_RESULTS = ROOT / "demo-data" / "jobs.json"

# The honest empty-state error string (used on absent / malformed / empty file).
_ABSENT_ERR = "no data file yet - demo-data/jobs.json absent"


def _to_int(value, default: int = 0) -> int:
    """Coerce a score to an int. Non-numeric / None -> default. NEVER raises."""
    if isinstance(value, bool):  # bool is an int subclass; treat as no-score
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        try:
            return int(value)
        except (ValueError, OverflowError):
            return default
    if isinstance(value, str):
        s = value.strip()
        try:
            return int(s)
        except ValueError:
            try:
                return int(float(s))
            except (ValueError, OverflowError):
                return default
    return default


def _relative_posted(value) -> str:
    """Return the UI-ready relative 'posted' string.

    The UI renders `posted {j.posted} ago`, so it expects a relative string like
    "2d" / "6h". If the source already emitted a relative string, pass it through.
    If it emitted an ISO-8601 datetime, convert it to a compact relative string.
    NEVER raises - on any parse failure the original value is passed through.
    """
    if value is None:
        return ""
    s = str(value).strip()
    if not s:
        return ""

    # Heuristic: an ISO date/datetime contains a '-' in the first 10 chars
    # (YYYY-MM-DD). A relative string like "2d" / "6h" does not.
    looks_iso = len(s) >= 10 and s[4:5] == "-" and s[7:8] == "-"
    if not looks_iso:
        return s

    try:
        iso = s.replace("Z", "+00:00")
        dt = datetime.datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        now = datetime.datetime.now(datetime.timezone.utc)
        delta = now - dt
        secs = int(delta.total_seconds())
        if secs < 0:
            secs = 0
        if secs < 3600:
            return f"{max(secs // 60, 0)}m"
        if secs < 86400:
            return f"{secs // 3600}h"
        return f"{secs // 86400}d"
    except (ValueError, TypeError, OverflowError):
        return s


def _normalize_job(raw: dict) -> dict:
    """Coerce ONE raw job dict to the UI JobRow shape. NEVER raises.

    Missing fields degrade to safe defaults (empty string / 0 / False) rather
    than dropping the row.
    """
    title = raw.get("title")
    company = raw.get("company")
    source = raw.get("source")
    location = raw.get("location")
    out = {
        "title": str(title) if title is not None else "",
        "company": str(company) if company is not None else "",
        "source": str(source) if source is not None else "",
        "location": str(location) if location is not None else "",
        "score": _to_int(raw.get("score"), 0),
        "posted": _relative_posted(raw.get("posted")),
        "tailored": bool(raw.get("tailored", False)),
    }
    return out


def read_jobs() -> dict:
    """Return job-board results for the Jobs tab.

    Fail-closed: absent / unreadable / malformed source -> honest empty-state
    with a real file-path hint. NEVER fabricates rows. NEVER raises.
    """
    try:
        if not BOARD_RESULTS.is_file():
            return {"jobs": [], "error": _ABSENT_ERR}

        try:
            text = BOARD_RESULTS.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return {"jobs": [], "error": f"could not read jobs.json: {type(e).__name__}"}

        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return {"jobs": [], "error": "jobs.json is malformed JSON"}

        if not isinstance(data, dict):
            return {"jobs": [], "error": "jobs.json is not a JSON object"}

        raw_jobs = data.get("jobs")
        if not isinstance(raw_jobs, list):
            return {"jobs": [], "error": "jobs.json has no 'jobs' list"}

        jobs = [_normalize_job(j) for j in raw_jobs if isinstance(j, dict)]

        result = {"jobs": jobs}
        last_scan = data.get("last_scan")
        if last_scan:
            result["last_scan"] = str(last_scan)
        if not jobs:
            result["error"] = "jobs.json present but contains 0 jobs"
        return result
    except Exception as e:
        return {"jobs": [], "error": f"read_jobs failed: {type(e).__name__}"}


def main(argv=None) -> int:
    try:
        result = read_jobs()
    except Exception as e:
        result = {"jobs": [], "error": f"read_jobs raised; backstop engaged: {type(e).__name__}"}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
