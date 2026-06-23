import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { X, Send } from "lucide-react";
import { API, type Turn } from "../lib/api";
import { Voice, type ConversationState } from "../lib/voice";
import { VoiceOrb } from "./VoiceOrb";

/**
 * SERVARI OS — GlobalVoice.
 *
 * Voice is GLOBAL. This component is mounted ONCE in Shell.tsx, outside the
 * route <Outlet/>, so it survives every navigation. It owns ALL listening +
 * speaking. A floating mic surface (bottom-right, z-50) is present on EVERY
 * screen — collapsed to a 56px mic button, expanded to the VoiceOrb + live
 * state + last exchange while a conversation is live.
 *
 * CHAT BY THE ORB:
 * When conversing OR the chat panel is toggled open, a compact chat panel slides
 * up ABOVE the orb in the same bottom-right corner — last 6 turns, scrollable
 * mini bubbles, and a text input so you can talk AND read in one corner.
 * Collapsed = just the orb button.
 *
 * COORDINATION CONTRACT with the chat surface:
 *   - On mount, we set window.__servariGlobalVoice = true. A route-level chat
 *     surface reads this flag and DISABLES its own conversation-mode mic +
 *     passive poll-speaker so nothing double-speaks. Its mic button instead
 *     dispatches the custom window event 'servari:activate-voice' to wake /
 *     flush THIS surface.
 *   - GlobalVoice advances the spoken-turn high-water mark itself; it does NOT
 *     run a passive poll-speaker (it speaks only the reply to the turn the user
 *     just spoke), so a chat tab that is open won't double-speak.
 */

// ---------------------------------------------------------------------------
// Voice error messages
// ---------------------------------------------------------------------------
function voiceErrorMessage(reason: string): string {
  switch (reason) {
    case "NotAllowedError":
    case "SecurityError":
      return "microphone blocked (NotAllowedError) — the app needs to be reopened after granting access";
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

// Operator-side turn sentinels (the user's own messages).
function isOperatorTurn(from: string | undefined): boolean {
  const f = (from || "").toLowerCase();
  return f === "operator" || f === "user";
}

function routeForCommand(text: string): { path: string; label: string } | null {
  const clean = text.toLowerCase().replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!/\b(open|go|show|navigate|launch|switch)\b/.test(clean)) return null;
  const routes: Array<[RegExp, string, string]> = [
    [/\b(dashboard|home|os)\b/, "/shell", "Dashboard"],
    [/\b(chat|conversation)\b/, "/shell/chat", "Chat"],
    [/\b(agent apps|apps)\b/, "/shell/agent-apps", "Agent Apps"],
    [/\b(agent map|neural map|org chart|network)\b/, "/shell/org-chart", "Agent Map"],
    [/\b(agents|agent grid)\b/, "/shell/agents", "Agents"],
    [/\b(trading|trade desk|markets)\b/, "/shell/trading", "Trading Desk"],
    [/\b(cv|resume|career builder|cv builder)\b/, "/shell/cv-builder", "CV Builder"],
    [/\b(projects|project studio|workflows)\b/, "/shell/projects", "Project Studio"],
    [/\b(settings|model settings|backend)\b/, "/shell/settings", "Settings"],
    [/\b(runtime|engine)\b/, "/shell/runtime", "Runtime"],
    [/\b(gates|fast verify|verify)\b/, "/shell/fast-verify", "Fast Verify Gates"],
    [/\b(autonomy|dials)\b/, "/shell/autonomy-dials", "Autonomy Dials"],
    [/\b(health|status)\b/, "/shell/health", "Health"],
    [/\b(tokens|usage)\b/, "/shell/tokens", "Tokens"],
    [/\b(company)\b/, "/shell/company", "The Company"],
    [/\b(personal)\b/, "/shell/personal", "Personal"],
  ];
  for (const [re, path, label] of routes) {
    if (re.test(clean)) return { path, label };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mini chat bubble
// ---------------------------------------------------------------------------
function ChatBubble({ turn, isUser }: { turn: Turn; isUser: boolean }) {
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className="max-w-[85%] px-2.5 py-1.5 rounded-xl text-[0.7rem] leading-snug"
        style={{
          background: isUser
            ? "rgba(20, 156, 150, 0.18)"
            : "rgba(250, 248, 243, 0.06)",
          border: isUser
            ? "1px solid rgba(20, 156, 150, 0.35)"
            : "1px solid rgba(250, 248, 243, 0.08)",
          color: isUser ? "var(--servari-ivory)" : "var(--servari-dimmed)",
          wordBreak: "break-word",
        }}
      >
        {turn.text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
interface GlobalVoiceProps {
  showMiniChat?: boolean;
  showLauncher?: boolean;
}

export function GlobalVoice({ showMiniChat = true, showLauncher = true }: GlobalVoiceProps) {
  const navigate = useNavigate();
  const [convState, setConvState] = useState<ConversationState>("idle");
  const [inConversation, setInConversation] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [micSilent, setMicSilent] = useState(false);
  const [lastUserSaid, setLastUserSaid] = useState<string>("");
  const [lastReply, setLastReply] = useState<string>("");

  // Chat panel state
  const [chatOpen, setChatOpen] = useState(false);
  const [chatTurns, setChatTurns] = useState<Turn[]>([]);
  const [textInput, setTextInput] = useState("");
  const [sending, setSending] = useState(false);
  // Partial / streaming transcription (fires via onInterim from voice.ts)
  const [partialText, setPartialText] = useState<string>("");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  const listenStartRef = useRef<number>(0);
  const maxAmpRef = useRef<number>(0);
  const lastSpokenTurnRef = useRef<number>(-1);
  const primedRef = useRef<boolean>(false);
  // Polling interval for the chat panel turn list
  const chatPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // OWNERSHIP FLAG
  // -------------------------------------------------------------------------
  useEffect(() => {
    const w = window as unknown as { __servariGlobalVoice?: boolean };
    w.__servariGlobalVoice = true;
    Voice.init();
    return () => {
      w.__servariGlobalVoice = false;
      Voice.stopListening();
      void Voice.stopConversation();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Chat panel — fetch last 6 turns from state and keep polling while open
  // -------------------------------------------------------------------------
  const fetchChatTurns = useCallback(async () => {
    try {
      const res = await API.state();
      const turns = res?.turns ?? [];
      // Last 6 turns in chronological order
      const last6 = turns.slice(-6);
      setChatTurns(last6);
    } catch {
      // transient — keep existing turns
    }
  }, []);

  // Auto-scroll to bottom when turns update
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatTurns]);

  // Start/stop polling when the panel is open
  useEffect(() => {
    if (showMiniChat && chatOpen) {
      void fetchChatTurns();
      chatPollRef.current = setInterval(() => void fetchChatTurns(), 2500);
    } else {
      if (chatPollRef.current) {
        clearInterval(chatPollRef.current);
        chatPollRef.current = null;
      }
    }
    return () => {
      if (chatPollRef.current) {
        clearInterval(chatPollRef.current);
        chatPollRef.current = null;
      }
    };
  }, [chatOpen, fetchChatTurns, showMiniChat]);

  // Also refresh turns when a new voice reply lands
  const refreshChat = useCallback(() => {
    if (showMiniChat && chatOpen) void fetchChatTurns();
  }, [chatOpen, fetchChatTurns, showMiniChat]);

  // -------------------------------------------------------------------------
  // Amplitude handler
  // -------------------------------------------------------------------------
  const onAmp = useCallback(
    (level: number) => {
      setAmplitude(level);
      if (level > maxAmpRef.current) maxAmpRef.current = level;
      if (level >= 0.01 && micSilent) setMicSilent(false);
    },
    [micSilent],
  );

  // -------------------------------------------------------------------------
  // Silent-mic detector
  // -------------------------------------------------------------------------
  const isListening = inConversation && convState !== "idle";
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

  // -------------------------------------------------------------------------
  // Get latest system turn number
  // -------------------------------------------------------------------------
  const latestSystemTurn = useCallback(async (): Promise<number> => {
    try {
      const res = await API.state();
      const turns = res?.turns ?? [];
      let max = -1;
      for (const t of turns) {
        const n = typeof t.turn === "number" ? t.turn : -1;
        if (!isOperatorTurn(t.from) && n > max) max = n;
      }
      return max;
    } catch {
      return -1;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Send the user's utterance and fast-poll for the reply
  // -------------------------------------------------------------------------
  const handleUserSaid = useCallback(
    async (said: string) => {
      const text = said.trim();
      if (!text) return;
      // Clear the streaming partial text — the final transcription replaces it.
      setPartialText("");
      setLastUserSaid(text);
      const nav = routeForCommand(text);
      if (nav) {
        navigate(nav.path);
        const reply = `Opening ${nav.label}.`;
        setLastReply(reply);
        Voice.conversationSpeak(reply);
        return;
      }
      const baseline = await latestSystemTurn();
      if (baseline > lastSpokenTurnRef.current) lastSpokenTurnRef.current = baseline;
      try {
        await API.say(text);
      } catch {
        Voice.conversationSpeak("");
        return;
      }

      // Fast-poll for a NEW system turn (every 1.5s, up to 60s).
      const deadline = Date.now() + 60000;
      let replyText: string | null = null;
      while (Date.now() < deadline) {
        if (!Voice.inConversation) return;
        await new Promise((r) => setTimeout(r, 1500));
        if (!Voice.inConversation) return;
        try {
          const res = await API.state();
          const turns = res?.turns ?? [];
          let bestN = baseline;
          let bestText: string | null = null;
          for (const t of turns) {
            const n = typeof t.turn === "number" ? t.turn : -1;
            if (!isOperatorTurn(t.from) && n > bestN && t.text) {
              bestN = n;
              bestText = t.text;
            }
          }
          if (bestText) {
            replyText = bestText;
            if (bestN > lastSpokenTurnRef.current) lastSpokenTurnRef.current = bestN;
            break;
          }
        } catch {
          // transient miss — keep polling.
        }
      }
      if (!Voice.inConversation) return;
      if (replyText) {
        setLastReply(replyText);
        refreshChat();
      }
      Voice.conversationSpeak(replyText ?? "");
    },
    [latestSystemTurn, navigate, refreshChat],
  );

  // -------------------------------------------------------------------------
  // Start / stop conversation loop
  // -------------------------------------------------------------------------
  const startConversation = useCallback(() => {
    if (Voice.inConversation) return;
    setVoiceError(null);
    setInConversation(true);
    setConvState("listening");
    if (showMiniChat) {
      setChatOpen(true);
    }
    primedRef.current = false;
    void latestSystemTurn().then((n) => {
      if (!primedRef.current) {
        lastSpokenTurnRef.current = n;
        primedRef.current = true;
      }
    });
    void Voice.startConversation({
      lang: "en-US",
      onStateChange: (s) => setConvState(s),
      onAmplitude: onAmp,
      // Stream partial transcription into the chat panel.
      onInterim: (text) => {
        setPartialText(text);
        // Auto-open the chat panel so partial text is visible.
        if (showMiniChat) {
          setChatOpen(true);
        }
      },
      onUserSaid: (t) => void handleUserSaid(t),
      onError: (reason) => {
        const hard =
          reason !== "transcribe_failed" && reason !== "transcribe_request_failed";
        setVoiceError(voiceErrorMessage(reason));
        if (hard) {
          setInConversation(false);
          setConvState("idle");
          setAmplitude(0);
        }
      },
    });
  }, [handleUserSaid, onAmp, latestSystemTurn, showMiniChat]);

  const stopConversation = useCallback(() => {
    void Voice.stopConversation();
    setInConversation(false);
    setConvState("idle");
    setAmplitude(0);
    setPartialText("");
  }, []);

  // Single mic-click while conversing = FLUSH; otherwise enter conversation.
  const micClick = useCallback(() => {
    if (Voice.inConversation) Voice.flush();
    else startConversation();
  }, [startConversation]);

  // Toggle the chat panel open/closed without starting voice
  const toggleChat = useCallback(() => {
    setChatOpen((prev) => !prev);
  }, []);

  // -------------------------------------------------------------------------
  // ACTIVATION EVENT
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onActivate = () => micClick();
    window.addEventListener("servari:activate-voice", onActivate);
    return () => window.removeEventListener("servari:activate-voice", onActivate);
  }, [micClick]);

  // -------------------------------------------------------------------------
  // Text input send
  // -------------------------------------------------------------------------
  const sendText = useCallback(async () => {
    const text = textInput.trim();
    if (!text || sending) return;
    setSending(true);
    setTextInput("");
    try {
      const nav = routeForCommand(text);
      if (nav) {
        navigate(nav.path);
        setLastUserSaid(text);
        setLastReply(`Opening ${nav.label}.`);
        setSending(false);
        return;
      }
      await API.say(text);
      // Give the server ~2s to produce a reply, then refresh turns
      setTimeout(() => {
        void fetchChatTurns();
        setSending(false);
      }, 2000);
    } catch {
      setSending(false);
    }
  }, [textInput, sending, fetchChatTurns, navigate]);

  const onTextKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendText();
      }
    },
    [sendText],
  );

  // -------------------------------------------------------------------------
  // Derived display state
  // -------------------------------------------------------------------------
  const expanded = inConversation;
  // The chat panel is visible only when enabled for this route.
  const chatPanelVisible = showMiniChat && chatOpen;

  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-2 pointer-events-none">

      {/* ------------------------------------------------------------------ */}
      {/* CHAT PANEL — slides up above the orb                               */}
      {/* ------------------------------------------------------------------ */}
      <AnimatePresence>
        {chatPanelVisible && (
          <motion.div
            key="chat-panel"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto flex flex-col rounded-2xl overflow-hidden"
            style={{
              width: 288,
              background: "var(--servari-glass)",
              backdropFilter: "blur(28px)",
              border: "1px solid rgba(20, 156, 150, 0.2)",
              boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
            }}
          >
            {/* Panel header */}
            <div
              className="flex items-center justify-between px-3 py-2"
              style={{
                borderBottom: "1px solid rgba(250, 248, 243, 0.06)",
              }}
            >
              <span
                className="font-mono text-[0.65rem] tracking-widest uppercase"
                style={{ color: "var(--servari-teal)" }}
              >
                SERVARI
              </span>
              <div className="flex items-center gap-1.5">
                {inConversation && (
                  <span
                    className="font-mono text-[0.6rem] tracking-wide"
                    style={{ color: "var(--servari-teal-soft)" }}
                  >
                    {convState === "transcribing"
                      ? "transcribing…"
                      : convState === "speaking"
                        ? "speaking…"
                        : "listening…"}
                  </span>
                )}
                <button
                  onClick={() => {
                    setChatOpen(false);
                    if (inConversation) stopConversation();
                  }}
                  className="p-1 rounded hover:bg-white/5 transition-colors"
                  title="Close"
                >
                  <X size={13} style={{ color: "var(--servari-dimmed)" }} />
                </button>
              </div>
            </div>

            {/* Turns scroll area */}
            <div
              ref={chatScrollRef}
              className="flex flex-col gap-1.5 overflow-y-auto px-3 py-2"
              style={{ maxHeight: 220, minHeight: 80 }}
            >
              {chatTurns.length === 0 && !partialText ? (
                <p
                  className="text-center font-mono text-[0.65rem] py-4"
                  style={{ color: "var(--servari-dimmed)" }}
                >
                  no turns yet — speak or type
                </p>
              ) : (
                chatTurns.map((t, i) => {
                  const isUser = isOperatorTurn(t.from);
                  return <ChatBubble key={i} turn={t} isUser={isUser} />;
                })
              )}
              {/* streaming partial transcription ghost bubble */}
              {partialText && (
                <div className="flex justify-end">
                  <div
                    className="max-w-[85%] px-2.5 py-1.5 rounded-xl text-[0.7rem] leading-snug"
                    style={{
                      background: "rgba(20, 156, 150, 0.08)",
                      border: "1px solid rgba(20, 156, 150, 0.2)",
                      color: "var(--servari-teal-soft)",
                      fontStyle: "italic",
                      wordBreak: "break-word",
                    }}
                  >
                    {partialText}
                    <span
                      className="inline-block ml-1 align-middle"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--servari-teal)",
                        animation: "pulse 1s infinite",
                      }}
                    />
                  </div>
                </div>
              )}
              {/* Show voice error inline if conversation active */}
              {voiceError && inConversation && (
                <p
                  className="text-center font-mono text-[0.6rem] px-2"
                  style={{ color: "var(--servari-red)" }}
                >
                  {voiceError}
                </p>
              )}
              {micSilent && inConversation && (
                <p
                  className="text-center font-mono text-[0.6rem] px-2"
                  style={{ color: "var(--servari-red)" }}
                >
                  I can't hear anything — check your mic
                </p>
              )}
            </div>

            {/* Text input row */}
            <div
              className="flex items-center gap-1.5 px-2.5 py-2"
              style={{ borderTop: "1px solid rgba(250, 248, 243, 0.06)" }}
            >
              <input
                ref={textInputRef}
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={onTextKeyDown}
                placeholder="type a message…"
                className="flex-1 bg-transparent outline-none font-mono text-[0.7rem] placeholder:opacity-30"
                style={{
                  color: "var(--servari-ivory)",
                  caretColor: "var(--servari-teal)",
                }}
                disabled={sending}
              />
              <button
                onClick={() => void sendText()}
                disabled={!textInput.trim() || sending}
                className="p-1.5 rounded transition-colors disabled:opacity-30"
                style={{ color: "var(--servari-teal)" }}
                title="Send (Enter)"
              >
                <Send size={13} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ------------------------------------------------------------------ */}
      {/* VOICE ORB PANEL — visible when conversation is active              */}
      {/* ------------------------------------------------------------------ */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="global-voice-expanded"
            initial={{ opacity: 0, scale: 0.9, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 12 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="pointer-events-auto flex flex-col items-center gap-3 p-5 rounded-3xl"
            style={{
              background: "var(--servari-glass)",
              backdropFilter: "blur(24px)",
              border: "1px solid rgba(20, 156, 150, 0.25)",
              boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
              width: 260,
            }}
          >
            {/* End-conversation X — top-right of the panel. */}
            <button
              onClick={stopConversation}
              className="self-end -mt-1 -mr-1 p-1.5 rounded-full hover:bg-white/5 transition-colors"
              title="End conversation"
            >
              <X size={16} style={{ color: "var(--servari-red)" }} />
            </button>

            {/* The orb — reflects the REAL conversation state + live amplitude. */}
            <VoiceOrb size={120} state={convState} amplitude={amplitude} />

            {/* Live state line (listening / transcribing / speaking / errors). */}
            <div
              className="text-center"
              style={{ fontSize: "0.8125rem", letterSpacing: "0.3px", minHeight: "1.4em" }}
            >
              {voiceError ? (
                <span style={{ color: "var(--servari-red)" }}>{voiceError}</span>
              ) : micSilent ? (
                <span style={{ color: "var(--servari-red)" }}>
                  I can't hear anything — check your mic
                </span>
              ) : convState === "transcribing" ? (
                <span style={{ color: "var(--servari-teal)" }}>heard you — transcribing…</span>
              ) : convState === "speaking" ? (
                <span style={{ color: "var(--servari-teal)" }}>speaking…</span>
              ) : (
                <span style={{ color: "var(--servari-teal)" }}>listening…</span>
              )}
            </div>

            {/* Last exchange snippet — last words + last reply, dim, 2 lines. */}
            {(lastUserSaid || lastReply) && (
              <div className="w-full space-y-1" style={{ fontSize: "0.75rem", lineHeight: 1.4 }}>
                {lastUserSaid && (
                  <div
                    className="truncate"
                    style={{ color: "var(--servari-dimmed)" }}
                    title={lastUserSaid}
                  >
                    you: {lastUserSaid}
                  </div>
                )}
                {lastReply && (
                  <div
                    className="truncate"
                    style={{ color: "var(--servari-teal-soft)" }}
                    title={lastReply}
                  >
                    servari: {lastReply}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ------------------------------------------------------------------ */}
      {/* COLLAPSED MIC BUTTON — hidden on the dedicated chat route          */}
      {/* ------------------------------------------------------------------ */}
      {showLauncher && (
      <div className="pointer-events-auto flex items-center gap-2">
        {/* Chat toggle button — opens the panel without starting voice */}
        {showMiniChat && (
        <motion.button
          onClick={toggleChat}
          className="relative w-[40px] h-[40px] rounded-full flex items-center justify-center"
          style={{
            background: chatOpen
              ? "rgba(20, 156, 150, 0.15)"
              : "var(--servari-panel)",
            border: chatOpen
              ? "1px solid rgba(20, 156, 150, 0.4)"
              : "1px solid var(--servari-edge-2)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
          }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          title="Toggle chat panel"
        >
          {/* Simple speech-bubble icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
              stroke={chatOpen ? "var(--servari-teal)" : "var(--servari-dimmed)"}
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.button>
        )}

        {/* Main mic / orb button */}
        <motion.button
          onClick={micClick}
          className="relative w-[56px] h-[56px] rounded-full flex items-center justify-center"
          style={{
            background: isListening
              ? "radial-gradient(circle, var(--servari-teal) 0%, var(--servari-teal-dark) 100%)"
              : "var(--servari-panel)",
            border: isListening
              ? "2px solid var(--servari-teal)"
              : "2px solid var(--servari-edge-2)",
            boxShadow: isListening
              ? "0 0 20px rgba(20,156,150,0.5)"
              : "0 6px 20px rgba(0,0,0,0.35)",
          }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          title={
            Voice.inConversation
              ? "Click to send now (flush) · X to end"
              : "Click to talk to SERVARI — anywhere"
          }
        >
          {/* Pulsing rings when active — speed reflects the sub-state. */}
          {isListening &&
            (() => {
              const ringDur =
                convState === "transcribing" ? 0.9 : convState === "speaking" ? 3.2 : 2;
              return (
                <>
                  <motion.div
                    className="absolute inset-0 rounded-full"
                    style={{ border: "2px solid var(--servari-teal)" }}
                    animate={{ scale: [1, 1.35, 1.35], opacity: [0.6, 0, 0] }}
                    transition={{ duration: ringDur, repeat: Infinity, ease: "easeOut" }}
                  />
                  <motion.div
                    className="absolute inset-0 rounded-full"
                    style={{ border: "2px solid var(--servari-teal)" }}
                    animate={{ scale: [1, 1.35, 1.35], opacity: [0.6, 0, 0] }}
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

          {/* Feather/mic icon — teal when idle, ivory when live. */}
          <svg width="28" height="28" viewBox="0 0 36 36" className="relative z-10">
            <path
              d="M18 4 Q15 10, 13 18 Q15 26, 18 32 Q21 26, 23 18 Q21 10, 18 4 Z M18 4 Q16 8, 10 16 M18 12 Q15 16, 11 20 M18 20 Q16 22, 13 26"
              fill="none"
              stroke={isListening ? "var(--servari-ivory)" : "var(--servari-teal)"}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>

          {/* MIC LIVE red pulsing dot */}
          <AnimatePresence>
            {isListening && (
              <motion.span
                key="mic-live-dot"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                className="absolute -top-0.5 -right-0.5 rounded-full"
                style={{
                  width: 12,
                  height: 12,
                  background: "var(--servari-red)",
                  border: "2px solid var(--servari-ink)",
                }}
              >
                <motion.span
                  className="absolute inset-0 rounded-full"
                  style={{ background: "var(--servari-red)" }}
                  animate={{ opacity: [1, 0.2, 1], scale: [1, 1.6, 1] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>
      )}
    </div>
  );
}

export default GlobalVoice;
