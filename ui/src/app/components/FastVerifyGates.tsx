import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, X } from "lucide-react";
import { API, type VerifyQueueItem } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

// Turn a backend ISO/epoch ts into a short "Nm ago" relative label.
function relTime(ts: unknown): string {
  if (ts === undefined || ts === null || ts === "") return "";
  let ms: number;
  if (typeof ts === "number") {
    ms = ts < 1e12 ? ts * 1000 : ts;
  } else {
    const parsed = Date.parse(String(ts));
    if (Number.isNaN(parsed)) return String(ts);
    ms = parsed;
  }
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return s <= 1 ? "just now" : `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// The backend pending entry carries a `gate` (the kind of action being held) and
// no explicit risk grade. Use the gate as the chip; colour it by a small
// heuristic over known high-stakes gate kinds, defaulting to medium.
function gateRisk(gate: string): "low" | "medium" | "high" {
  const g = (gate || "").toLowerCase();
  if (/(send|deploy|production|legal|money|contract|spend|delete|drop|secret|migrat|dns)/.test(g))
    return "high";
  if (/(review|draft|queue|notify|report)/.test(g)) return "low";
  return "medium";
}

export function FastVerifyGates() {
  const [actions, setActions] = useState<VerifyQueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = await API.verifyQueue();
      if (d.error) {
        setError(d.error);
        setActions([]);
      } else {
        setError(null);
        setActions(d.pending || []);
      }
    } catch {
      setError("verify-queue unavailable");
      setActions([]);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const decide = async (id: string, decision: "approve" | "reject") => {
    try {
      await API.verifyDecide(id, decision, "via SERVARI OS");
    } catch {
      /* server degrades gracefully */
    }
    load();
  };

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case "low": return 'var(--servari-green)';
      case "medium": return 'var(--servari-amber)';
      case "high": return 'var(--servari-red)';
      default: return 'var(--servari-dimmed)';
    }
  };

  const getRiskBg = (risk: string) => {
    switch (risk) {
      case "low": return 'rgba(63, 185, 80, 0.1)';
      case "medium": return 'rgba(224, 169, 42, 0.1)';
      case "high": return 'rgba(248, 81, 73, 0.1)';
      default: return 'rgba(138, 148, 162, 0.1)';
    }
  };

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
          FAST-VERIFY GATES
        </div>

        {actions.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-20"
          >
            <div
              className="mb-4"
              style={{
                color: 'var(--servari-dimmed)',
                fontSize: '1.125rem'
              }}
            >
              Nothing waiting on you.
            </div>
            <div
              style={{
                color: 'var(--servari-dimmed)',
                fontSize: '0.875rem',
                opacity: 0.6
              }}
            >
              {error || 'All agents are operating within their autonomy levels.'}
            </div>
          </motion.div>
        ) : (
          <div className="space-y-4">
            {actions.map((action, index) => {
              // Risk heuristic runs on the RAW gate kind (matches internal
              // action kinds like deploy/secret/migrat that the seal neutralizes);
              // every label that RENDERS is sealed so no denied word reaches the UI.
              const risk = (action.risk as string) || gateRisk(action.gate);
              const title = sealLabel(action.gate || action.action || '') || '(gated action)';
              const rationale = sealLabel(action.summary || action.action || '') || '(no summary)';
              const agent = sealLabel(action.agent || '') || '?';
              const timestamp = relTime(action.ts);
              return (
              <motion.div
                key={action.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
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
                      {title}
                    </div>
                    <div
                      className="flex items-center gap-3"
                      style={{
                        color: 'var(--servari-dimmed)',
                        fontSize: '0.8125rem'
                      }}
                    >
                      <span>{agent}</span>
                      {timestamp && <span>·</span>}
                      {timestamp && <span>{timestamp}</span>}
                    </div>
                  </div>

                  {/* Risk chip */}
                  <div
                    className="px-3 py-1 rounded-full text-xs uppercase"
                    style={{
                      background: getRiskBg(risk),
                      color: getRiskColor(risk),
                      border: `1px solid ${getRiskColor(risk)}`,
                      letterSpacing: '0.5px'
                    }}
                  >
                    {risk} risk
                  </div>
                </div>

                {/* Rationale */}
                <div
                  className="mb-6 p-4 rounded-lg"
                  style={{
                    background: 'rgba(250, 248, 243, 0.02)',
                    color: 'var(--servari-dimmed)',
                    fontSize: '0.9375rem',
                    lineHeight: '1.6'
                  }}
                >
                  {rationale}
                </div>

                {/* Action buttons */}
                <div className="flex gap-3">
                  <motion.button
                    onClick={() => decide(action.id, 'approve')}
                    className="flex-1 py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-all"
                    style={{
                      background: 'rgba(63, 185, 80, 0.1)',
                      border: '1px solid var(--servari-green)',
                      color: 'var(--servari-green)',
                      fontSize: '0.9375rem',
                      fontWeight: 500
                    }}
                    whileHover={{
                      background: 'rgba(63, 185, 80, 0.2)',
                      scale: 1.02
                    }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <Check size={18} />
                    Approve
                  </motion.button>

                  <motion.button
                    onClick={() => decide(action.id, 'reject')}
                    className="flex-1 py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-all"
                    style={{
                      background: 'rgba(248, 81, 73, 0.1)',
                      border: '1px solid var(--servari-red)',
                      color: 'var(--servari-red)',
                      fontSize: '0.9375rem',
                      fontWeight: 500
                    }}
                    whileHover={{
                      background: 'rgba(248, 81, 73, 0.2)',
                      scale: 1.02
                    }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <X size={18} />
                    Reject
                  </motion.button>
                </div>
              </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
