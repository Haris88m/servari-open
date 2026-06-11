# -*- coding: utf-8 -*-
# Portions derived from Odysseus (MIT) — see NOTICE.
# https://github.com/pewdiepie-archdaemon/odysseus
# Copyright (c) 2025 Odysseus Contributors. Licensed under the MIT License.
"""Local hardware probe: CPU / RAM / GPU + VRAM detection.

Ported from Odysseus services/hwfit/hardware.py with two deliberate changes:

  1. LOCAL-ONLY. All SSH-remote probing (host=/ssh_port= plumbing) is NOT
     ported — SERVARI scans the machine it runs on, nothing else.
  2. NO WMI, NO `platform` module. The original detected Windows hardware via
     a PowerShell/WMI query; WMI (and the `platform` module functions that
     shell out to it) can hang for minutes on some Windows machines. This port
     uses os/sys/env/ctypes only: GlobalMemoryStatusEx for RAM, the
     PROCESSOR_IDENTIFIER env var for the CPU name, os.cpu_count() for cores,
     and nvidia-smi (when present on PATH or in its stock install dirs) for
     the GPU. AMD GPUs on Windows are not detectable without WMI, so they
     degrade to has_gpu=False — honestly reported, never a crash.

Degrades gracefully everywhere: no GPU, sandboxed environments (subprocess
blocked), and missing tools all yield a valid CPU-only profile. Pure stdlib.

Linux (nvidia-smi / ROCm sysfs) and macOS (sysctl / Apple Silicon unified
memory) detection is kept near-verbatim from the original.
"""
import os
import re
import shutil
import subprocess
import sys
import time

CACHE_TTL = 24 * 3600  # 24 h — hardware probes are user-initiated via rescan (fresh=True);
                       # hardware rarely changes mid-session.

_last_gpu_error = None  # set by _detect_nvidia() when nvidia-smi errors (driver mismatch, etc.)

# Windows: keep child consoles hidden (the server may run windowless).
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _platform_label():
    """"windows" / "darwin" / "linux" from os/sys only (no `platform` module —
    its uname/processor helpers can shell out to WMI on Windows and hang)."""
    if os.name == "nt":
        return "windows"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"


def _machine_arch():
    """Machine architecture string, lowercased ("amd64", "x86_64", "arm64"…).
    POSIX: os.uname(). Windows: the PROCESSOR_ARCHITECTURE env var."""
    if hasattr(os, "uname"):
        try:
            return (os.uname().machine or "").lower()
        except Exception:
            pass
    return (os.environ.get("PROCESSOR_ARCHITECTURE") or "").lower()


def _run(cmd):
    """Run a local command; return stripped stdout on rc=0, else None.
    Never raises — sandboxes that block subprocess degrade to None."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10,
                           creationflags=_NO_WINDOW)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return None


def _group_gpus(gpus):
    """Group identical GPUs by (name, rounded VRAM).

    Tensor-parallel serving only works across IDENTICAL GPUs, so a mixed box
    must be split into homogeneous pools. Each group carries the device indices
    so a serve command can pin CUDA_VISIBLE_DEVICES to exactly one pool. Biggest
    pool (by total VRAM) first — that's the sensible auto-default serving target.
    """
    groups = {}
    order = []
    for g in gpus:
        key = (g["name"], round(g["vram_gb"]))
        if key not in groups:
            groups[key] = {
                "name": g["name"],
                "vram_each": round(g["vram_gb"], 1),
                "count": 0,
                "indices": [],
            }
            order.append(key)
        groups[key]["count"] += 1
        groups[key]["indices"].append(g.get("index"))
    out = []
    for key in order:
        grp = groups[key]
        grp["vram_total"] = round(grp["vram_each"] * grp["count"], 1)
        out.append(grp)
    out.sort(key=lambda x: x["vram_total"], reverse=True)
    return out


def _nvidia_smi_path():
    """Locate nvidia-smi without WMI: PATH first, then the two stock install
    locations on Windows. Returns None when absent (no GPU / no driver / sandbox)."""
    found = shutil.which("nvidia-smi")
    if found:
        return found
    if os.name == "nt":
        sysroot = os.environ.get("SystemRoot", r"C:\Windows")
        progfiles = os.environ.get("ProgramFiles", r"C:\Program Files")
        for cand in (
            os.path.join(sysroot, "System32", "nvidia-smi.exe"),
            os.path.join(progfiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
        ):
            if os.path.isfile(cand):
                return cand
    return None


def _detect_nvidia():
    global _last_gpu_error
    _last_gpu_error = None
    smi = _nvidia_smi_path()
    if not smi:
        return None
    out = _run([smi, "--query-gpu=memory.total,name", "--format=csv,noheader,nounits"])
    if not out:
        return None

    # nvidia-smi present but unable to talk to the driver (e.g. it was updated
    # without a reboot). It prints an error and no GPU rows — surface that as a
    # driver error rather than the misleading "No GPU".
    _low = out.lower()
    if ("nvml" in _low or "driver/library version mismatch" in _low
            or "couldn't communicate" in _low or "no devices were found" in _low
            or "failed to initialize" in _low):
        _last_gpu_error = out.strip().split("\n")[0][:140] or "NVIDIA driver error"
        return None

    gpus = []
    # Devices nvidia-smi lists with a real name but a non-numeric memory.total.
    unified = []
    # nvidia-smi lists GPUs in index order (0,1,2,...), so the row position is
    # the CUDA device index we'd pass to CUDA_VISIBLE_DEVICES.
    for idx, line in enumerate(out.strip().split("\n")):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2:
            try:
                vram_mb = float(parts[0])
                gpus.append({"index": idx, "name": parts[1], "vram_gb": vram_mb / 1024.0})
            except ValueError:
                # Grace Blackwell GB10 / DGX Spark and other unified-memory
                # NVIDIA parts report memory.total as "[N/A]"/"Not Supported"
                # because the GPU shares the system LPDDR pool instead of
                # carrying discrete VRAM. Don't drop the device — remember it so
                # we report a unified-memory GPU below rather than "No GPU".
                if parts[1]:
                    unified.append({"index": idx, "name": parts[1]})
                continue

    if not gpus:
        if unified:
            # Unified-memory CUDA box: report the GPU backed by system RAM so the
            # Cookbook recommends models and serving works. The pool is shared
            # (not per-GPU discrete VRAM), so report the RAM total once.
            ram_gb = round(_get_ram_gb(), 1)
            gpus = [{"index": g["index"], "name": g["name"], "vram_gb": ram_gb} for g in unified]
            return {
                "gpu_name": gpus[0]["name"],
                "gpu_vram_gb": ram_gb,
                "gpu_count": len(gpus),
                "gpus": gpus,
                "gpu_groups": _group_gpus(gpus),
                "homogeneous": True,
                "backend": "cuda",
                "unified_memory": True,
            }
        return None
    total_vram = sum(g["vram_gb"] for g in gpus)
    groups = _group_gpus(gpus)
    return {
        "gpu_name": gpus[0]["name"],
        "gpu_vram_gb": round(total_vram, 1),
        "gpu_count": len(gpus),
        "gpus": gpus,
        "gpu_groups": groups,
        "homogeneous": len(groups) <= 1,
        "backend": "cuda",
    }


def classify_amd_gfx(gfx):
    """Map an AMD ISA target (e.g. "gfx1200") to (gfx, family).

    family is one of:
      "rdna"    — consumer Radeon RX (gfx10xx RDNA1/2, gfx11xx RDNA3, gfx12xx RDNA4)
      "cdna"    — datacenter Instinct (gfx908 MI100, gfx90a MI200, gfx94x/95x MI300+)
      "gcn"     — older GCN/Vega (gfx900/906)
      "unknown" — empty/unrecognized; callers must treat conservatively

    This drives the serving decision: vLLM/SGLang on ROCm are validated on CDNA
    but fragile on consumer RDNA (AWQ kernels largely unsupported, FP8 needs
    out-of-tree patches), so RDNA is steered to GGUF/llama.cpp.
    """
    gfx = (gfx or "").lower().strip()
    m = re.fullmatch(r"gfx(\d+[a-f]?)", gfx)
    if not m:
        return "", "unknown"
    digits = m.group(1)
    if digits[:2] in ("10", "11", "12"):
        return gfx, "rdna"
    if digits in ("908", "90a") or digits[:2] in ("94", "95"):
        return gfx, "cdna"
    if digits[:1] == "9":
        return gfx, "gcn"
    return gfx, "unknown"


def _detect_amd():
    """Detect AMD GPUs via Linux sysfs. Handles both discrete cards (with
    mem_info_vram_total) and APUs / unified-memory SoCs like Strix Halo (which
    expose mem_info_vis_vram_total instead, or only mem_info_gtt_total).
    Windows has no sysfs (and this port avoids WMI), so AMD-on-Windows
    returns None — honest degradation."""
    def _read(path):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                return f.read().strip()
        except Exception:
            return None

    def _list_drm_cards():
        try:
            return [e for e in os.listdir("/sys/class/drm") if e.startswith("card") and "-" not in e]
        except Exception:
            return []

    def _amd_arch():
        """Best-effort AMD GPU ISA + family from rocminfo.

        rocminfo is the source of truth; its GPU agents report a `Name: gfxNNNN`
        line (CPU agents report a brand string, not a gfx target), so the first
        gfx match is the GPU ISA. Returns (gfx, family) — see classify_amd_gfx.
        """
        info = _run(["rocminfo"]) or _run(["/opt/rocm/bin/rocminfo"]) or ""
        m = re.search(r"gfx\d+[a-f]?", info)
        return classify_amd_gfx(m.group(0) if m else "")

    try:
        cards = []
        is_apu = False
        for _cidx, entry in enumerate(_list_drm_cards()):
            base = f"/sys/class/drm/{entry}/device"
            vendor = _read(f"{base}/vendor")
            if vendor != "0x1002":
                continue
            # Discrete cards usually report real VRAM in mem_info_vram_total,
            # while some AMD APUs / Docker views expose a tiny vram_total and
            # the usable pool in vis_vram_total. Use the larger of those two;
            # only fall back to GTT if neither VRAM field is available.
            vram_raw = _read(f"{base}/mem_info_vram_total")
            vis_raw = _read(f"{base}/mem_info_vis_vram_total")
            gtt_raw = _read(f"{base}/mem_info_gtt_total")
            vram_val = int(vram_raw) if vram_raw and vram_raw.isdigit() else 0
            vis_val = int(vis_raw) if vis_raw and vis_raw.isdigit() else 0
            gtt_val = int(gtt_raw) if gtt_raw and gtt_raw.isdigit() else 0
            vram_bytes = max(vram_val, vis_val)
            if vram_bytes <= 0:
                vram_bytes = gtt_val
            if vis_val and vis_val >= vram_val:
                is_apu = True
            if vram_bytes <= 0:
                continue
            name = _read(f"{base}/product_name") or f"AMD GPU ({entry})"
            cards.append({"index": _cidx, "name": name, "vram_gb": vram_bytes / (1024**3)})

        if not cards:
            return None
        total_vram = sum(c["vram_gb"] for c in cards)
        groups = _group_gpus(cards)
        gfx, family = _amd_arch()
        # NOTE: for APUs with BIOS UMA carveout (e.g. Strix Halo), vis_vram_total
        # is the real usable GPU memory — it's physically backed but reserved
        # by BIOS so it doesn't appear in /proc/meminfo. Don't cap it at system
        # RAM: the two pools are separate from the OS's perspective.
        return {
            "gpu_name": cards[0]["name"],
            "gpu_vram_gb": round(total_vram, 1),
            "gpu_count": len(cards),
            "gpus": cards,
            "gpu_groups": groups,
            "homogeneous": len(groups) <= 1,
            "backend": "rocm",
            "unified_memory": is_apu,
            # AMD ISA/family so downstream can tell datacenter Instinct (CDNA,
            # where vLLM/SGLang run AWQ/GPTQ reliably) from consumer Radeon
            # (RDNA, where the practical path is GGUF via llama.cpp). Empty/
            # "unknown" when rocminfo isn't available — callers must treat
            # unknown conservatively, not assume vLLM works.
            "gpu_arch": gfx,
            "gpu_family": family,
        }
    except Exception:
        return None


def _detect_apple_silicon():
    """Detect Apple Silicon (M-series) GPUs.

    Macs have no discrete VRAM — the GPU shares the system's unified memory.
    We report a fraction of total RAM as the usable GPU budget (matching macOS's
    default Metal working-set limit) so the Cookbook recommends models that
    actually run on the GPU instead of classifying the machine as CPU-only.

    backend="metal" is what fit.py and serve-command generation key off of.
    Gated on sys.platform (never the `platform` module).
    """
    if sys.platform != "darwin":
        return None
    arch = _machine_arch()

    # Only Apple Silicon (arm64) has a Metal GPU worth serving LLMs on; Intel
    # Macs fall through to the CPU path.
    if "arm" not in arch and "aarch64" not in arch:
        return None

    # Chip name, e.g. "Apple M4 Max" — carries the Pro/Max/Ultra variant that
    # the fit bandwidth table keys off of.
    brand = (_run(["sysctl", "-n", "machdep.cpu.brand_string"]) or "Apple Silicon").strip()

    # Total unified memory in bytes.
    memsize = _run(["sysctl", "-n", "hw.memsize"])
    try:
        total_gb = int(memsize) / (1024**3) if memsize else 0.0
    except ValueError:
        total_gb = 0.0
    if total_gb <= 0:
        return None

    # Usable GPU budget. macOS lets Metal use most of unified memory, but the
    # default working-set limit scales with RAM: small machines have to keep
    # more back for the OS + app. These fractions track Apple's
    # recommendedMaxWorkingSetSize defaults across the lineup. Honour an
    # explicit override if the user raised it with
    # `sudo sysctl iogpu.wired_limit_mb=…`.
    if total_gb <= 16:
        frac = 0.67
    elif total_gb <= 64:
        frac = 0.75
    else:
        frac = 0.80
    vram_gb = round(total_gb * frac, 1)
    wired = _run(["sysctl", "-n", "iogpu.wired_limit_mb"])
    try:
        wired_mb = int(wired) if wired else 0
        if wired_mb > 0:
            vram_gb = round(wired_mb / 1024.0, 1)
    except ValueError:
        pass

    gpu = {"index": 0, "name": brand, "vram_gb": vram_gb}
    return {
        "gpu_name": brand,
        "gpu_vram_gb": vram_gb,
        "gpu_count": 1,
        "gpus": [gpu],
        "gpu_groups": _group_gpus([gpu]),
        "homogeneous": True,
        "backend": "metal",
        # Unified memory: the "VRAM" above is carved out of system RAM, not a
        # separate pool — downstream fit logic uses this to avoid double-budgeting.
        "unified_memory": True,
    }


def _read_file(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return None


def _parse_meminfo():
    """Parse /proc/meminfo into a dict of key -> KB values."""
    text = _read_file("/proc/meminfo")
    if not text:
        return {}
    result = {}
    for line in text.split("\n"):
        if ":" in line:
            key, val = line.split(":", 1)
            parts = val.strip().split()
            if parts:
                try:
                    result[key.strip()] = int(parts[0])
                except ValueError:
                    pass
    return result


def _windows_memory_status():
    """Windows RAM via GlobalMemoryStatusEx (kernel32, ctypes) — instant, no
    WMI, no subprocess. Returns (total_gb, available_gb) or (0.0, 0.0)."""
    if os.name != "nt":
        return 0.0, 0.0
    try:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return stat.ullTotalPhys / (1024**3), stat.ullAvailPhys / (1024**3)
    except Exception:
        pass
    return 0.0, 0.0


def _get_ram_gb():
    if os.name == "nt":
        total, _avail = _windows_memory_status()
        return total

    meminfo = _parse_meminfo()
    if "MemTotal" in meminfo:
        return meminfo["MemTotal"] / (1024**2)

    # os.sysconf only exists on Unix — guard so this never raises elsewhere.
    if hasattr(os, "sysconf") and "SC_PHYS_PAGES" in getattr(os, "sysconf_names", {}):
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            if pages and page_size:
                return (pages * page_size) / (1024**3)
        except Exception:
            pass

    # macOS has no /proc/meminfo — fall back to sysctl.
    memsize = _run(["sysctl", "-n", "hw.memsize"])
    if memsize:
        try:
            return int(memsize.strip()) / (1024**3)
        except ValueError:
            pass
    return 0.0


def _get_available_ram_gb():
    if os.name == "nt":
        _total, avail = _windows_memory_status()
        return avail

    meminfo = _parse_meminfo()
    if "MemAvailable" in meminfo:
        return meminfo["MemAvailable"] / (1024**2)
    return _get_ram_gb() * 0.7


def _get_cpu_name():
    if os.name == "nt":
        # Env-based — set by Windows for every process; no WMI, no subprocess.
        return (os.environ.get("PROCESSOR_IDENTIFIER") or "unknown").strip() or "unknown"

    text = _read_file("/proc/cpuinfo")
    if text:
        for line in text.split("\n"):
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()

    # macOS has no /proc/cpuinfo — sysctl gives the chip name (e.g. "Apple M4").
    # Harmlessly returns nothing on Linux, so it's safe to try unconditionally.
    brand = _run(["sysctl", "-n", "machdep.cpu.brand_string"])
    if brand and brand.strip():
        return brand.strip()
    return "unknown"


def _get_cpu_count():
    return os.cpu_count() or 1


def _detect_windows():
    """Local Windows hardware WITHOUT WMI/PowerShell (the Odysseus original
    shelled out to Get-CimInstance; WMI can hang for minutes on some machines).
    RAM via GlobalMemoryStatusEx, CPU via env/os, GPU via nvidia-smi when
    present. Always returns a well-shaped dict."""
    total_gb, avail_gb = _windows_memory_status()
    result = {
        "total_ram_gb": round(total_gb, 1),
        "available_ram_gb": round(avail_gb, 1),
        "cpu_cores": _get_cpu_count(),
        "cpu_name": _get_cpu_name(),
        "has_gpu": False,
        "gpu_name": None,
        "gpu_vram_gb": None,
        "gpu_count": 0,
        "backend": "cpu_arm" if "arm" in _machine_arch() else "cpu_x86",
        "homogeneous": True,
        "gpu_error": None,
        "platform": "windows",
    }
    gpu_info = _detect_nvidia()
    if gpu_info:
        result.update({
            "has_gpu": True,
            "gpu_name": gpu_info["gpu_name"],
            "gpu_vram_gb": gpu_info["gpu_vram_gb"],
            "gpu_count": gpu_info["gpu_count"],
            "gpus": gpu_info.get("gpus", []),
            "gpu_groups": gpu_info.get("gpu_groups", []),
            "homogeneous": gpu_info.get("homogeneous", True),
            "backend": gpu_info["backend"],
            "unified_memory": gpu_info.get("unified_memory", False),
        })
    else:
        # nvidia-smi exists but errored (driver mismatch etc.) — say so instead
        # of the misleading "No GPU". AMD/Intel GPUs on Windows are not
        # detectable without WMI and degrade to has_gpu=False.
        result["gpu_error"] = _last_gpu_error
    return result


_cache_by_host = {}  # "_local" -> (timestamp, result); kept dict-shaped for cache hygiene


def detect_system(fresh=False):
    """Detect local system hardware: RAM, CPU, GPU. Cached (hardware rarely
    changes). Pass fresh=True to bypass the cache and re-probe (a "Rescan").

    Local-only: the Odysseus SSH-remote probing is intentionally not ported.
    Always returns a well-shaped dict — no GPU / sandboxed environments yield
    a valid CPU-only profile rather than an exception.
    """
    cache_key = "_local"
    now = time.time()
    if not fresh and cache_key in _cache_by_host:
        ts, cached = _cache_by_host[cache_key]
        if (now - ts) < CACHE_TTL:
            return cached

    # Windows: ctypes/env/nvidia-smi probe (the Linux /proc + /sys path below
    # would report 0 GB RAM and "unknown" CPU here).
    if os.name == "nt":
        result = _detect_windows()
        _cache_by_host[cache_key] = (now, result)
        return result

    # Linux / macOS / Termux.
    total_ram = round(_get_ram_gb(), 1)
    available_ram = round(_get_available_ram_gb(), 1)
    cpu_cores = _get_cpu_count()
    cpu_name = _get_cpu_name()

    gpu_info = _detect_apple_silicon() or _detect_nvidia() or _detect_amd()

    if gpu_info:
        result = {
            "total_ram_gb": total_ram,
            "available_ram_gb": available_ram,
            "cpu_cores": cpu_cores,
            "cpu_name": cpu_name,
            "has_gpu": True,
            "gpu_name": gpu_info["gpu_name"],
            "gpu_vram_gb": gpu_info["gpu_vram_gb"],
            "gpu_count": gpu_info["gpu_count"],
            "gpus": gpu_info.get("gpus", []),
            "gpu_groups": gpu_info.get("gpu_groups", []),
            "homogeneous": gpu_info.get("homogeneous", True),
            "backend": gpu_info["backend"],
            # Apple Silicon / AMD APUs share system RAM with the GPU — carry the
            # flag through so callers can tell unified from discrete VRAM.
            "unified_memory": gpu_info.get("unified_memory", False),
            "platform": _platform_label(),
        }
        if "gpu_arch" in gpu_info:
            result["gpu_arch"] = gpu_info["gpu_arch"]
            result["gpu_family"] = gpu_info.get("gpu_family", "unknown")
    else:
        arch_out = _machine_arch()
        backend = "cpu_arm" if "aarch64" in arch_out or "arm" in arch_out else "cpu_x86"
        result = {
            "total_ram_gb": total_ram,
            "available_ram_gb": available_ram,
            "cpu_cores": cpu_cores,
            "cpu_name": cpu_name,
            "has_gpu": False,
            "gpu_name": None,
            "gpu_vram_gb": None,
            "gpu_count": 0,
            "backend": backend,
            # Set when nvidia-smi exists but failed (e.g. driver/library
            # version mismatch) — lets the UI say "GPU driver error" instead
            # of the misleading "No GPU".
            "gpu_error": _last_gpu_error,
            "platform": _platform_label(),
        }

    _cache_by_host[cache_key] = (now, result)
    return result
