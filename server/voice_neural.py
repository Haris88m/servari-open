#!/usr/bin/env python3
"""
voice_neural.py — THE LOCAL NEURAL TTS BACKEND for the SERVARI shell.

A local, fluid neural voice via piper-tts (MIT), an on-device ONNX neural TTS.
Sovereign, zero-cost, nothing leaves the machine (the dependent's data stays
home). The voice model lives on disk; synthesis is sub-second and fully offline.

  - stdlib + one optional open-source dep (piper-tts, MIT — onnxruntime under it)
  - cp1252-safe (stdout/stderr reconfigured to UTF-8)
  - fail-closed: missing piper / missing model -> {ok:false, error:"tts_unavailable"}
  - lazy model load: the PiperVoice is loaded on first synthesize and cached in a
    module global (cold load ~1.7s; subsequent calls reuse it).
  - cache-by-text-hash: repeated phrases reuse the WAV file in _tts_cache/.

Public API:
  synthesize(text, voice=DEFAULT_VOICE) -> {ok, audio_path, duration_sec, engine,
                                            voice, bytes, cached, synth_sec}
      Writes (or reuses) _tts_cache/<sha1(voice|text)>.wav and returns its path.
  list_voices() -> {ok, engine, default, voices:[{id, model, exists, bytes}]}
  self_test()   -> synthesizes a known phrase, asserts the WAV exists + > 50KB.

CLI:
  python voice_neural.py --speak "text" [--voice en_US-ryan-high]
  python voice_neural.py --voices
  python voice_neural.py --self-test

STDLIB-only except piper-tts. Voice models are downloaded once into _tts_models/
(en_US-ryan-high ~120MB onnx + json). If piper or the model is absent, every
entry point fails closed with a clear {ok:false, error, hint} — it NEVER raises.
The _tts_models/ + _tts_cache/ directories are gitignored (downloaded on first run).
"""

import argparse
import hashlib
import json
import os
import sys
import time
import wave

# --- the optional dep: piper-tts. Fail-closed if absent. ------------------------
try:
    from piper import PiperVoice  # type: ignore
    _PIPER_OK = True
    _PIPER_ERR = None
except Exception as _e:  # pragma: no cover - defensive import guard
    PiperVoice = None  # type: ignore
    _PIPER_OK = False
    _PIPER_ERR = f"{type(_e).__name__}: {_e}"

# --- paths ----------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(_HERE, "_tts_models")
CACHE_DIR = os.path.join(_HERE, "_tts_cache")

# --- voice catalog --------------------------------------------------------------
# A voice id maps to its on-disk ONNX model basename in MODELS_DIR. The ".onnx.json"
# config sits beside it (piper auto-discovers it). en_US-ryan-high is the shipped
# neural male voice (fluid, natural). lessac is an optional second voice if its
# model is downloaded later.
VOICES = {
    "en_US-ryan-high": "en_US-ryan-high.onnx",
    "en_US-lessac-high": "en_US-lessac-high.onnx",
}
DEFAULT_VOICE = "en_US-ryan-high"
ENGINE = "piper-tts"

# --- module-global model cache (lazy load, keyed by voice id) -------------------
_MODELS = {}        # voice_id -> PiperVoice
_LOAD_ERR = {}      # voice_id -> last load error string


def _model_path(voice_id):
    """Resolve the on-disk ONNX path for a voice id, or None if unknown/missing."""
    basename = VOICES.get(voice_id)
    if not basename:
        return None
    path = os.path.join(MODELS_DIR, basename)
    return path if os.path.isfile(path) else None


def _load_voice(voice_id):
    """Lazy-load + cache a PiperVoice for `voice_id`. Raises RuntimeError with a
    short code on any failure (piper missing / unknown voice / model file absent /
    load error). The caller (synthesize) turns these into fail-closed dicts."""
    if not _PIPER_OK:
        raise RuntimeError("tts_unavailable")
    if voice_id in _MODELS:
        return _MODELS[voice_id]
    if voice_id not in VOICES:
        raise RuntimeError("unknown_voice")
    path = _model_path(voice_id)
    if path is None:
        raise RuntimeError("model_not_found")
    try:
        v = PiperVoice.load(path)
    except Exception as e:
        _LOAD_ERR[voice_id] = "%s: %s" % (type(e).__name__, e)
        raise RuntimeError("model_load_failed")
    _MODELS[voice_id] = v
    return v


def _cache_key(voice_id, text):
    """Deterministic cache filename for a (voice, text) pair."""
    h = hashlib.sha1(("%s|%s" % (voice_id, text)).encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, h + ".wav")


def _wav_duration_sec(path):
    """Read the WAV header to get its duration in seconds. 0.0 on any failure."""
    try:
        with wave.open(path, "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate() or 1
            return round(frames / float(rate), 3)
    except Exception:
        return 0.0


# --- public API -----------------------------------------------------------------
def synthesize(text, voice=DEFAULT_VOICE):
    """Synthesize `text` to a WAV via the local neural voice, caching by text hash.

    Returns a dict, NEVER raises:
      {ok, audio_path, duration_sec, engine, voice, bytes, cached, synth_sec}  (ok)
      {ok:false, error, hint, [detail]}                                       (fail)

    fail-closed cases:
      - piper not installed   -> error="tts_unavailable"
      - empty text            -> error="empty_text"
      - unknown voice id       -> error="unknown_voice"
      - model file missing     -> error="model_not_found"
      - model load failure      -> error="model_load_failed"
      - synthesis failure        -> error="synthesize_failed"
    """
    if not _PIPER_OK:
        return {"ok": False, "error": "tts_unavailable",
                "hint": "pip install piper-tts", "detail": _PIPER_ERR}

    clean = (text or "").strip()
    if not clean:
        return {"ok": False, "error": "empty_text", "hint": "text was empty"}

    voice_id = voice or DEFAULT_VOICE
    if voice_id not in VOICES:
        return {"ok": False, "error": "unknown_voice",
                "hint": "voice %r not in catalog; try one of %s"
                        % (voice_id, ", ".join(sorted(VOICES)))}

    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
    except OSError as e:
        return {"ok": False, "error": "synthesize_failed",
                "hint": "cannot create cache dir: %s" % e}

    out = _cache_key(voice_id, clean)

    # cache hit: reuse the file (the whole point of hashing by text).
    if os.path.isfile(out) and os.path.getsize(out) > 0:
        return {
            "ok": True, "audio_path": out,
            "duration_sec": _wav_duration_sec(out),
            "engine": ENGINE, "voice": voice_id,
            "bytes": os.path.getsize(out), "cached": True, "synth_sec": 0.0,
        }

    try:
        v = _load_voice(voice_id)
    except RuntimeError as e:
        code = str(e)
        hints = {
            "tts_unavailable": "pip install piper-tts",
            "unknown_voice": "voice not in catalog",
            "model_not_found": "missing model in %s; download en_US-ryan-high" % MODELS_DIR,
            "model_load_failed": _LOAD_ERR.get(voice_id, "PiperVoice.load failed"),
        }
        return {"ok": False, "error": code, "hint": hints.get(code, code)}

    tmp = out + ".part"
    try:
        t0 = time.time()
        with wave.open(tmp, "wb") as wf:
            v.synthesize_wav(clean, wf)
        synth_sec = round(time.time() - t0, 3)
        if not os.path.isfile(tmp) or os.path.getsize(tmp) == 0:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return {"ok": False, "error": "synthesize_failed",
                    "hint": "piper produced an empty WAV"}
        # atomic-ish rename into the cache slot
        os.replace(tmp, out)
        return {
            "ok": True, "audio_path": out,
            "duration_sec": _wav_duration_sec(out),
            "engine": ENGINE, "voice": voice_id,
            "bytes": os.path.getsize(out), "cached": False, "synth_sec": synth_sec,
        }
    except Exception as e:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return {"ok": False, "error": "synthesize_failed",
                "hint": "%s: %s" % (type(e).__name__, e)}


def list_voices():
    """Report the neural-voice surface: catalog + on-disk availability. NEVER
    raises. {ok, engine, default, available, voices:[{id, model, exists, bytes}]}.
    `available` is True only when piper is importable AND >=1 model file exists."""
    voices = []
    any_model = False
    for vid, basename in sorted(VOICES.items()):
        path = os.path.join(MODELS_DIR, basename)
        exists = os.path.isfile(path)
        if exists:
            any_model = True
        voices.append({
            "id": vid, "model": basename, "exists": exists,
            "bytes": os.path.getsize(path) if exists else 0,
        })
    return {
        "ok": _PIPER_OK and any_model,
        "engine": ENGINE,
        "default": DEFAULT_VOICE,
        "available": _PIPER_OK and any_model,
        "piper_ok": _PIPER_OK,
        "voices": voices,
        **({"error": "tts_unavailable", "hint": "pip install piper-tts",
            "detail": _PIPER_ERR} if not _PIPER_OK else {}),
    }


def self_test():
    """End-to-end proof: synthesize a phrase via the neural voice, assert the WAV
    exists and is > 50KB. Returns a dict, NEVER raises.

    {ok:true, ...synthesize fields..., over_50kb:true}   on success
    {ok:false, error, hint}                              on any failure
    """
    if not _PIPER_OK:
        return {"ok": False, "error": "tts_unavailable",
                "hint": "pip install piper-tts", "detail": _PIPER_ERR}

    phrase = "SERVARI is alive, and this is my real voice."
    result = synthesize(phrase, voice=DEFAULT_VOICE)
    if not result.get("ok"):
        return result
    nbytes = int(result.get("bytes", 0))
    result["spoken"] = phrase
    result["over_50kb"] = nbytes > 50000
    if not result["over_50kb"]:
        return {"ok": False, "error": "wav_too_small",
                "hint": "synthesized WAV was only %d bytes (<=50KB)" % nbytes,
                "audio_path": result.get("audio_path")}
    return result


# --- CLI ------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="SERVARI local NEURAL TTS backend (piper-tts).")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--speak", metavar="TEXT",
                       help="Synthesize TEXT to a cached WAV and print its path.")
    group.add_argument("--voices", action="store_true",
                       help="List neural voices + on-disk availability.")
    group.add_argument("--self-test", action="store_true",
                       help="Synthesize a known phrase and assert WAV > 50KB.")
    parser.add_argument("--voice", default=DEFAULT_VOICE,
                        help="Voice id (default: %s)." % DEFAULT_VOICE)
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    args = parser.parse_args(argv)

    if args.speak is not None:
        result = synthesize(args.speak, voice=args.voice)
        _emit(result, args.pretty)
        return 0 if result.get("ok") else 1

    if args.voices:
        result = list_voices()
        _emit(result, args.pretty)
        return 0 if result.get("ok") else 1

    if args.self_test:
        result = self_test()
        _emit(result, args.pretty)
        if result.get("ok"):
            # human-readable PASS line in addition to the JSON.
            print("SELF-TEST PASS  spoken=%r  voice=%s engine=%s  bytes=%d (>50KB=%s)  dur=%.2fs  synth=%.2fs  cached=%s  path=%s"
                  % (result.get("spoken"), result.get("voice"), result.get("engine"),
                     result.get("bytes", 0), result.get("over_50kb"),
                     result.get("duration_sec", 0.0), result.get("synth_sec", 0.0),
                     result.get("cached"), result.get("audio_path")))
            return 0
        print("SELF-TEST FAIL  error=%s  hint=%s"
              % (result.get("error"), result.get("hint")))
        return 1

    parser.print_help()
    return 1


def _emit(obj, pretty):
    if pretty:
        print(json.dumps(obj, indent=2))
    else:
        print(json.dumps(obj))


if __name__ == "__main__":
    # Windows consoles default to cp1252; force UTF-8 so any non-ASCII print()s survive.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, OSError, ValueError):
            pass
    sys.exit(main())
