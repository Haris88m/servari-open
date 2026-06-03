/**
 * SERVARI OS — Voice client.
 *
 * The browser-side voice surface for the Cave. Two halves:
 *
 * STT (listening):
 * - Preferred:  webkitSpeechRecognition (instant, on-device, streams interim
 * results) when the browser exposes it.
 * - Fallback:   MediaRecorder captures mic audio -> POST to the server's
 * local faster-whisper backend via API.voiceTranscribe (sovereign, zero
 * egress). Used when webkitSpeechRecognition is absent (e.g. Electron /
 * Firefox).
 * - Amplitude:  an AnalyserNode taps the same mic stream and reports a
 * 0..1 loudness value via the onAmplitude callback (drives the feather
 * mic's reactive animation).
 *
 * TTS (speaking):
 * - speechSynthesis, preferring a 'Microsoft David' voice when installed.
 * - Strips markdown / code so the spoken text is clean prose; clamps to
 * <= 600 chars so a long reply doesn't monologue.
 * - Gated by Voice.ttsEnabled (localStorage 'servari-tts', default true).
 *
 * Nothing here redesigns the UI — it is pure plumbing the feather-mic component
 * calls into.
 */

import { API } from './api';

// ---------------------------------------------------------------------------
// Browser API typing (webkitSpeechRecognition isn't in the DOM lib types).
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    webkitSpeechRecognition?: SpeechRecognitionCtor;
    SpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.webkitSpeechRecognition || w.SpeechRecognition || null;
}

// ---------------------------------------------------------------------------
// Listening options.
// ---------------------------------------------------------------------------

export interface ListenOptions {
  /** Partial, in-progress transcript (fires repeatedly while speaking). */
  onInterim?: (text: string) => void;
  /** Final transcript for an utterance. */
  onFinal?: (text: string) => void;
  /** 0..1 microphone loudness, ~30fps, for the reactive mic animation. */
  onAmplitude?: (level: number) => void;
  /** Called on error with a short reason string. */
  onError?: (reason: string) => void;
  /** BCP-47 language tag; default 'en-US'. */
  lang?: string;
}

// ---------------------------------------------------------------------------
// Conversation mode (hands-free, talk-like-to-Claude).
// ---------------------------------------------------------------------------

/** The four states the conversation loop cycles through. */
export type ConversationState = 'listening' | 'transcribing' | 'speaking' | 'idle';

export interface ConversationOptions {
  /** Fires every time the loop changes state (drives the mic/waveform visuals). */
  onStateChange?: (state: ConversationState) => void;
  /** Partial, in-progress transcript. Fires every ~4s during active speech via
   * the streaming interim transcription path. */
  onInterim?: (text: string) => void;
  /** A complete, non-empty user utterance was transcribed. Send THIS to SERVARI. */
  onUserSaid?: (text: string) => void;
  /** 0..1 microphone loudness, ~30fps, for the reactive waveform. */
  onAmplitude?: (level: number) => void;
  /** Called on a hard error with a short reason string. */
  onError?: (reason: string) => void;
  /** BCP-47 language tag; default 'en-US'. */
  lang?: string;
}

const TTS_KEY = 'servari-tts';
const MAX_TTS_CHARS = 600;

// ---------------------------------------------------------------------------
// VAD (voice activity detection) tuning — the calibration knobs.
//
// These thresholds are the ONLY numbers a human voice can truly calibrate.
// the first real conversation IS the calibration test. If speech
// is cut off too early -> raise VAD_SILENCE_MS or lower VAD_SILENCE_LEVEL.
// If it never auto-sends -> lower VAD_SILENCE_MS or raise VAD_SILENCE_LEVEL.
// If it sends on background noise -> raise VAD_SPEECH_LEVEL.
// ---------------------------------------------------------------------------

/** Amplitude (0..1) above which we consider the user to be actively speaking.
 * lowered 0.08 -> 0.035. the user's mic never crossed 0.08 so
 * the VAD never locked speech and nothing ever sent — silently. */
const VAD_SPEECH_LEVEL = 0.035;
/** Continuous ms above VAD_SPEECH_LEVEL before we confirm "speech has started". */
const VAD_SPEECH_MS = 300;
/** Amplitude (0..1) below which we consider the user silent.
 * lowered 0.05 -> 0.025 to match the lowered speech level. */
const VAD_SILENCE_LEVEL = 0.025;
/** Continuous ms of silence (after speech started) that ENDS the utterance. */
const VAD_SILENCE_MS = 1400;
/** Recycle the recorder this often while idle so blobs stay small. */
const VAD_RECYCLE_MS = 20000;

// ---------------------------------------------------------------------------
// PRIVACY GUARD — added after the room-capture incident.
// The open mic recorded 50s of private nearby conversation not directed at
// SERVARI. What people say near the machine that is not directed at SERVARI is
// never recorded. These limits are simple + fail-safe.
// ---------------------------------------------------------------------------

/** Hard cap on a single recording window's SPEECH span.
 * raised 30000 -> 120000. The original 30s cap
 * was a privacy guard against room capture; users now use voice for
 * extended dictation (architecture discussions, multi-step instructions). 120s
 * (2 minutes) is the new ceiling — still a hard cap above the VAD silence-end,
 * still a room-capture defence at scale, and long enough for real dictation. */
const MAX_UTTERANCE_MS = 120000;
/** After this many CONSECUTIVE blank/noise transcriptions (nothing actually
 * sent to SERVARI), the mic is hearing a room, not a conversation — autoclose. */
const ROOM_NOISE_BLANK_LIMIT = 3;
/** If the conversation runs this long with NOTHING ever sent to SERVARI, it is
 * an idle open mic in a room — autoclose. */
const ROOM_IDLE_MAX_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// STREAMING INTERIM TRANSCRIPTION.
//
// While the user is actively speaking, every INTERIM_INTERVAL_MS we
// take a snapshot of the audio so far (requestData flushes buffered chunks),
// POST it to /api/voice-transcribe?partial=1 (skips correction map for speed),
// and surface the result via opts.onInterim. The final authoritative
// transcription on utterance-end still goes through the full correction path.
//
// Debounce guarantee: a second partial request never fires while one is in
// flight (interimPending). The timer arms only when speech is LOCKED (after
// VAD_SPEECH_MS of continuous above-threshold amplitude) and disarms when the
// utterance ends.
// ---------------------------------------------------------------------------

/** How often to slice and POST interim audio while speech is active. */
const INTERIM_INTERVAL_MS = 4000;

// ---------------------------------------------------------------------------
// INSTANT ACK.
//
// When an utterance ends and the transcribed text is non-blank, immediately
// speak a SHORT canned acknowledgment phrase BEFORE the SERVARI reply arrives.
// This fills the silent gap between "user finishes talking" and "SERVARI starts
// replying" — the gap that makes voice feel slow.
//
// Rotation is deterministic by turn count (not random) so it's predictable.
// The real reply follows via conversationSpeak() as normal and also speaks.
// ---------------------------------------------------------------------------

const ACK_PHRASES = ['On it.', 'Heard.', 'One moment.'] as const;
let _ackTurnCount = 0;

/** Return the next canned ACK phrase (deterministic rotation). */
function nextAck(): string {
  const phrase = ACK_PHRASES[_ackTurnCount % ACK_PHRASES.length];
  _ackTurnCount += 1;
  return phrase;
}

// ---------------------------------------------------------------------------
// GLOBAL ECHO SUPPRESSION (the critical fix).
//
// When SERVARI's TTS reply plays through the user's speakers, his mic
// records SERVARI's own words and they get sent back as his next message
// (the proven echo loop — turn 14 was SERVARI's guidance message echoed back).
//
// The cure is a single source of truth: ttsSpeaking. It is set true the moment
// ANY utterance starts and cleared on end/error/cancel. While it is true:
//  - the classic MediaRecorder is PAUSED (or stopped + its segment discarded);
//  - the VAD/amplitude is forbidden from locking "speech" on speaker bleed;
//  - any recorded window whose time-span overlaps a TTS window by > 40% is
//    dropped ('echo_dropped') instead of transcribed.
// ---------------------------------------------------------------------------

/** True while TTS is actively speaking. Module-level — every recording path
 * reads it so the mic goes DEAF in ALL modes during a spoken reply. */
let ttsSpeaking = false;
/** ms timestamp when the current/last TTS utterance started (0 = none). */
let ttsLastSpokeFrom = 0;
/** ms timestamp until which TTS audio may still be bleeding into the mic.
 * Set on every TTS end so a window that started during speech is still
 * recognised as echo even after onend fires. */
let ttsLastSpokeUntil = 0;
/** Fraction of a recorded window that may overlap a TTS window before the
 * window is dropped as echo. */
const ECHO_OVERLAP_FRACTION = 0.4;
/** Grace ms added after TTS onend during which the speaker may still bleed. */
const ECHO_TAIL_MS = 600;

/** Mark TTS as started: set the flag + start-timestamp, and PAUSE/DEAFEN any
 * live classic recorder so it does not capture the spoken reply. */
function markTtsStart(): void {
  ttsSpeaking = true;
  ttsLastSpokeFrom = Date.now();
  ttsLastSpokeUntil = 0; // not ended yet
  pauseClassicForTts();
}

/** Mark TTS as ended/cancelled: clear the flag, stamp the bleed window, and
 * RESUME the classic recorder cleanly. Idempotent. */
function markTtsEnd(): void {
  if (!ttsSpeaking && ttsLastSpokeUntil !== 0) return; // already ended
  ttsSpeaking = false;
  ttsLastSpokeUntil = Date.now() + ECHO_TAIL_MS;
  resumeClassicAfterTts();
}

/** Did a recorded window [startMs, endMs] overlap the last TTS window by more
 * than ECHO_OVERLAP_FRACTION? If so it is SERVARI's own voice — drop it. */
function windowOverlapsTts(startMs: number, endMs: number): boolean {
  if (startMs <= 0 || endMs <= startMs) return false;
  // TTS window = [ttsLastSpokeFrom .. (ttsLastSpokeUntil || now-if-still-speaking)].
  const ttsFrom = ttsLastSpokeFrom;
  if (ttsFrom <= 0) return false;
  const ttsUntil = ttsSpeaking ? Date.now() : ttsLastSpokeUntil;
  if (ttsUntil <= ttsFrom) return false;
  const overlap = Math.min(endMs, ttsUntil) - Math.max(startMs, ttsFrom);
  if (overlap <= 0) return false;
  const windowLen = endMs - startMs;
  return overlap / windowLen >= ECHO_OVERLAP_FRACTION;
}

/** Minimum blob size to bother POSTing to the transcriber. Empty/near-empty
 * recordings (the 110-byte failures in the live log) are skipped. */
const MIN_BLOB_BYTES = 2000;

/** Track when the classic recorder was paused for TTS so we can resume it. */
let classicPausedForTts = false;

/** PAUSE (or stop+discard) the classic-listen / push-to-talk recorder while TTS
 * speaks, so SERVARI's reply never gets captured. */
function pauseClassicForTts(): void {
  if (!mediaRecorder) return;
  try {
    if (mediaRecorder.state === 'recording') {
      if (typeof mediaRecorder.pause === 'function') {
        mediaRecorder.pause();
        classicPausedForTts = true;
        debug('mic_paused_for_tts', { mode: 'classic', method: 'pause' });
      } else {
        // pause() unavailable — stop + DISCARD this segment, restart after TTS.
        classicPausedForTts = true;
        recordedChunks = []; // discard whatever was captured up to now
        if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        debug('mic_paused_for_tts', { mode: 'classic', method: 'stop-discard' });
      }
    }
  } catch {
    /* never let echo-suppression break the loop */
  }
}

/** RESUME the classic recorder after TTS ends. If it was paused, resume; if it
 * was stopped (no pause support), start a fresh clean recording. */
function resumeClassicAfterTts(): void {
  if (!classicPausedForTts) return;
  classicPausedForTts = false;
  if (!listening || !usingWhisperFallback) return;
  try {
    if (mediaRecorder && mediaRecorder.state === 'paused' && typeof mediaRecorder.resume === 'function') {
      mediaRecorder.resume();
      debug('mic_resumed_after_tts', { mode: 'classic', method: 'resume' });
      return;
    }
  } catch {
    /* fall through to a clean restart */
  }
  // No live paused recorder — restart cleanly so the next utterance is fresh.
  if (listening && usingWhisperFallback && classicListenOpts) {
    void startWhisperFallback(classicListenOpts);
    debug('mic_resumed_after_tts', { mode: 'classic', method: 'restart' });
  }
}

/** The last ListenOptions used by the classic whisper path — kept so the
 * recorder can be restarted cleanly after a no-pause TTS stop. */
let classicListenOpts: ListenOptions | null = null;

// ---------------------------------------------------------------------------
// Debug sink. Voice fails SILENTLY in the Electron exe; this POSTs
// one JSON event per moment to the server's /api/voice-debug sink so SERVARI can
// SEE what happened (getUserMedia / VAD / amplitude / transcribe / TTS / stop).
// Fire-and-forget — it NEVER throws and NEVER blocks the voice loop.
// ---------------------------------------------------------------------------

function debug(event: string, detail?: unknown): void {
  try {
    const body = JSON.stringify({
      event,
      detail: detail ?? null,
      ts: new Date().toISOString(),
    });
    // keepalive lets the beacon survive a page/exe teardown (e.g. on stop).
    void fetch('/api/voice-debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      /* sink unreachable — never let logging break voice */
    });
  } catch {
    /* serialization failure — swallow */
  }
}

// Amplitude-window stat: while listening, accumulate max+avg and flush once per
// ~5s via debug('amplitude_stat', {max, avg, samples}) so we can SEE if the mic
// hears anything at all (silent mic / wrong input device = max stays ~0).
let ampStatMax = 0;
let ampStatSum = 0;
let ampStatCount = 0;
let ampStatLastFlush = 0;

function recordAmplitude(level: number): void {
  if (level > ampStatMax) ampStatMax = level;
  ampStatSum += level;
  ampStatCount += 1;
  const now = Date.now();
  if (ampStatLastFlush === 0) ampStatLastFlush = now;
  if (now - ampStatLastFlush >= 5000) {
    debug('amplitude_stat', {
      max: Number(ampStatMax.toFixed(4)),
      avg: Number((ampStatCount ? ampStatSum / ampStatCount : 0).toFixed(4)),
      samples: ampStatCount,
    });
    ampStatMax = 0;
    ampStatSum = 0;
    ampStatCount = 0;
    ampStatLastFlush = now;
  }
}

function resetAmplitudeStat(): void {
  ampStatMax = 0;
  ampStatSum = 0;
  ampStatCount = 0;
  ampStatLastFlush = 0;
}

// ---------------------------------------------------------------------------
// State-change subscription. TopBar's voice pill must reflect the
// REAL voice state. Voice owns the truth; listeners get notified on every change
// to listening / inConversation / conversationState. getState() is the snapshot.
// ---------------------------------------------------------------------------

export interface VoiceStateSnapshot {
  listening: boolean;
  inConversation: boolean;
  conversationState: ConversationState;
  sttAvailable: boolean;
}

type VoiceStateListener = (s: VoiceStateSnapshot) => void;
const stateListeners = new Set<VoiceStateListener>();

function voiceStateSnapshot(): VoiceStateSnapshot {
  return {
    listening,
    inConversation: conversing,
    conversationState: convState,
    sttAvailable: whisperReady !== false || getRecognitionCtor() !== null,
  };
}

function emitVoiceState(): void {
  const snap = voiceStateSnapshot();
  for (const fn of stateListeners) {
    try {
      fn(snap);
    } catch {
      /* a bad listener must not break the loop */
    }
  }
}

// ---------------------------------------------------------------------------
// Internal state.
// ---------------------------------------------------------------------------

let recognition: SpeechRecognitionLike | null = null;
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: BlobPart[] = [];
let mediaStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let amplitudeRAF: number | null = null;
let listening = false;
let usingWhisperFallback = false;
let cachedVoices: SpeechSynthesisVoice[] = [];
// ms timestamp the current classic-listen recording window started (echo check).
let classicWindowStartedAt = 0;

// --- conversation-mode state ---
let conversing = false;
let convOpts: ConversationOptions | null = null;
let convState: ConversationState = 'idle';
// VAD bookkeeping for the current recording window.
let convSpeechStartedAt = 0; // ms timestamp when amplitude first crossed the speech level
let convSpeechLockedAt = 0; // ms timestamp when we confirmed speech (held > VAD_SPEECH_MS)
let convSpeaking = false; // has the user actually started talking this window?
let convSilenceStartedAt = 0; // ms timestamp when amplitude dropped below silence level
let convRecorder: MediaRecorder | null = null;
let convChunks: BlobPart[] = [];
// ms timestamp the current conversation recording window started (echo check).
let convWindowStartedAt = 0;
let convVadRAF: number | null = null;
let convRecycleTimer: ReturnType<typeof setTimeout> | null = null;
let convStopReason: 'vad' | 'recycle' | 'leave' = 'vad';
// PRIVACY GUARD (B5) bookkeeping.
let convStartedAt = 0; // ms the conversation began (room-idle timeout base)
let convLastSentAt = 0; // ms a REAL utterance last went to SERVARI (0 = none yet)
let convConsecutiveBlanks = 0; // consecutive blank/noise transcriptions (room noise)
// Whether the local whisper backend is ready (probed from /api/voice-config at init).
// null = not yet probed; the local backend is the PRIMARY engine.
let whisperReady: boolean | null = null;

// ---------------------------------------------------------------------------
// STREAMING INTERIM state.
// Managed per conversation window; cleared on every convStartWindow().
// ---------------------------------------------------------------------------

/** The snapshot of convChunks length at the last interim slice. Used to know
 * how many chunks are NEW since the last partial POST. */
let interimLastChunkCount = 0;
/** True while a partial transcription POST is in flight. Prevents overlap. */
let interimPending = false;
/** The setInterval handle for the 4s interim tick. */
let interimTimer: ReturnType<typeof setInterval> | null = null;

/** Arm the interim timer. Called when VAD locks speech (convSpeaking goes true). */
function startInterimTimer(lang: string): void {
  if (interimTimer !== null) return; // already armed
  interimTimer = setInterval(() => {
    void fireInterim(lang);
  }, INTERIM_INTERVAL_MS);
}

/** Disarm the interim timer and reset slice bookkeeping. */
function stopInterimTimer(): void {
  if (interimTimer !== null) {
    clearInterval(interimTimer);
    interimTimer = null;
  }
  interimLastChunkCount = 0;
  interimPending = false;
}

/** Slice the chunks accumulated SINCE the last interim, POST to
 * /api/voice-transcribe?partial=1, surface via opts.onInterim.
 * Fire-and-forget with the pending guard. */
async function fireInterim(lang: string): Promise<void> {
  if (interimPending) return; // previous request still in flight
  if (!conversing || !convOpts?.onInterim) return;
  // Only new chunks since the last slice.
  const newChunks = convChunks.slice(interimLastChunkCount);
  if (newChunks.length === 0) return;
  interimLastChunkCount = convChunks.length;
  const blob = new Blob(newChunks, { type: convRecorder?.mimeType || 'audio/webm' });
  if (blob.size < MIN_BLOB_BYTES) return; // too small to be meaningful
  interimPending = true;
  debug('interim_request', { blob_bytes: blob.size, lang });
  try {
    // POST with ?partial=1 — the server skips the brand-word correction map for speed.
    const res = await fetch(`/api/voice-transcribe?language=${encodeURIComponent(lang)}&partial=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    const data = (await res.json()) as { ok?: boolean; text?: string };
    if (data.ok && data.text && data.text.trim()) {
      debug('interim_response', { text_len: data.text.length });
      convOpts?.onInterim?.(data.text.trim());
    }
  } catch (err) {
    debug('interim_failed', String(err));
    // never let interim errors break the main loop
  } finally {
    interimPending = false;
  }
}

// ---------------------------------------------------------------------------
// Amplitude metering (shared by both STT paths — it only needs the mic stream).
// ---------------------------------------------------------------------------

async function startAmplitude(onAmplitude?: (level: number) => void): Promise<void> {
  if (!onAmplitude || typeof navigator === 'undefined' || !navigator.mediaDevices) {
    return;
  }
  try {
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const Ctx =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    const source = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!analyser) return;
      analyser.getByteTimeDomainData(data);
      // RMS of the waveform deviation from the 128 midpoint -> 0..1.
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, rms * 3); // scale up — speech RMS is small
      onAmplitude(level);
      recordAmplitude(level);
      amplitudeRAF = requestAnimationFrame(tick);
    };
    amplitudeRAF = requestAnimationFrame(tick);
  } catch (err) {
    // Mic permission denied or AudioContext unavailable — log it (was SILENT before).
    const name = (err as DOMException)?.name || 'AmplitudeError';
    debug('amplitude_failed', { name, message: String(err) });
  }
}

function stopAmplitude(): void {
  if (amplitudeRAF !== null) {
    cancelAnimationFrame(amplitudeRAF);
    amplitudeRAF = null;
  }
  if (analyser) {
    try {
      analyser.disconnect();
    } catch {
      /* ignore */
    }
    analyser = null;
  }
  if (audioCtx) {
    try {
      void audioCtx.close();
    } catch {
      /* ignore */
    }
    audioCtx = null;
  }
}

function releaseStream(): void {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    mediaStream = null;
  }
}

// ---------------------------------------------------------------------------
// MediaRecorder -> faster-whisper fallback.
// ---------------------------------------------------------------------------

async function startWhisperFallback(opts: ListenOptions): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    opts.onError?.('no_media_devices');
    listening = false;
    return;
  }
  try {
    if (!mediaStream) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        debug('getusermedia_ok', { path: 'classic-whisper' });
      } catch (err) {
        const name = (err as DOMException)?.name || 'GetUserMediaError';
        const message = (err as DOMException)?.message || String(err);
        debug('getusermedia_failed', { name, message, path: 'classic-whisper' });
        opts.onError?.(name);
        listening = false;
        emitVoiceState();
        return;
      }
    }
    classicListenOpts = opts;
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    // window-start timestamp so we can detect TTS overlap (echo) on stop.
    classicWindowStartedAt = Date.now();
    mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      const windowStart = classicWindowStartedAt;
      const windowEnd = Date.now();
      const blob = new Blob(recordedChunks, {
        type: mediaRecorder?.mimeType || 'audio/webm',
      });
      recordedChunks = [];
      if (blob.size === 0) return;
      // FIX 1 (belt + braces): if this window overlapped a TTS window by >40%,
      // it is SERVARI's own spoken reply bleeding into the mic — drop it.
      if (windowOverlapsTts(windowStart, windowEnd)) {
        debug('echo_dropped', { blob_bytes: blob.size, path: 'classic-whisper' });
        return;
      }
      // FIX 2: never POST a near-empty blob (the 110-byte empty-recording fails).
      if (blob.size < MIN_BLOB_BYTES) {
        debug('blob_too_small_skipped', { blob_bytes: blob.size, path: 'classic-whisper' });
        return;
      }
      try {
        const lang = (opts.lang || 'en-US').split('-')[0] || 'en';
        debug('transcribe_request', { blob_bytes: blob.size, lang, path: 'classic-whisper' });
        const res = await API.voiceTranscribe(blob, lang);
        if (res.ok && res.text) {
          debug('transcribe_response', { ok: true, text_len: res.text.length });
          opts.onFinal?.(res.text);
        } else if (res.error) {
          debug('transcribe_error', { ok: res.ok, error: res.error });
          opts.onError?.(res.error);
        }
      } catch (err) {
        debug('transcribe_request_failed', String(err));
        opts.onError?.('transcribe_request_failed');
      }
    };
    mediaRecorder.start();
    debug('recorder_start', { mimeType: mediaRecorder.mimeType || 'audio/webm', path: 'classic-whisper' });
  } catch (err) {
    const name = (err as DOMException)?.name || 'WhisperFallbackError';
    debug('whisper_fallback_failed', { name, message: String(err) });
    opts.onError?.(name === 'WhisperFallbackError' ? 'mic_permission_denied' : name);
    listening = false;
    emitVoiceState();
  }
}

// ---------------------------------------------------------------------------
// webkitSpeechRecognition path.
// ---------------------------------------------------------------------------

function startWebSpeech(Ctor: SpeechRecognitionCtor, opts: ListenOptions): void {
  recognition = new Ctor();
  recognition.lang = opts.lang || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (e: SpeechRecognitionEventLike) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const transcript = result[0]?.transcript || '';
      if (result.isFinal) {
        opts.onFinal?.(transcript.trim());
      } else {
        interim += transcript;
      }
    }
    if (interim) opts.onInterim?.(interim.trim());
  };
  recognition.onerror = (e: { error?: string }) => {
    opts.onError?.(e.error || 'speech_error');
  };
  recognition.onend = () => {
    // continuous mode can end on silence; only mark stopped if we asked to.
    if (!listening) return;
    try {
      recognition?.start();
    } catch {
      listening = false;
    }
  };
  recognition.start();
}

// ---------------------------------------------------------------------------
// Conversation mode — hands-free VAD loop.
//
// Lifecycle per turn:
//  listening  -> (VAD detects end of utterance) -> transcribing
//  transcribing -> onUserSaid(text); caller sends to SERVARI + later calls
//                  conversationSpeak(reply)
//  speaking   -> (TTS onend) -> listening again   [loop]
//
// Blank/noise transcriptions never leave the listening state — we silently
// resume so the user can just keep talking.
// ---------------------------------------------------------------------------

function setConvState(s: ConversationState): void {
  if (convState === s) return;
  convState = s;
  convOpts?.onStateChange?.(s);
  emitVoiceState();
}

/** True for transcriptions that are empty / pure punctuation / known whisper
 * noise tokens (whisper emits 'you', 'thanks for watching', '.', etc. on
 * silence). These must NOT be sent — we silently resume listening. */
function isBlankTranscript(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t) return true;
  // strip surrounding punctuation/whitespace to test the core token
  const core = t.replace(/[\s.,!?;:"'`~\-_]+/g, ' ').trim();
  if (!core) return true;
  // single-word whisper hallucinations on near-silence
  const NOISE = new Set([
    'you',
    'thank you',
    'thanks',
    'thanks for watching',
    'bye',
    'okay',
    'ok',
    'uh',
    'um',
    'hmm',
    'mm',
    'mmm',
    'yeah',
  ]);
  if (NOISE.has(core)) return true;
  return false;
}

function clearConvTimers(): void {
  if (convVadRAF !== null) {
    cancelAnimationFrame(convVadRAF);
    convVadRAF = null;
  }
  if (convRecycleTimer !== null) {
    clearTimeout(convRecycleTimer);
    convRecycleTimer = null;
  }
}

/** Start one recording window: fresh MediaRecorder + VAD watcher + recycle timer. */
async function convStartWindow(): Promise<void> {
  if (!conversing) return;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    convOpts?.onError?.('no_media_devices');
    return;
  }
  // Reset interim state for this new window.
  stopInterimTimer();
  try {
    if (!mediaStream) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        debug('getusermedia_ok');
      } catch (err) {
        // getUserMedia rejection is the #1 SILENT failure. Surface the DOMException
        // name (NotAllowedError / NotFoundError / NotReadableError) so the UI can
        // show the user EXACTLY what is wrong.
        const name = (err as DOMException)?.name || 'GetUserMediaError';
        const message = (err as DOMException)?.message || String(err);
        debug('getusermedia_failed', { name, message });
        convOpts?.onError?.(name);
        await Voice.stopConversation();
        return;
      }
    }
    // Amplitude analyser drives BOTH the visual waveform and the VAD. Reuse the
    // shared AnalyserNode set up by startAmplitude; ensure it exists.
    if (!analyser) {
      await startConvAmplitude();
    }

    convChunks = [];
    convRecorder = new MediaRecorder(mediaStream);
    convRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) convChunks.push(e.data);
    };
    convRecorder.onstop = () => {
      // Disarm the interim timer — the window is done.
      stopInterimTimer();
      const reason = convStopReason;
      const blob = new Blob(convChunks, {
        type: convRecorder?.mimeType || 'audio/webm',
      });
      convChunks = [];
      convRecorder = null;

      if (reason === 'leave' || !conversing) {
        return; // exiting — drop the blob
      }
      if (reason === 'recycle') {
        // No speech this window; just start a fresh window, stay listening.
        if (!convSpeaking) {
          void convStartWindow();
          return;
        }
        // Speech was mid-flight when recycle fired — treat like a VAD end.
      }
      // VAD end (or recycle-with-speech): transcribe this window.
      void convTranscribeAndAdvance(blob);
    };

    // reset VAD bookkeeping for this window
    convSpeaking = false;
    convSpeechStartedAt = 0;
    convSpeechLockedAt = 0;
    convSilenceStartedAt = 0;
    convStopReason = 'vad';

    convRecorder.start();
    convWindowStartedAt = Date.now();
    debug('recorder_start', { mimeType: convRecorder.mimeType || 'audio/webm' });
    setConvState('listening');
    startConvVad();

    // Recycle timer keeps blobs small during long silences.
    convRecycleTimer = setTimeout(() => {
      if (!conversing) return;
      // Only recycle when we are NOT mid-utterance; if speaking, let VAD finish.
      if (!convSpeaking && convRecorder && convRecorder.state !== 'inactive') {
        convStopReason = 'recycle';
        try {
          convRecorder.stop();
        } catch {
          /* ignore */
        }
      }
    }, VAD_RECYCLE_MS);
  } catch (err) {
    const name = (err as DOMException)?.name || 'ConvWindowError';
    debug('conv_window_failed', { name, message: String(err) });
    convOpts?.onError?.(name === 'ConvWindowError' ? 'mic_permission_denied' : name);
    void Voice.stopConversation();
  }
}

/** Ensure the shared AnalyserNode exists for VAD (mirrors startAmplitude but
 * does not require an onAmplitude callback). */
async function startConvAmplitude(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
  try {
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const Ctx =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    const source = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
  } catch {
    /* metering unavailable — VAD will see 0 amplitude and never auto-send */
  }
}

/** The VAD frame loop: reads amplitude, forwards to onAmplitude, and decides
 * when the user's utterance has ended (auto-stop the recorder). */
function startConvVad(): void {
  if (!analyser) return;
  // never stack RAF loops — cancel any prior one first
  if (convVadRAF !== null) {
    cancelAnimationFrame(convVadRAF);
    convVadRAF = null;
  }
  const data = new Uint8Array(analyser.frequencyBinCount);
  // Capture the lang at VAD-arm time for the interim timer.
  const interimLang = ((convOpts?.lang || 'en-US').split('-')[0] || 'en');

  const tick = () => {
    if (!conversing || !analyser) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 3);
    convOpts?.onAmplitude?.(level);
    // Accumulate the once-per-5s amplitude stat so SERVARI can SEE whether the
    // mic hears anything (silent mic / wrong input device => max stays ~0).
    recordAmplitude(level);

    // FIX 1: while TTS is speaking (or in the bleed-tail just after), the
    // amplitude the mic hears is SERVARI's own reply through the speakers.
    // Do NOT let the VAD treat speaker bleed as speech — hold state, skip.
    if (ttsSpeaking || Date.now() < ttsLastSpokeUntil) {
      convVadRAF = requestAnimationFrame(tick);
      return;
    }

    // Only run VAD while we're in the listening state with a live recorder.
    if (convState === 'listening' && convRecorder && convRecorder.state === 'recording') {
      const now = Date.now();
      // PRIVACY GUARD (B5): hard cap on a single utterance. A 50s "utterance" is
      // a room, not a command — once speech has been flowing for MAX_UTTERANCE_MS
      // straight, cut + transcribe what we have (treat like a VAD end), then the
      // loop resumes a fresh window.
      if (convSpeaking && convSpeechLockedAt && now - convSpeechLockedAt >= MAX_UTTERANCE_MS) {
        convStopReason = 'vad';
        debug('utterance_end', {
          trigger: 'max_utterance_cap',
          duration_ms: now - convSpeechLockedAt,
          cap_ms: MAX_UTTERANCE_MS,
        });
        try {
          convRecorder.stop();
        } catch {
          /* ignore */
        }
        if (convVadRAF !== null) {
          cancelAnimationFrame(convVadRAF);
          convVadRAF = null;
        }
        return;
      }
      if (level >= VAD_SPEECH_LEVEL) {
        // above speech threshold
        if (convSpeechStartedAt === 0) convSpeechStartedAt = now;
        convSilenceStartedAt = 0;
        if (!convSpeaking && now - convSpeechStartedAt >= VAD_SPEECH_MS) {
          convSpeaking = true;
          convSpeechLockedAt = now;
          debug('speech_detected', { level: Number(level.toFixed(4)), threshold: VAD_SPEECH_LEVEL });
          // arm the interim timer now that speech is confirmed.
          startInterimTimer(interimLang);
        }
      } else if (level <= VAD_SILENCE_LEVEL) {
        // below silence threshold
        convSpeechStartedAt = 0;
        if (convSpeaking) {
          if (convSilenceStartedAt === 0) convSilenceStartedAt = now;
          if (now - convSilenceStartedAt >= VAD_SILENCE_MS) {
            // utterance ended — auto-stop and transcribe
            convStopReason = 'vad';
            debug('utterance_end', {
              trigger: 'vad',
              duration_ms: convSpeechLockedAt ? now - convSpeechLockedAt : null,
            });
            try {
              convRecorder.stop();
            } catch {
              /* ignore */
            }
            // stop ticking until the next window starts
            if (convVadRAF !== null) {
              cancelAnimationFrame(convVadRAF);
              convVadRAF = null;
            }
            return;
          }
        }
      } else {
        // in the hysteresis band between silence and speech levels: hold state,
        // but don't accumulate silence (prevents premature cut on soft speech).
        convSilenceStartedAt = 0;
      }
    }
    convVadRAF = requestAnimationFrame(tick);
  };
  convVadRAF = requestAnimationFrame(tick);
}

/** PRIVACY GUARD (B5): decide whether the open mic is hearing a ROOM rather than
 * a conversation, and if so autoclose. Two fail-safe triggers:
 * 1. ROOM_NOISE_BLANK_LIMIT consecutive blank/noise transcriptions, OR
 * 2. the conversation has run ROOM_IDLE_MAX_MS with NOTHING ever sent.
 * Returns true if it triggered an autoclose (caller must NOT resume listening).
 * Fail-safe: any reason to close errs toward closing the mic. */
function privacyShouldAutoclose(): boolean {
  if (!conversing) return false;
  const now = Date.now();
  const blanksHit = convConsecutiveBlanks >= ROOM_NOISE_BLANK_LIMIT;
  // room-idle: nothing ever sent AND we've been open past the idle ceiling.
  const idleHit = convLastSentAt === 0 && convStartedAt > 0 && now - convStartedAt >= ROOM_IDLE_MAX_MS;
  if (!blanksHit && !idleHit) return false;
  debug('privacy_autoclose', {
    reason: blanksHit ? 'consecutive_blank_noise' : 'room_idle_timeout',
    consecutive_blanks: convConsecutiveBlanks,
    open_ms: convStartedAt > 0 ? now - convStartedAt : 0,
    ever_sent: convLastSentAt !== 0,
  });
  void Voice.stopConversation();
  return true;
}

/** Transcribe a recorded window; on a real utterance fire onUserSaid; on blank
 * silently resume listening. */
async function convTranscribeAndAdvance(blob: Blob): Promise<void> {
  if (convRecycleTimer !== null) {
    clearTimeout(convRecycleTimer);
    convRecycleTimer = null;
  }
  if (!conversing) return;
  if (blob.size === 0) {
    void convStartWindow();
    return;
  }
  // FIX 1 (belt + braces): drop a window that overlapped a TTS window by >40%
  // — it is SERVARI's own spoken reply, not the user. Resume listening.
  const windowStart = convWindowStartedAt;
  const windowEnd = Date.now();
  if (windowOverlapsTts(windowStart, windowEnd)) {
    debug('echo_dropped', { blob_bytes: blob.size, path: 'conversation' });
    void convStartWindow();
    return;
  }
  // FIX 2: skip near-empty blobs (the 110-byte empty-recording failures).
  if (blob.size < MIN_BLOB_BYTES) {
    debug('blob_too_small_skipped', { blob_bytes: blob.size, path: 'conversation' });
    void convStartWindow();
    return;
  }
  setConvState('transcribing');
  try {
    const lang = (convOpts?.lang || 'en-US').split('-')[0] || 'en';
    debug('transcribe_request', { blob_bytes: blob.size, lang });
    const res = await API.voiceTranscribe(blob, lang);
    if (!conversing) return;
    if (!res.ok || res.error) {
      debug('transcribe_error', { ok: res.ok, error: res.error || 'unknown' });
      convOpts?.onError?.(res.error || 'transcribe_failed');
      // resilient: keep the conversation alive, resume listening
      void convStartWindow();
      return;
    }
    const text = (res.text ? res.text : '').trim();
    debug('transcribe_response', { ok: true, text_len: text.length, blank: isBlankTranscript(text) });
    if (isBlankTranscript(text)) {
      // nothing meaningful — resume listening without sending.
      // PRIVACY GUARD (B5): count consecutive blanks. Past the limit the mic is
      // hearing a room, not a conversation — autoclose instead of resuming.
      convConsecutiveBlanks += 1;
      if (privacyShouldAutoclose()) return;
      void convStartWindow();
      return;
    }
    // A real utterance — reset the room-noise counter + stamp the last-sent time.
    convConsecutiveBlanks = 0;
    convLastSentAt = Date.now();
    // fire an instant ACK so the user never
    // waits in silence between finishing speaking and SERVARI starting to reply.
    // The real reply follows via conversationSpeak() and also speaks. The ACK is
    // short (1-3 words) so it finishes before the real reply arrives.
    if (Voice.ttsEnabled) {
      const ack = nextAck();
      debug('instant_ack', { phrase: ack });
      // Fire-and-forget — do NOT await, do NOT let it delay onUserSaid.
      void speakNeural(ack);
    }
    convOpts?.onUserSaid?.(text);
    // We now WAIT: the caller sends to SERVARI and calls conversationSpeak()
    // with the reply, which will resume listening via the TTS onend hook. To
    // avoid deadlock if the reply never speaks, we do NOT auto-resume here —
    // the caller owns the next step. (conversationSpeak resumes; if TTS is off
    // the caller's reply path still calls conversationSpeak, which resumes
    // immediately because it falls through to onComplete.)
  } catch (err) {
    if (!conversing) return;
    debug('transcribe_request_failed', String(err));
    convOpts?.onError?.('transcribe_request_failed');
    // resilient: keep the conversation alive, resume listening
    void convStartWindow();
  }
}

// ---------------------------------------------------------------------------
// TTS helpers.
// ---------------------------------------------------------------------------

function loadVoices(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  cachedVoices = window.speechSynthesis.getVoices();
}

function stripForSpeech(text: string): string {
  let t = text;
  // fenced code blocks
  t = t.replace(/```[\s\S]*?```/g, ' ');
  // inline code
  t = t.replace(/`[^`]*`/g, ' ');
  // images / links -> keep the visible label
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // headings / blockquotes / list bullets at line starts
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  // emphasis / bold markers
  t = t.replace(/(\*\*|__|\*|_|~~)/g, '');
  // collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TTS_CHARS) t = t.slice(0, MAX_TTS_CHARS).trim();
  return t;
}

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoices.length === 0) loadVoices();
  if (cachedVoices.length === 0) return null;
  // Preference order: Microsoft David -> any English male -> any English -> first.
  const byName = cachedVoices.find((v) => /david/i.test(v.name));
  if (byName) return byName;
  const enVoice = cachedVoices.find((v) => /^en[-_]/i.test(v.lang));
  if (enVoice) return enVoice;
  return cachedVoices[0] || null;
}

// ---------------------------------------------------------------------------
// Public Voice surface.
// ---------------------------------------------------------------------------

export const Voice = {
  /** True when ANY STT engine is usable: the local whisper backend (primary) OR
   * browser-native SpeechRecognition (fallback). */
  get sttAvailable(): boolean {
    return whisperReady !== false || getRecognitionCtor() !== null;
  },

  /** True only when STT is TRULY unavailable: whisper probed false AND no browser
   * SpeechRecognition. The TopBar mic-OFF icon should show ONLY when this is true. */
  get sttUnavailable(): boolean {
    return whisperReady === false && getRecognitionCtor() === null;
  },

  /** A snapshot of the live voice state (for TopBar's pill / any poller). */
  getState(): VoiceStateSnapshot {
    return voiceStateSnapshot();
  },

  /** Subscribe to voice-state changes (listening / inConversation / convState /
   * sttAvailable). Returns an unsubscribe fn. Fires immediately with the current
   * snapshot so a fresh subscriber renders correctly. */
  onStateChange(fn: (s: VoiceStateSnapshot) => void): () => void {
    stateListeners.add(fn);
    try {
      fn(voiceStateSnapshot());
    } catch {
      /* ignore a throwing subscriber on first call */
    }
    return () => {
      stateListeners.delete(fn);
    };
  },

  /** TTS on/off, persisted in localStorage ('servari-tts'), default true. */
  get ttsEnabled(): boolean {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem(TTS_KEY) !== '0';
  },
  set ttsEnabled(on: boolean) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(TTS_KEY, on ? '1' : '0');
    if (!on) Voice.cancelSpeech();
  },

  /** Whether STT is currently active. */
  get isListening(): boolean {
    return listening;
  },

  /**
   * Warm up the voice surface: pre-load the synth voice list (Chrome populates
   * getVoices() asynchronously). Safe to call repeatedly. No-op server-side.
   */
  init(): void {
    if (typeof window === 'undefined') return;
    // Probe the local whisper backend (the PRIMARY STT engine). Non-blocking.
    fetch('/api/voice-config')
      .then((r) => r.json())
      .then((cfg: { stt_ready?: boolean }) => {
        whisperReady = cfg && cfg.stt_ready === true;
        debug('voice_config', { stt_ready: whisperReady });
        emitVoiceState(); // sttAvailable may have changed once the probe lands
      })
      .catch((e) => {
        whisperReady = false;
        debug('voice_config_error', String(e));
        emitVoiceState();
      });
    if (!window.speechSynthesis) return;
    loadVoices();
    // voices often arrive after a tick — listen for the populate event.
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    } else {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  },

  /**
   * Start listening. Uses webkitSpeechRecognition when present, else falls back
   * to MediaRecorder -> the local whisper backend. Either way, an AnalyserNode
   * reports mic amplitude via onAmplitude for the reactive feather mic.
   */
  async startListening(opts: ListenOptions = {}): Promise<void> {
    if (listening) return;
    listening = true;
    resetAmplitudeStat();
    debug('listen_start', { whisperReady });
    emitVoiceState();
    await startAmplitude(opts.onAmplitude);

    // PRIMARY: the local whisper backend (proven, sovereign, zero-cloud).
    // browser SpeechRecognition (webkitSpeechRecognition)
    // depends on vendor cloud servers and fails SILENTLY when unreachable or
    // unpermissioned — it demoted from primary to fallback-only.
    if (whisperReady !== false) {
      usingWhisperFallback = true;
      await startWhisperFallback(opts);
      return;
    }

    // FALLBACK: browser-native SpeechRecognition (only when whisper is unavailable).
    const Ctor = getRecognitionCtor();
    if (Ctor) {
      usingWhisperFallback = false;
      try {
        startWebSpeech(Ctor, opts);
      } catch (err) {
        debug('speech_start_failed', String(err));
        opts.onError?.('speech_start_failed');
        listening = false;
        stopAmplitude();
        releaseStream();
        emitVoiceState();
      }
    } else {
      debug('no_stt_engine_available');
      opts.onError?.('no_stt_engine_available');
      listening = false;
      stopAmplitude();
      releaseStream();
      emitVoiceState();
    }
  },

  /** Stop listening and release the mic. Flushes a pending whisper transcription. */
  stopListening(): void {
    listening = false;
    debug('listen_stop');
    emitVoiceState();
    if (recognition) {
      try {
        recognition.onend = null;
        recognition.stop();
      } catch {
        /* ignore */
      }
      recognition = null;
    }
    if (usingWhisperFallback && mediaRecorder) {
      try {
        if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      } catch {
        /* ignore */
      }
      mediaRecorder = null;
    }
    stopAmplitude();
    releaseStream();
  },

  // -------------------------------------------------------------------------
  // Conversation mode (hands-free, talk-like-to-Claude).
  // -------------------------------------------------------------------------

  /** True while a hands-free conversation loop is active. */
  get inConversation(): boolean {
    return conversing;
  },

  /** Current conversation state ('idle' when not in a conversation). */
  get conversationState(): ConversationState {
    return convState;
  },

  /**
   * Enter conversation mode: listen continuously with VAD. When the user stops
   * talking (silence > VAD_SILENCE_MS after speech began), the utterance is
   * transcribed via the local whisper backend and delivered via onUserSaid.
   * The caller then sends it to SERVARI and calls conversationSpeak(reply),
   * which speaks the reply and automatically re-arms the mic. Click again to
   * leave (stopConversation).
   *
   * Uses the whisper backend (the sovereign primary). webkitSpeechRecognition
   * is NOT used here — VAD over MediaRecorder is uniform and works in Electron.
   */
  async startConversation(opts: ConversationOptions = {}): Promise<void> {
    if (conversing) return;
    conversing = true;
    convOpts = opts;
    convState = 'idle';
    resetAmplitudeStat();
    // PRIVACY GUARD (B5): start the room-idle clock + reset the noise counters.
    convStartedAt = Date.now();
    convLastSentAt = 0;
    convConsecutiveBlanks = 0;
    // reset the ACK turn count so the first ACK is 'On it.'
    _ackTurnCount = 0;
    debug('conversation_start', { whisperReady, lang: opts.lang || 'en-US' });
    emitVoiceState();
    // Prime the synth voice list so the first reply isn't silent.
    if (cachedVoices.length === 0) loadVoices();
    await convStartWindow();
  },

  /**
   * Speak SERVARI reply, then automatically resume listening IF the
   * conversation is still active. This is the loop's turn-around point. If TTS
   * is off (or unavailable), it still re-arms the mic immediately so the user
   * can keep talking. Safe to call when not in conversation (acts like speak()).
   */
  conversationSpeak(text: string): void {
    if (!conversing) {
      // NEURAL FIRST: the fluid local voice; classic synth as fallback.
      if (Voice.ttsEnabled && (text || '').trim()) {
        void speakNeural(text).then((played) => {
          if (!played) Voice.speak(text);
        });
      } else {
        Voice.speak(text);
      }
      return;
    }
    setConvState('speaking');
    debug('tts_start', { text_len: (text || '').length, ttsEnabled: Voice.ttsEnabled });
    const rearm = () => {
      debug('tts_end');
      // re-arm only if still conversing (user may have left mid-reply)
      if (conversing) {
        void convStartWindow();
      }
    };
    // NEURAL FIRST: piper ryan-high via /api/voice-speak — resolves after
    // playback ends (so the re-arm timing is identical); falls back to the classic synth.
    if (Voice.ttsEnabled && (text || '').trim()) {
      void speakNeural(text).then((played) => {
        if (played) rearm();
        else Voice.speak(text, rearm);
      });
    } else {
      // empty text / TTS off -> the existing immediate re-arm path.
      Voice.speak(text, rearm);
    }
  },

  /**
   * MANUAL FLUSH: the natural instinct when the loop seems stuck is
   * to click the mic — so a single mic click SENDS. This stops the current
   * recording window and transcribes + sends whatever was captured, then the
   * normal loop (onUserSaid -> SERVARI reply -> conversationSpeak) re-arms listening.
   * No-op when not conversing or not currently recording.
   */
  flush(): void {
    if (!conversing) return;
    if (convRecorder && convRecorder.state === 'recording') {
      debug('manual_flush', { speaking: convSpeaking });
      convStopReason = 'vad'; // treat like an utterance end -> transcribe + send
      // stop the VAD RAF so it doesn't double-fire while the recorder flushes
      if (convVadRAF !== null) {
        cancelAnimationFrame(convVadRAF);
        convVadRAF = null;
      }
      try {
        convRecorder.stop();
      } catch {
        /* ignore — onstop still fires the transcribe path */
      }
    } else {
      debug('manual_flush_noop', { recorderState: convRecorder?.state || 'none' });
    }
  },

  /** Leave conversation mode entirely: stop the loop, release the mic, idle. */
  async stopConversation(): Promise<void> {
    if (!conversing) {
      setConvState('idle');
      return;
    }
    debug('conversation_stop');
    conversing = false;
    convStopReason = 'leave';
    clearConvTimers();
    // disarm the interim timer on stop.
    stopInterimTimer();
    if (convRecorder) {
      try {
        if (convRecorder.state !== 'inactive') convRecorder.stop();
      } catch {
        /* ignore */
      }
      convRecorder = null;
    }
    convChunks = [];
    convSpeaking = false;
    // PRIVACY GUARD (B5): clear the room-noise bookkeeping on leave.
    convStartedAt = 0;
    convLastSentAt = 0;
    convConsecutiveBlanks = 0;
    Voice.cancelSpeech();
    stopAmplitude();
    releaseStream();
    resetAmplitudeStat();
    convOpts?.onAmplitude?.(0);
    setConvState('idle');
    emitVoiceState();
    convOpts = null;
  },

  /**
   * Speak text via the browser synth. Honors ttsEnabled, prefers 'Microsoft
   * David', strips markdown/code, clamps to 600 chars. No-op when TTS is off or
   * speechSynthesis is unavailable.
   *
   * `onComplete` (if given) fires when the utterance finishes OR when speaking
   * was skipped (TTS off / empty / unavailable) — so callers can chain reliably
   * (the conversation loop uses it to re-arm the mic).
   */
  speak(text: string, onComplete?: () => void): void {
    const done = () => {
      if (onComplete) {
        try {
          onComplete();
        } catch {
          /* ignore */
        }
      }
    };
    if (!text || !Voice.ttsEnabled) return done();
    if (typeof window === 'undefined') return done();
    // ============================================================================
    // THE ONE-VOICE RULE:
    // The classic Windows synth (David) is DEAD. Every spoken word routes through
    // the neural voice (speakNeural / piper). If neural cannot play, the reply is
    // simply not spoken — it stays on screen. Silence is acceptable; two voices
    // talking over each other is not. The old SpeechSynthesisUtterance path was
    // removed because two independent code paths could both reach it and overlap
    // with neural playback. One voice. Always.
    // ============================================================================
    // Kill anything the legacy synth might still be saying, then go neural.
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    void speakNeural(text).finally(() => done());
  },

  /** Cancel any in-progress speech immediately. */
  cancelSpeech(): void {
    // FIX 1: cancelling speech ends the deaf-mic window too.
    markTtsEnd();
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  },
};

export default Voice;

// ---------------------------------------------------------------------------
// speakNeural — APPENDED. Local NEURAL TTS (piper-tts) playback.
//
// a user request: "Can you change your voice? It's too generic, it
// needs to be more fluid." The browser's built-in 'Microsoft David' SAPI synth
// (used by Voice.speak) is the 1990s generic voice. speakNeural instead asks the
// server to synthesize the text with a local neural ONNX voice and plays the
// returned WAV through an <Audio> element — real, fluid, on-device, zero-cloud.
//
// CONTRACT: returns true if the neural audio actually played, false on ANY
// failure (TTS off / fetch failed / non-audio response / playback error) so the
// caller can fall back to the old Voice.speak(). Honors Voice.ttsEnabled.
//
// ECHO-LOOP SAFETY: this plays through the speakers exactly like Voice.speak, so
// it MUST mark the same TTS-speaking suppression window (markTtsStart/markTtsEnd
// — the module's single source of truth, ) so the mic goes deaf
// during the spoken reply and SERVARI's own words are never re-recorded. Also
// sets window.__servariTtsSpeaking as a belt-and-suspenders cross-module flag.
// ---------------------------------------------------------------------------
export async function speakNeural(text: string): Promise<boolean> {
  if (!text || !Voice.ttsEnabled) return false;
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return false;

  // ============================================================================
  // SINGLE-PLAYBACK GUARD:
  // Multiple code paths (the conversation loop + the passive poller) can both
  // trigger speech for the same reply within ~1-2s of each other. Two overlapping
  // playbacks of the same words = "two voices talking at the same time".
  // The flag is set HERE, at function entry, BEFORE any async work — so a second
  // caller can never slip through during the fetch window. Cleared in finally.
  // ============================================================================
  const w = window as unknown as { __servariNeuralPlaying?: boolean };
  if (w.__servariNeuralPlaying) {
    void debug('neural_skip_already_playing', { dropped_text_len: text.length });
    return true; // the reply IS being spoken (by the first caller) — report success
  }
  // ============================================================================
  // CROSS-WINDOW SPEAKER LOCK: if the exe AND a browser tab are BOTH open, each window
  // independently speaks every reply = "two voices". localStorage is shared across
  // same-origin windows — a 30s speaker lease lets exactly ONE window be the voice.
  // ============================================================================
  try {
    const LEASE_KEY = 'servari-speaker-lease';
    const now = Date.now();
    const lease = JSON.parse(localStorage.getItem(LEASE_KEY) || '{}') as { id?: string; until?: number };
    const myId = (w as unknown as { __servariWindowId?: string }).__servariWindowId
      || ((w as unknown as { __servariWindowId?: string }).__servariWindowId = String(now) + Math.random().toString(36).slice(2));
    if (lease.id && lease.id !== myId && (lease.until || 0) > now) {
      void debug('neural_skip_other_window_speaking', { lease_id: lease.id });
      return true; // another window owns the voice right now — stay silent here
    }
    localStorage.setItem(LEASE_KEY, JSON.stringify({ id: myId, until: now + 30000 }));
  } catch {
    /* localStorage unavailable — single-window assumption holds */
  }
  w.__servariNeuralPlaying = true;

  const setSuppress = (on: boolean): void => {
    try {
      (window as unknown as { __servariTtsSpeaking?: boolean }).__servariTtsSpeaking = on;
    } catch {
      /* ignore — flag is best-effort */
    }
  };

  let url: string | null = null;
  let audio: HTMLAudioElement | null = null;
  try {
    const res = await fetch('/api/voice-speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return false;
    // The server returns audio/wav bytes on success, or a JSON {ok:false} on
    // failure. Anything that isn't audio means we fall back to the old voice.
    const ctype = res.headers.get('Content-Type') || '';
    if (!ctype.includes('audio')) {
      void debug('neural_tts_not_audio', { ctype });
      return false;
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) return false;

    url = URL.createObjectURL(blob);
    audio = new Audio(url);

    // Mark the deaf-mic window for the whole playback (echo-loop cure). Mirror
    // the speechSynthesis path: start on play, end on finish/error.
    markTtsStart();
    setSuppress(true);
    // DOUBLE-VOICE KILL: flag neural playback globally + cancel any
    // classic synth already speaking — exactly one voice can ever play.
    (window as unknown as { __servariNeuralPlaying?: boolean }).__servariNeuralPlaying = true;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }

    const played = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      if (!audio) return finish(false);
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.play().then(
        () => {
          /* playing — wait for onended */
        },
        () => finish(false),
      );
    });

    void debug('neural_tts_played', { ok: played, bytes: blob.size });
    return played;
  } catch (err) {
    void debug('neural_tts_failed', String(err));
    return false;
  } finally {
    // ALWAYS close the suppression window + free the object URL, success or not.
    // CRITICAL: release the single-playback guard or every later reply stays silent.
    (window as unknown as { __servariNeuralPlaying?: boolean }).__servariNeuralPlaying = false;
    markTtsEnd();
    setSuppress(false);
    if (audio) {
      try {
        audio.onended = null;
        audio.onerror = null;
      } catch {
        /* ignore */
      }
    }
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
  }
}
