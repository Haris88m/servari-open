import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Send } from "lucide-react";
import { API, type ChannelSummary, type Turn } from "../lib/api";
import { sealLabel } from "../lib/display_seal";
import { AgentGrid } from "./AgentGrid";

// ---------------------------------------------------------------------------
// THE AGENTS WINDOW — every agent's chat open at once, the orchestrator on top.
//
// Top-center: the ROOT node (the raven, "the orchestrator", a live one-line
// status, teal glow, breathing). Below: a responsive grid of AGENT CHAT WINDOWS,
// one per channel from API.state().channels — each a glass card with a header
// (name + turn count + owes badge + activity dot), a scrollable body of that
// agent's last 6 turns (API.agentChannel), and a compose footer that sends via
// API.agentSay(name, text) — your direct intervention line.
//
// SVG connection lines run from the root card to each agent window and DRAW
// themselves on mount (pathLength animation), teal + glowing, tracking the real
// card geometry via refs + a ResizeObserver.
//
// DISPLAY SEAL: agent labels (the CHROME) are sealed to clean outward titles.
// The chat CONTENT (the turns + the status line) is the real conversation —
// gated separately by the outbound seal — and is NOT touched here.
// ---------------------------------------------------------------------------

const BODY_TURNS = 6; // how many recent turns each mini-window shows
const POLL_MS = 5000; // per-window channel poll interval
const STAGGER_MS = 650; // gap between each window's poll fire (so they don't all hit at once)

// Operator-side turn sentinels (the user's own messages).
function isOperatorTurn(from: string | undefined): boolean {
  const f = (from || "").toLowerCase();
  return f === "operator" || f === "user";
}

interface AgentMeta {
  name: string;
  label: string;
  turns: number;
  owes: number;
  isIdle: boolean;
}

// A title-cased label from a channel key like "r1-backend-security", then SEALED
// so no internal vocabulary reaches the display.
function labelFor(name: string): string {
  const titled = name
    .replace(/[-_:]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return sealLabel(titled) || titled;
}

// The latest non-operator turn text from the main channel = the orchestrator's
// live one-line status.
function latestSystemLine(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (!isOperatorTurn(turns[i]?.from)) {
      const text = (turns[i].text || "").trim();
      if (text) return text;
    }
  }
  return "";
}

// Trim a turn text to a single readable status line. The agents-dashboard
// previews (workspace mini-bubbles + the central orchestrator status line) are
// a DERIVED chrome surface, not the primary chat surface (/shell/chat keeps its
// own content-exemption). So these previews ALSO pass the display seal:
// sealLabel() maps internal vocabulary to product words and hides anything
// denylisted, so a status line never renders a denylisted term on the display.
function oneLine(text: string, max = 150): string {
  const flat = sealLabel((text || "").replace(/\s+/g, " ").trim());
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

// ---------------------------------------------------------------------------
// One agent chat window — owns its own channel poll (staggered) + compose box.
// ---------------------------------------------------------------------------

interface AgentWindowProps {
  meta: AgentMeta;
  index: number;
  pollDelayMs: number;
  reduce: boolean;
  // report this window's header anchor (in container coords) up to the parent so
  // the SVG can draw a connection line from the root to here.
  registerAnchor: (name: string, el: HTMLElement | null) => void;
}

function AgentWindow({ meta, index, pollDelayMs, reduce, registerAnchor }: AgentWindowProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState(false); // pulse the activity dot briefly when new turns arrive
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const lastCountRef = useRef(0);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // expose the header anchor to the parent for line-drawing.
  useLayoutEffect(() => {
    registerAnchor(meta.name, headerRef.current);
    return () => registerAnchor(meta.name, null);
  }, [meta.name, registerAnchor]);

  const refetch = useCallback(async () => {
    try {
      const res = await API.agentChannel(meta.name);
      const all = res?.turns ?? [];
      const recent = all.slice(-BODY_TURNS);
      setTurns(recent);
      // a growing turn-count = fresh activity → blip the dot.
      if (all.length > lastCountRef.current && lastCountRef.current !== 0) {
        setLive(true);
        if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
        liveTimerRef.current = setTimeout(() => setLive(false), 2400);
      }
      lastCountRef.current = all.length;
    } catch {
      // server degrades gracefully — keep whatever we had.
    }
  }, [meta.name]);

  // staggered polling: first fetch after pollDelayMs, then every POLL_MS.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const startTimer = setTimeout(() => {
      void refetch();
      interval = setInterval(() => void refetch(), POLL_MS);
    }, pollDelayMs);
    return () => {
      clearTimeout(startTimer);
      if (interval) clearInterval(interval);
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    };
  }, [refetch, pollDelayMs]);

  // keep the mini-chat pinned to the newest turn.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    // optimistic operator bubble so the intervention feels instant.
    setTurns((prev) => [...prev, { from: "operator", text, turn: -1 }].slice(-BODY_TURNS));
    try {
      await API.agentSay(meta.name, text);
    } catch {
      // swallow — the next poll reconciles real server state.
    } finally {
      setSending(false);
      void refetch();
    }
  }, [draft, sending, meta.name, refetch]);

  const dotActive = live || !meta.isIdle;

  return (
    <motion.div
      initial={{ opacity: 0, y: 26, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        delay: reduce ? 0 : 0.45 + index * 0.06,
        type: "spring",
        stiffness: 230,
        damping: 22,
      }}
      whileHover={{ y: -4 }}
      className="relative flex flex-col rounded-xl overflow-hidden"
      style={{
        background: "var(--servari-glass)",
        backdropFilter: "blur(24px)",
        border: meta.owes
          ? "1px solid rgba(224, 169, 42, 0.28)"
          : meta.isIdle
            ? "1px solid rgba(250, 248, 243, 0.07)"
            : "1px solid rgba(20, 156, 150, 0.22)",
        minHeight: 264,
      }}
    >
      {/* Header — name + turn count + owes badge + activity dot */}
      <div
        ref={headerRef}
        className="flex items-center gap-2 px-4 py-3"
        style={{ borderBottom: "1px solid rgba(250, 248, 243, 0.06)" }}
      >
        {/* activity dot */}
        <span className="relative flex h-2.5 w-2.5">
          {dotActive && !reduce && (
            <motion.span
              aria-hidden
              className="absolute inline-flex h-full w-full rounded-full"
              style={{ background: "var(--servari-teal)" }}
              animate={{ opacity: [0.6, 0, 0.6], scale: [1, 2.2, 1] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          <span
            className="relative inline-flex h-2.5 w-2.5 rounded-full"
            style={{
              background: dotActive ? "var(--servari-teal)" : "var(--servari-dimmed)",
            }}
          />
        </span>

        <span
          className="flex-1 truncate"
          style={{ color: "var(--servari-ivory)", fontSize: "0.875rem", fontWeight: 500 }}
          title={meta.label}
        >
          {meta.label}
        </span>

        <span
          style={{
            color: "var(--servari-dimmed)",
            fontSize: "0.72rem",
            fontFamily: "var(--font-mono)",
          }}
          title={`${meta.turns} turns on channel`}
        >
          {meta.turns}t
        </span>

        {meta.owes > 0 && (
          <span
            className="px-1.5 py-0.5 rounded"
            style={{
              background: "rgba(224, 169, 42, 0.14)",
              border: "1px solid rgba(224, 169, 42, 0.3)",
              color: "var(--servari-amber)",
              fontSize: "0.66rem",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.3px",
            }}
            title={`owes ${meta.owes} repl${meta.owes === 1 ? "y" : "ies"}`}
          >
            owes {meta.owes}
          </span>
        )}
      </div>

      {/* Body — that agent's last 6 turns, scrollable mini chat bubbles */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2" style={{ maxHeight: 240 }}>
        {turns.length === 0 ? (
          <div
            className="h-full flex items-center justify-center text-center px-3"
            style={{ color: "var(--servari-dimmed)", fontSize: "0.78rem", lineHeight: 1.5 }}
          >
            {meta.isIdle ? "Idle — awaiting next directive" : "Loading channel…"}
          </div>
        ) : (
          turns.map((t, i) => {
            const isOperator = isOperatorTurn(t.from);
            return (
              <motion.div
                key={t.turn !== undefined && t.turn !== null && t.turn >= 0 ? `t${t.turn}` : `i${i}-${t.text?.slice(0, 8)}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22 }}
                className={`flex ${isOperator ? "justify-end" : "justify-start"}`}
              >
                <div
                  className="max-w-[88%] px-3 py-2 rounded-xl"
                  style={{
                    background: isOperator ? "rgba(20, 156, 150, 0.15)" : "rgba(18, 22, 30, 0.6)",
                    border: isOperator
                      ? "1px solid rgba(20, 156, 150, 0.3)"
                      : "1px solid rgba(250, 248, 243, 0.05)",
                    color: "var(--servari-ivory)",
                    fontSize: "0.78rem",
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {oneLine(t.text || "", 320)}
                </div>
              </motion.div>
            );
          })
        )}
      </div>

      {/* Footer — direct-intervention compose box → API.agentSay(name, text) */}
      <div
        className="flex items-center gap-2 px-3 py-2.5"
        style={{ borderTop: "1px solid rgba(250, 248, 243, 0.06)" }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Intervene · ${meta.label}…`}
          className="flex-1 bg-transparent outline-none"
          style={{ color: "var(--servari-ivory)", fontSize: "0.8rem" }}
        />
        <button
          onClick={() => void send()}
          disabled={!draft.trim() || sending}
          className="p-1.5 rounded hover:bg-white/5 transition-colors disabled:opacity-30"
          title="Send to this agent"
        >
          <Send
            size={14}
            style={{ color: draft.trim() ? "var(--servari-teal)" : "var(--servari-dimmed)" }}
          />
        </button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// The view — orchestrator root node + the grid + the self-drawing lines.
// ---------------------------------------------------------------------------

export function AgentsView() {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [statusLine, setStatusLine] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduce = useReducedMotion() ?? false;
  const uid = useRef(`av-${Math.random().toString(36).slice(2, 8)}`).current;

  // geometry: the container, the root card, and each window's header anchor —
  // measured in container-local coordinates so the SVG overlay draws true lines.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorEls = useRef<Map<string, HTMLElement>>(new Map());
  const [lines, setLines] = useState<{ name: string; x1: number; y1: number; x2: number; y2: number }[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  // initial load — the roster + the orchestrator's latest status line.
  useEffect(() => {
    let alive = true;
    API.state()
      .then((s) => {
        if (!alive) return;
        const channels = s.channels || {};
        const list: AgentMeta[] = Object.entries(channels)
          .map(([name, summary]: [string, ChannelSummary]) => {
            const turns = Number(summary?.turns ?? 0);
            const owes = Number(summary?.owes ?? 0);
            return { name, label: labelFor(name), turns, owes, isIdle: turns === 0 };
          })
          .sort((a, b) => b.turns - a.turns);
        setAgents(list);
        setStatusLine(latestSystemLine(s.turns ?? []));
        setLoaded(true);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // keep the orchestrator's one-line status fresh (every 5s).
  useEffect(() => {
    const id = setInterval(() => {
      API.state()
        .then((s) => setStatusLine(latestSystemLine(s.turns ?? [])))
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const registerAnchor = useCallback((name: string, el: HTMLElement | null) => {
    if (el) anchorEls.current.set(name, el);
    else anchorEls.current.delete(name);
  }, []);

  // Recompute the connection lines from the root card's bottom-center to each
  // window header's top-center, in container-local coordinates.
  const measure = useCallback(() => {
    const container = containerRef.current;
    const root = rootRef.current;
    if (!container || !root) return;
    const cRect = container.getBoundingClientRect();
    setSvgSize({ w: container.scrollWidth, h: container.scrollHeight });
    const aRect = root.getBoundingClientRect();
    const ax = aRect.left - cRect.left + aRect.width / 2;
    const ay = aRect.top - cRect.top + aRect.height; // bottom-center of root card
    const next: { name: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const [name, el] of anchorEls.current.entries()) {
      const r = el.getBoundingClientRect();
      const x2 = r.left - cRect.left + r.width / 2;
      const y2 = r.top - cRect.top; // top-center of the window header
      next.push({ name, x1: ax, y1: ay, x2, y2 });
    }
    setLines(next);
  }, []);

  // measure after layout, on resize, and whenever the roster changes. A small
  // rAF chain lets the entrance springs settle into their resting geometry.
  useLayoutEffect(() => {
    if (!loaded) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      measure();
      raf2 = requestAnimationFrame(measure);
    });
    const ro = new ResizeObserver(() => measure());
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", measure);
    // re-measure once the entrance staggers have landed.
    const settle = setTimeout(measure, 900);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(settle);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [loaded, agents, measure]);

  // a gentle downward-bowed bezier, root → window.
  const linePath = (l: { x1: number; y1: number; x2: number; y2: number }) => {
    const midY = (l.y1 + l.y2) / 2;
    return `M ${l.x1} ${l.y1} C ${l.x1} ${midY}, ${l.x2} ${midY}, ${l.x2} ${l.y2}`;
  };

  return (
    <div className="h-full p-8 overflow-auto">
      <div ref={containerRef} className="relative max-w-6xl mx-auto">
        {/* Self-drawing SVG connection lines (behind the cards) */}
        {lines.length > 0 && (
          <svg
            className="pointer-events-none absolute inset-0"
            width={svgSize.w}
            height={svgSize.h}
            viewBox={`0 0 ${svgSize.w} ${svgSize.h}`}
            style={{ zIndex: 0, overflow: "visible" }}
          >
            <defs>
              <filter id={`${uid}-glow`} x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="2.6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {lines.map((l, i) => (
              <motion.path
                key={l.name}
                d={linePath(l)}
                fill="none"
                stroke="var(--servari-teal)"
                strokeWidth={1.4}
                strokeLinecap="round"
                filter={`url(#${uid}-glow)`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 0.32 }}
                transition={{
                  pathLength: {
                    duration: reduce ? 0 : 0.55,
                    delay: reduce ? 0 : 0.5 + i * 0.05,
                    ease: "easeInOut",
                  },
                  opacity: { duration: 0.4, delay: reduce ? 0 : 0.5 + i * 0.05 },
                }}
              />
            ))}
          </svg>
        )}

        {/* ROOT node — the orchestrator, top-center */}
        <div className="relative z-10 flex justify-center mb-12">
          <motion.div
            ref={rootRef}
            initial={{ opacity: 0, y: -16, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 220, damping: 20 }}
            className="relative w-full max-w-xl rounded-2xl px-6 py-5 flex items-center gap-5 overflow-hidden"
            style={{
              background: "radial-gradient(120% 140% at 50% 0%, #1b2230 0%, var(--servari-panel) 70%)",
              border: "1px solid rgba(20, 156, 150, 0.4)",
              boxShadow: "0 0 0 1px rgba(20,156,150,0.18), 0 24px 60px -22px rgba(20,156,150,0.5)",
            }}
          >
            {/* breathing teal glow halo */}
            {!reduce && (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0"
                animate={{ opacity: [0.35, 0.7, 0.35] }}
                transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut" }}
                style={{
                  background:
                    "radial-gradient(80% 120% at 50% 0%, rgba(20,156,150,0.18), transparent 65%)",
                }}
              />
            )}

            {/* the raven, breathing */}
            <motion.div
              className="relative shrink-0 rounded-full flex items-center justify-center"
              style={{
                width: 72,
                height: 72,
                background: "rgba(20, 156, 150, 0.08)",
                border: "1px solid rgba(20, 156, 150, 0.45)",
              }}
              animate={reduce ? undefined : { scale: [1, 1.04, 1] }}
              transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut" }}
            >
              {!reduce && (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-full"
                  style={{ border: "1px solid rgba(20,156,150,0.5)" }}
                  animate={{ opacity: [0.5, 0.05, 0.5], scale: [1, 1.22, 1] }}
                  transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
                />
              )}
              <img
                src="/raven.png"
                alt="Orchestrator"
                width={56}
                height={56}
                draggable={false}
                className="relative select-none"
                style={{
                  width: 56,
                  height: 56,
                  objectFit: "contain",
                  filter: "drop-shadow(0 0 8px rgba(20,156,150,0.6))",
                }}
              />
            </motion.div>

            {/* identity + live status */}
            <div className="relative min-w-0 flex-1">
              <div
                style={{
                  color: "var(--servari-teal-soft)",
                  fontSize: "0.72rem",
                  letterSpacing: "2px",
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                }}
              >
                THE ORCHESTRATOR
              </div>
              <div
                className="mt-1.5 truncate-2"
                style={{
                  color: "var(--servari-ivory)",
                  fontSize: "0.9rem",
                  lineHeight: 1.5,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {statusLine ? oneLine(statusLine, 170) : "Standing by — orchestrating the company."}
              </div>
            </div>
          </motion.div>
        </div>

        {/* Empty / error states */}
        {loaded && !error && agents.length === 0 && (
          <div
            className="relative z-10 p-6 rounded-xl text-center"
            style={{
              background: "var(--servari-glass)",
              border: "1px solid rgba(250, 248, 243, 0.08)",
              color: "var(--servari-dimmed)",
              fontSize: "0.875rem",
            }}
          >
            No agent channels online yet.
          </div>
        )}

        {error && (
          <div
            className="relative z-10 p-6 rounded-xl"
            style={{
              background: "var(--servari-glass)",
              border: "1px solid rgba(248, 81, 73, 0.2)",
              color: "var(--servari-dimmed)",
              fontSize: "0.8125rem",
            }}
          >
            Channels unavailable: {error}
          </div>
        )}

        {/* ── WORKSPACE PANE GRID ─────────────────────────────────────────── */}
        {/* Live orchestration status for the registered agents.                */}
        {/* Polls /api/agents/status every 5 s. Sits above the full agent-chat   */}
        {/* grid so the operator sees dispatch state at a glance before diving    */}
        {/* into conversation logs.                                              */}
        <section className="relative z-10 mb-8">
          <div
            className="font-mono text-[0.62rem] tracking-widest uppercase mb-3"
            style={{ color: "var(--servari-dimmed)" }}
          >
            Agent Workspace
          </div>
          <AgentGrid />
        </section>

        {/* The grid of agent chat windows */}
        {agents.length > 0 && (
          <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {agents.map((agent, i) => (
              <AgentWindow
                key={agent.name}
                meta={agent}
                index={i}
                pollDelayMs={i * STAGGER_MS}
                reduce={reduce}
                registerAnchor={registerAnchor}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentsView;
