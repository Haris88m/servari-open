#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""retention.py — THE METRIC-GATED RETENTION LOOP.

The principle: improvement loops can run UNATTENDED only if quality cannot
silently erode. This extends a syntax-gating edit check from SYNTAX-gating to
QUALITY-gating. A change to the system is KEPT only if the metric suite does not
degrade (and ideally improves); otherwise it is AUTO-REVERTED to byte-exact
baseline. The metric-gated auto-retention loop is the safety rail that lets an
improvement loop run without supervision.

The flow:
  1. baseline(targets) -> snapshot the target files (copy bytes) + run the metric
     suite + record baseline scores.  Returns a run_id.
  2. ...the loop edits the target files (anything: a job, a scheduler, a human)...
  3. decide(run_id) -> re-run the SAME metric suite, compare vs baseline.
       KEEP  if no GATING metric degraded (ties allowed; improvement welcome).
       REVERT if any gating metric degraded -> restore the snapshot bytes EXACTLY.
     Fail-closed: if ANY metric fails to RUN at decide-time -> REVERT.

Metric registry: demo-data/retention/retention_metrics.json. Each entry
{id, label, cmd (argv list), cwd ('.'=home root), parse, higher_is_better,
gating, timeout_sec}. parse.mode is 'exit_code' OR 'regex'.

State: demo-data/retention/
  runs/<run_id>/snapshot/<flattened-path>   byte-exact copies of each target
  runs/<run_id>/meta.json                   {run_id, targets, path_map, baseline_scores, ts, metric_ids, decided}
  audit.jsonl                               append-only; one decision event per line

INVARIANTS:
  - REVERT restores byte-exact content (sha256 verified).
  - Every decision appends to the audit (never rewritten).
  - A run can be decided ONCE (double-decide rejected, fail-closed).
  - Fail-closed everywhere: any metric run-failure at decide-time -> REVERT;
    missing run / corrupt state -> safe error, never crash.

CLI:
  python retention.py --baseline --targets a,b,c [--metrics m1,m2]
  python retention.py --decide <run_id>
  python retention.py --pending
  python retention.py --history [--limit N]
  python retention.py --self-test

All output JSON. Exit 0 ok / 1 fail.

STDLIB only. cp1252-safe (stdout/stderr reconfigured to UTF-8).
"""
from __future__ import annotations

import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

STATE_DIRNAME = "retention"
REGISTRY_NAME = "retention_metrics.json"
AUDIT_NAME = "audit.jsonl"


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


def _demo_dir():
    return os.path.join(_home(), "demo-data")


def _state_dir():
    return os.path.join(_demo_dir(), STATE_DIRNAME)


def _runs_dir():
    return os.path.join(_state_dir(), "runs")


def _audit_path():
    return os.path.join(_state_dir(), AUDIT_NAME)


def _registry_path():
    return os.path.join(_state_dir(), REGISTRY_NAME)


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


# --- metric registry ------------------------------------------------------------
def _load_registry():
    """Load the metric registry. Missing/corrupt -> {} entries. NEVER raises.
    Returns {metric_id: entry_dict}."""
    path = _registry_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    metrics = data.get("metrics")
    if not isinstance(metrics, list):
        return {}
    out = {}
    for m in metrics:
        if not isinstance(m, dict):
            continue
        mid = m.get("id")
        if not mid or not isinstance(m.get("cmd"), list) or not m["cmd"]:
            continue
        out[str(mid)] = m
    return out


def _resolve_metric_ids(requested):
    """Return ordered list of (metric_id, entry) for the requested ids, or ALL if
    requested is falsy. Unknown ids are dropped (reported separately by caller)."""
    reg = _load_registry()
    if not requested:
        return [(mid, reg[mid]) for mid in reg], []
    chosen = []
    unknown = []
    for mid in requested:
        mid = str(mid).strip()
        if not mid:
            continue
        if mid in reg:
            chosen.append((mid, reg[mid]))
        else:
            unknown.append(mid)
    return chosen, unknown


# --- metric execution -----------------------------------------------------------
def _run_metric(entry):
    """Run ONE metric. Returns {id, ok, score, exit_code, error, raw_tail}.
    ok=False means the metric could not be SCORED (run failure / parse failure /
    timeout) -> caller treats as fail-closed (forces REVERT at decide-time).
    `score` is comparable: higher_is_better tells the comparator the direction.
    For exit_code mode score = exit_code (0 = success); the comparator uses
    higher_is_better=false so lower score = better, ties allowed.
    NEVER raises."""
    mid = entry.get("id", "?")
    root = _home()
    cwd = entry.get("cwd", ".")
    run_cwd = root if cwd in (".", "", None) else os.path.join(root, cwd)
    timeout_sec = entry.get("timeout_sec", 120)
    try:
        timeout_sec = int(timeout_sec)
    except (TypeError, ValueError):
        timeout_sec = 120

    try:
        proc = subprocess.run(
            entry["cmd"],
            cwd=run_cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_sec,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as e:
        return {"id": mid, "ok": False, "score": None, "exit_code": None,
                "error": f"command_not_found: {e}", "raw_tail": ""}
    except subprocess.TimeoutExpired:
        return {"id": mid, "ok": False, "score": None, "exit_code": None,
                "error": f"timeout_after_{timeout_sec}s", "raw_tail": ""}
    except OSError as e:
        return {"id": mid, "ok": False, "score": None, "exit_code": None,
                "error": f"os_error: {e}", "raw_tail": ""}

    out = proc.stdout or ""
    tail = out[-400:]
    parse = entry.get("parse", {})
    mode = parse.get("mode", "exit_code")

    if mode == "exit_code":
        # score = exit code (0 = success). higher_is_better should be false.
        return {"id": mid, "ok": True, "score": proc.returncode,
                "exit_code": proc.returncode, "error": None, "raw_tail": tail}

    if mode == "regex":
        pattern = parse.get("pattern", "")
        group = parse.get("group", 1)
        vtype = parse.get("type", "int")
        try:
            m = re.search(pattern, out)
        except re.error as e:
            return {"id": mid, "ok": False, "score": None,
                    "exit_code": proc.returncode,
                    "error": f"bad_regex: {e}", "raw_tail": tail}
        if not m:
            return {"id": mid, "ok": False, "score": None,
                    "exit_code": proc.returncode,
                    "error": "regex_no_match", "raw_tail": tail}
        try:
            raw = m.group(group)
        except IndexError:
            return {"id": mid, "ok": False, "score": None,
                    "exit_code": proc.returncode,
                    "error": "regex_group_missing", "raw_tail": tail}
        try:
            val = int(raw) if vtype == "int" else float(raw)
        except (TypeError, ValueError):
            return {"id": mid, "ok": False, "score": None,
                    "exit_code": proc.returncode,
                    "error": f"cast_failed_value={raw!r}", "raw_tail": tail}
        return {"id": mid, "ok": True, "score": val,
                "exit_code": proc.returncode, "error": None, "raw_tail": tail}

    return {"id": mid, "ok": False, "score": None, "exit_code": proc.returncode,
            "error": f"unknown_parse_mode: {mode}", "raw_tail": tail}


def _run_suite(metric_pairs):
    """Run a list of (mid, entry). Returns dict {mid: result-dict}."""
    results = {}
    for mid, entry in metric_pairs:
        results[mid] = _run_metric(entry)
    return results


def _scores_only(suite_results):
    """Project a suite-results map down to {mid: score} for storage/comparison."""
    return {mid: r.get("score") for mid, r in suite_results.items()}


# --- snapshot / restore (byte-exact) --------------------------------------------
def _sha256(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _safe_relpath(path, start):
    """os.path.relpath that NEVER raises. On Windows, relpath raises ValueError
    when `path` and `start` are on different mounts/drives. Fail-graceful: on any
    ValueError fall back to the absolute path so callers (snapshot naming, meta
    storage, restore reporting) never crash on an out-of-home / cross-drive target."""
    try:
        return os.path.relpath(path, start)
    except ValueError:
        # cross-drive / cross-mount: no relative path exists. Use the absolute
        # path; _flatten_rel still produces a single safe snapshot filename, and
        # decide() reconstructs an absolute path from an absolute path unchanged.
        return os.path.abspath(path)


def _flatten_rel(rel):
    """Make a relative path safe as a single snapshot filename.
    'demo-data/x/file.md' -> 'demo-data__x__file.md'.
    Also flattens a drive colon (cross-drive abs fallback) so the snapshot name
    is a single legal filename: 'C:/tmp/x.txt' -> 'C__tmp__x.txt'."""
    return rel.replace("\\", "/").replace(":", "_").replace("/", "__")


def _snapshot_targets(run_id, targets):
    """Copy byte-exact each target into runs/<run_id>/snapshot/. Returns
    (path_map, errors). path_map: {abs_target: snapshot_abs}. Only existing
    files are snapshotted; missing targets are reported in errors (fail-closed
    upstream decides whether to proceed)."""
    root = _home()
    snap_dir = os.path.join(_runs_dir(), run_id, "snapshot")
    path_map = {}
    errors = []
    try:
        os.makedirs(snap_dir, exist_ok=True)
    except OSError as e:
        return {}, [f"cannot_make_snapshot_dir: {e}"]
    for t in targets:
        abs_t = t if os.path.isabs(t) else os.path.join(root, t)
        abs_t = os.path.abspath(abs_t)
        if not os.path.isfile(abs_t):
            errors.append(f"target_not_a_file: {t}")
            continue
        rel = _safe_relpath(abs_t, root)
        snap_name = _flatten_rel(rel)
        snap_abs = os.path.join(snap_dir, snap_name)
        try:
            shutil.copy2(abs_t, snap_abs)
        except OSError as e:
            errors.append(f"copy_failed: {t}: {e}")
            continue
        path_map[abs_t] = snap_abs
    return path_map, errors


def _restore_snapshot(path_map):
    """Restore each target from its snapshot byte-exact. Returns
    (restored, errors). restored: list of abs paths restored + sha-verified."""
    restored = []
    errors = []
    for abs_t, snap_abs in path_map.items():
        if not os.path.isfile(snap_abs):
            errors.append(f"snapshot_missing: {snap_abs}")
            continue
        try:
            shutil.copy2(snap_abs, abs_t)
        except OSError as e:
            errors.append(f"restore_failed: {abs_t}: {e}")
            continue
        # byte-exact verification
        if _sha256(abs_t) != _sha256(snap_abs):
            errors.append(f"restore_hash_mismatch: {abs_t}")
            continue
        restored.append(abs_t)
    return restored, errors


# --- run meta I/O ---------------------------------------------------------------
def _meta_path(run_id):
    return os.path.join(_runs_dir(), run_id, "meta.json")


def _save_meta(run_id, meta):
    path = _meta_path(run_id)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        os.replace(tmp, path)
        return True
    except OSError:
        return False


def _load_meta(run_id):
    path = _meta_path(run_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _append_audit(event):
    path = _audit_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
        return True
    except OSError:
        return False


def _read_audit():
    path = _audit_path()
    out = []
    try:
        if not os.path.isfile(path):
            return out
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except (json.JSONDecodeError, ValueError):
                    pass
    except OSError:
        return out
    return out


def _make_run_id(ts, targets):
    # Uniqueness matters: the "decide-once" invariant relies on a unique run_id,
    # and ts is only second-resolution -> two baselines on the same targets in the
    # same second would collide. Mix in os.urandom so collisions are impossible
    # even for back-to-back same-target baselines.
    salt = hashlib.sha1(os.urandom(16)).hexdigest()[:8]
    raw = (ts + "|" + ",".join(sorted(targets)) + "|" + salt).encode("utf-8", "replace")
    return "run_" + hashlib.sha1(raw).hexdigest()[:12]


# --- comparison -----------------------------------------------------------------
def _degraded(baseline_score, after_score, higher_is_better):
    """True if after_score is WORSE than baseline_score (a real degradation).
    Ties (equal) are NOT degradation. None scores are handled by caller
    (fail-closed). higher_is_better picks the direction."""
    if baseline_score is None or after_score is None:
        return True  # fail-closed: cannot compare -> treat as degraded
    try:
        b = float(baseline_score)
        a = float(after_score)
    except (TypeError, ValueError):
        return True
    if higher_is_better:
        return a < b
    return a > b


# --- public API -----------------------------------------------------------------
def baseline(targets, metrics=None):
    """Snapshot the target files (byte-exact) + run the metric suite + record
    baseline scores. Returns {run_id, targets, baseline_scores, ts, ...}.

    targets: list of paths (relative-to-home-root or absolute).
    metrics: optional list of metric ids; default = all registry metrics.

    Fail-closed: if NO valid metrics resolve -> error (no run created). If a
    target is missing/uncopyable it is reported in `snapshot_errors` and the
    run still records the available snapshot (decide will fail-closed REVERT if
    it can't restore, which for a never-snapshotted file is a no-op)."""
    if not targets:
        return {"ok": False, "error": "no_targets"}
    metric_pairs, unknown = _resolve_metric_ids(metrics)
    if not metric_pairs:
        return {"ok": False, "error": "no_valid_metrics",
                "unknown_metrics": unknown}

    ts = _now_iso()
    run_id = _make_run_id(ts, targets)

    # snapshot first (so we capture pre-change bytes)
    path_map, snap_errors = _snapshot_targets(run_id, targets)

    # run the baseline suite
    suite = _run_suite(metric_pairs)
    baseline_scores = _scores_only(suite)

    meta = {
        "run_id": run_id,
        "ts": ts,
        "targets": list(targets),
        # store path_map as rel->snapshot-rel so meta is portable. _safe_relpath
        # falls back to the absolute path for cross-drive targets (decide()
        # reconstructs correctly: os.path.join(root, abs_path) == abs_path).
        "path_map": {_safe_relpath(k, _home()):
                     _safe_relpath(v, _home())
                     for k, v in path_map.items()},
        "metric_ids": [mid for mid, _ in metric_pairs],
        "unknown_metrics": unknown,
        "baseline_scores": baseline_scores,
        "baseline_detail": {mid: {"ok": r.get("ok"), "error": r.get("error")}
                            for mid, r in suite.items()},
        "snapshot_errors": snap_errors,
        "decided": False,
    }
    saved = _save_meta(run_id, meta)
    _append_audit({
        "type": "baseline", "run_id": run_id, "ts": ts,
        "targets": list(targets), "metric_ids": meta["metric_ids"],
        "baseline_scores": baseline_scores, "snapshot_errors": snap_errors,
        "meta_saved": saved,
    })
    return {
        "ok": bool(saved),
        "run_id": run_id,
        "targets": list(targets),
        "baseline_scores": baseline_scores,
        "metric_ids": meta["metric_ids"],
        "unknown_metrics": unknown,
        "snapshot_errors": snap_errors,
        "ts": ts,
    }


def decide(run_id):
    """Re-run the same metric suite, compare vs baseline.
      KEEP  if no GATING metric degraded (ties allowed).
      REVERT if any gating metric degraded -> restore snapshot bytes EXACTLY.
    Fail-closed: a metric that cannot RUN/SCORE at decide-time -> REVERT.
    A run can be decided ONCE; double-decide -> rejected (status already_decided).

    Returns {run_id, decision: 'KEEP'|'REVERT', baseline_scores, after_scores,
             restored_files, ...}."""
    if not run_id:
        return {"ok": False, "error": "no_run_id"}
    meta = _load_meta(run_id)
    if meta is None:
        return {"ok": False, "error": "unknown_run_id", "run_id": run_id}
    if meta.get("decided"):
        return {"ok": False, "error": "already_decided", "run_id": run_id,
                "decision": meta.get("decision"),
                "decided_ts": meta.get("decided_ts")}

    root = _home()
    metric_ids = meta.get("metric_ids", [])
    metric_pairs, unknown = _resolve_metric_ids(metric_ids)
    reg = {mid: entry for mid, entry in metric_pairs}

    baseline_scores = meta.get("baseline_scores", {})

    # re-run suite
    suite = _run_suite(metric_pairs)
    after_scores = _scores_only(suite)

    # decide: any gating metric that (a) failed to run, or (b) degraded -> REVERT
    reasons = []
    revert = False

    # if a baseline metric is no longer resolvable, that's fail-closed REVERT
    missing_metrics = [m for m in metric_ids if m not in reg]
    if missing_metrics:
        revert = True
        reasons.append(f"metric_unresolvable:{','.join(missing_metrics)}")

    for mid, entry in metric_pairs:
        r = suite.get(mid, {})
        gating = bool(entry.get("gating", True))
        hib = bool(entry.get("higher_is_better", True))
        if not r.get("ok"):
            # fail-closed: metric could not be scored at decide-time
            if gating:
                revert = True
                reasons.append(f"{mid}:run_failed({r.get('error')})")
            continue
        b = baseline_scores.get(mid)
        a = r.get("score")
        if _degraded(b, a, hib):
            if gating:
                revert = True
                reasons.append(f"{mid}:degraded({b}->{a},hib={hib})")
            else:
                reasons.append(f"{mid}:degraded_nongating({b}->{a})")

    decision = "REVERT" if revert else "KEEP"
    restored_files = []
    restore_errors = []

    if revert:
        # rebuild abs path_map from stored rel pairs
        path_map = {}
        for rel_t, rel_snap in meta.get("path_map", {}).items():
            abs_t = os.path.abspath(os.path.join(root, rel_t))
            abs_snap = os.path.abspath(os.path.join(root, rel_snap))
            path_map[abs_t] = abs_snap
        restored_files, restore_errors = _restore_snapshot(path_map)
        if restore_errors:
            reasons.append(f"restore_errors:{len(restore_errors)}")

    decided_ts = _now_iso()
    meta["decided"] = True
    meta["decision"] = decision
    meta["decided_ts"] = decided_ts
    meta["after_scores"] = after_scores
    meta["decision_reasons"] = reasons
    meta["restored_files"] = [_safe_relpath(p, root) for p in restored_files]
    meta["restore_errors"] = restore_errors
    _save_meta(run_id, meta)

    _append_audit({
        "type": "decision", "run_id": run_id, "ts": decided_ts,
        "decision": decision, "baseline_scores": baseline_scores,
        "after_scores": after_scores, "reasons": reasons,
        "restored_files": meta["restored_files"],
        "restore_errors": restore_errors,
    })

    return {
        "ok": True,
        "run_id": run_id,
        "decision": decision,
        "baseline_scores": baseline_scores,
        "after_scores": after_scores,
        "restored_files": [_safe_relpath(p, root) for p in restored_files],
        "restore_errors": restore_errors,
        "reasons": reasons,
        "decided_ts": decided_ts,
    }


def history(limit=20):
    """Recent DECISION events from the append-only audit (newest last, capped).
    Returns a list of {run_id, decision, ts, baseline_scores, after_scores,
    reasons, restored_files}."""
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 20
    if limit <= 0:
        limit = 20
    decisions = [e for e in _read_audit() if e.get("type") == "decision"]
    return decisions[-limit:]


def pending():
    """Runs that have a baseline but no decision yet (newest-first by ts).
    Reads run meta.json files (authoritative for decided-state)."""
    runs_dir = _runs_dir()
    out = []
    try:
        if not os.path.isdir(runs_dir):
            return out
        for run_id in os.listdir(runs_dir):
            meta = _load_meta(run_id)
            if meta is None:
                continue
            if not meta.get("decided"):
                out.append({
                    "run_id": meta.get("run_id", run_id),
                    "ts": meta.get("ts", ""),
                    "targets": meta.get("targets", []),
                    "metric_ids": meta.get("metric_ids", []),
                    "baseline_scores": meta.get("baseline_scores", {}),
                })
    except OSError:
        return out
    out.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return out


# ================================================================================
# SELF-TEST
# ================================================================================
def _self_test():
    """Exercise the full contract with a probe metric against a temp target:
      1. baseline -> improve-file -> decide == KEEP (no degradation)
      2. baseline -> break-file   -> decide == REVERT + byte-exact restoration
      3. double-decide rejection (already_decided)
    Uses an ISOLATED probe registry + probe target under retention/_selftest/ so
    it never touches the real metrics or repo files. NEVER mutates real state
    beyond the retention/_selftest/ + the runs/audit it creates (cleaned up).
    Returns {ok, checks:[...]}."""
    checks = []
    root = _home()
    selftest_dir = os.path.join(_state_dir(), "_selftest")
    os.makedirs(selftest_dir, exist_ok=True)

    # A probe target file whose "quality" is the count of GOOD lines.
    target = os.path.join(selftest_dir, "probe_target.txt")
    with open(target, "w", encoding="utf-8") as f:
        f.write("GOOD\nGOOD\nGOOD\n")  # baseline quality = 3

    # A probe metric script: prints "QUALITY: N" = number of lines containing GOOD.
    probe_script = os.path.join(selftest_dir, "probe_metric.py")
    with open(probe_script, "w", encoding="utf-8") as f:
        f.write(
            "import sys\n"
            "p = sys.argv[1]\n"
            "n = sum(1 for ln in open(p, encoding='utf-8') if 'GOOD' in ln)\n"
            "print('QUALITY: %d' % n)\n"
        )

    target_rel = os.path.relpath(target, root)

    # Build an isolated registry via a temp registry file + monkeypatch path.
    probe_registry = {
        "metrics": [{
            "id": "probe_quality",
            "label": "self-test probe (GOOD-line count)",
            "cmd": ["python", os.path.relpath(probe_script, root),
                    os.path.relpath(target, root)],
            "cwd": ".",
            "parse": {"mode": "regex", "pattern": "QUALITY:\\s*(\\d+)",
                      "group": 1, "type": "int"},
            "higher_is_better": True,
            "gating": True,
            "timeout_sec": 30,
        }]
    }
    probe_reg_path = os.path.join(selftest_dir, "probe_registry.json")
    with open(probe_reg_path, "w", encoding="utf-8") as f:
        json.dump(probe_registry, f)

    # Monkeypatch _registry_path to point at the probe registry for the duration.
    global _registry_path
    _orig_registry_path = _registry_path
    _registry_path = lambda: probe_reg_path  # noqa: E731

    overall_ok = True
    try:
        # ---- Scenario 1: baseline -> improve -> KEEP ----
        b1 = baseline([target_rel], metrics=["probe_quality"])
        ok1a = b1.get("ok") and b1.get("baseline_scores", {}).get("probe_quality") == 3
        checks.append({"check": "S1.baseline_score==3", "pass": bool(ok1a),
                       "detail": b1.get("baseline_scores")})
        # IMPROVE the file (add a GOOD line -> quality 4, higher_is_better -> not degraded)
        with open(target, "a", encoding="utf-8") as f:
            f.write("GOOD\n")
        d1 = decide(b1["run_id"])
        ok1b = d1.get("decision") == "KEEP"
        checks.append({"check": "S1.decide==KEEP", "pass": bool(ok1b),
                       "detail": {"decision": d1.get("decision"),
                                  "after": d1.get("after_scores")}})
        # file should remain IMPROVED (KEEP does not restore)
        with open(target, encoding="utf-8") as f:
            kept = f.read()
        ok1c = kept.count("GOOD") == 4
        checks.append({"check": "S1.file_kept_improved(4 GOOD)", "pass": bool(ok1c),
                       "detail": {"good_count": kept.count("GOOD")}})

        # ---- Scenario 2: baseline -> break -> REVERT + byte-exact restore ----
        with open(target, "w", encoding="utf-8") as f:
            f.write("GOOD\nGOOD\nGOOD\nGOOD\nGOOD\n")  # quality 5
        b2 = baseline([target_rel], metrics=["probe_quality"])
        pre_break_bytes = open(target, "rb").read()
        pre_break_sha = hashlib.sha256(pre_break_bytes).hexdigest()
        ok2a = b2.get("baseline_scores", {}).get("probe_quality") == 5
        checks.append({"check": "S2.baseline_score==5", "pass": bool(ok2a),
                       "detail": b2.get("baseline_scores")})
        # BREAK the file (remove GOOD lines -> quality 1, degradation)
        with open(target, "w", encoding="utf-8") as f:
            f.write("GOOD\nBAD\nBAD\n")  # quality 1
        d2 = decide(b2["run_id"])
        ok2b = d2.get("decision") == "REVERT"
        checks.append({"check": "S2.decide==REVERT", "pass": bool(ok2b),
                       "detail": {"decision": d2.get("decision"),
                                  "reasons": d2.get("reasons")}})
        # file must be byte-exactly restored to the 5-GOOD baseline
        post_bytes = open(target, "rb").read()
        post_sha = hashlib.sha256(post_bytes).hexdigest()
        ok2c = (post_sha == pre_break_sha) and (post_bytes == pre_break_bytes)
        checks.append({"check": "S2.byte_exact_restore", "pass": bool(ok2c),
                       "detail": {"pre_sha": pre_break_sha[:12],
                                  "post_sha": post_sha[:12],
                                  "restored": d2.get("restored_files")}})

        # ---- Scenario 3: double-decide rejection ----
        d3 = decide(b2["run_id"])
        ok3 = (not d3.get("ok")) and d3.get("error") == "already_decided"
        checks.append({"check": "S3.double_decide_rejected", "pass": bool(ok3),
                       "detail": {"ok": d3.get("ok"), "error": d3.get("error")}})

        overall_ok = all(c["pass"] for c in checks)
    finally:
        # restore registry path
        _registry_path = _orig_registry_path
        # clean up the probe target + script + registry (keep runs/audit as audit
        # is append-only by contract; the self-test runs are real history).
        for p in (target, probe_script, probe_reg_path):
            try:
                os.remove(p)
            except OSError:
                pass

    return {"ok": overall_ok, "checks": checks,
            "passed": sum(1 for c in checks if c["pass"]),
            "total": len(checks)}


# --- CLI ------------------------------------------------------------------------
def _emit(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="The metric-gated retention loop (KEEP if metrics hold, else REVERT).")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--baseline", action="store_true",
                       help="Snapshot targets + record baseline metric scores.")
    group.add_argument("--decide", metavar="RUN_ID",
                       help="Re-run metrics; KEEP or REVERT (restore snapshot).")
    group.add_argument("--pending", action="store_true",
                       help="List runs with a baseline but no decision yet.")
    group.add_argument("--history", action="store_true",
                       help="Recent decisions from the audit log.")
    group.add_argument("--self-test", action="store_true",
                       help="Exercise the full contract (KEEP / REVERT / double-decide).")
    ap.add_argument("--targets", default="",
                    help="Comma-separated target files (for --baseline).")
    ap.add_argument("--metrics", default="",
                    help="Comma-separated metric ids (for --baseline; default=all).")
    ap.add_argument("--limit", type=int, default=20,
                    help="Limit for --history (default 20).")
    args = ap.parse_args(argv)

    if args.baseline:
        targets = [t.strip() for t in args.targets.split(",") if t.strip()]
        metrics = [m.strip() for m in args.metrics.split(",") if m.strip()] or None
        result = baseline(targets, metrics=metrics)
        _emit(result)
        return 0 if result.get("ok") else 1

    if args.decide is not None:
        result = decide(args.decide)
        _emit(result)
        return 0 if result.get("ok") else 1

    if args.pending:
        result = pending()
        _emit({"ok": True, "pending_count": len(result), "pending": result})
        return 0

    if args.history:
        result = history(args.limit)
        _emit({"ok": True, "count": len(result), "decisions": result})
        return 0

    if args.self_test:
        result = _self_test()
        _emit(result)
        return 0 if result.get("ok") else 1

    ap.print_help()
    return 1


if __name__ == "__main__":
    # Force UTF-8 so non-ASCII print()s survive Windows cp1252 consoles.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, OSError, ValueError):
            pass
    sys.exit(main())
