#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inbox.py - SERVARI: the awaiting-reply email-thread surface.

Route:
    GET /api/inbox  ->  read_inbox()

Data source (cache-first, PURE-STDLIB reader):
    demo-data/inbox.json
        a synthetic seed (in your own deploy, an email-triage agent writes the
        triage cache here). This module only READS that cache, so the synchronous
        HTTP request path stays fast and NO external service is called inside the
        web-server request path. Wiring a live mailbox is a follow-up that
        populates the same cache file.

When the cache is absent or malformed at runtime, the module returns an HONEST
empty state with "connected": false and a file-path hint - it NEVER fabricates
threads.

Response shape (matches the UI InboxResponse + InboxThread):
    {
      "threads": [
        { "from": "string", "subject": "string (optional)",
          "age_str": "2d", "priority": "high|medium|low",
          "thread_id": "optional" }
      ],
      "last_triage": "ISO-8601 or omitted",
      "connected": true|false,
      "error": "present only on failure / empty"
    }

The UI dot-colors `priority` (high=red / medium=amber / low=dimmed). `age_str` is
a relative string the UI renders verbatim (e.g. "2d", "22m"); if the cache stored
an ISO timestamp or epoch-ms instead, read_inbox() converts it here. The priority
HEURISTIC is owned by whatever WRITES the cache; this reader only validates the
enum and falls back to "low" on an unknown value.

CLI:
    python inbox.py   ->  prints the JSON

STDLIB only. cp1252-safe. FAIL-CLOSED: a missing or malformed cache file degrades
to {"threads": [], "connected": false, "error": ...}; the function NEVER raises.
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
    """Resolve the data home (SERVARI_HOME env, else repo root, else cwd). Never
    hardcodes a drive."""
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
CACHE = ROOT / "demo-data" / "inbox.json"

# Repo-relative hint used in honest empty-state messages (drive-independent).
_CACHE_HINT = "demo-data/inbox.json"

# The InboxThread fields the UI consumes. Only these are emitted.
_VALID_PRIORITY = ("high", "medium", "low")
_DEFAULT_PRIORITY = "low"


def _empty(reason: str) -> dict:
    """Honest empty-state: no threads, connected=false, a real file-path hint."""
    return {"threads": [], "connected": False, "error": reason}


def _coerce_priority(raw) -> str:
    """Validate the priority enum; unknown/missing -> 'low'.

    Whatever writes the cache owns the heuristic; this reader only guards that the
    value the UI dot-colors is one of the three valid strings. A stray case
    ('High') is normalized; anything else degrades to 'low'.
    """
    if isinstance(raw, str):
        low = raw.strip().lower()
        if low in _VALID_PRIORITY:
            return low
    return _DEFAULT_PRIORITY


def _relative_age(value) -> str:
    """Convert a thread's age signal into the relative string the UI renders.

    The cache SHOULD already store a relative `age_str` (e.g. "2d", "22m"); in
    that case it is passed through verbatim. But if an ISO-8601 timestamp (or an
    epoch-ms value) was stored, convert it to a coarse relative string here so the
    UI never shows a raw timestamp.

    Fail-soft: an unparseable value is returned stringified (never raises);
    a missing value yields "".
    """
    if value is None:
        return ""
    # Already a relative string (the expected case): pass through verbatim.
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return ""
        # Heuristic: an ISO timestamp contains '-' and 'T' or ':'. Only attempt
        # an ISO parse when it LOOKS like a timestamp.
        looks_iso = ("T" in s and "-" in s) or (s.count(":") >= 1 and "-" in s)
        if not looks_iso:
            return s
        try:
            iso = s.replace("Z", "+00:00")
            dt = datetime.datetime.fromisoformat(iso)
            return _delta_to_str(dt)
        except (ValueError, TypeError):
            return s
    # Numeric: treat as epoch. An epoch-MILLIS value is also tolerated
    # (disambiguate by magnitude).
    if isinstance(value, (int, float)):
        try:
            epoch = float(value)
            # > ~ year 2001 in millis (1e12) => millis; else seconds.
            if epoch > 1e12:
                epoch = epoch / 1000.0
            dt = datetime.datetime.fromtimestamp(epoch, tz=datetime.timezone.utc)
            return _delta_to_str(dt)
        except (ValueError, OSError, OverflowError):
            return str(value)
    return str(value)


def _delta_to_str(dt: datetime.datetime) -> str:
    """Coarse relative-time string from an aware/naive datetime to now (UTC).
    e.g. '22m', '6h', '2d', '3w'. Future or zero -> '0m'. Never raises."""
    try:
        now = datetime.datetime.now(datetime.timezone.utc)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        secs = (now - dt).total_seconds()
        if secs < 0:
            return "0m"
        mins = int(secs // 60)
        if mins < 60:
            return f"{mins}m"
        hours = mins // 60
        if hours < 24:
            return f"{hours}h"
        days = hours // 24
        if days < 7:
            return f"{days}d"
        weeks = days // 7
        return f"{weeks}w"
    except Exception:
        return ""


def _coerce_thread(raw: dict) -> dict:
    """Project ONE source dict down to the exact InboxThread shape the UI expects.

    - `from` (required for display) defaults to "" if missing.
    - `subject` and `thread_id` are optional; included only when present+truthy.
    - `priority` is validated to the enum (unknown -> 'low').
    - `age_str` is the relative string (ISO/epoch converted if needed).
    All values stringified defensively.
    """
    row = {}

    frm = raw.get("from", "")
    row["from"] = frm if isinstance(frm, str) else ("" if frm is None else str(frm))

    subj = raw.get("subject")
    if subj:
        row["subject"] = subj if isinstance(subj, str) else str(subj)

    # age_str is canonical; fall back to other timestamp keys before giving up to "".
    age_source = raw.get("age_str")
    if age_source in (None, ""):
        for alt in ("age", "internalDate", "ts", "received", "date"):
            if alt in raw and raw[alt] not in (None, ""):
                age_source = raw[alt]
                break
    row["age_str"] = _relative_age(age_source)

    row["priority"] = _coerce_priority(raw.get("priority"))

    tid = raw.get("thread_id")
    if tid:
        row["thread_id"] = tid if isinstance(tid, str) else str(tid)

    return row


def read_inbox() -> dict:
    """Return the awaiting-reply email threads, fail-closed.

    Reads demo-data/inbox.json (cache-first; no external service is called here).
    Expected file shape:
        { "threads": [ {from, subject, age_str, priority, thread_id}, ... ],
          "last_triage": "ISO-8601" }
    (a bare top-level list of threads is also tolerated.)

    Returns:
        On success with threads: {"threads": [...], "connected": true,
                                  "last_triage": "..."(if present)}
        On empty/absent/bad:     {"threads": [], "connected": false,
                                  "error": "<honest reason + file hint>"}

    NEVER raises; NEVER fabricates threads; NEVER calls a live external service.
    """
    try:
        if not CACHE.is_file():
            return _empty(f"inbox not yet triaged - {_CACHE_HINT} absent")

        text = CACHE.read_text(encoding="utf-8", errors="replace")
        if not text.strip():
            return _empty(f"triage cache is empty - {_CACHE_HINT} has no content")

        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError) as e:
            return _empty(f"triage cache malformed (not valid JSON): {type(e).__name__}")

        # Accept either {"threads": [...], "last_triage": ...} or a bare [...] list.
        last_triage = None
        if isinstance(data, dict):
            threads = data.get("threads", [])
            lt = data.get("last_triage")
            if isinstance(lt, str) and lt.strip():
                last_triage = lt.strip()
        elif isinstance(data, list):
            threads = data
        else:
            return _empty(
                "triage cache has unexpected shape "
                "(expected an object with 'threads' or a list)"
            )

        if not isinstance(threads, list):
            return _empty("triage cache 'threads' is not a list - cannot read rows")

        rows = [_coerce_thread(t) for t in threads if isinstance(t, dict)]

        if not rows:
            return _empty(f"triage cache present but contains no threads - {_CACHE_HINT}")

        out = {"threads": rows, "connected": True}
        if last_triage:
            out["last_triage"] = last_triage
        return out

    except Exception as e:
        return _empty(f"read failed: {type(e).__name__}")


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        result = read_inbox()
    except Exception as e:
        result = {"threads": [], "connected": False, "error": f"backstop: {type(e).__name__}"}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
