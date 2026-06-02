#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
finance.py - SERVARI: the FINANCE surface.

Route:
    GET /api/finance  ->  read_finance()

Data source:
    demo-data/finance.json   (a synthetic seed; write real month-to-date finance +
    outstanding invoices here in your own deploy). When the file is absent this
    module returns an honest empty-state {"connected": false, "error": "..."} with
    NO fabricated figures.

Response shape (flat object, returned DIRECTLY - no wrapper key; matches the UI
FinanceResponse + InvoiceRow):
    {
      "mtd_revenue_eur": <number>,
      "mtd_expenses_eur": <number>,
      "mtd_net_eur": <number>,
      "outstanding_eur": <number>,
      "invoices": [ {"inv_id","client","amount_eur","due_str"} ],
      "as_of_iso": "ISO-8601",
      "connected": true,
      "error": "present only on failure / empty"
    }

CLI:
    python finance.py   ->  prints the finance JSON

STDLIB only. cp1252-safe. FAIL-CLOSED: a missing or malformed data file degrades
to an honest {"connected": false, "error": ...} empty-state; the function NEVER
throws. Pass-through only: every figure in the response traces back to the source
file (never synthesized).
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
FINANCE_SUMMARY = ROOT / "demo-data" / "finance.json"

# Repo-relative path string for honest error hints (never a hardcoded drive).
_SUMMARY_REL = "demo-data/finance.json"

# The EUR fields the UI reads. Only values that came from the source file are
# passed through; this module never synthesizes one.
_EUR_FIELDS = ("mtd_revenue_eur", "mtd_expenses_eur", "mtd_net_eur", "outstanding_eur")


def _empty_state(reason: str) -> dict:
    """The honest empty-state: NO fabricated figures, connected=false.

    Returned whenever the data file is absent or unreadable. The UI renders "-"
    for absent *_eur values and shows no invoice rows. This is the correct
    first-run behavior, not a bug.
    """
    return {"connected": False, "error": reason}


def _coerce_invoices(raw) -> list:
    """Validate/normalize the invoices list. Never raises. Drops non-dict rows.

    Each kept row carries the 4 fields the UI's InvoiceRow expects
    (inv_id / client / amount_eur / due_str). amount_eur is passed through as a
    number when it already is one; a non-numeric amount degrades to None (the UI
    renders "-") rather than being fabricated. due_str passes through verbatim.
    """
    if not isinstance(raw, list):
        return []
    out = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        amount = row.get("amount_eur")
        if not isinstance(amount, (int, float)) or isinstance(amount, bool):
            amount = None  # do not fabricate; honest "-" in the UI
        out.append({
            "inv_id": str(row.get("inv_id", "")),
            "client": str(row.get("client", "")),
            "amount_eur": amount,
            "due_str": str(row.get("due_str", "")),
        })
    return out


def read_finance() -> dict:
    """Read MTD finance + outstanding invoices. Returned DIRECTLY by the
    /api/finance route (no wrapper key).

    Behavior:
      - finance.json absent  -> honest empty-state (NO fabricated figures).
      - finance.json malformed / not an object -> honest empty-state.
      - finance.json present + valid -> pass its fields through verbatim.

    NEVER fabricates figures. NEVER raises - any failure degrades to the empty-state.
    """
    try:
        if not FINANCE_SUMMARY.is_file():
            return _empty_state(f"no finance summary yet - {_SUMMARY_REL} absent")
        try:
            text = FINANCE_SUMMARY.read_text(encoding="utf-8", errors="replace")
            data = json.loads(text)
        except (json.JSONDecodeError, ValueError, OSError) as e:
            return _empty_state(f"finance summary unreadable ({type(e).__name__}) - {_SUMMARY_REL}")

        if not isinstance(data, dict):
            return _empty_state(f"finance summary malformed (not an object) - {_SUMMARY_REL}")

        # Pass through the real fields verbatim. Only include a *_eur field if the
        # source actually provides a numeric value. We do not invent zeros for
        # absent fields (an absent figure is honest "-" in the UI).
        out = {"connected": True}
        for fld in _EUR_FIELDS:
            val = data.get(fld)
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                out[fld] = val

        out["invoices"] = _coerce_invoices(data.get("invoices"))

        as_of = data.get("as_of_iso")
        if isinstance(as_of, str) and as_of:
            out["as_of_iso"] = as_of

        # If the source carried an explicit error, surface it.
        src_err = data.get("error")
        if isinstance(src_err, str) and src_err:
            out["error"] = src_err

        return out
    except Exception as e:
        return _empty_state(f"finance read failed: {type(e).__name__}")


def main(argv=None) -> int:
    try:
        result = read_finance()
    except Exception as e:
        result = _empty_state(f"read_finance raised; backstop: {type(e).__name__}")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
