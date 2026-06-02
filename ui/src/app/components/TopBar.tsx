import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { Mic, MicOff, Grid3x3 } from "lucide-react";
import { motion } from "motion/react";
import { API } from "../lib/api";
import { Voice } from "../lib/voice";
import { INSTANT } from "../lib/motion";

interface TopBarProps {
  activeAppName: string;
  onProcessTableClick: () => void;
}

// ---------------------------------------------------------------------------
// useCountUp — animate a displayed number from its previous value to the next.
// Only fires when `target` actually changes — no re-animation on re-renders.
// ---------------------------------------------------------------------------
function useCountUp(target: number, duration = 700): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const prevTarget = useRef(target);

  useEffect(() => {
    // Skip animation when value hasn't changed
    if (prevTarget.current === target) return;
    prevTarget.current = target;

    const from = fromRef.current;
    const to = target;
    if (from === to) {
      setDisplay(to);
      return;
    }
    if (typeof document !== "undefined" && document.hidden) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const v = from + (to - from) * easeOut(p);
      setDisplay(v);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        rafRef.current = null;
      }
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      fromRef.current = to;
    };
  }, [target, duration]);

  return display;
}

// Health dot status
function dotStatus(value: unknown): "active" | "idle" {
  if (value === undefined || value === null) return "idle";
  if (typeof value === "boolean") return value ? "active" : "idle";
  if (typeof value === "object" && Object.keys(value as object).length === 0) return "idle";
  return "active";
}

// Derive {level, color} from a pressure number or string
function readPressure(p: number | string | undefined): { level: string; color: string } {
  if (p === undefined || p === null) return { level: "—", color: "var(--servari-dimmed)" };
  if (typeof p === "string") {
    const up = p.trim().toUpperCase();
    if (up.startsWith("LOW")) return { level: "LOW", color: "var(--s-status-ok)" };
    if (up.startsWith("MOD") || up.startsWith("MED")) return { level: "MED", color: "var(--s-status-warn)" };
    if (up.startsWith("HIGH") || up.startsWith("CRIT")) return { level: "HIGH", color: "var(--s-status-error)" };
    const n = Number(up);
    if (!Number.isNaN(n)) return readPressure(n);
    return { level: up, color: "var(--servari-dimmed)" };
  }
  const frac = p > 1 ? Math.min(1, p / 100) : Math.min(1, Math.max(0, p));
  if (frac < 0.4) return { level: "LOW", color: "var(--s-status-ok)" };
  if (frac < 0.75) return { level: "MED", color: "var(--s-status-warn)" };
  return { level: "HIGH", color: "var(--s-status-error)" };
}

function formatTokens(n: number | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function TopBar({ activeAppName, onProcessTableClick }: TopBarProps) {
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());

  const [healthDots, setHealthDots] = useState([
    { status: "idle" as "active" | "idle", tooltip: "Heartbeat" },
    { status: "idle" as "active" | "idle", tooltip: "Roster" },
    { status: "idle" as "active" | "idle", tooltip: "Integration" },
  ]);
  const [pressure, setPressure] = useState(readPressure(undefined));
  const [tokens, setTokens] = useState<{ total: number; cost: number }>({ total: 0, cost: 0 });
  const [gateCount, setGateCount] = useState(0);

  const [voiceState, setVoiceState] = useState<{
    listening: boolean;
    unavailable: boolean;
    convState: string;
  }>({
    listening: Voice.isListening || Voice.inConversation,
    unavailable: Voice.sttUnavailable,
    convState: Voice.conversationState,
  });

  // 1s clock
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Voice subscription
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
    return () => { unsub(); clearInterval(id); };
  }, []);

  // Health + pressure + gates (every 5s)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [state, ctx] = await Promise.all([API.state(), API.context()]);
        if (!alive) return;
        const h = state.health || {};
        setHealthDots([
          { status: dotStatus(h.heartbeat), tooltip: "Heartbeat" },
          { status: dotStatus(h.roster), tooltip: "Roster" },
          { status: dotStatus(h.integration), tooltip: "Integration" },
        ]);
        setPressure(readPressure(ctx.pressure?.pressure as number | string | undefined));
        // count open gates from state
        const openGates = (state as unknown as { open_gates?: unknown[] }).open_gates ?? [];
        setGateCount(openGates.length);
      } catch { /* keep last */ }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Token ticker (every 5s)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const t = await API.tokens();
        if (!alive) return;
        const liveTotal = t.live?.total_tokens ?? 0;
        const liveCost = t.live?.cost_usd ?? 0;
        if (liveTotal > 0) {
          setTokens({ total: liveTotal, cost: liveCost });
        } else {
          const all = t.summary?.all_time;
          setTokens({ total: all?.total_tokens ?? 0, cost: all?.cost_usd ?? 0 });
        }
      } catch { /* keep last */ }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const tokensDisplay = useCountUp(tokens.total);
  const costDisplay = useCountUp(tokens.cost);

  const formatTime = (date: Date) =>
    date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  const voiceLabel =
    voiceState.listening
      ? voiceState.convState === "transcribing"
        ? "transcribing"
        : voiceState.convState === "speaking"
          ? "speaking"
          : "listening"
      : voiceState.unavailable
        ? "no STT"
        : "ready";

  return (
    <div
      className="fixed top-0 left-0 right-0 h-[46px] z-50 flex items-center justify-between px-4"
      style={{
        background: "var(--s-glass)",
        backdropFilter: "blur(24px)",
        borderBottom: "1px solid var(--s-edge-subtle)",
      }}
    >
      {/* ── LEFT (240px) ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3" style={{ width: 240 }}>
        {/* Raven — breathes */}
        <motion.img
          src="/raven.png"
          alt="SERVARI"
          className="select-none cursor-pointer"
          draggable={false}
          style={{ width: 24, height: 24, objectFit: "contain", filter: "drop-shadow(0 0 6px rgba(20,156,150,0.45))" }}
          animate={{ scale: [1, 1.03, 1] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          onClick={() => navigate("/shell")}
        />

        {/* Wordmark — Playfair, ivory base with teal-glow A + I (SERV A R I) */}
        <span
          style={{
            fontFamily: "var(--font-wordmark)",
            fontSize: "var(--t-16)",
            letterSpacing: "var(--ls-caps)",
            fontWeight: 600,
            lineHeight: 1,
            whiteSpace: "pre",
          }}
        >
          <span style={{ color: "var(--s-text-primary)" }}>SERV</span>
          <span style={{ color: "var(--s-text-teal)", textShadow: "0 0 8px rgba(20,156,150,0.7)" }}>A</span>
          <span style={{ color: "var(--s-text-primary)" }}>R</span>
          <span style={{ color: "var(--s-text-teal)", textShadow: "0 0 8px rgba(20,156,150,0.7)" }}>I</span>
        </span>

        {/* Divider */}
        <div className="w-px h-5 shrink-0" style={{ background: "var(--s-edge-subtle)" }} />

        {/* Active app name */}
        <span
          style={{
            color: "var(--s-text-secondary)",
            fontSize: "var(--t-13)",
            letterSpacing: "var(--ls-wide)",
            textTransform: "uppercase",
          }}
        >
          {activeAppName}
        </span>
      </div>

      {/* ── CENTER (flex-1) ─────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3"
        style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-13)", color: "var(--s-text-secondary)" }}
      >
        {/* Clock */}
        <span className="tabular-nums">{formatTime(time)}</span>

        <span style={{ color: "var(--s-edge)" }}>·</span>

        {/* Token ticker */}
        <button
          onClick={() => navigate("/shell/tokens")}
          className="flex items-center gap-1 hover:opacity-100 transition-opacity"
          style={{ opacity: 0.9 }}
          title="Token spend — open Tokens panel"
        >
          <motion.span
            key={`tok-${tokens.total}`}
            className="tabular-nums"
            style={{ color: "var(--s-text-teal)", fontWeight: 600 }}
            initial={{ textShadow: "0 0 10px rgba(20,156,150,0.9)" }}
            animate={{ textShadow: "0 0 0px rgba(20,156,150,0)" }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          >
            {formatTokens(Math.round(tokensDisplay))}
          </motion.span>
          <span>tok</span>
          <span>·</span>
          <motion.span
            key={`cost-${tokens.cost.toFixed(2)}`}
            className="tabular-nums"
            style={{ color: "var(--s-text-secondary)" }}
            initial={{ textShadow: "0 0 8px rgba(20,156,150,0.6)" }}
            animate={{ textShadow: "0 0 0px rgba(20,156,150,0)" }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          >
            ${costDisplay.toFixed(2)}
          </motion.span>
        </button>

        <span style={{ color: "var(--s-edge)" }}>·</span>

        {/* Gate chip */}
        <span
          style={{
            fontSize: "var(--t-11)",
            color: gateCount > 0 ? "var(--s-status-warn)" : "var(--s-text-secondary)",
            letterSpacing: "var(--ls-wide)",
          }}
        >
          {gateCount > 0 ? `${gateCount} gate${gateCount === 1 ? "" : "s"}` : "no gates"}
        </span>
      </div>

      {/* ── RIGHT (240px) ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 justify-end" style={{ width: 240 }}>
        {/* Health dots — 800ms stagger pulse (sequential, not simultaneous) */}
        <div className="flex items-center gap-1.5">
          {healthDots.map((dot, i) => {
            const active = dot.status === "active";
            return (
              <div key={i} className="relative group">
                {active && (
                  <motion.span
                    className="absolute rounded-full pointer-events-none"
                    style={{ width: 6, height: 6, background: "var(--s-status-ok)", top: 0, left: 0 }}
                    animate={{ opacity: [0.4, 0, 0.4], scale: [1, 2.2, 1] }}
                    transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", delay: i * 0.8 }}
                  />
                )}
                <motion.div
                  className="w-1.5 h-1.5 rounded-full relative z-10"
                  style={{
                    background: active ? "var(--s-status-ok)" : "var(--s-text-secondary)",
                    boxShadow: active ? "var(--s-glow-green)" : "none",
                    opacity: active ? 1 : 0.4,
                  }}
                  animate={active ? { opacity: [1, 0.6, 1] } : { opacity: 0.4 }}
                  transition={{ duration: 2.4, repeat: active ? Infinity : 0, ease: "easeInOut", delay: i * 0.8 }}
                />
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap bg-black/90 text-white px-2 py-1 rounded text-xs z-50">
                  {dot.tooltip}
                </div>
              </div>
            );
          })}
        </div>

        {/* CTX pressure — text badge, no SVG arc */}
        <span
          style={{
            fontSize: "var(--t-11)",
            color: pressure.color,
            letterSpacing: "var(--ls-wide)",
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
          }}
        >
          CTX {pressure.level}
        </span>

        {/* Voice state pill — single pill, red border when listening */}
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
          style={{
            background: voiceState.listening ? "rgba(20,156,150,0.10)" : "var(--s-hover-bg)",
            border: voiceState.listening
              ? "1.5px solid var(--servari-red)"
              : voiceState.unavailable
                ? "1px solid var(--s-status-error)"
                : "1px solid var(--s-edge-subtle)",
          }}
        >
          {voiceState.listening ? (
            <motion.span
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
              style={{ display: "flex" }}
            >
              <Mic size={12} style={{ color: "var(--servari-teal)" }} />
            </motion.span>
          ) : voiceState.unavailable ? (
            <MicOff size={12} style={{ color: "var(--s-status-error)" }} />
          ) : (
            <Mic size={12} style={{ color: "var(--s-text-secondary)" }} />
          )}
          <span
            style={{
              fontSize: "var(--t-12)",
              color: voiceState.listening
                ? "var(--servari-teal)"
                : voiceState.unavailable
                  ? "var(--s-status-error)"
                  : "var(--s-text-secondary)",
            }}
          >
            {voiceLabel}
          </span>
        </div>

        {/* Grid / process table button */}
        <motion.button
          onClick={onProcessTableClick}
          className="p-1.5 rounded"
          whileHover={{ backgroundColor: "var(--s-hover-bg)" }}
          transition={INSTANT}
          style={{ color: "var(--servari-teal)" }}
          title="Process table"
        >
          <Grid3x3 size={18} />
        </motion.button>
      </div>
    </div>
  );
}
