import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { API, GridPane, paneTurnCount, paneTurnList } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

interface ProcessTableOverlayProps {
  onClose: () => void;
}

// The non-navigable center node. The grid marks it with this neutral key; it is
// the orchestrator's own row, not an agent you open.
const ROOT_KEY = "root";

// Title-case a channel key like "r1-backend-security", then SEAL it so no
// internal vocabulary reaches the SERVARI display. Mirrors the Company screen's
// labelFor() so both screens speak the same sealed display language. Falls back
// to the titled form if the seal returns empty.
function labelFor(name: string): string {
  if (!name) return "process";
  const titled = name
    .replace(/[-_:]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return sealLabel(titled) || titled;
}

// A pane is "owes" when the server marks an outstanding reply (a truthy, non-zero
// owes value), wins over active/idle. Otherwise active vs idle from status.
function paneOwes(p: GridPane): boolean {
  const o = p.owes as unknown;
  if (typeof o === "number") return o > 0;
  if (typeof o === "string") return o !== "" && o !== "0";
  return Boolean(o);
}

// Map a server pane to a visual status (owes > active > idle).
function paneStatus(p: GridPane): "active" | "idle" | "owes" {
  if (paneOwes(p)) return "owes";
  return p.status === "active" ? "active" : "idle";
}

// "just now" / "2m ago" / "3h ago" / "5d ago" from an ISO last_ts.
function relTime(iso: number | string | null): string {
  if (!iso || typeof iso !== "string") return "dormant";
  const t = Date.parse(iso);
  if (isNaN(t)) return "dormant";
  let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  let m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  let h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

// Build a 10-14 bar sparkline (heights 0-100) from recent turn epoch-secs.
// Older -> newer gradient.
function sparkBars(activity: unknown): number[] {
  const a = Array.isArray(activity) ? activity.slice(-14) : [];
  if (a.length < 2) return [];
  const n = a.length;
  const bars: number[] = [];
  for (let i = 0; i < n; i++) {
    bars.push(Math.round(30 + (i / (n - 1)) * 70));
  }
  return bars;
}

// Latest turn text snippet from a pane's turns array. Uses the canonical
// paneTurnList() accessor (never touches pane.turns raw — that array of turn
// objects rendered directly = React #31). The author label is SEALED. The
// snippet TEXT is a CHROME PREVIEW on the process table (not the primary chat
// surface), so it ALSO passes the display seal: sealLabel() maps internal
// vocabulary to product words and hides anything denylisted, so a process turn
// never renders an internal term on the display. (The main chat surface shows
// the full conversation and keeps its own content-exemption; the table preview
// is structural and seals here.)
function lastSnippet(p: GridPane): { from: string; text: string } | null {
  const turns = paneTurnList(p);
  if (!turns.length) return null;
  const last = turns[turns.length - 1] || ({} as { from?: string; text?: string });
  return {
    from: labelFor(last.from || "?"),
    text: sealLabel((last.text || "").slice(0, 260)),
  };
}

export function ProcessTableOverlay({ onClose }: ProcessTableOverlayProps) {
  const navigate = useNavigate();
  const [panes, setPanes] = useState<GridPane[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reduce = useReducedMotion();

  const load = useCallback(() => {
    return API.grid()
      .then((d) => {
        setPanes(Array.isArray(d.panes) ? d.panes : []);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Poll every 3s while the overlay is open.
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const activeCount = panes.filter((p) => paneStatus(p) === "active").length;
  const owesCount = panes.filter((p) => paneStatus(p) === "owes").length;
  const idleCount = panes.filter((p) => paneStatus(p) === "idle").length;

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active": return 'var(--servari-green)';
      case "owes": return 'var(--servari-amber)';
      case "idle": return 'var(--servari-dimmed)';
      default: return 'var(--servari-dimmed)';
    }
  };

  const openAgent = (p: GridPane) => {
    if (p.key === ROOT_KEY) return; // the center is not a navigable agent
    onClose();
    navigate('/shell?agent=' + encodeURIComponent(p.key));
  };

  return (
    <motion.div
      initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
      animate={{ opacity: 1, backdropFilter: 'blur(32px)' }}
      exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
      transition={{ duration: reduce ? 0 : 0.35, ease: 'easeOut' }}
      className="fixed inset-0 z-[100] flex flex-col"
      style={{
        background:
          'radial-gradient(circle at center, rgba(15, 18, 24, 0.95) 0%, rgba(15, 18, 24, 0.985) 100%)',
        backdropFilter: 'blur(32px)',
      }}
    >
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reduce ? 0 : 0.12, type: 'spring', stiffness: 260, damping: 26 }}
        className="px-8 py-6 flex items-center justify-between"
        style={{
          borderBottom: '1px solid rgba(250, 248, 243, 0.08)',
        }}
      >
        <div>
          <div
            className="mb-2"
            style={{
              color: 'var(--servari-ivory)',
              fontSize: '1.5rem',
              letterSpacing: '1px'
            }}
          >
            PROCESS TABLE
          </div>
          <div
            className="flex items-center gap-4"
            style={{
              color: 'var(--servari-dimmed)',
              fontSize: '0.875rem'
            }}
          >
            <span style={{ color: 'var(--servari-green)' }}>{activeCount} active</span>
            <span style={{ color: 'var(--servari-amber)' }}>{owesCount} owes</span>
            <span>{idleCount} idle</span>
          </div>
        </div>

        <motion.button
          onClick={onClose}
          whileHover={{ scale: 1.08, rotate: 90 }}
          whileTap={{ scale: 0.92 }}
          transition={{ type: 'spring', stiffness: 320, damping: 18 }}
          className="p-2 rounded hover:bg-white/5"
          style={{ color: 'var(--servari-ivory)' }}
        >
          <X size={24} />
        </motion.button>
      </motion.div>

      {/* Agent panes grid */}
      <div className="flex-1 overflow-auto p-8">
        {error && (
          <div
            className="mb-4 p-4 rounded-xl max-w-[1800px] mx-auto"
            style={{
              background: 'var(--servari-glass)',
              border: '1px solid rgba(248, 81, 73, 0.2)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.8125rem',
            }}
          >
            Grid unavailable: {error}
          </div>
        )}
        {!error && panes.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduce ? 0 : 0.3, ease: 'easeOut' }}
            className="max-w-[1800px] mx-auto flex flex-col items-center justify-center text-center py-24"
          >
            <div
              className="mb-2"
              style={{
                color: 'var(--servari-ivory)',
                fontSize: '1.05rem',
                letterSpacing: '0.5px',
              }}
            >
              {/* sealed idle headline */}
              {sealLabel('team idle')}
            </div>
            <div style={{ color: 'var(--servari-dimmed)', fontSize: '0.8125rem' }}>
              No running processes.
            </div>
          </motion.div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-w-[1800px] mx-auto">
          {panes.map((pane, index) => {
            const status = paneStatus(pane);
            const snip = lastSnippet(pane);
            const bars = sparkBars(pane.activity);
            const isRoot = pane.key === ROOT_KEY;
            const paneLabel = labelFor(pane.name);
            const turnCount = paneTurnCount(pane);

            const entranceDelay = reduce ? 0 : Math.min(index, 18) * 0.04;
            const glow =
              status === 'owes'
                ? '0 0 0 1px rgba(224,169,42,0.45), 0 0 26px -6px rgba(224,169,42,0.5)'
                : status === 'active'
                  ? '0 0 0 1px rgba(63,185,80,0.4), 0 0 26px -6px rgba(63,185,80,0.45)'
                  : 'none';

            return (
              <motion.div
                key={pane.key}
                initial={{ opacity: 0, scale: 0.92, y: 22 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{
                  delay: entranceDelay,
                  type: "spring",
                  stiffness: 240,
                  damping: 20,
                }}
                whileHover={isRoot ? undefined : { y: -6, scale: 1.025 }}
                onClick={() => openAgent(pane)}
                className={
                  "relative p-4 rounded-xl " +
                  (isRoot ? "" : "cursor-pointer")
                }
                style={{
                  background: 'var(--servari-glass)',
                  backdropFilter: 'blur(16px)',
                  border:
                    status === 'owes'
                      ? '1px solid rgba(224, 169, 42, 0.4)'
                      : status === 'active'
                        ? '1px solid rgba(63, 185, 80, 0.28)'
                        : '1px solid rgba(250, 248, 243, 0.08)',
                }}
              >
                {/* Live edge-glow — breathes on active / owes panes */}
                {status !== 'idle' && !reduce && (
                  <motion.span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-xl"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0.35, 0.9, 0.35] }}
                    transition={{
                      duration: 3,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: entranceDelay + 0.3,
                    }}
                    style={{ boxShadow: glow }}
                  />
                )}

                {/* Name and status — name SEALED (raw channel keys can carry
                    internal vocab; the seal maps or hides). */}
                <div className="relative flex items-center justify-between mb-3">
                  <div
                    className="min-w-0 truncate"
                    style={{
                      color: 'var(--servari-ivory)',
                      fontSize: '0.9375rem',
                      fontWeight: 500
                    }}
                    title={paneLabel}
                  >
                    {paneLabel}
                  </div>
                  <motion.div
                    className="w-2 h-2 rounded-full flex-shrink-0 ml-2"
                    style={{ background: getStatusColor(status) }}
                    animate={status !== "idle" ? { opacity: [1, 0.5, 1] } : {}}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  />
                </div>

                {/* Meta: turn count + relative last-active */}
                <div
                  className="relative flex items-center justify-between mb-3"
                  style={{ fontSize: '0.75rem' }}
                >
                  <span
                    style={{
                      color: status === 'owes' ? 'var(--servari-amber)' : 'var(--servari-dimmed)',
                    }}
                  >
                    {status === 'owes' ? 'owes a reply' : `${turnCount} turns`}
                  </span>
                  <span style={{ color: status === 'active' ? 'var(--servari-green)' : 'var(--servari-dimmed)' }}>
                    {relTime(pane.last_ts)}
                  </span>
                </div>

                {/* Snippet */}
                <div
                  className="relative mb-3 line-clamp-2"
                  style={{
                    color: 'var(--servari-dimmed)',
                    fontSize: '0.8125rem',
                    lineHeight: '1.4'
                  }}
                >
                  {snip ? (
                    <>
                      <span style={{ color: 'var(--servari-teal)' }}>{snip.from}: </span>
                      {snip.text}
                    </>
                  ) : (
                    'no turns yet'
                  )}
                </div>

                {/* Activity sparkline — bars rise sequentially on mount */}
                <div className="relative flex items-end gap-1 h-8">
                  {bars.length ? (
                    bars.map((value, i) => (
                      <motion.div
                        key={i}
                        className="flex-1 rounded-t origin-bottom"
                        initial={{ height: "0%", opacity: 0 }}
                        animate={{ height: `${value}%`, opacity: 1 }}
                        transition={{
                          delay: reduce ? 0 : entranceDelay + 0.15 + i * 0.035,
                          type: "spring",
                          stiffness: 200,
                          damping: 18,
                        }}
                        style={{
                          background:
                            status === "active"
                              ? 'rgba(63, 185, 80, 0.5)'
                              : status === "owes"
                                ? 'rgba(224, 169, 42, 0.5)'
                                : 'rgba(138, 148, 162, 0.3)',
                        }}
                      />
                    ))
                  ) : (
                    <div style={{ color: 'var(--servari-dimmed)', fontSize: '0.7rem' }}>
                      no activity
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
