import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, Circle, AlertCircle } from "lucide-react";
import { API, LaunchStage } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

// The server's launch surface parses the launch-arc table into
// {stage, goal, status, gate, cls} where cls in done|partial|bad|idle.
// We render the ladder visuals, mapping cls onto the three visual buckets:
// done / active / pending.
type VisualStatus = "complete" | "active" | "bad" | "pending";

interface UIStage {
  num: string; // leading number from the stage label ("0", "1", ...)
  name: string; // remainder of the stage label
  goal: string;
  status: string; // raw status text (carries the emoji + DONE/PARTIAL/UNMET)
  gate: string;
  cls: string;
  vstatus: VisualStatus;
}

function visualFor(cls: string): VisualStatus {
  if (cls === "done") return "complete";
  if (cls === "partial") return "active";
  if (cls === "bad") return "bad";
  return "pending";
}

// Strip the leading "0 " / "1 " etc off the stage label so the ladder shows
// "Stage 0" + the name on separate lines.
function splitStage(stage: string): { num: string; name: string } {
  const m = stage.match(/^\s*([0-9]+)\s+(.*)$/);
  if (m) return { num: m[1], name: m[2].trim() };
  return { num: "", name: stage.trim() };
}

// Strip emoji/markup so the inline status reads cleanly in the badge.
// Keep only ASCII (status words like DONE / PARTIAL / UNMET); drop the
// emoji glyphs used as status dots.
function cleanStatus(s: string): string {
  return s
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function LaunchArc() {
  const [stages, setStages] = useState<UIStage[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    API.launch()
      .then((d) => {
        if (!alive) return;
        const raw = (d.stages || []) as LaunchStage[];
        const mapped: UIStage[] = raw.map((s) => {
          const { num, name } = splitStage(s.stage || "");
          // DISPLAY SEAL: the launch-arc labels are authored from source prose
          // and can carry internal vocabulary. Seal the human-readable label
          // fields to their professional outward form.
          return {
            num,
            name: sealLabel(name) || name,
            goal: sealLabel(s.goal || ""),
            status: s.status || "",
            gate: sealLabel(s.gate || ""),
            cls: s.cls || "idle",
            vstatus: visualFor(s.cls || "idle"),
          };
        });
        setStages(mapped);
        if (!mapped.length && typeof d.note === "string") setNote(sealLabel(d.note) || d.note);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const getStatusColor = (status: VisualStatus) => {
    switch (status) {
      case "complete": return 'var(--servari-green)';
      case "active": return 'var(--servari-teal)';
      case "bad": return 'var(--servari-red)';
      case "pending": return 'var(--servari-dimmed)';
      default: return 'var(--servari-dimmed)';
    }
  };

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="max-w-5xl mx-auto">
        <div
          className="mb-8"
          style={{
            color: 'var(--servari-ivory)',
            fontSize: '1.5rem',
            letterSpacing: '1px'
          }}
        >
          LAUNCH ARC
        </div>

        {error && (
          <div
            className="mb-6 p-4 rounded-xl"
            style={{
              background: 'var(--servari-glass)',
              border: '1px solid rgba(248, 81, 73, 0.2)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.8125rem',
            }}
          >
            Launch arc unavailable: {error}
          </div>
        )}

        {note && !stages.length && (
          <div
            className="mb-6 p-4 rounded-xl"
            style={{
              background: 'var(--servari-glass)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.875rem',
            }}
          >
            {note}
          </div>
        )}

        {/* Progress visualization */}
        {stages.length > 0 && (
          <div className="mb-12 relative">
            <div className="flex justify-between items-start mb-8">
              {stages.map((stage, index) => (
                <div
                  key={index}
                  className="flex flex-col items-center relative"
                  style={{ width: `${100 / stages.length}%` }}
                >
                  {/* Connecting line */}
                  {index < stages.length - 1 && (
                    <div
                      className="absolute top-5 left-1/2 w-full h-0.5"
                      style={{
                        background: stage.vstatus === 'complete'
                          ? 'var(--servari-green)'
                          : 'rgba(250, 248, 243, 0.1)',
                      }}
                    />
                  )}

                  {/* Stage circle */}
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: index * 0.1, type: "spring" }}
                    className="relative z-10 w-10 h-10 rounded-full flex items-center justify-center mb-3"
                    style={{
                      background: stage.vstatus === 'pending'
                        ? 'var(--servari-panel)'
                        : getStatusColor(stage.vstatus),
                      border: `2px solid ${getStatusColor(stage.vstatus)}`,
                    }}
                  >
                    {stage.vstatus === 'complete' ? (
                      <Check size={20} style={{ color: 'var(--servari-ink)' }} />
                    ) : stage.vstatus === 'active' ? (
                      <motion.div
                        className="w-3 h-3 rounded-full"
                        style={{ background: 'var(--servari-ink)' }}
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{ duration: 2, repeat: Infinity }}
                      />
                    ) : stage.vstatus === 'bad' ? (
                      <AlertCircle size={18} style={{ color: 'var(--servari-ink)' }} />
                    ) : (
                      <Circle size={16} style={{ color: 'var(--servari-dimmed)' }} />
                    )}
                  </motion.div>

                  {/* Stage number and name */}
                  <div
                    className="text-center"
                    style={{
                      color: getStatusColor(stage.vstatus),
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      marginBottom: '0.25rem'
                    }}
                  >
                    Stage {stage.num || index}
                  </div>
                  <div
                    className="text-center"
                    style={{
                      color: 'var(--servari-ivory)',
                      fontSize: '0.9375rem',
                      fontWeight: 500
                    }}
                  >
                    {stage.name}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stage details */}
        <div className="space-y-4">
          {stages.map((stage, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 + index * 0.1 }}
              className="p-6 rounded-xl"
              style={{
                background: stage.vstatus === 'active'
                  ? 'rgba(20, 156, 150, 0.05)'
                  : stage.vstatus === 'bad'
                    ? 'rgba(248, 81, 73, 0.05)'
                    : 'var(--servari-glass)',
                backdropFilter: 'blur(24px)',
                border: stage.vstatus === 'active'
                  ? '1px solid rgba(20, 156, 150, 0.3)'
                  : stage.vstatus === 'bad'
                    ? '1px solid rgba(248, 81, 73, 0.3)'
                    : '1px solid rgba(250, 248, 243, 0.08)',
              }}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div
                    className="mb-1"
                    style={{
                      color: 'var(--servari-ivory)',
                      fontSize: '1.125rem',
                      fontWeight: 500
                    }}
                  >
                    Stage {stage.num || index} &mdash; {stage.name}
                  </div>
                  <div
                    style={{
                      color: 'var(--servari-dimmed)',
                      fontSize: '0.875rem'
                    }}
                  >
                    {stage.goal}
                  </div>
                </div>

                <div
                  style={{
                    color: getStatusColor(stage.vstatus),
                    fontSize: '0.9375rem',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    marginLeft: '1rem'
                  }}
                >
                  {cleanStatus(stage.status)}
                </div>
              </div>

              {/* Proof-gate */}
              {stage.gate && (
                <div
                  className="flex items-start gap-3"
                  style={{
                    color: stage.vstatus === 'complete'
                      ? 'var(--servari-green)'
                      : stage.vstatus === 'active'
                        ? 'var(--servari-ivory)'
                        : 'var(--servari-dimmed)',
                    fontSize: '0.875rem'
                  }}
                >
                  {stage.vstatus === 'complete' ? (
                    <Check size={16} style={{ flexShrink: 0, marginTop: '0.2rem' }} />
                  ) : (
                    <Circle size={16} style={{ flexShrink: 0, marginTop: '0.2rem', opacity: 0.5 }} />
                  )}
                  <span>{stage.gate}</span>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
