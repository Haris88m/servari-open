import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import {
  Lock,
  Unlock,
  Volume2,
  VolumeX,
  Send,
  MessageCircle,
  X,
} from "lucide-react";
import { API, type Turn } from "../lib/api";
import { Voice, speakNeural, type ConversationState } from "../lib/voice";
import { VoiceOrb } from "./VoiceOrb";
import { sealLabel } from "../lib/display_seal";

type VoiceMode = "push-to-talk" | "toggle-listen" | "conversation";

interface Message {
  id: string;
  role: "operator" | "system";
  content: string;
  // Carried through from Turn.error so model-failure turns render as a
  // visibly-distinct (orange) error bubble instead of a normal grey one —
  // consistent with ChatPanel.
  error?: boolean;
}

// Map a raw voice error reason -> the EXACT, human-visible message the user
// must see. Voice failures are no longer silent.
function voiceErrorMessage(reason: string): string {
  switch (reason) {
    case "NotAllowedError":
    case "SecurityError":
      return "microphone blocked (NotAllowedError) — the exe needs to be reopened after the fix";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no microphone found";
    case "NotReadableError":
    case "TrackStartError":
      return "mic is in use by another app (NotReadableError) — close it and retry";
    case "no_media_devices":
      return "this build has no microphone access (no media devices)";
    case "no_stt_engine_available":
    case "speech_start_failed":
      return "no speech engine available — the local transcriber is offline";
    case "transcribe_failed":
    case "transcribe_request_failed":
      return "transcription failed — the local whisper backend did not respond";
    default:
      return `voice error: ${reason}`;
  }
}

// FIX — echo detection. The user's mic can record SERVARI's spoken
// reply; the resulting transcription is then sent back as his next message
// (the echo loop). Before sending a transcription, compare its words
// against the last 2 SERVARI turns: if >60% of its words appear there, it is the
// SERVARI's own voice echoed back — drop it.
function tokenizeWords(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function isEchoOfSelf(transcript: string, lastSystemTexts: string[]): boolean {
  // DISABLED: the word-overlap filter ate REAL
  // messages — the user naturally reuses SERVARI's words when replying ("voice",
  // "hear", "speaking"), tripping the >60% overlap and silently dropping his speech.
  // The deaf-mic suppression (mic paused while TTS plays) is the real echo defense and
  // it works at the SOURCE. This second layer caused more harm than good.
  void transcript;
  void lastSystemTexts;
  void tokenizeWords;
  return false;
}

// Map a live server turn -> a chat bubble. The operator is on the right,
// everyone/everything else is the system voice (left).
function turnToMessage(t: Turn, index: number): Message {
  const from = (t.from || "").toLowerCase();
  const role: Message["role"] =
    from === "operator" || from === "user" ? "operator" : "system";
  const id =
    t.turn !== undefined && t.turn !== null ? `t${t.turn}` : `i${index}`;
  return { id, role, content: t.text ?? "", error: t.error === true };
}

const NUM_BARS = 20;

// True when the GLOBAL voice surface (GlobalVoice.tsx, mounted in Shell) is
// present. When it is, GlobalVoice OWNS all listening + speaking for the main
// channel — so ChatStage must NOT run its own conversation-mode mic or its
// passive poll-speaker (that would double-speak). ChatStage's mic button then
// just activates the global surface via the 'servari:activate-voice' event.
// Read live (not cached) so it stays correct even if mount order shifts.
function globalVoicePresent(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (window as unknown as { __servariGlobalVoice?: boolean })
      .__servariGlobalVoice === true
  );
}

export function ChatStage() {
  const [searchParams] = useSearchParams();
  // Agent-intervention mode: /shell?agent=<name> talks to that agent's channel.
  const agent = searchParams.get("agent") || null;
  // THE DISPLAY SEAL — the agent param may be a raw internal code-name.
  // The intervention banner + composer placeholder are STRUCTURAL CHROME, so the
  // name renders through sealLabel (internal label -> professional product word).
  // Chat CONTENT (turn text) stays seal-EXEMPT. Fall back to the raw name only if
  // the seal returns empty (a denied term) so the chrome never breaks.
  const agentLabel = agent ? sealLabel(agent) || agent : null;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isListening, setIsListening] = useState(false);
  // Conversation is the NEW DEFAULT mode: click the mic once to enter, just talk.
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("conversation");
  const [ttsOn, setTtsOn] = useState<boolean>(Voice.ttsEnabled);
  const [sending, setSending] = useState(false);
  // 0..1 per-bar amplitude for the live waveform.
  const [amplitude, setAmplitude] = useState(0);
  // Conversation-loop state ('idle' when not conversing) — drives mic/waveform visuals.
  const [convState, setConvState] = useState<ConversationState>("idle");
  // VISIBLE voice error — shown in red under the mic. null = none.
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // "I can't hear anything" detector: if we sit in listening for 8s with peak
  // amplitude < 0.01, surface a silent-mic hint (keep listening).
  const [micSilent, setMicSilent] = useState(false);
  // FIX — shown briefly when a transcription was dropped as SERVARI's echo.
  const [echoFiltered, setEchoFiltered] = useState(false);
  const echoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenStartRef = useRef<number>(0);
  const maxAmpRef = useRef<number>(0);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // FIX — the last 2 SERVARI (system) turn texts, kept current so the send paths
  // can compare a transcription against them without re-creating callbacks.
  const lastSystemTurnsRef = useRef<string[]>([]);
  // Highest turn number we've already spoken — so TTS only fires for NEW arrivals.
  const lastSpokenTurnRef = useRef<number>(-1);
  // Guard so the very first poll doesn't read out the entire backlog.
  const primedRef = useRef<boolean>(false);
  // In conversation mode SERVARI reply is spoken by the LOOP (conversationSpeak),
  // not by the passive poll-speaker. This ref tells the poller to stay quiet so
  // we never double-speak. When set, the poller still advances the high-water mark.
  const convActiveRef = useRef<boolean>(false);

  // --- live data: poll every 3s (state for main chat, agent-channel in intervention mode) ---
  const refetch = useCallback(async () => {
    try {
      if (agent) {
        const res = await API.agentChannel(agent);
        const turns = res?.turns ?? [];
        setMessages(turns.map(turnToMessage));
        speakNewSystemTurns(turns);
      } else {
        const res = await API.state();
        const turns = res?.turns ?? [];
        setMessages(turns.map(turnToMessage));
        speakNewSystemTurns(turns);
      }
    } catch {
      // server degrades gracefully; keep whatever we had on a transient miss.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // Speak only NEW system turns (highest unseen turn number), gated by TTS.
  function speakNewSystemTurns(turns: Turn[]) {
    if (turns.length === 0) return;
    // On the first load just record the high-water mark — never read the backlog.
    if (!primedRef.current) {
      let maxTurn = -1;
      for (const t of turns) {
        const n = typeof t.turn === "number" ? t.turn : -1;
        if (n > maxTurn) maxTurn = n;
      }
      lastSpokenTurnRef.current = maxTurn;
      primedRef.current = true;
      return;
    }
    if (!Voice.ttsEnabled || convActiveRef.current || globalVoicePresent()) {
      // keep the high-water mark moving so re-enabling TTS (or leaving
      // conversation mode) doesn't dump backlog. In conversation mode the loop
      // itself speaks the reply via conversationSpeak — the poller stays quiet.
      // When GlobalVoice is present it OWNS speaking — the poller stays quiet
      // here too so the two surfaces never double-speak the same reply.
      for (const t of turns) {
        const n = typeof t.turn === "number" ? t.turn : -1;
        if (n > lastSpokenTurnRef.current) lastSpokenTurnRef.current = n;
      }
      return;
    }
    // Find new system turns in turn-order and speak them.
    const fresh = turns
      .filter((t) => {
        const n = typeof t.turn === "number" ? t.turn : -1;
        const from = (t.from || "").toLowerCase();
        return (
          n > lastSpokenTurnRef.current &&
          from !== "operator" &&
          from !== "user"
        );
      })
      .sort((a, b) => (Number(a.turn) || 0) - (Number(b.turn) || 0));

    for (const t of turns) {
      const n = typeof t.turn === "number" ? t.turn : -1;
      if (n > lastSpokenTurnRef.current) lastSpokenTurnRef.current = n;
    }
    // Speak ONLY the latest fresh reply: backed-up replies read as
    // "repeating itself" when queued aloud — older ones stay visible as text.
    // Neural voice (piper) first; classic synth as fallback.
    const latest = fresh[fresh.length - 1];
    if (latest && latest.text) {
      void speakNeural(latest.text).then((played) => {
        if (!played) Voice.speak(latest.text);
      });
    }
  }

  useEffect(() => {
    Voice.init();
    // reset speak-priming when switching channels.
    primedRef.current = false;
    lastSpokenTurnRef.current = -1;
    refetch();
    const interval = setInterval(refetch, 3000);
    return () => clearInterval(interval);
  }, [refetch]);

  // auto-scroll to newest message.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // FIX — keep the last-2-system-turns ref current for the echo filter.
  useEffect(() => {
    const systemTexts = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    lastSystemTurnsRef.current = systemTexts.slice(-2);
  }, [messages]);

  // FIX — briefly flash "(echo filtered)" in the status line, then clear.
  const flashEchoFiltered = useCallback(() => {
    setEchoFiltered(true);
    if (echoTimerRef.current) clearTimeout(echoTimerRef.current);
    echoTimerRef.current = setTimeout(() => setEchoFiltered(false), 1800);
  }, []);

  // clear the echo-flash timer on unmount.
  useEffect(() => {
    return () => {
      if (echoTimerRef.current) clearTimeout(echoTimerRef.current);
    };
  }, []);

  // Amplitude handler shared by every voice path: drives the waveform AND tracks
  // the running peak so the silent-mic detector can tell if the mic hears anything.
  const onAmp = useCallback(
    (level: number) => {
      setAmplitude(level);
      if (level > maxAmpRef.current) maxAmpRef.current = level;
      if (level >= 0.01 && micSilent) setMicSilent(false);
    },
    [micSilent],
  );

  // Silent-mic detector: while listening, if 8s pass with peak amplitude < 0.01,
  // surface "I can't hear anything" (keep listening — don't tear the loop down).
  useEffect(() => {
    if (!isListening) {
      setMicSilent(false);
      return;
    }
    listenStartRef.current = Date.now();
    maxAmpRef.current = 0;
    setMicSilent(false);
    const id = setInterval(() => {
      if (Date.now() - listenStartRef.current >= 8000) {
        setMicSilent(maxAmpRef.current < 0.01);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [isListening, convState]);

  // --- sending ---
  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      setSending(true);
      setInput("");
      // optimistic operator bubble so the UI feels instant.
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: "operator", content: text },
      ]);
      try {
        if (agent) {
          await API.agentSay(agent, text);
        } else {
          await API.say(text);
        }
      } catch {
        // swallow — the next poll reconciles real server state.
      } finally {
        setSending(false);
        refetch();
      }
    },
    [agent, refetch, sending],
  );

  // --- voice wiring ---
  const startVoice = useCallback(() => {
    if (isListening) return;
    setVoiceError(null);
    setIsListening(true);
    void Voice.startListening({
      lang: "en-US",
      onInterim: (t) => setInput(t),
      onFinal: (t) => {
        const clean = t.trim();
        setInput("");
        if (!clean) return;
        // FIX: drop SERVARI's own voice echoed back into the mic.
        if (isEchoOfSelf(clean, lastSystemTurnsRef.current)) {
          flashEchoFiltered();
          return;
        }
        void send(clean);
      },
      onAmplitude: onAmp,
      onError: (reason) => {
        setVoiceError(voiceErrorMessage(reason));
        setIsListening(false);
        setAmplitude(0);
      },
    });
  }, [isListening, send, onAmp, flashEchoFiltered]);

  const stopVoice = useCallback(() => {
    if (!isListening) return;
    Voice.stopListening();
    setIsListening(false);
    setAmplitude(0);
  }, [isListening]);

  const toggleVoice = useCallback(() => {
    if (isListening) stopVoice();
    else startVoice();
  }, [isListening, startVoice, stopVoice]);

  // --- conversation mode (hands-free) ---

  // Fetch the highest system turn number currently on the channel (the reply
  // high-water mark). System = anything not from the operator.
  const latestSystemTurn = useCallback(async (): Promise<number> => {
    try {
      const res = agent ? await API.agentChannel(agent) : await API.state();
      const turns = res?.turns ?? [];
      let max = -1;
      for (const t of turns) {
        const from = (t.from || "").toLowerCase();
        const n = typeof t.turn === "number" ? t.turn : -1;
        if (from !== "operator" && from !== "user" && n > max) max = n;
      }
      return max;
    } catch {
      return -1;
    }
  }, [agent]);

  // Send the user's utterance, then fast-poll for SERVARI reply and speak it
  // (which re-arms the mic via the loop). Fast-poll: every 1.5s up to 60s.
  const handleUserSaid = useCallback(
    async (said: string) => {
      const text = said.trim();
      if (!text) return;
      // FIX: if the utterance is mostly SERVARI's own last reply, it is the
      // TTS echoing back through the mic — drop it, flash the notice, and re-arm
      // listening (no-op conversationSpeak resumes the loop). Never send it.
      if (isEchoOfSelf(text, lastSystemTurnsRef.current)) {
        flashEchoFiltered();
        if (Voice.inConversation) Voice.conversationSpeak("");
        return;
      }
      // optimistic operator bubble.
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: "operator", content: text },
      ]);
      // baseline = newest system turn BEFORE we send, so we only speak the reply.
      const baseline = await latestSystemTurn();
      try {
        if (agent) {
          await API.agentSay(agent, text);
        } else {
          await API.say(text);
        }
      } catch {
        // swallow — keep the conversation alive; speak a soft fallback so the
        // loop re-arms instead of hanging on silence.
        Voice.conversationSpeak("");
        refetch();
        return;
      }
      refetch();

      // Fast-poll for a NEW system turn (every 1.5s, up to 60s).
      const deadline = Date.now() + 60000;
      let replyText: string | null = null;
      while (Date.now() < deadline) {
        if (!Voice.inConversation) return; // user left mid-wait
        await new Promise((r) => setTimeout(r, 1500));
        if (!Voice.inConversation) return;
        try {
          const res = agent ? await API.agentChannel(agent) : await API.state();
          const turns = res?.turns ?? [];
          setMessages(turns.map(turnToMessage));
          // newest system turn strictly above baseline = the reply.
          let bestN = baseline;
          let bestText: string | null = null;
          for (const t of turns) {
            const from = (t.from || "").toLowerCase();
            const n = typeof t.turn === "number" ? t.turn : -1;
            if (from !== "operator" && from !== "user" && n > bestN && t.text) {
              bestN = n;
              bestText = t.text;
            }
          }
          if (bestText) {
            replyText = bestText;
            break;
          }
        } catch {
          // transient miss — keep polling.
        }
      }
      // Speak the reply (or re-arm with a no-op if none arrived in time). Either
      // way conversationSpeak resumes listening when it finishes.
      if (!Voice.inConversation) return;
      Voice.conversationSpeak(replyText ?? "");
    },
    [agent, latestSystemTurn, refetch, flashEchoFiltered],
  );

  const startConversation = useCallback(() => {
    if (Voice.inConversation) return;
    setVoiceError(null);
    convActiveRef.current = true;
    setIsListening(true);
    setConvState("listening");
    void Voice.startConversation({
      lang: "en-US",
      onStateChange: (s) => setConvState(s),
      onAmplitude: onAmp,
      onUserSaid: (t) => void handleUserSaid(t),
      onError: (reason) => {
        // A transient transcribe miss keeps the loop alive (voice.ts resumes
        // listening) — only tear the UI down for hard errors (mic/permission).
        const hard =
          reason !== "transcribe_failed" &&
          reason !== "transcribe_request_failed";
        setVoiceError(voiceErrorMessage(reason));
        if (hard) {
          convActiveRef.current = false;
          setIsListening(false);
          setConvState("idle");
          setAmplitude(0);
        }
      },
    });
  }, [handleUserSaid, onAmp]);

  const stopConversation = useCallback(() => {
    convActiveRef.current = false;
    void Voice.stopConversation();
    setIsListening(false);
    setConvState("idle");
    setAmplitude(0);
    // FIX: after a conversation ends, the next big-mic click re-enters
    // CONVERSATION mode (not a classic mode). Classic modes stay reachable only
    // via the small mode toggle.
    setVoiceMode("conversation");
  }, []);

  // Single mic-click while conversing = FLUSH (send what's captured) — that is the
  // natural instinct when it seems stuck. If NOT yet conversing, click enters the
  // loop. Leaving the loop is the separate end-conversation 'x' button.
  //
  // When the GLOBAL voice surface is present (the normal case inside Shell), the
  // mic click DELEGATES to it via 'servari:activate-voice' — GlobalVoice owns the
  // conversation loop so it survives navigation. ChatStage does NOT run its own
  // loop in that case.
  const micClickConversation = useCallback(() => {
    if (globalVoicePresent()) {
      window.dispatchEvent(new CustomEvent("servari:activate-voice"));
      return;
    }
    if (Voice.inConversation) Voice.flush();
    else startConversation();
  }, [startConversation]);

  const toggleTts = useCallback(() => {
    const next = !ttsOn;
    Voice.ttsEnabled = next;
    setTtsOn(next);
    if (!next) Voice.cancelSpeech();
  }, [ttsOn]);

  // stop listening if the component unmounts — BUT NOT when GlobalVoice owns the
  // conversation. Tearing down on unmount is exactly the bug we are fixing: the
  // operator navigates away and the conversation must SURVIVE. When GlobalVoice
  // is present it owns the loop across navigation, so ChatStage leaves it alone.
  useEffect(() => {
    return () => {
      if (globalVoicePresent()) return;
      Voice.stopListening();
      void Voice.stopConversation();
    };
  }, []);

  // When GlobalVoice owns the conversation surface, ChatStage suppresses its
  // own duplicated voice visuals (waveform / status line / big orb / MIC LIVE /
  // in-loop end-X). It keeps the composer + message history + agent mode. The
  // mic button stays as the activator for the global surface.
  const globalVoice = globalVoicePresent();

  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="w-full max-w-3xl mx-auto flex flex-col h-full max-h-[800px]">
        {/* Agent-intervention banner (only in ?agent= mode) */}
        {agent && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 px-4 py-2 rounded-xl text-center"
            style={{
              background: "rgba(20, 156, 150, 0.10)",
              border: "1px solid rgba(20, 156, 150, 0.25)",
              color: "var(--servari-teal)",
              fontSize: "0.8125rem",
              letterSpacing: "0.5px",
            }}
          >
            intervening · {agentLabel}
          </motion.div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto space-y-4 mb-6">
          {messages.map((message) => (
            <motion.div
              key={message.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${message.role === "operator" ? "justify-end" : "justify-start"}`}
            >
              <div
                className="max-w-[80%] px-4 py-3 rounded-2xl"
                style={{
                  background: message.error
                    ? "rgba(217, 119, 6, 0.10)"
                    : message.role === "operator"
                      ? "rgba(20, 156, 150, 0.15)"
                      : "var(--servari-glass)",
                  backdropFilter: "blur(12px)",
                  border: message.error
                    ? "1px solid rgba(217, 119, 6, 0.55)"
                    : message.role === "operator"
                      ? "1px solid rgba(20, 156, 150, 0.3)"
                      : "1px solid rgba(250, 248, 243, 0.04)",
                  color: message.error ? "#f59e0b" : "var(--servari-ivory)",
                  fontSize: "0.9375rem",
                  lineHeight: "1.6",
                  whiteSpace: "pre-wrap",
                }}
              >
                {message.content}
              </div>
            </motion.div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Waveform (when listening) — suppressed when GlobalVoice owns the surface */}
        <AnimatePresence>
          {isListening && !globalVoice && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 32 }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-4 flex items-center justify-center gap-1"
            >
              {[...Array(NUM_BARS)].map((_, i) => {
                // Real heights: amplitude (0..1) shaped into a centered wave so
                // the middle bars react most — keeps the exact bar styling.
                const center = (NUM_BARS - 1) / 2;
                const dist = Math.abs(i - center) / center; // 0 center .. 1 edges
                const shape = 1 - dist * 0.6;
                const h = 8 + amplitude * 28 * shape;
                return (
                  <motion.div
                    key={i}
                    className="w-1 rounded-full"
                    style={{ background: "var(--servari-teal)" }}
                    animate={{ height: Math.max(8, h) }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                  />
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Voice status line — every voice state + error is VISIBLE.
            Errors render in red; listening shows a tiny live amplitude bar so the
            operator can SEE the mic is heard. Silent-mic + transcribing/speaking
            states are surfaced too. Suppressed when GlobalVoice owns the surface. */}
        {(isListening || voiceError || echoFiltered) && !globalVoice && (
          <div
            className="mb-3 flex items-center justify-center gap-2 px-3 text-center"
            style={{
              fontSize: "0.8125rem",
              letterSpacing: "0.3px",
              minHeight: "1.4em",
            }}
          >
            {voiceError ? (
              <span style={{ color: "var(--servari-red)" }}>{voiceError}</span>
            ) : echoFiltered ? (
              <span style={{ color: "var(--servari-dimmed)" }}>
                (echo filtered)
              </span>
            ) : micSilent ? (
              <span style={{ color: "var(--servari-red)" }}>
                I can't hear anything — your mic may be muted or the wrong input
                device
              </span>
            ) : convState === "transcribing" ? (
              <span style={{ color: "var(--servari-teal)" }}>
                heard you — transcribing…
              </span>
            ) : convState === "speaking" ? (
              <span style={{ color: "var(--servari-teal)" }}>speaking…</span>
            ) : (
              <span
                className="flex items-center gap-2"
                style={{ color: "var(--servari-teal)" }}
              >
                listening…
                {/* tiny live amplitude bar — width tracks the running level */}
                <span
                  className="inline-block rounded-full overflow-hidden"
                  style={{
                    width: 56,
                    height: 4,
                    background: "rgba(250, 248, 243, 0.12)",
                  }}
                >
                  <motion.span
                    className="block h-full rounded-full"
                    style={{ background: "var(--servari-teal)" }}
                    animate={{
                      width: `${Math.min(100, Math.round(amplitude * 100))}%`,
                    }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                  />
                </span>
              </span>
            )}
          </div>
        )}

        {/* VoiceOrb — the high-tech speaking animation (the design plan). Renders above
            the composer while a hands-free conversation is live, centered, 140px,
            reflecting the REAL conversation state + live mic amplitude. The 72px
            mic button below stays the click target. In classic listen modes the
            orb still shows a listening pulse so the surface always feels alive. */}
        <AnimatePresence>
          {!globalVoice &&
          ((voiceMode === "conversation" && Voice.inConversation) ||
            (voiceMode !== "conversation" && isListening)) ? (
            <motion.div
              key="voice-orb"
              initial={{ opacity: 0, scale: 0.85, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.85, y: 8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="mb-5 flex items-center justify-center"
            >
              <VoiceOrb
                size={140}
                state={
                  voiceMode === "conversation"
                    ? convState
                    : isListening
                      ? "listening"
                      : "idle"
                }
                amplitude={amplitude}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* MIC LIVE — the privacy guard's visibility requirement (the design plan #3).
            A clearly visible PULSING red dot + "MIC LIVE" label whenever the mic
            is open, so the user always KNOWS the mic is hot. Suppressed when
            GlobalVoice owns the surface (it shows its own MIC LIVE dot). */}
        <AnimatePresence>
          {isListening && !globalVoice && (
            <motion.div
              key="mic-live"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              className="mb-3 flex items-center justify-center"
            >
              <span
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full"
                style={{
                  background: "rgba(248, 81, 73, 0.10)",
                  border: "1px solid rgba(248, 81, 73, 0.35)",
                }}
              >
                <motion.span
                  className="inline-block rounded-full"
                  style={{
                    width: 8,
                    height: 8,
                    background: "var(--servari-red)",
                  }}
                  animate={{ opacity: [1, 0.25, 1], scale: [1, 1.25, 1] }}
                  transition={{
                    duration: 1.2,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
                <span
                  style={{
                    color: "var(--servari-red)",
                    fontSize: "0.6875rem",
                    fontFamily: "var(--font-mono)",
                    letterSpacing: "1.5px",
                    fontWeight: 600,
                  }}
                >
                  MIC LIVE
                </span>
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Composer */}
        <div className="relative">
          <div
            className="flex items-center gap-4 p-4 rounded-2xl"
            style={{
              background: "var(--servari-glass)",
              backdropFilter: "blur(24px)",
              border: "1px solid rgba(250, 248, 243, 0.08)",
            }}
          >
            {/* Text input */}
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={
                agentLabel
                  ? `Speak or type to ${agentLabel}...`
                  : "Speak or type your command..."
              }
              className="flex-1 bg-transparent outline-none"
              style={{
                color: "var(--servari-ivory)",
                fontSize: "0.9375rem",
              }}
            />

            {/* Send button */}
            <button
              onClick={() => void send(input)}
              disabled={!input.trim() || sending}
              className="p-2 rounded hover:bg-white/5 transition-colors disabled:opacity-30"
              title="Send"
            >
              <Send
                size={16}
                style={{
                  color: input.trim()
                    ? "var(--servari-teal)"
                    : "var(--servari-dimmed)",
                }}
              />
            </button>

            {/* TTS toggle */}
            <button
              onClick={toggleTts}
              className="p-2 rounded hover:bg-white/5 transition-colors"
              title={ttsOn ? "Voice replies on" : "Voice replies off"}
            >
              {ttsOn ? (
                <Volume2 size={16} style={{ color: "var(--servari-teal)" }} />
              ) : (
                <VolumeX size={16} style={{ color: "var(--servari-dimmed)" }} />
              )}
            </button>

            {/* Voice mode toggle — cycles conversation -> push-to-talk -> toggle-listen */}
            <button
              onClick={() => {
                // leaving conversation mode? tear the loop down cleanly first.
                if (voiceMode === "conversation" && Voice.inConversation)
                  stopConversation();
                else if (isListening) stopVoice();
                setVoiceMode(
                  voiceMode === "conversation"
                    ? "push-to-talk"
                    : voiceMode === "push-to-talk"
                      ? "toggle-listen"
                      : "conversation",
                );
              }}
              className="p-2 rounded hover:bg-white/5 transition-colors"
              title={
                voiceMode === "conversation"
                  ? "Conversation - just talk"
                  : voiceMode === "push-to-talk"
                    ? "Push to talk - hold"
                    : "Toggle - click start/stop"
              }
            >
              {voiceMode === "conversation" ? (
                <MessageCircle
                  size={16}
                  style={{ color: "var(--servari-teal)" }}
                />
              ) : voiceMode === "push-to-talk" ? (
                <Unlock size={16} style={{ color: "var(--servari-dimmed)" }} />
              ) : (
                <Lock size={16} style={{ color: "var(--servari-teal)" }} />
              )}
            </button>

            {/* End-conversation button — only while a hands-free loop is live.
                The mic's single click SENDS (flush); THIS leaves the loop.
                Suppressed when GlobalVoice owns the loop (it has its own X). */}
            {voiceMode === "conversation" &&
              Voice.inConversation &&
              !globalVoice && (
                <button
                  onClick={stopConversation}
                  className="p-2 rounded hover:bg-white/5 transition-colors"
                  title="End conversation"
                >
                  <X size={16} style={{ color: "var(--servari-red)" }} />
                </button>
              )}

            {/* Large mic button — behavior follows the active voice mode.
                conversation: single click SENDS (flush); 'x' ends the loop.
                push-to-talk: hold to talk.
                toggle-listen: click toggles classic listen. */}
            <motion.button
              onMouseDown={() => voiceMode === "push-to-talk" && startVoice()}
              onMouseUp={() => voiceMode === "push-to-talk" && stopVoice()}
              onMouseLeave={() =>
                voiceMode === "push-to-talk" && isListening && stopVoice()
              }
              onClick={() => {
                // conversation mode: single click SENDS (flush) if already in the
                // loop, else enters it. Ending the loop is the separate 'x' button.
                if (voiceMode === "conversation") micClickConversation();
                else if (voiceMode === "toggle-listen") toggleVoice();
              }}
              title={
                voiceMode === "conversation"
                  ? Voice.inConversation
                    ? "Click to send now (flush)"
                    : "Click to start conversation"
                  : voiceMode === "push-to-talk"
                    ? "Hold to talk"
                    : "Click to toggle listen"
              }
              className="relative w-[72px] h-[72px] rounded-full flex items-center justify-center -m-2"
              style={{
                background: isListening
                  ? "radial-gradient(circle, var(--servari-teal) 0%, var(--servari-teal-dark) 100%)"
                  : "var(--servari-panel)",
                border: isListening
                  ? "2px solid var(--servari-teal)"
                  : "2px solid var(--servari-edge-2)",
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              {/* Pulsing rings — present whenever the mic is active. In
                  conversation mode the ring speed reflects the sub-state:
                  listening = steady pulse, transcribing = quick shimmer,
                  speaking = slow soft ripple. Classic modes keep the 2s pulse. */}
              {isListening &&
                (() => {
                  // ringDur drives the visible feedback per state.
                  const inConv = voiceMode === "conversation";
                  const ringDur =
                    inConv && convState === "transcribing"
                      ? 0.9 // shimmer — fast
                      : inConv && convState === "speaking"
                        ? 3.2 // soft ripple — slow
                        : 2; // listening / classic — steady
                  return (
                    <>
                      <motion.div
                        className="absolute inset-0 rounded-full"
                        style={{ border: "2px solid var(--servari-teal)" }}
                        animate={{ scale: [1, 1.3, 1.3], opacity: [0.6, 0, 0] }}
                        transition={{
                          duration: ringDur,
                          repeat: Infinity,
                          ease: "easeOut",
                        }}
                      />
                      <motion.div
                        className="absolute inset-0 rounded-full"
                        style={{ border: "2px solid var(--servari-teal)" }}
                        animate={{ scale: [1, 1.3, 1.3], opacity: [0.6, 0, 0] }}
                        transition={{
                          duration: ringDur,
                          repeat: Infinity,
                          ease: "easeOut",
                          delay: ringDur / 2,
                        }}
                      />
                    </>
                  );
                })()}

              {/* Feather/mic icon */}
              <svg
                width="36"
                height="36"
                viewBox="0 0 36 36"
                className="relative z-10"
              >
                <path
                  d="M18 4 Q15 10, 13 18 Q15 26, 18 32 Q21 26, 23 18 Q21 10, 18 4 Z M18 4 Q16 8, 10 16 M18 12 Q15 16, 11 20 M18 20 Q16 22, 13 26"
                  fill="none"
                  stroke={
                    isListening ? "var(--servari-ivory)" : "var(--servari-teal)"
                  }
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}
