import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { motion, useReducedMotion } from "motion/react";
import {
  Briefcase,
  Code,
  FlaskConical,
  Shield,
  DollarSign,
  Wrench,
  MessageSquare,
  Users,
  Cpu,
  Rocket,
  Megaphone,
  Mail,
  Boxes,
  LayoutGrid,
  ArrowRight,
} from "lucide-react";
import { API, ChannelSummary, GridPane } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

// Icon pool — assigned per-agent by a stable hash of the channel name so the
// same agent always gets the same icon.
const ICON_POOL = [
  Wrench,
  Briefcase,
  Code,
  FlaskConical,
  Shield,
  DollarSign,
  Users,
  Cpu,
  Rocket,
  Megaphone,
  Mail,
  Boxes,
];

function iconFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ICON_POOL[h % ICON_POOL.length];
}

// A title-cased label from a channel key like "r1-backend-security", then SEALED
// so no internal vocabulary reaches the display.
function labelFor(name: string) {
  const titled = name
    .replace(/[-_:]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return sealLabel(titled) || titled;
}

// Build a real sparkline from /api/grid pane activity[] timestamps.
// activity[] is an array of epoch-second numbers (most recent last).
// We bucket them into 10 columns, weight by recency, height 8-96.
// Falls back to flat low bars when activity is empty (honest idle state).
function sparkFromActivity(activity: unknown[], idle: boolean): number[] {
  if (!activity.length || idle) {
    // honest flat line — not fake random heights
    return Array.from({ length: 10 }, () => 8);
  }
  const NUM_BARS = 10;
  const secs = (activity as number[]).filter((v) => typeof v === "number");
  if (secs.length < 2) return Array.from({ length: NUM_BARS }, () => 16);
  const newest = secs[secs.length - 1];
  const oldest = secs[0];
  const span = Math.max(newest - oldest, 1);
  const buckets = Array.from({ length: NUM_BARS }, () => 0);
  for (const ts of secs) {
    const idx = Math.min(NUM_BARS - 1, Math.floor(((ts - oldest) / span) * NUM_BARS));
    buckets[idx]++;
  }
  const maxCount = Math.max(...buckets, 1);
  return buckets.map((c) => Math.max(8, Math.round(8 + (c / maxCount) * 88)));
}

interface AgentCard {
  name: string;
  label: string;
  turns: number;
  owes: number;
  isIdle: boolean;
  statusText: string;
  activity: number[];
}

export function Company() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    let alive = true;
    // Fetch both state (turn counts / owes) AND grid (real activity timestamps).
    Promise.all([API.state(), API.grid()])
      .then(([s, g]) => {
        if (!alive) return;
        const channels = s.channels || {};
        // Build a lookup from pane name → grid pane (for activity[]).
        const gridByName: Record<string, GridPane> = {};
        for (const pane of g.panes ?? []) {
          gridByName[pane.name] = pane;
        }
        const cards: AgentCard[] = Object.entries(channels)
          .map(([name, summary]: [string, ChannelSummary]) => {
            const turns = Number(summary?.turns ?? 0);
            const owes = Number(summary?.owes ?? 0);
            const isIdle = turns === 0;
            const statusText = owes
              ? `Owes ${owes} — awaiting reply`
              : isIdle
                ? "Idle — awaiting next directive"
                : `Active — ${turns} turn${turns === 1 ? "" : "s"} on channel`;
            // Use real activity timestamps from /api/grid if the pane is there.
            const gridPane = gridByName[name];
            const rawActivity = Array.isArray(gridPane?.activity) ? (gridPane.activity as number[]) : [];
            return {
              name,
              label: labelFor(name),
              turns,
              owes,
              isIdle,
              statusText,
              activity: sparkFromActivity(rawActivity, isIdle),
            };
          })
          .sort((a, b) => b.turns - a.turns);
        setAgents(cards);
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

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div
            style={{
              color: 'var(--servari-ivory)',
              fontSize: '1.5rem',
              letterSpacing: '1px'
            }}
          >
            THE COMPANY
          </div>

          {/* Gateway to the deep AgentsView — every chat open at once,
              the orchestrator view. */}
          <motion.button
            onClick={() => navigate('/shell/agents')}
            whileHover={{ scale: 1.04, y: -1 }}
            whileTap={{ scale: 0.97 }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl"
            style={{
              background: 'rgba(20, 156, 150, 0.12)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(20, 156, 150, 0.4)',
              color: 'var(--servari-teal-soft)',
              fontSize: '0.8125rem',
              letterSpacing: '0.5px',
              boxShadow: '0 0 0 1px rgba(20,156,150,0.12), 0 14px 36px -16px rgba(20,156,150,0.45)',
            }}
            title="Open every agent's chat at once — the orchestrator view"
          >
            <LayoutGrid size={15} />
            <span>All agents · the orchestrator view</span>
            <ArrowRight size={15} />
          </motion.button>
        </div>

        {loaded && !error && agents.length === 0 && (
          <div
            className="p-6 rounded-xl"
            style={{
              background: 'var(--servari-glass)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.875rem',
            }}
          >
            No agent channels online yet.
          </div>
        )}

        {error && (
          <div
            className="p-6 rounded-xl"
            style={{
              background: 'var(--servari-glass)',
              border: '1px solid rgba(248, 81, 73, 0.2)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.8125rem',
            }}
          >
            Channels unavailable: {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {agents.map((agent, index) => {
            const Icon = iconFor(agent.name);
            const isIdle = agent.isIdle;

            const entranceDelay = reduce ? 0 : index * 0.055;

            return (
              <motion.div
                key={agent.name}
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  delay: entranceDelay,
                  type: "spring",
                  stiffness: 230,
                  damping: 20,
                }}
                whileHover={{ y: -8 }}
                className="group relative"
              >
                <motion.div
                  className="relative p-6 rounded-xl cursor-pointer overflow-hidden"
                  onClick={() => navigate('/shell?agent=' + encodeURIComponent(agent.name))}
                  initial={{ boxShadow: '0 0 0 0 rgba(20,156,150,0)' }}
                  whileHover={{
                    boxShadow: isIdle
                      ? '0 18px 40px -16px rgba(0,0,0,0.6)'
                      : '0 0 0 1px rgba(20,156,150,0.45), 0 18px 44px -14px rgba(20,156,150,0.35)',
                  }}
                  transition={{ duration: 0.3 }}
                  style={{
                    background: 'var(--servari-glass)',
                    backdropFilter: 'blur(24px)',
                    border: '1px solid rgba(250, 248, 243, 0.08)',
                  }}
                >
                  {/* sweep highlight on hover */}
                  {!isIdle && (
                    <motion.span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100"
                      style={{
                        background:
                          'radial-gradient(120% 80% at 50% 0%, rgba(20,156,150,0.10), transparent 60%)',
                        transition: 'opacity 0.35s ease',
                      }}
                    />
                  )}

                  {/* Icon avatar */}
                  <motion.div
                    className="relative w-16 h-16 rounded-full flex items-center justify-center mb-4"
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: entranceDelay + 0.08, type: "spring", stiffness: 260, damping: 16 }}
                    whileHover={{ scale: 1.06, rotate: isIdle ? 0 : -4 }}
                    style={{
                      background: isIdle
                        ? 'rgba(138, 148, 162, 0.1)'
                        : 'rgba(20, 156, 150, 0.1)',
                      border: isIdle
                        ? '1px solid rgba(138, 148, 162, 0.2)'
                        : '1px solid rgba(20, 156, 150, 0.3)',
                    }}
                  >
                    {/* live halo for active agents */}
                    {!isIdle && !reduce && (
                      <motion.span
                        aria-hidden
                        className="absolute inset-0 rounded-full"
                        animate={{ opacity: [0.5, 0.1, 0.5], scale: [1, 1.18, 1] }}
                        transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
                        style={{ border: '1px solid rgba(20,156,150,0.4)' }}
                      />
                    )}
                    <Icon
                      size={28}
                      style={{
                        color: isIdle ? 'var(--servari-dimmed)' : 'var(--servari-teal)'
                      }}
                    />
                  </motion.div>

                  {/* Role name */}
                  <div
                    className="relative mb-2"
                    style={{
                      color: 'var(--servari-ivory)',
                      fontSize: '1.125rem',
                      fontWeight: 500
                    }}
                  >
                    {agent.label}
                  </div>

                  {/* Status */}
                  <div
                    className="relative mb-4 text-sm"
                    style={{
                      color: agent.owes
                        ? 'var(--servari-amber)'
                        : isIdle
                          ? 'var(--servari-dimmed)'
                          : 'var(--servari-teal)',
                      fontSize: '0.8125rem'
                    }}
                  >
                    {agent.statusText}
                  </div>

                  {/* Activity sparkline — bars rise sequentially on mount */}
                  <div className="relative mb-4 flex items-end gap-1 h-12">
                    {agent.activity.map((value, i) => (
                      <motion.div
                        key={i}
                        className="flex-1 rounded-t origin-bottom"
                        initial={{ height: "0%", opacity: 0 }}
                        animate={{ height: `${value}%`, opacity: 1 }}
                        transition={{
                          delay: reduce ? 0 : entranceDelay + 0.2 + i * 0.04,
                          type: "spring",
                          stiffness: 210,
                          damping: 18,
                        }}
                        style={{
                          background: isIdle
                            ? 'rgba(138, 148, 162, 0.3)'
                            : 'rgba(20, 156, 150, 0.5)',
                        }}
                      />
                    ))}
                  </div>

                  {/* Open channel button */}
                  <motion.button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate('/shell?agent=' + encodeURIComponent(agent.name));
                    }}
                    whileHover={{ scale: 1.02, backgroundColor: 'rgba(20,156,150,0.08)' }}
                    whileTap={{ scale: 0.98 }}
                    className="relative w-full py-2 px-4 rounded-lg flex items-center justify-center gap-2"
                    style={{
                      border: '1px solid rgba(250, 248, 243, 0.1)',
                      color: 'var(--servari-ivory)',
                      fontSize: '0.8125rem',
                    }}
                  >
                    <MessageSquare size={14} />
                    Open Channel
                  </motion.button>
                </motion.div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
