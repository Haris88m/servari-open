import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { API, type AgentStatusCell } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

/**
 * SERVARI OS — AgentGrid
 *
 * The workspace pane grid.
 * Polls /api/agents/status every 5000ms and renders one card per agent.
 *
 * Status colours:
 *   live        → teal border + shadow (replied in last 60s)
 *   working     → dim teal border (active but >60s ago)
 *   idle        → muted border (no reply in 5+ min)
 *   done        → green border (last message was [[DONE]])
 *   blocked     → red border (last message was [[BLOCKED]])
 *   error       → red border (channel read failure)
 *   not_started → near-invisible border (channel file missing)
 */

const STATUS_BORDER: Record<string, string> = {
  live:        "border-[#149C96] shadow-[0_0_10px_rgba(20,156,150,0.3)]",
  working:     "border-[#149C96]/50",
  idle:        "border-[#FAF8F3]/15",
  done:        "border-green-500",
  blocked:     "border-red-500",
  error:       "border-red-500/70",
  not_started: "border-[#FAF8F3]/08",
};

const STATUS_DOT: Record<string, string> = {
  live:        "bg-[#149C96] animate-pulse",
  working:     "bg-[#149C96]/60",
  idle:        "bg-[#FAF8F3]/25",
  done:        "bg-green-500",
  blocked:     "bg-red-500",
  error:       "bg-red-400",
  not_started: "bg-[#FAF8F3]/10",
};

const STATUS_LABEL: Record<string, string> = {
  live:        "LIVE",
  working:     "WORKING",
  idle:        "IDLE",
  done:        "DONE",
  blocked:     "BLOCKED",
  error:       "ERROR",
  not_started: "NOT STARTED",
};

// The server's display_name may be shaped "<Role> (<Codename>)". The
// parenthetical is an internal codename that must NEVER reach the display; the
// leading role token may also be internal vocabulary the seal maps to a clean
// outward title. We drop the parenthetical (so the seal doesn't emit a redundant
// double-label), then run the residual through sealLabel() as the fail-closed
// backstop. If the seal strips everything, fall back to a neutral "Agent" so the
// card still renders a header rather than an empty one.
function sealAgentName(displayName: string): string {
  const noCodename = (displayName || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const sealed = sealLabel(noCodename || displayName);
  return sealed || "Agent";
}

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface AgentGridProps {
  agents?: AgentStatusCell[];
  fetchError?: string | null;
  ready?: boolean;
}

export function AgentGrid(props: AgentGridProps = {}) {
  const controlled = props.agents !== undefined;
  const [agents, setAgents] = useState<AgentStatusCell[]>(props.agents ?? []);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (controlled) return;
    let alive = true;

    const poll = () =>
      API.agentsStatus()
        .then((d) => {
          if (!alive) return;
          setAgents(d.agents ?? []);
          setFetchError(d.error ?? null);
          setReady(true);
        })
        .catch((e) => {
          if (!alive) return;
          setFetchError(String(e));
          setReady(true);
        });

    poll();
    const id = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [controlled]);

  useEffect(() => {
    if (!controlled) return;
    setAgents(props.agents ?? []);
  }, [controlled, props.agents]);

  const actualReady = controlled ? (props.ready ?? true) : ready;
  const actualError = controlled ? (props.fetchError ?? null) : fetchError;

  if (!actualReady) {
    return (
      <div
        className="font-mono text-[0.65rem] py-3 text-center"
        style={{ color: "var(--servari-dimmed)" }}
      >
        loading agent workspace…
      </div>
    );
  }

  if (actualError && agents.length === 0) {
    return (
      <div
        className="rounded-lg px-3 py-2 font-mono text-[0.65rem]"
        style={{ color: "var(--servari-dimmed)", border: "1px solid rgba(248,81,73,0.18)" }}
      >
        agent status surface offline - {actualError}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div
        className="font-mono text-[0.65rem] py-3 text-center"
        style={{ color: "var(--servari-dimmed)" }}
      >
        no agents registered
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 w-full">
      {agents.map((agent, i) => {
        const borderClass = STATUS_BORDER[agent.status] ?? STATUS_BORDER.idle;
        const dotClass = STATUS_DOT[agent.status] ?? STATUS_DOT.idle;
        const statusLabel = STATUS_LABEL[agent.status] ?? agent.status.toUpperCase();
        const timeAgo = relTime(agent.latest_reply_ts);

        return (
          <motion.div
            key={agent.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={`
              rounded-xl border p-4 min-h-[136px] flex flex-col gap-2 transition-all duration-300
              ${borderClass}
            `}
            style={{ background: "var(--servari-panel)" }}
          >
            {/* Header: dot + name + status badge */}
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`}
                aria-hidden
              />
              <span
                className="flex-1 truncate font-semibold text-[0.8125rem]"
                style={{ color: "var(--servari-ivory)" }}
                title={sealAgentName(agent.display_name)}
              >
                {sealAgentName(agent.display_name)}
              </span>
              <span
                className="font-mono text-[0.58rem] px-1.5 py-0.5 rounded shrink-0"
                style={{
                  background: "rgba(250,248,243,0.06)",
                  color: "var(--servari-dimmed)",
                  letterSpacing: "0.08em",
                }}
              >
                {statusLabel}
              </span>
            </div>

            {/* Current task — what SERVARI gave it */}
            {agent.current_task ? (
              <div
                className="text-[0.68rem] leading-snug line-clamp-2"
                style={{ color: "var(--servari-dimmed)" }}
              >
                <span style={{ color: "var(--servari-teal)", marginRight: 4 }}>task:</span>
                {agent.current_task}
              </div>
            ) : (
              <div
                className="text-[0.65rem]"
                style={{ color: "var(--servari-dimmed)", opacity: 0.5 }}
              >
                no active task
              </div>
            )}

            {/* Latest reply */}
            {agent.latest_reply && (
              <div
                className="font-mono text-[0.66rem] leading-snug line-clamp-3 mt-auto"
                style={{ color: "var(--servari-ivory)", opacity: 0.82 }}
              >
                {agent.latest_reply}
              </div>
            )}

            {/* Timestamp */}
            {timeAgo && (
              <div
                className="font-mono text-[0.58rem]"
                style={{ color: "var(--servari-dimmed)", opacity: 0.45 }}
              >
                {timeAgo}
              </div>
            )}

            {/* Channel-missing warning */}
            {!agent.channel_exists && (
              <div
                className="font-mono text-[0.6rem] mt-1"
                style={{ color: "#f59e0b", opacity: 0.7 }}
              >
                channel file missing — launch agent first
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

export default AgentGrid;
