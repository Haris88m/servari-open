# -*- coding: utf-8 -*-
"""Model Cookbook (server/hwfit/) — catalog, fit math, recommend, endpoints.

Ported from Odysseus (MIT — see NOTICE). The load-bearing claims under test:
  - the vendored 911-model catalog loads and every entry is sane,
  - the calibrated VRAM/quant math reproduces known answers (7B @ Q4_K_M on an
    8 GB card fits at ~4.8 GB; 70B does not fit and says so honestly),
  - recommendations are computed from a MOCKED hardware profile — the suite
    never assumes a real GPU,
  - the local hardware scan degrades gracefully (a sandbox / GPU-less box gets
    a valid CPU-only profile, never an exception) and never touches WMI or the
    `platform` module (which can hang on some Windows machines),
  - the /cookbook/scan + /cookbook/recommend routes answer well-shaped JSON
    through the real do_GET dispatch (no socket bound, mirroring server_mod).
"""
from __future__ import annotations

import inspect
import io
import json

import pytest

import hwfit.fit as hwfit_fit
import hwfit.hardware as hwfit_hardware
import hwfit.models as hwfit_models
import hwfit.profiles as hwfit_profiles

# ---------------------------------------------------------------------------
# Mocked hardware profiles — every recommendation test runs against these,
# never against the machine the suite happens to execute on.
# ---------------------------------------------------------------------------
GPU_8GB = {
    "total_ram_gb": 32.0, "available_ram_gb": 24.0, "cpu_cores": 8,
    "cpu_name": "Mock CPU", "has_gpu": True,
    "gpu_name": "NVIDIA GeForce RTX 3060 Ti", "gpu_vram_gb": 8.0,
    "gpu_count": 1, "backend": "cuda", "platform": "linux",
}
CPU_ONLY_16GB = {
    "total_ram_gb": 16.0, "available_ram_gb": 12.0, "cpu_cores": 8,
    "cpu_name": "Mock CPU", "has_gpu": False, "gpu_name": None,
    "gpu_vram_gb": None, "gpu_count": 0, "backend": "cpu_x86",
    "platform": "linux",
}

SEVEN_B = {"name": "Mock-7B-Instruct", "parameter_count": "7B",
           "context_length": 4096, "quantization": "Q4_K_M"}
SEVENTY_B = {"name": "Mock-70B-Instruct", "parameter_count": "70B",
             "context_length": 4096, "quantization": "Q4_K_M"}


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------

def test_catalog_loads_with_sane_entries():
    models = hwfit_models.get_models()
    assert len(models) >= 900  # the vendored catalog ships 911 entries
    for m in models:
        assert isinstance(m, dict)
        assert m.get("name"), m
        assert "parameter_count" in m, m
        assert "quantization" in m, m
        assert "context_length" in m, m
        # params_b must never raise on any catalog row (bad rows yield 0.0)
        assert hwfit_models.params_b(m) >= 0.0


def test_catalog_path_points_at_vendored_data():
    import os
    p = hwfit_models.model_catalog_path()
    assert os.path.isfile(p)
    assert p.endswith(os.path.join("data", "hf_models.json"))


def test_quant_tables_cover_the_gguf_hierarchy():
    for q in hwfit_models.QUANT_HIERARCHY:
        assert q in hwfit_models.QUANT_BPP
        assert q in hwfit_models.QUANT_SPEED_MULT
        assert q in hwfit_models.QUANT_QUALITY_PENALTY
        assert q in hwfit_models.QUANT_BYTES_PER_PARAM


# ---------------------------------------------------------------------------
# Fit math — known cases
# ---------------------------------------------------------------------------

def test_params_b_parses_unit_suffixes_and_raw_precedence():
    assert hwfit_models.params_b({"parameter_count": "7B"}) == pytest.approx(7.0)
    assert hwfit_models.params_b({"parameter_count": "355M"}) == pytest.approx(0.355)
    assert hwfit_models.params_b({"parameter_count": "80K"}) == pytest.approx(0.00008)
    # parameters_raw (exact count) wins over the display string
    assert hwfit_models.params_b(
        {"parameters_raw": 2_000_000_000, "parameter_count": "7B"}
    ) == pytest.approx(2.0)
    # malformed rows degrade to 0.0, never raise
    assert hwfit_models.params_b({"parameter_count": "1.5.3B"}) == 0.0
    assert hwfit_models.params_b({}) == 0.0


def test_estimate_memory_seven_b_q4_at_8k_ctx():
    # weights 7 * 0.58 + KV 0.000008 * 7 * 8192 + 0.5 overhead = ~5.02 GB
    mem = hwfit_models.estimate_memory_gb(SEVEN_B, "Q4_K_M", 8192)
    assert mem == pytest.approx(5.019, abs=0.01)


def test_moe_kv_cache_scales_with_active_params_only():
    dense = {"name": "Dense-30B", "parameter_count": "30B", "context_length": 8192}
    moe = {"name": "MoE-30B-A3B", "parameter_count": "30B", "context_length": 8192,
           "is_moe": True, "active_parameters": 3_000_000_000}
    # Same weights footprint, smaller KV for the MoE (3B active vs 30B dense).
    assert (hwfit_models.estimate_memory_gb(moe, "Q4_K_M", 8192)
            < hwfit_models.estimate_memory_gb(dense, "Q4_K_M", 8192))


def test_best_quant_for_budget_known_cases():
    # 8 GB budget @ 4k ctx: Q8_0 needs ~8.08 GB (no), Q6_K needs ~6.33 GB (yes).
    quant, ctx, mem = hwfit_models.best_quant_for_budget(SEVEN_B, 8.0, 4096)
    assert (quant, ctx) == ("Q6_K", 4096)
    assert mem == pytest.approx(6.33, abs=0.01)
    # 12 GB budget: the best quant (Q8_0, ~8.08 GB) fits outright.
    quant, ctx, _mem = hwfit_models.best_quant_for_budget(SEVEN_B, 12.0, 4096)
    assert (quant, ctx) == ("Q8_0", 4096)
    # 2 GB budget: a 7B does NOT fit at any quant/context — honest None.
    assert hwfit_models.best_quant_for_budget(SEVEN_B, 2.0, 4096) == (None, None, None)


def test_analyze_seven_b_fits_8gb_gpu_at_q4():
    r = hwfit_fit.analyze_model(SEVEN_B, GPU_8GB)
    assert r is not None
    assert r["quant"] == "Q4_K_M"
    assert r["run_mode"] == "gpu"
    assert r["fit_level"] == "perfect"
    assert r["required_gb"] == pytest.approx(4.8, abs=0.1)
    # Calibrated speed path: 448 GB/s (3060 Ti) / 3.5 GB weights * 0.55 = ~70.4 t/s
    assert r["speed_tps"] == pytest.approx(70.4, abs=1.0)
    assert r["score"] > 0


def test_analyze_seventy_b_is_honestly_too_tight_on_8gb():
    r = hwfit_fit.analyze_model(SEVENTY_B, GPU_8GB)
    assert r is not None
    assert r["fit_level"] == "too_tight"
    assert r["run_mode"] == "no_fit"
    assert r["score"] == 0
    assert r["required_gb"] > GPU_8GB["gpu_vram_gb"]


def test_bandwidth_lookup_longest_key_wins():
    assert hwfit_fit._lookup_bandwidth("NVIDIA GeForce RTX 4090") == 1008
    assert hwfit_fit._lookup_bandwidth("NVIDIA GeForce RTX 3060 Ti") == 448  # not bare "3060"
    assert hwfit_fit._lookup_bandwidth("AMD Radeon RX 7900 XTX") == 960
    assert hwfit_fit._lookup_bandwidth("Apple M4 Max") == 546               # not bare "m4"
    assert hwfit_fit._lookup_bandwidth("Totally Unknown GPU 9999") is None
    assert hwfit_fit._lookup_bandwidth(None) is None


def test_speed_estimator_cpu_fallback_uses_backend_constant():
    # No GPU name -> FALLBACK_K path: 70 (cpu_x86) / 7B * 1.15 (Q4 mult) = 11.5
    tps = hwfit_fit._estimate_speed(SEVEN_B, "Q4_K_M", "cpu_only", CPU_ONLY_16GB)
    assert tps == pytest.approx(11.5, abs=0.1)


# ---------------------------------------------------------------------------
# Recommend logic — mocked profiles only
# ---------------------------------------------------------------------------

def test_rank_models_on_mocked_gpu_returns_sorted_fits():
    results = hwfit_fit.rank_models(GPU_8GB, limit=20)
    assert results, "an 8 GB GPU + 24 GB RAM box must get recommendations"
    assert len(results) <= 20
    scores = [r["score"] for r in results]
    assert scores == sorted(scores, reverse=True)
    for r in results:
        for key in ("name", "quant", "run_mode", "fit_level", "required_gb",
                    "speed_tps", "score", "scores"):
            assert key in r, (key, r["name"])
        if r["run_mode"] == "gpu":
            assert r["required_gb"] <= GPU_8GB["gpu_vram_gb"]


def test_rank_models_fit_only_drops_too_tight_rows():
    results = hwfit_fit.rank_models(GPU_8GB, limit=100, sort="params", fit_only=True)
    assert results
    assert all(r["fit_level"] != "too_tight" for r in results)


def test_rank_models_cpu_only_profile_never_claims_gpu():
    results = hwfit_fit.rank_models(CPU_ONLY_16GB, limit=20, fit_only=True)
    assert results, "a 16 GB CPU-only box must still get (smaller) recommendations"
    for r in results:
        assert r["run_mode"] == "cpu_only"
        assert r["required_gb"] <= CPU_ONLY_16GB["available_ram_gb"]


def test_rank_models_use_case_filter_is_strict():
    results = hwfit_fit.rank_models(GPU_8GB, use_case="coding", limit=15)
    assert results
    assert all(r["use_case"] == "coding" for r in results)


def test_rank_models_search_filter_matches_name_or_provider():
    results = hwfit_fit.rank_models(GPU_8GB, search="qwen", limit=15)
    assert results
    for r in results:
        joined = (r["name"] or "").lower() + " " + (r.get("provider") or "").lower()
        assert "qwen" in joined


def test_rank_models_image_gen_not_ported_returns_empty():
    # Odysseus image-model fit is deliberately not ported (v2+); the filter
    # answers an empty list rather than mis-ranking text models.
    assert hwfit_fit.rank_models(GPU_8GB, use_case="image_gen") == []


def test_serve_profiles_for_long_context_model():
    model = {"name": "Mock-7B-Long", "parameter_count": "7B",
             "context_length": 131072, "quantization": "Q4_K_M"}
    system = {"gpu_vram_gb": 24.0}
    profs = hwfit_profiles.compute_serve_profiles(system, model)
    assert profs
    for p in profs:
        for key in ("key", "label", "quant", "n_gpu_layers", "n_cpu_moe",
                    "cache_type", "ctx", "est_vram_gb", "fits", "note"):
            assert key in p
        assert p["ctx"] <= 131072
    # No GPU -> no llama.cpp GPU profiles, honest empty list.
    assert hwfit_profiles.compute_serve_profiles({"gpu_vram_gb": 0}, model) == []


# ---------------------------------------------------------------------------
# Hardware scan — graceful degradation, no WMI
# ---------------------------------------------------------------------------

def test_detect_system_local_smoke_is_well_shaped():
    # Runs on whatever machine executes the suite — GPU-less boxes and
    # sandboxes must still produce a valid profile, never an exception.
    info = hwfit_hardware.detect_system()
    assert isinstance(info, dict)
    for key in ("total_ram_gb", "available_ram_gb", "cpu_cores", "cpu_name",
                "has_gpu", "gpu_name", "gpu_vram_gb", "gpu_count", "backend",
                "platform"):
        assert key in info, key
    assert isinstance(info["has_gpu"], bool)
    assert info["total_ram_gb"] >= 0.0
    assert info["cpu_cores"] >= 1
    assert info["platform"] in ("windows", "darwin", "linux")
    if not info["has_gpu"]:
        assert info["gpu_count"] == 0 and info["gpu_name"] is None
    # Cached: a second call returns the same profile without re-probing.
    assert hwfit_hardware.detect_system() == info


def test_hardware_probe_never_imports_platform_module():
    # Regression guard for the port's hard constraint: the `platform` module
    # (and the WMI/PowerShell probe of the Odysseus original) can hang on some
    # Windows machines. The scan must stay os/sys/env/ctypes-based. Checks
    # actual imports/attributes, not prose (the docstrings legitimately
    # describe what was removed).
    src = inspect.getsource(hwfit_hardware)
    assert "import platform" not in src
    assert "from platform" not in src
    assert "platform" not in vars(hwfit_hardware), \
        "hwfit.hardware must not hold the platform module at runtime"


# ---------------------------------------------------------------------------
# Endpoints — real do_GET dispatch, no socket bound (mirrors server_mod)
# ---------------------------------------------------------------------------

def _http_get(server_mod, path):
    """Drive the real handler dispatch in-process: build an H instance without
    a socket (no bind, matching the suite's no-network convention), point its
    wfile at a buffer, and call do_GET."""
    h = server_mod.H.__new__(server_mod.H)
    h.rfile = io.BytesIO(b"")
    h.wfile = io.BytesIO()
    h.command = "GET"
    h.path = path
    h.request_version = "HTTP/1.1"
    h.requestline = f"GET {path} HTTP/1.1"
    h.client_address = ("127.0.0.1", 0)
    h.do_GET()
    raw = h.wfile.getvalue()
    status = int(raw.split(b" ", 2)[1])
    body = raw.split(b"\r\n\r\n", 1)[1]
    return status, body


def test_scan_endpoint_returns_ok_json(server_mod):
    status, body = _http_get(server_mod, "/cookbook/scan")
    assert status == 200
    payload = json.loads(body)
    assert payload["ok"] is True
    assert isinstance(payload["system"], dict)
    assert "has_gpu" in payload["system"]


def test_scan_endpoint_api_alias(server_mod):
    status, body = _http_get(server_mod, "/api/cookbook/scan")
    assert status == 200
    assert json.loads(body)["ok"] is True


def test_recommend_endpoint_with_mocked_hardware(server_mod, monkeypatch):
    monkeypatch.setattr(hwfit_hardware, "detect_system",
                        lambda fresh=False: dict(GPU_8GB))
    status, body = _http_get(server_mod, "/cookbook/recommend?limit=5&use_case=coding")
    assert status == 200
    payload = json.loads(body)
    assert payload["ok"] is True
    assert payload["system"]["gpu_name"] == GPU_8GB["gpu_name"]
    recs = payload["recommendations"]
    assert payload["count"] == len(recs)
    assert 0 < len(recs) <= 5
    assert all(r["use_case"] == "coding" for r in recs)


def test_recommend_endpoint_bad_limit_degrades_to_default(server_mod, monkeypatch):
    monkeypatch.setattr(hwfit_hardware, "detect_system",
                        lambda fresh=False: dict(GPU_8GB))
    status, body = _http_get(server_mod, "/api/cookbook/recommend?limit=banana")
    assert status == 200
    payload = json.loads(body)
    assert payload["ok"] is True
    assert payload["count"] <= 20  # the default limit


def test_unknown_cookbook_route_is_404(server_mod):
    status, body = _http_get(server_mod, "/cookbook/nope")
    assert status == 404
    assert json.loads(body)["error"] == "not found"
