#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
applications.py - SERVARI: the job-application tracker surface.

Route:
    GET /api/applications  ->  read_applications()

Data source:
    demo-data/applications.json   (a synthetic seed; write real rows here in your
    own deploy). When the file is absent or malformed, the module returns an
    HONEST empty state with "connected": false and a file-path hint - it NEVER
    fabricates applications.

Response shape (matches the UI ApplicationsResponse + AppRow):
    {
      "applications": [
        { "company": "string", "role": "string", "status": "string",
          "date": "YYYY-MM-DD", "url": "optional" }
      ],
      "connected": true|false,
      "error": "present only on failure / empty"
    }

CLI:
    python applications.py   ->  prints the JSON

STDLIB only. cp1252-safe. FAIL-CLOSED: a missing or malformed data file degrades
to {"applications": [], "connected": false, "error": ...}; the function NEVER raises.
"""

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
TRACKER = ROOT / "demo-data" / "applications.json"

# Repo-relative hint used in honest empty-state messages (drive-independent).
_TRACKER_HINT = "demo-data/applications.json"

# The AppRow fields the UI consumes. Keep order stable; only these are emitted
# (plus an optional "url"). Unknown source keys are dropped (no leakage).
_REQUIRED_FIELDS = ("company", "role", "status", "date")
_OPTIONAL_FIELDS = ("url",)


def _empty(reason: str) -> dict:
    """Honest empty-state: no rows, connected=false, a real file-path hint."""
    return {"applications": [], "connected": False, "error": reason}


def _coerce_row(raw: dict) -> dict:
    """Project ONE source dict down to the exact AppRow shape the UI expects.

    - Required string fields default to "" if missing (so the UI renders a row
      rather than crashing on undefined).
    - Optional `url` is included only when present and truthy.
    - All values are stringified defensively.
    """
    row = {}
    for f in _REQUIRED_FIELDS:
        val = raw.get(f, "")
        row[f] = val if isinstance(val, str) else ("" if val is None else str(val))
    for f in _OPTIONAL_FIELDS:
        if f in raw and raw[f]:
            v = raw[f]
            row[f] = v if isinstance(v, str) else str(v)
    return row


def read_applications() -> dict:
    """Return the job-application tracker, fail-closed.

    Reads demo-data/applications.json. Expected file shape:
        { "applications": [ {company, role, status, date, url?}, ... ] }
    (a bare top-level list of rows is also tolerated).

    Returns:
        On success with rows:   {"applications": [...], "connected": true}
        On empty/absent/bad:    {"applications": [], "connected": false,
                                 "error": "<honest reason + file hint>"}

    NEVER raises; NEVER fabricates rows.
    """
    try:
        if not TRACKER.is_file():
            return _empty(f"no tracker file yet - {_TRACKER_HINT} absent")

        text = TRACKER.read_text(encoding="utf-8", errors="replace")
        if not text.strip():
            return _empty(f"tracker file is empty - {_TRACKER_HINT} has no content")

        try:
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError) as e:
            return _empty(f"tracker file malformed (not valid JSON): {type(e).__name__}")

        # Accept either {"applications": [...]} or a bare [...] list.
        if isinstance(data, dict):
            apps = data.get("applications", [])
        elif isinstance(data, list):
            apps = data
        else:
            return _empty(
                "tracker file has unexpected shape "
                "(expected an object with 'applications' or a list)"
            )

        if not isinstance(apps, list):
            return _empty("tracker 'applications' is not a list - cannot read rows")

        rows = [_coerce_row(r) for r in apps if isinstance(r, dict)]

        if not rows:
            return _empty(f"tracker file present but contains no application rows - {_TRACKER_HINT}")

        return {"applications": rows, "connected": True}

    except Exception as e:
        return _empty(f"read failed: {type(e).__name__}")


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        result = read_applications()
    except Exception as e:
        result = {"applications": [], "connected": False, "error": f"backstop: {type(e).__name__}"}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
