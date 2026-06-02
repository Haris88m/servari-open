#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
career.py - SERVARI: the Career-profile surface.

Route:
    GET /api/career  ->  read_career()
    NOTE: this route returns the profile dict DIRECTLY (no wrapper key) -
    the server does json.dumps(career.read_career()) straight to the client.

Data source:
    demo-data/career.json   (a synthetic seed; write your own profile here).

The profile is read verbatim, and if it declares a `portfolio_path`, the
`portfolio_file_count` is derived LIVE by actually walking that directory
(Path.is_dir() + rglob count) — never stored as a literal. A relative
portfolio_path is resolved against the home root, so a demo portfolio folder can
be declared relatively.

If career.json is absent or malformed, return an HONEST error/empty state -
never fabricated values.

STDLIB only. cp1252-safe. FAIL-CLOSED: a missing/bad file degrades to
{"error": ...}; a bad portfolio_path degrades only that one field; the function
NEVER raises.
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
PROFILE = ROOT / "demo-data" / "career.json"


def _count_portfolio_files(portfolio_path: str):
    """Count real files under portfolio_path by walking the filesystem.

    Returns (count, resolved_path_str, note):
      - count: int file count if the path is a real dir; None if it isn't / failed.
      - resolved_path_str: the path we actually checked (for transparency).
      - note: None on success, else a short reason the count could not be derived.

    Honest by construction: the count is DERIVED from rglob, never a literal.
    A path that does not exist or is not a directory yields count=None.

    Path resolution: an absolute portfolio_path is used as-is; a relative one is
    resolved against the home ROOT.
    """
    try:
        p = Path(portfolio_path)
    except Exception as e:
        return None, str(portfolio_path), f"bad_path: {type(e).__name__}"

    try:
        if not p.is_absolute():
            p = (ROOT / p)
        p = p.resolve()
    except Exception as e:
        return None, str(portfolio_path), f"resolve_failed: {type(e).__name__}"

    try:
        if not p.is_dir():
            return None, str(p), "path_not_a_dir"
    except Exception as e:
        return None, str(p), f"is_dir_failed: {type(e).__name__}"

    try:
        count = 0
        for entry in p.rglob("*"):
            try:
                if entry.is_file():
                    count += 1
            except Exception:
                # An individual entry we can't stat (permission/race) -> skip it.
                continue
        return count, str(p), None
    except Exception as e:
        return None, str(p), f"walk_failed: {type(e).__name__}"


def read_career() -> dict:
    """Return the career profile as a FLAT dict (no wrapper key).

    Shape (matches the UI CareerProfile):
        {name, headline, location, languages,
         portfolio_path (optional), portfolio_file_count (optional, DERIVED),
         skills:[...], error (only on failure)}

    Behavior:
      - career.json absent/malformed -> {"error": "..."} (honest empty state).
      - career.json present -> return its dict verbatim, EXCEPT:
          * if it declares portfolio_path, derive portfolio_file_count LIVE from
            the filesystem. If the path can't be counted, the field is OMITTED
            (never guessed) and a transparency note is attached.
    The function NEVER raises.
    """
    try:
        if not PROFILE.is_file():
            return {"error": "no profile yet - demo-data/career.json absent"}

        raw = PROFILE.read_text(encoding="utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, ValueError) as e:
            return {"error": f"career.json malformed: {type(e).__name__}"}

        if not isinstance(data, dict):
            return {"error": "career.json is not a JSON object"}

        # Work on a copy so we never mutate via a shared reference.
        profile = dict(data)

        # Derive the portfolio count LIVE if a path is declared.
        portfolio_path = profile.get("portfolio_path")
        if isinstance(portfolio_path, str) and portfolio_path.strip():
            count, resolved, note = _count_portfolio_files(portfolio_path)
            if count is not None:
                profile["portfolio_file_count"] = count
            else:
                profile.pop("portfolio_file_count", None)
                profile["portfolio_count_note"] = f"count unavailable ({note})"
        else:
            # No portfolio path declared -> a stored count would be unverifiable.
            profile.pop("portfolio_file_count", None)

        return profile
    except Exception as e:
        return {"error": f"read_career failed: {type(e).__name__}"}


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        result = read_career()
    except Exception as e:
        result = {"error": f"main backstop: {type(e).__name__}"}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
