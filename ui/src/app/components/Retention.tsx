import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { API } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

// --- shapes from the retention server module (typed locally; the API marks these unknown[]) ---
interface PendingRun {
  run_id: string;
  ts?: string;
  targets?: string[];
  metric_ids?: string[];
  baseline_scores?: Record<string, number>;
}
interface HistoryRun {
  run_id?: string;
  decision?: string; // "KEEP" | "REVERT"
  ts?: string;
  baseline_scores?: Record<string, number>;
  after_scores?: Record<string, number>;
  reasons?: string[];
  restored_files?: string[];
}

function relTime(ts?: string): string {
  if (!ts) return "";
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts;
  const diff = Date.now() - parsed;
  if (diff < 0) return "just now";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// Pick the first metric id that exists in the score map (the headline metric).
function primaryMetric(
  baseline: Record<string, number> = {},
  after?: Record<string, number>
): { metric: string; baseline: number; current: number | null; change: number | null } {
  const keys = Object.keys(baseline).length
    ? Object.keys(baseline)
    : after
      ? Object.keys(after)
      : [];
  if (!keys.length) return { metric: "score", baseline: 0, current: null, change: null };
  const k = keys[0];
  const b = Number(baseline[k] ?? 0);
  const c = after && after[k] !== undefined ? Number(after[k]) : null;
  let change: number | null = null;
  if (c !== null && b !== 0) change = ((c - b) / Math.abs(b)) * 100;
  else if (c !== null && b === 0) change = c === 0 ? 0 : 100;
  return { metric: k, baseline: b, current: c, change };
}

export function Retention() {
  const [pending, setPending] = useState<PendingRun[]>([]);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const d = await API.retention();
      if (d.error) {
        setError(d.error);
        setPending([]);
        setHistory([]);
      } else {
        setError(null);
        setPending((d.pending || []) as PendingRun[]);
        setHistory((d.history || []) as HistoryRun[]);
      }
    } catch {
      setError("retention unavailable");
      setPending([]);
      setHistory([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const decide = async (runId: string) => {
    try {
      await API.retentionDecide(runId);
    } catch {
      /* server degrades gracefully */
    }
    load();
  };

  // history is oldest-last from the backend; show newest first, capped at 20
  // (matches the server's /api/retention history[20] contract).
  const recentHistory = [...history].reverse().slice(0, 20);

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="max-w-4xl mx-auto">
        <div
          className="mb-8"
          style={{
            color: 'var(--servari-ivory)',
            fontSize: '1.5rem',
            letterSpacing: '1px'
          }}
        >
          RETENTION
        </div>

        <div
          className="mb-6 p-4 rounded-xl"
          style={{
            background: 'rgba(20, 156, 150, 0.05)',
            border: '1px solid rgba(20, 156, 150, 0.2)',
            color: 'var(--servari-dimmed)',
            fontSize: '0.875rem',
            lineHeight: '1.6'
          }}
        >
          Review metric-gated changes. Keep improvements, revert degradations. Each run is measured against its baseline.
        </div>

        {loaded && !error && pending.length === 0 && recentHistory.length === 0 && (
          <div
            className="text-center py-20"
            style={{ color: 'var(--servari-dimmed)', fontSize: '0.9375rem' }}
          >
            No retention runs yet.
          </div>
        )}
        {error && (
          <div
            className="text-center py-20"
            style={{ color: 'var(--servari-dimmed)', fontSize: '0.9375rem' }}
          >
            {error}
          </div>
        )}

        <div className="space-y-4">
          {/* Honest pending empty-state: history exists but nothing awaits a
              decision (the current real state — pending [] from the server). */}
          {loaded && !error && pending.length === 0 && recentHistory.length > 0 && (
            <div
              className="rounded-xl px-4 py-4 text-center"
              style={{
                background: 'rgba(250, 248, 243, 0.02)',
                border: '1px solid rgba(250, 248, 243, 0.06)',
                color: 'var(--servari-dimmed)',
                fontSize: '0.875rem'
              }}
            >
              No change runs awaiting a decision.
            </div>
          )}

          {/* --- PENDING runs: baseline captured, awaiting Decide (keep/revert) --- */}
          {pending.map((run, index) => {
            const pm = primaryMetric(run.baseline_scores);
            const agentRaw = (run.targets && run.targets.length)
              ? run.targets.join(', ')
              : 'retention';
            const agent = sealLabel(agentRaw) || agentRaw;
            return (
              <motion.div
                key={`p-${run.run_id}`}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.1 }}
                className="p-6 rounded-xl"
                style={{
                  background: 'var(--servari-glass)',
                  backdropFilter: 'blur(24px)',
                  border: '1px solid rgba(250, 248, 243, 0.08)',
                }}
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <div
                      className="mb-2"
                      style={{
                        color: 'var(--servari-ivory)',
                        fontSize: '1.125rem',
                        fontWeight: 500
                      }}
                    >
                      {sealLabel(run.run_id) || run.run_id}
                    </div>
                    <div
                      className="flex items-center gap-3"
                      style={{
                        color: 'var(--servari-dimmed)',
                        fontSize: '0.8125rem'
                      }}
                    >
                      <span>{agent}</span>
                      {run.ts && <span>·</span>}
                      {run.ts && <span>{relTime(run.ts)}</span>}
                    </div>
                  </div>
                </div>

                {/* Metrics (baseline captured; current pending the decision) */}
                <div
                  className="mb-6 p-4 rounded-lg"
                  style={{ background: 'rgba(250, 248, 243, 0.02)' }}
                >
                  <div
                    className="mb-3"
                    style={{
                      color: 'var(--servari-dimmed)',
                      fontSize: '0.8125rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px'
                    }}
                  >
                    {sealLabel(pm.metric) || pm.metric}
                  </div>

                  <div className="flex items-end gap-6">
                    <div>
                      <div
                        style={{
                          color: 'var(--servari-dimmed)',
                          fontSize: '0.75rem',
                          marginBottom: '0.25rem'
                        }}
                      >
                        Baseline
                      </div>
                      <div
                        style={{
                          color: 'var(--servari-ivory)',
                          fontSize: '1.5rem',
                          fontWeight: 500
                        }}
                      >
                        {pm.baseline}
                      </div>
                    </div>

                    <div className="ml-auto">
                      <div
                        style={{
                          color: 'var(--servari-dimmed)',
                          fontSize: '0.75rem',
                          marginBottom: '0.25rem'
                        }}
                      >
                        Status
                      </div>
                      <div
                        style={{
                          color: 'var(--servari-amber)',
                          fontSize: '1.5rem',
                          fontWeight: 500
                        }}
                      >
                        pending
                      </div>
                    </div>
                  </div>
                </div>

                {/* Decide button */}
                <div className="flex gap-3">
                  <motion.button
                    onClick={() => decide(run.run_id)}
                    className="flex-1 py-3 px-6 rounded-lg transition-all"
                    style={{
                      background: 'rgba(20, 156, 150, 0.1)',
                      border: '1px solid var(--servari-teal)',
                      color: 'var(--servari-teal)',
                      fontSize: '0.9375rem',
                      fontWeight: 500
                    }}
                    whileHover={{
                      background: 'rgba(20, 156, 150, 0.2)',
                      scale: 1.02
                    }}
                    whileTap={{ scale: 0.98 }}
                  >
                    Decide (keep or revert)
                  </motion.button>
                </div>
              </motion.div>
            );
          })}

          {/* --- HISTORY: decided runs with before/after + KEEP/REVERT badge --- */}
          {recentHistory.map((run, index) => {
            const pm = primaryMetric(run.baseline_scores, run.after_scores);
            const isImprovement = (pm.change ?? 0) >= 0;
            const status = (run.decision || '').toUpperCase() === 'KEEP' ? 'keep' : 'revert';
            const agentRaw = (run.reasons && run.reasons.length)
              ? run.reasons[0]
              : 'retention';
            const agent = sealLabel(agentRaw) || agentRaw;
            return (
              <motion.div
                key={`h-${run.run_id}-${index}`}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 0.7, x: 0 }}
                transition={{ delay: index * 0.1 }}
                className="p-6 rounded-xl"
                style={{
                  background: 'var(--servari-glass)',
                  backdropFilter: 'blur(24px)',
                  border: '1px solid rgba(250, 248, 243, 0.08)',
                }}
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <div
                      className="mb-2"
                      style={{
                        color: 'var(--servari-ivory)',
                        fontSize: '1.125rem',
                        fontWeight: 500
                      }}
                    >
                      {(run.run_id && (sealLabel(run.run_id) || run.run_id)) || ''}
                    </div>
                    <div
                      className="flex items-center gap-3"
                      style={{
                        color: 'var(--servari-dimmed)',
                        fontSize: '0.8125rem'
                      }}
                    >
                      <span>{agent}</span>
                      {run.ts && <span>·</span>}
                      {run.ts && <span>{relTime(run.ts)}</span>}
                    </div>
                  </div>

                  {/* Status badge */}
                  <div
                    className="px-3 py-1 rounded-full text-xs uppercase"
                    style={{
                      background: status === 'keep'
                        ? 'rgba(63, 185, 80, 0.1)'
                        : 'rgba(248, 81, 73, 0.1)',
                      color: status === 'keep'
                        ? 'var(--servari-green)'
                        : 'var(--servari-red)',
                      border: status === 'keep'
                        ? '1px solid var(--servari-green)'
                        : '1px solid var(--servari-red)',
                      letterSpacing: '0.5px'
                    }}
                  >
                    {status}
                  </div>
                </div>

                {/* Metrics */}
                <div
                  className="p-4 rounded-lg"
                  style={{ background: 'rgba(250, 248, 243, 0.02)' }}
                >
                  <div
                    className="mb-3"
                    style={{
                      color: 'var(--servari-dimmed)',
                      fontSize: '0.8125rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px'
                    }}
                  >
                    {sealLabel(pm.metric) || pm.metric}
                  </div>

                  <div className="flex items-end gap-6">
                    <div>
                      <div
                        style={{
                          color: 'var(--servari-dimmed)',
                          fontSize: '0.75rem',
                          marginBottom: '0.25rem'
                        }}
                      >
                        Baseline
                      </div>
                      <div
                        style={{
                          color: 'var(--servari-ivory)',
                          fontSize: '1.5rem',
                          fontWeight: 500
                        }}
                      >
                        {pm.baseline}
                      </div>
                    </div>

                    <div className="pb-2">
                      {isImprovement ? (
                        <TrendingUp size={24} style={{ color: 'var(--servari-green)' }} />
                      ) : (
                        <TrendingDown size={24} style={{ color: 'var(--servari-red)' }} />
                      )}
                    </div>

                    <div>
                      <div
                        style={{
                          color: 'var(--servari-dimmed)',
                          fontSize: '0.75rem',
                          marginBottom: '0.25rem'
                        }}
                      >
                        Current
                      </div>
                      <div
                        style={{
                          color: isImprovement ? 'var(--servari-green)' : 'var(--servari-red)',
                          fontSize: '1.5rem',
                          fontWeight: 500
                        }}
                      >
                        {pm.current === null ? '—' : pm.current}
                      </div>
                    </div>

                    {pm.change !== null && (
                      <div className="ml-auto">
                        <div
                          style={{
                            color: 'var(--servari-dimmed)',
                            fontSize: '0.75rem',
                            marginBottom: '0.25rem'
                          }}
                        >
                          Change
                        </div>
                        <div
                          style={{
                            color: isImprovement ? 'var(--servari-green)' : 'var(--servari-red)',
                            fontSize: '1.5rem',
                            fontWeight: 500
                          }}
                        >
                          {pm.change > 0 ? '+' : ''}{pm.change.toFixed(1)}%
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
