import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Mic, MicOff, Send } from "lucide-react";
import { COMPOSED, SNAPPY } from "../lib/motion";
import { VoiceOrb } from "./VoiceOrb";
import { Voice } from "../lib/voice";
import { API, type Turn } from "../lib/api";

interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ChatPanel({ isOpen, onClose }: ChatPanelProps) {
  const [messages, setMessages] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [voiceState, setVoiceState] = useState({
    listening: Voice.isListening || Voice.inConversation,
    unavailable: Voice.sttUnavailable,
    convState: Voice.conversationState,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Subscribe to voice state
  useEffect(() => {
    const apply = () => {
      setVoiceState({
        listening: Voice.isListening || Voice.inConversation,
        unavailable: Voice.sttUnavailable,
        convState: Voice.conversationState,
      });
    };
    const unsub = Voice.onStateChange(apply);
    const id = setInterval(apply, 1000);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);

  // Load messages (poll when open)
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    const load = async () => {
      try {
        const state = await API.state();
        if (!alive) return;
        setMessages(state.turns.slice(-40));
      } catch { /* graceful */ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [isOpen]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    // Optimistic update
    setMessages((prev) => [...prev, { from: "operator", text, ts: new Date().toISOString() }]);
    try {
      await API.say(text);
      // Reload after delay to get the reply
      setTimeout(async () => {
        try {
          const state = await API.state();
          setMessages(state.turns.slice(-40));
        } catch { /* keep */ }
        setSending(false);
      }, 1200);
    } catch {
      setSending(false);
    }
  }, [input, sending]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const voiceLabel =
    voiceState.listening
      ? voiceState.convState === "transcribing"
        ? "transcribing"
        : voiceState.convState === "speaking"
          ? "speaking"
          : "listening"
      : voiceState.unavailable
        ? "unavailable"
        : "ready";

  const hasInput = input.trim().length > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed right-0 bottom-0 flex flex-col z-40"
          style={{
            top: 46,
            width: 380,
            background: "var(--s-glass)",
            backdropFilter: "blur(28px)",
            borderLeft: "1px solid var(--s-edge)",
          }}
          initial={{ x: 380 }}
          animate={{ x: 0 }}
          exit={{ x: 380 }}
          transition={COMPOSED}
        >
          {/* HEADER */}
          <div
            className="flex items-center gap-3 px-4 shrink-0"
            style={{ height: 56, borderBottom: "1px solid var(--s-edge-subtle)" }}
          >
            <img
              src="/raven.png"
              alt="SERVARI"
              style={{
                width: 20,
                height: 20,
                objectFit: "contain",
                filter: "drop-shadow(0 0 4px rgba(20,156,150,0.5))",
              }}
              draggable={false}
            />
            <span
              style={{
                fontSize: "var(--t-14)",
                color: "var(--s-text-primary)",
                fontWeight: 600,
                letterSpacing: "var(--ls-caps)",
              }}
            >
              SERVARI
            </span>

            <div className="flex-1" />

            {/* Compact VoiceOrb + state label */}
            <div className="flex flex-col items-center mr-2">
              <VoiceOrb
                size={48}
                state={
                  voiceState.listening
                    ? ((voiceState.convState as "idle" | "listening" | "transcribing" | "speaking") ||
                        "listening")
                    : "idle"
                }
              />
              <span
                style={{
                  fontSize: "var(--t-10)",
                  color: "var(--s-text-secondary)",
                  marginTop: 2,
                  letterSpacing: "var(--ls-wide)",
                }}
              >
                {voiceLabel}
              </span>
            </div>

            {/* Close */}
            <motion.button
              onClick={onClose}
              className="p-1.5 rounded"
              whileHover={{ backgroundColor: "var(--s-hover-bg)" }}
              transition={SNAPPY}
              style={{ color: "var(--s-text-secondary)" }}
            >
              <X size={16} />
            </motion.button>
          </div>

          {/* MESSAGES */}
          <div className="flex-1 overflow-auto p-4 flex flex-col gap-2">
            {messages.length === 0 && (
              <div
                className="flex-1 flex items-center justify-center"
                style={{ fontSize: "var(--t-13)", color: "var(--s-text-secondary)" }}
              >
                Start speaking or type below
              </div>
            )}
            {messages.map((msg, i) => {
              const isOp =
                msg.from === "user" || msg.from === "operator";
              const isError = msg.error === true;
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={SNAPPY}
                  className="flex"
                  style={{ justifyContent: isOp ? "flex-end" : "flex-start" }}
                >
                  <div
                    style={{
                      maxWidth: "60%",
                      padding: "8px 12px",
                      borderRadius: isOp ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                      background: isError
                        ? "rgba(217,119,6,0.10)"
                        : isOp
                          ? "rgba(20,156,150,0.12)"
                          : "var(--s-panel)",
                      border: isError ? "1px solid rgba(217,119,6,0.55)" : undefined,
                      fontSize: "var(--t-13)",
                      color: isError
                        ? "#f59e0b"
                        : isOp
                          ? "var(--s-text-primary)"
                          : "var(--s-text-secondary)",
                      lineHeight: 1.5,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {msg.text}
                  </div>
                </motion.div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* COMPOSE */}
          <div
            className="flex items-center gap-2 px-4 shrink-0"
            style={{ height: 56, borderTop: "1px solid var(--s-edge)" }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask SERVARI..."
              className="flex-1 bg-transparent outline-none"
              style={{
                fontSize: "var(--t-13)",
                color: "var(--s-text-primary)",
                fontFamily: "var(--font-mono)",
              }}
            />
            <motion.button
              onClick={sending || voiceState.listening ? undefined : sendMessage}
              className="grid place-items-center rounded-md"
              style={{
                width: 32,
                height: 32,
                background:
                  hasInput || voiceState.listening ? "var(--servari-teal)" : "transparent",
                color:
                  hasInput || voiceState.listening
                    ? "var(--servari-ink)"
                    : "var(--s-text-secondary)",
                border: "none",
                cursor: hasInput ? "pointer" : "default",
                transition: "background 0.15s, color 0.15s",
              }}
              whileHover={hasInput ? { scale: 1.05 } : {}}
              whileTap={hasInput ? { scale: 0.95 } : {}}
            >
              {voiceState.listening ? (
                <motion.span
                  animate={{ opacity: [1, 0.4, 1] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                  style={{ display: "flex" }}
                >
                  <Mic size={14} />
                </motion.span>
              ) : voiceState.unavailable ? (
                <MicOff size={14} />
              ) : hasInput ? (
                <Send size={14} />
              ) : (
                <Mic size={14} />
              )}
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
