#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""reports.py - SERVARI: the generated-reports surface.

Lists report files written to disk under the demo data directory. The shell
server exposes this as:

    GET /api/reports  ->  reports.read_reports()

The server json.dumps() the returned dict straight to the client. The frontend
(PersonalView Reports tab, api.ts ReportsResponse + ReportRow) renders this
shape - no .tsx change is required.

Data source:
    demo-data/reports/   (resolved from the working directory, NOT hardcoded)
    Files are named  YYYY-MM-DD_HHMM_<slug>.<ext>  (e.g. 2026-06-01_0504_all_time.md).
    First content line of each = a markdown "# " heading, used as `desc`.

Response shape (MUST match api.ts ReportsResponse + ReportRow):
    {
      "reports": [
        { "date": "2026-06-01", "slug": "all_time",
          "path": "demo-data/reports/2026-06-01_0504_all_time.md",
          "desc": "SERVARI - Sample Report", "ext": "md" }
      ],
      "error": "present only on failure / empty"
    }
Newest-first by (date, full filename).

Reads the real files on disk - no fabricated rows. If the directory is absent
or empty, the honest result is {"reports": [], "error": "<reason>"} with
"connected": false - never a faked row.

STDLIB only. Encoding-safe (utf-8 reads with errors='replace'; stdout/stderr
reconfigured to utf-8). FAIL-CLOSED: a bad/unreadable file degrades THAT one row
(skipped or tolerantly parsed); the function NEVER raises.
"""

import glob
import json
import os
import re
import sys
from pathlib import Path

# encoding guard: never die on a non-utf-8 byte when printing on Windows.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _find_root() -> Path:
    """Resolve the project root in a drive-independent, portable way.

    Honors the SERVARI_HOME environment variable when set; otherwise uses the
    current working directory. Fail-soft to the module's parent. NEVER raises.
    """
    env = os.environ.get("SERVARI_HOME")
    if env:
        try:
            p = Path(env).resolve()
            if p.is_dir():
                return p
        except Exception:
            pass
    try:
        return Path.cwd().resolve()
    except Exception:
        try:
            return Path(__file__).resolve().parents[2]
        except Exception:
            return Path(__file__).resolve().parent


ROOT = _find_root()
REPORTS_DIR = ROOT / "demo-data" / "reports"

# Recognised report extensions, in glob order.
_EXTENSIONS = ("md", "pdf", "docx")

# Filename convention: YYYY-MM-DD_HHMM_<slug>.<ext>
# e.g. 2026-06-01_0504_all_time.md  ->  date=2026-06-01, slug=all_time
_NAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})_(\d{3,4})_(.+)$")


def _first_heading(path: Path) -> str:
    """Return the first markdown '# ' heading line (without the leading '# '),
    or '' if none found / unreadable. NEVER raises.

    Only .md files carry headings; for binary types (.pdf/.docx) we never try to
    text-parse - we fall back to the filename stem at the call site.
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                stripped = line.strip()
                if stripped.startswith("# "):
                    return stripped[2:].strip()
                # Stop scanning at the first non-empty, non-heading content line:
                # the report convention puts the title as the very first line.
                if stripped:
                    break
    except Exception:
        return ""
    return ""


def _parse_report(path: Path) -> dict:
    """Parse one report file into a ReportRow dict. Tolerant: an off-convention
    name falls back to (date='', slug=<full stem>). NEVER raises.

    Returns {date, slug, path (repo-relative), desc, ext}.
    """
    name = path.name
    ext = path.suffix.lstrip(".").lower()
    stem = path.stem  # filename without the final extension

    m = _NAME_RE.match(stem)
    if m:
        date = m.group(1)            # YYYY-MM-DD
        slug = m.group(3)            # remainder after YYYY-MM-DD_HHMM_
    else:
        # Tolerant fallback: try just the leading date, else leave date empty.
        date = stem[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", stem) else ""
        slug = stem

    # desc = first '# ' heading (md only); else the slug as a readable fallback.
    desc = ""
    if ext == "md":
        desc = _first_heading(path)
    if not desc:
        desc = slug

    # path = repo-relative, forward-slashed for a stable cross-platform value.
    try:
        rel = path.resolve().relative_to(ROOT)
        rel_str = rel.as_posix()
    except Exception:
        rel_str = path.as_posix()

    return {
        "date": date,
        "slug": slug,
        "path": rel_str,
        "desc": desc,
        "ext": ext,
    }


def read_reports() -> dict:
    """List the report files from demo-data/reports/.

    Returns:
        On success (>=1 file):
            {"reports": [ReportRow, ...], "connected": True}   newest-first
        On empty dir / absent dir / unreadable dir (honest empty-state):
            {"reports": [], "error": "<reason>", "connected": False}

    Reads real files on disk. Never fabricates a row. Never raises - any per-file
    parse problem degrades that one file (tolerant fallback), and a
    directory-level failure degrades to the honest empty-state.
    """
    try:
        if not REPORTS_DIR.is_dir():
            return {
                "reports": [],
                "error": "no reports dir yet - demo-data/reports/ absent",
                "connected": False,
            }

        # glob *.md + *.pdf + *.docx (the source set).
        files = []
        for ext in _EXTENSIONS:
            try:
                files.extend(glob.glob(os.path.join(str(REPORTS_DIR), f"*.{ext}")))
            except Exception:
                # A glob failure for one extension must not sink the whole read.
                continue

        # De-dup (case-insensitive globs can repeat on some filesystems) + keep files only.
        seen = set()
        report_paths = []
        for fp in files:
            try:
                p = Path(fp)
                key = str(p.resolve()).lower()
                if key in seen:
                    continue
                if not p.is_file():
                    continue
                seen.add(key)
                report_paths.append(p)
            except Exception:
                continue

        if not report_paths:
            return {
                "reports": [],
                "error": "no reports yet - demo-data/reports/ is empty",
                "connected": False,
            }

        rows = []
        for p in report_paths:
            try:
                rows.append(_parse_report(p))
            except Exception:
                # Last-resort per-file guard: skip an unparseable file rather than
                # crash or fabricate. (Should be unreachable - _parse_report is
                # itself fail-closed.)
                continue

        # Sort newest-first by (date, full filename). Both are strings, so the
        # YYYY-MM-DD date sorts chronologically and the HHMM-prefixed filename
        # breaks ties within a day.
        rows.sort(key=lambda r: (r.get("date", ""), r.get("path", "")), reverse=True)

        return {"reports": rows, "connected": True}

    except Exception as e:
        # Absolute backstop: an unexpected directory-level error degrades to the
        # honest empty-state - never a traceback, never a faked row.
        return {
            "reports": [],
            "error": f"read failed: {type(e).__name__}",
            "connected": False,
        }


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        result = read_reports()
    except Exception as e:
        # Backstop: a valid empty payload, never a traceback.
        result = {
            "reports": [],
            "error": f"read_reports raised: {type(e).__name__}",
            "connected": False,
        }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    # Exit 0 always: status lives in the JSON body, not the exit code - a monitor
    # must never confuse "the read ran" with "there were reports".
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
