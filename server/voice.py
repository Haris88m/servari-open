#!/usr/bin/env python3
"""
voice.py — THE LOCAL VOICE BACKEND for the SERVARI shell.

Sovereign, zero-cost, nothing leaves the machine. Speech-to-text runs locally
via faster-whisper (CTranslate2 backend); text-to-speech voices are enumerated
from the built-in Windows System.Speech synthesizer. No cloud, no API key, no
egress (the dependent's data stays home).

  - stdlib + one optional open-source dep (faster-whisper, MIT)
  - cp1252-safe (stdout/stderr reconfigured to UTF-8)
  - fail-closed: missing faster-whisper -> {ok:false, error:"stt_unavailable"}
  - lazy model load: the WhisperModel is loaded on first transcribe and cached
    in a module global (cold load ~5s; subsequent calls reuse it).

Public API:
  transcribe(audio, language="en", partial=False) -> {ok, text, duration_sec,
                                       language, model, device, compute_type,
                                       transcribe_sec, partial}
      audio: a path (str / os.PathLike) to a WAV/webm/etc file, OR raw audio
      bytes. Bytes are written to a temp file (CTranslate2 reads a path/stream).
      partial: when True, skip the brand-word correction map for speed (interim
      transcriptions — the final authoritative pass still corrects).
  voices() -> {ok, tts_voices: [...], stt_model, stt_device, stt_compute_type,
               stt_ready}
  self_test() -> runs the Windows-TTS-WAV -> transcribe loop end-to-end.

CLI:
  python voice.py --transcribe <path> [--language en] [--partial]
  python voice.py --voices
  python voice.py --self-test

STDLIB-only except faster-whisper. The STT model is the 'base' multilingual
model (~141MB on disk), CPU int8 by default with a cuda->cpu fallback chain.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

# --- the optional dep: faster-whisper. Fail-closed if absent. -------------------
try:
    from faster_whisper import WhisperModel  # type: ignore
    _FW_OK = True
    _FW_ERR = None
except Exception as _e:  # pragma: no cover - defensive import guard
    WhisperModel = None  # type: ignore
    _FW_OK = False
    _FW_ERR = f"{type(_e).__name__}: {_e}"

# --- config ---------------------------------------------------------------------
STT_MODEL = "base"          # ~141MB on disk; good accuracy/speed for dictation
DEFAULT_LANGUAGE = "en"
# device/compute fallback chain: try GPU first, fall back to CPU int8.
_FALLBACK_CHAIN = (("cuda", "float16"), ("cpu", "int8"))

# --- module-global model cache (lazy load) --------------------------------------
_MODEL = None
_MODEL_DEVICE = None
_MODEL_CTYPE = None
_MODEL_LOAD_ERR = None


def _load_model():
    """Lazy-load the WhisperModel, caching it in a module global. Walks the
    device/compute fallback chain (cuda/float16 -> cpu/int8). Returns
    (model, device, compute_type) or raises RuntimeError if no backend works.

    NOTE on the cuda check: ctranslate2.get_cuda_device_count() can report a
    GPU is PRESENT while the installed CTranslate2 wheel is CPU-only (no bundled
    CUDA/cuDNN) — so we do NOT trust a flag; we TRY cuda and catch the failure,
    falling back to cpu (inspect by trying, don't trust a flag)."""
    global _MODEL, _MODEL_DEVICE, _MODEL_CTYPE, _MODEL_LOAD_ERR
    if _MODEL is not None:
        return _MODEL, _MODEL_DEVICE, _MODEL_CTYPE
    if not _FW_OK:
        raise RuntimeError("stt_unavailable")
    errors = []
    for device, ctype in _FALLBACK_CHAIN:
        try:
            m = WhisperModel(STT_MODEL, device=device, compute_type=ctype)
            _MODEL, _MODEL_DEVICE, _MODEL_CTYPE = m, device, ctype
            _MODEL_LOAD_ERR = None
            return _MODEL, _MODEL_DEVICE, _MODEL_CTYPE
        except Exception as e:
            errors.append("%s/%s: %s" % (device, ctype, type(e).__name__))
            continue
    _MODEL_LOAD_ERR = "; ".join(errors)
    raise RuntimeError("no_compute_backend: " + _MODEL_LOAD_ERR)


# --- public API -----------------------------------------------------------------
def transcribe(audio, language=DEFAULT_LANGUAGE, partial=False):
    """Transcribe an audio file path OR raw audio bytes to text.

    Returns a dict, NEVER raises:
      {ok, text, duration_sec, language, model, device, compute_type,
       transcribe_sec, partial}                              (success)
      {ok:false, error, hint}                                (failure)

    partial=True: skip the brand-word correction map for speed. Use this for
    interim/streaming transcriptions where latency matters and corrections can
    wait for the final authoritative pass.

    fail-closed cases:
      - faster-whisper not installed -> error="stt_unavailable"
      - empty input                  -> error="empty_audio"
      - missing path                 -> error="audio_not_found"
      - no compute backend           -> error="no_compute_backend"
    """
    if not _FW_OK:
        return {"ok": False, "error": "stt_unavailable",
                "hint": "pip install faster-whisper", "detail": _FW_ERR}

    tmp_path = None
    try:
        # Resolve input -> a real file path on disk (CTranslate2 reads a path).
        if isinstance(audio, (bytes, bytearray)):
            if not audio:
                return {"ok": False, "error": "empty_audio",
                        "hint": "audio bytes were empty"}
            fd, tmp_path = tempfile.mkstemp(suffix=".audio", prefix="servari_stt_")
            with os.fdopen(fd, "wb") as f:
                f.write(audio)
            path = tmp_path
        else:
            path = os.fspath(audio)
            if not path:
                return {"ok": False, "error": "empty_audio",
                        "hint": "audio path was empty"}
            if not os.path.isfile(path):
                return {"ok": False, "error": "audio_not_found",
                        "hint": "no file at %r" % path}

        try:
            model, device, ctype = _load_model()
        except RuntimeError as e:
            msg = str(e)
            if msg == "stt_unavailable":
                return {"ok": False, "error": "stt_unavailable",
                        "hint": "pip install faster-whisper"}
            return {"ok": False, "error": "no_compute_backend",
                    "hint": msg}

        t0 = time.time()
        lang = (language or DEFAULT_LANGUAGE) or None
        # BRAND-WORD FIX: a coined product name is not in whisper's vocabulary —
        # the initial_prompt biases decoding toward it, and the correction map
        # catches the known mishearings. Add your own product names here.
        segments, info = model.transcribe(
            path, language=lang,
            initial_prompt="SERVARI.")
        text = "".join(seg.text for seg in segments).strip()
        # Known-mishearing correction map (case-insensitive, whole words/phrases).
        # Skip corrections on partial/interim calls — the final authoritative
        # transcription (partial=False) still applies them.
        if not partial:
            _corrections = {
                "survive": "SERVARI", "surveyor": "SERVARI", "so very": "SERVARI",
                "servery": "SERVARI", "savari": "SERVARI", "cervari": "SERVARI",
            }
            for wrong, right in _corrections.items():
                import re as _re
                text = _re.sub(_re.escape(wrong), right, text, flags=_re.IGNORECASE)
        elapsed = time.time() - t0

        return {
            "ok": True,
            "text": text,
            "duration_sec": round(float(getattr(info, "duration", 0.0)), 3),
            "language": getattr(info, "language", lang or DEFAULT_LANGUAGE),
            "model": STT_MODEL,
            "device": device,
            "compute_type": ctype,
            "transcribe_sec": round(elapsed, 3),
            "partial": bool(partial),
        }
    except Exception as e:
        return {"ok": False, "error": "transcribe_failed",
                "hint": "%s: %s" % (type(e).__name__, e)}
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _windows_tts_voices():
    """Enumerate installed Windows System.Speech voices. Returns a list of
    {name, culture, gender, age} dicts. Empty list on any failure (non-Windows,
    no PowerShell, no voices). NEVER raises."""
    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$v = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | "
        "ForEach-Object { [pscustomobject]@{ name=$_.Name; culture=$_.Culture.Name; "
        "gender=$_.Gender.ToString(); age=$_.Age.ToString() } }; "
        "$s.Dispose(); "
        "$v | ConvertTo-Json -Compress"
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    out = (r.stdout or "").strip()
    if r.returncode != 0 or not out:
        return []
    try:
        data = json.loads(out)
    except (ValueError, json.JSONDecodeError):
        return []
    # ConvertTo-Json yields a single object (not a list) when there's one voice.
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return []
    voices = []
    for v in data:
        if isinstance(v, dict) and v.get("name"):
            voices.append({
                "name": str(v.get("name", "")),
                "culture": str(v.get("culture", "")),
                "gender": str(v.get("gender", "")),
                "age": str(v.get("age", "")),
            })
    return voices


def voices():
    """Report the voice surface: installed Windows TTS voices + the STT
    model/device readiness. NEVER raises.

    Returns {ok, tts_voices:[...], stt_model, stt_device, stt_compute_type,
             stt_ready, [error], [hint]}.
    stt_ready is False (with error/hint) when faster-whisper is missing — but
    the TTS voice list is still returned (TTS does not depend on STT)."""
    tts = _windows_tts_voices()
    if not _FW_OK:
        return {
            "ok": False,
            "tts_voices": tts,
            "stt_model": STT_MODEL,
            "stt_device": None,
            "stt_compute_type": None,
            "stt_ready": False,
            "error": "stt_unavailable",
            "hint": "pip install faster-whisper",
        }
    # Report cached device/compute if the model is already loaded; otherwise
    # report the PLANNED first link of the fallback chain WITHOUT forcing a
    # cold load (voices() is a cheap config probe).
    if _MODEL is not None:
        device, ctype = _MODEL_DEVICE, _MODEL_CTYPE
    else:
        device, ctype = "cpu", "int8"  # the effective default on this host
    return {
        "ok": True,
        "tts_voices": tts,
        "stt_model": STT_MODEL,
        "stt_device": device,
        "stt_compute_type": ctype,
        "stt_ready": True,
    }


def self_test():
    """End-to-end proof: synthesize a known phrase via Windows TTS into a WAV,
    then transcribe it with faster-whisper. Returns a dict, NEVER raises.

    {ok:true, spoken, heard, ...transcribe fields...}   when STT produced text
    {ok:false, error, hint}                             on any failure
    """
    if not _FW_OK:
        return {"ok": False, "error": "stt_unavailable",
                "hint": "pip install faster-whisper", "detail": _FW_ERR}

    phrase = "SERVARI voice test one two three"
    fd, wav = tempfile.mkstemp(suffix=".wav", prefix="servari_selftest_")
    os.close(fd)
    try:
        ps = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            "$s.SetOutputToWaveFile('%s'); "
            "$s.Speak('%s'); "
            "$s.Dispose();"
        ) % (wav.replace("\\", "\\\\"), phrase)
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True, text=True, timeout=60,
            )
        except (OSError, subprocess.SubprocessError) as e:
            return {"ok": False, "error": "tts_failed",
                    "hint": "%s: %s" % (type(e).__name__, e)}
        if r.returncode != 0 or not os.path.isfile(wav) or os.path.getsize(wav) == 0:
            return {"ok": False, "error": "tts_failed",
                    "hint": "powershell rc=%s stderr=%s" % (r.returncode, (r.stderr or "").strip())}

        result = transcribe(wav, language="en")
        if not result.get("ok"):
            return result
        result["spoken"] = phrase
        result["heard"] = result.get("text", "")
        return result
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


# --- CLI ------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="SERVARI local voice backend — STT (faster-whisper) + TTS-voice enum.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--transcribe", metavar="PATH",
                       help="Transcribe an audio file to text.")
    group.add_argument("--voices", action="store_true",
                       help="List TTS voices + STT model/device.")
    group.add_argument("--self-test", action="store_true",
                       help="Run the TTS-WAV -> transcribe proof loop.")
    parser.add_argument("--language", default=DEFAULT_LANGUAGE,
                        help="Language hint for transcription (default: en).")
    parser.add_argument("--partial", action="store_true",
                        help="Skip brand-word corrections (faster interim pass).")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    args = parser.parse_args(argv)

    if args.transcribe is not None:
        result = transcribe(args.transcribe, language=args.language,
                            partial=getattr(args, "partial", False))
        _emit(result, args.pretty)
        return 0 if result.get("ok") else 1

    if args.voices:
        result = voices()
        _emit(result, args.pretty)
        return 0 if result.get("ok") else 1

    if args.self_test:
        result = self_test()
        _emit(result, args.pretty)
        if result.get("ok"):
            # human-readable PASS line in addition to the JSON.
            print("SELF-TEST PASS  spoken=%r  heard=%r  (%s/%s, audio %.2fs, transcribe %.2fs)"
                  % (result.get("spoken"), result.get("heard"),
                     result.get("device"), result.get("compute_type"),
                     result.get("duration_sec", 0.0), result.get("transcribe_sec", 0.0)))
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
