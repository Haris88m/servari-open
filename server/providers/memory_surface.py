#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
memory_surface.py - SERVARI: the personal-world MEMORY surface.

Route:
    GET /api/memory-surface  ->  read_memory_surface()
    The server passes the result straight to the client.

Data source:
    demo-data/memory-registry.json   (a hand-curated list; a synthetic seed ships)
    A list naming which files ARE appropriate to display. The curator writes one
    row per file: {"file": <display name>, "path": <relative-or-abs path>}. For
    each declared file the LIVE values are DERIVED from the filesystem:
      - updated = relative-time string from the file's real Path.stat().st_mtime
      - entries = count of markdown '##' heading lines (.md only; else null)

Every row is a real declared file with a LIVE-derived mtime + heading count. A
declared path that does not exist is surfaced honestly as
{entries: null, updated: "missing"} — never fabricated.

This module surfaces ONLY the files a curator explicitly declares in the registry.
It does NOT glob, walk, or scan any directory other than the exact paths the
registry names (plus reading the registry file itself under demo-data/memory/).
Relative paths are resolved against the home root.

STDLIB only. cp1252-safe. FAIL-CLOSED: a missing/bad registry degrades to
{"files": [], "connected": false, "error": ...}; a single bad declared path
degrades only that one row; the function NEVER raises.
"""

import json
import os
import sys
import time
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
# The registry of files appropriate to display, plus the exact paths it declares.
REGISTRY = ROOT / "demo-data" / "memory-registry.json"


def _relative_time(mtime: float) -> str:
    """Turn an epoch mtime into a compact relative-time string.

    Mirrors the UI's relative-string convention (e.g. "now", "22m", "2h", "3d",
    "2w", "5mo", "1y"). Derived LIVE from the real mtime - never stored. A future
    / clock-skewed mtime degrades to "now" rather than a negative span.
    """
    try:
        delta = time.time() - float(mtime)
    except (TypeError, ValueError):
        return "unknown"
    if delta < 0:
        return "now"
    minute = 60.0
    hour = 60.0 * minute
    day = 24.0 * hour
    week = 7.0 * day
    month = 30.0 * day
    year = 365.0 * day
    if delta < minute:
        return "now"
    if delta < hour:
        return f"{int(delta // minute)}m"
    if delta < day:
        return f"{int(delta // hour)}h"
    if delta < week:
        return f"{int(delta // day)}d"
    if delta < month:
        return f"{int(delta // week)}w"
    if delta < year:
        return f"{int(delta // month)}mo"
    return f"{int(delta // year)}y"


def _count_md_headings(path: Path) -> int:
    """Count markdown '##' heading lines in a .md file.

    Counts lines whose first non-whitespace content starts with '##' (H2 and
    deeper). A bare '#' (H1 title) is NOT counted. Reads with utf-8/errors='replace'
    so a stray byte never aborts the count.
    """
    count = 0
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.lstrip().startswith("##"):
                count += 1
    return count


def _derive_row(file_name, decl_path):
    """Derive one display row from a declared {file, path}.

    Returns a dict matching the UI MemoryFile:
        {file, path, entries: int|None, updated: str}
    Behavior (honest by construction - all values DERIVED from the filesystem):
      - path is resolved against ROOT if relative; absolute paths used as-is.
      - if the file does not exist  -> entries=None, updated="missing".
      - updated = relative-time from the REAL Path.stat().st_mtime.
      - entries = '##'-heading count for .md files; None for any other ext.
    A single bad row degrades only itself (its own error note), never the call.
    """
    declared = str(decl_path) if decl_path is not None else ""
    display_name = str(file_name) if file_name is not None else (declared or "?")

    row = {
        "file": display_name,
        "path": declared,
        "entries": None,
        "updated": "missing",
    }

    if not declared.strip():
        row["updated"] = "missing"
        row["note"] = "no path declared"
        return row

    try:
        p = Path(declared)
        if not p.is_absolute():
            p = ROOT / p
        p = p.resolve()
    except Exception as e:
        row["note"] = f"bad_path: {type(e).__name__}"
        return row

    try:
        if not p.is_file():
            row["updated"] = "missing"
            row["note"] = "declared path is not a file"
            return row
    except Exception as e:
        row["note"] = f"is_file_failed: {type(e).__name__}"
        return row

    # LIVE mtime -> relative string.
    try:
        st = p.stat()
        row["updated"] = _relative_time(st.st_mtime)
    except Exception as e:
        row["updated"] = "unknown"
        row["note"] = f"stat_failed: {type(e).__name__}"

    # '##'-heading count for markdown; None for non-.md.
    try:
        if p.suffix.lower() == ".md":
            row["entries"] = _count_md_headings(p)
        else:
            row["entries"] = None
    except Exception as e:
        row["entries"] = None
        row.setdefault("note", f"count_failed: {type(e).__name__}")

    return row


def read_memory_surface() -> dict:
    """Surface the files declared in the registry.

    Shape (matches the UI MemorySurfaceResponse + MemoryFile):
        {
          "files": [ {file, path, entries:int|None, updated:str}, ... ],
          "connected": bool,
          "error": "present only on failure / empty"
        }

    Behavior:
      - memory-registry.json absent  -> {"files": [], "connected": false,
        "error": "no registry yet - demo-data/memory-registry.json absent"}.
      - malformed registry           -> {"files": [], "connected": false, "error": ...}.
      - present + valid              -> derive one LIVE row per declared file.
    NEVER raises; NEVER fabricates a row.
    """
    try:
        if not REGISTRY.is_file():
            return {
                "files": [],
                "connected": False,
                "error": "no registry yet - demo-data/memory-registry.json absent",
            }

        raw = REGISTRY.read_text(encoding="utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, ValueError) as e:
            return {
                "files": [],
                "connected": False,
                "error": f"memory-registry.json malformed: {type(e).__name__}",
            }

        if not isinstance(data, dict):
            return {
                "files": [],
                "connected": False,
                "error": "memory-registry.json is not a JSON object",
            }

        declared = data.get("files")
        if not isinstance(declared, list):
            return {
                "files": [],
                "connected": False,
                "error": "memory-registry.json has no 'files' list",
            }

        rows = []
        for item in declared:
            try:
                if not isinstance(item, dict):
                    continue
                rows.append(_derive_row(item.get("file"), item.get("path")))
            except Exception:
                # A single bad row degrades only itself - never the whole call.
                continue

        result = {"files": rows, "connected": True}
        if not rows:
            result["error"] = "registry declares no files"
        return result
    except Exception as e:
        return {
            "files": [],
            "connected": False,
            "error": f"read_memory_surface failed: {type(e).__name__}",
        }


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        result = read_memory_surface()
    except Exception as e:
        result = {"files": [], "connected": False, "error": f"main backstop: {type(e).__name__}"}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
