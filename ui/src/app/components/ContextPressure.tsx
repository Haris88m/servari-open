import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Pin, Archive } from "lucide-react";
import { API, type ContextResponse } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

interface PinRow {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

// The backend reports a CATEGORICAL pressure ('LOW'|'MEDIUM'|'HIGH'), not a
// 0-100 number. Map it onto the design's circular gauge fill while keeping the
// real level word as the headline.
function levelToPct(level: string): number {
  switch ((level || "").toUpperCase()) {
    case "HIGH": return 100;
    case "MEDIUM": return 66;
    case "LOW": return 33;
    default: return 0;
  }
}

export function ContextPressure() {
  const [data, setData] = useState<ContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = await API.context();
      if (d.error) {
        setError(d.error);
        setData(null);
      } else {
        setError(null);
        setData(d);
      }
    } catch {
      setError("context unavailable");
      setData(null);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const checkpoint = async () => {
    try {
      await API.contextCheckpoint("via SERVARI OS");
    } catch {
      /* server degrades gracefully */
    }
    load();
  };

  const levelWord = String(data?.pressure?.pressure ?? (error ? "—" : "")).toUpperCase();
  const pct = levelToPct(levelWord);
  // The backend recommendation is real free-text and may carry internal
  // vocabulary — pass it through the display seal like every other dynamic
  // label before it renders.
  const recommendation = sealLabel((data?.pressure?.recommendation as string) || "");

  // Survival pins: {name: {ok, detail}} -> rows. A missing pin is the tool
  // WORKING (a real gap surfaced), not an error.
  //
  // SEAL: the pin NAME (derived from backend keys) goes through sealLabel(). The
  // backend DETAIL string is operational prose that may carry internal
  // vocabulary in token-glued forms the word-seal cannot split — so it is NOT
  // rendered verbatim. The real, leak-free signal is ok/missing, which we render
  // as the status word; the tooltip carries the same sealed status, never the raw
  // backend detail. (display_seal.ts is a shared asset — not edited here.)
  const pinsObj = (data?.survival?.pins as Record<string, { ok?: boolean; detail?: string }>) || {};
  const pins: PinRow[] = Object.keys(pinsObj).map((k, i) => {
    const rawLabel = k.replace(/_/g, " ");
    const ok = !!pinsObj[k]?.ok;
    return {
      id: String(i),
      label: sealLabel(rawLabel) || rawLabel,
      ok,
      detail: ok ? "on disk" : "not yet on disk",
    };
  });

  const getPressureColor = () => {
    if (pct >= 80) return 'var(--servari-red)';
    if (pct >= 60) return 'var(--servari-amber)';
    return 'var(--servari-teal)';
  };

  const getPressureStatus = () => levelWord || '—';

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
          CONTEXT PRESSURE
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Pressure gauge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-6 rounded-xl"
            style={{
              background: 'var(--servari-glass)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
            }}
          >
            <div
              className="mb-6"
              style={{
                color: 'var(--servari-ivory)',
                fontSize: '0.9375rem',
                letterSpacing: '1px',
                textTransform: 'uppercase'
              }}
            >
              Pressure Level
            </div>

            {/* Circular gauge */}
            <div className="flex flex-col items-center mb-6">
              <svg width="200" height="200" viewBox="0 0 200 200" className="mb-4">
                <circle
                  cx="100"
                  cy="100"
                  r="80"
                  fill="none"
                  stroke="rgba(250, 248, 243, 0.1)"
                  strokeWidth="16"
                />
                <motion.circle
                  cx="100"
                  cy="100"
                  r="80"
                  fill="none"
                  stroke={getPressureColor()}
                  strokeWidth="16"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 80}`}
                  initial={{ strokeDashoffset: 2 * Math.PI * 80 }}
                  animate={{
                    strokeDashoffset: 2 * Math.PI * 80 * (1 - pct / 100)
                  }}
                  transition={{ duration: 1.5, ease: "easeOut" }}
                  transform="rotate(-90 100 100)"
                />
                <text
                  x="100"
                  y="100"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={getPressureColor()}
                  fontSize="32"
                  fontWeight="500"
                  fontFamily="var(--font-mono)"
                >
                  {getPressureStatus()}
                </text>
              </svg>

              <div
                className="text-center"
                style={{
                  color: 'var(--servari-dimmed)',
                  fontSize: '0.875rem',
                  lineHeight: '1.6'
                }}
              >
                {recommendation || 'Context window utilization. Consider checkpointing to preserve critical state.'}
              </div>
            </div>

            {/* Checkpoint button */}
            <motion.button
              onClick={checkpoint}
              className="w-full py-3 px-6 rounded-lg flex items-center justify-center gap-2"
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
              <Archive size={18} />
              Checkpoint Now
            </motion.button>
          </motion.div>

          {/* Pinned items (survival pins) */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="p-6 rounded-xl"
            style={{
              background: 'var(--servari-glass)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
            }}
          >
            <div
              className="mb-6"
              style={{
                color: 'var(--servari-ivory)',
                fontSize: '0.9375rem',
                letterSpacing: '1px',
                textTransform: 'uppercase'
              }}
            >
              Survival Pins
            </div>

            <div
              className="mb-4 p-3 rounded-lg"
              style={{
                background: 'rgba(20, 156, 150, 0.05)',
                border: '1px solid rgba(20, 156, 150, 0.2)',
                color: 'var(--servari-dimmed)',
                fontSize: '0.8125rem',
                lineHeight: '1.5'
              }}
            >
              These items are protected from context pressure and will always be retained. A missing pin is a real gap surfaced.
            </div>

            <div className="space-y-3">
              {pins.length === 0 && (
                <div
                  style={{ color: 'var(--servari-dimmed)', fontSize: '0.8125rem', opacity: 0.7 }}
                >
                  {(error ? sealLabel(error) : '') || 'Context module unavailable.'}
                </div>
              )}
              {pins.map((item, index) => {
                const color = item.ok ? 'var(--servari-teal)' : 'var(--servari-red)';
                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 + index * 0.05 }}
                    className="flex items-center gap-3 p-3 rounded-lg"
                    style={{
                      background: 'rgba(250, 248, 243, 0.02)',
                      border: '1px solid rgba(250, 248, 243, 0.05)',
                    }}
                    title={item.detail}
                  >
                    <Pin size={14} style={{ color, flexShrink: 0 }} />
                    <div className="flex-1">
                      <div
                        style={{
                          color: 'var(--servari-ivory)',
                          fontSize: '0.875rem',
                          marginBottom: '0.125rem'
                        }}
                      >
                        {item.label}
                      </div>
                      <div
                        style={{
                          color,
                          fontSize: '0.75rem',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px'
                        }}
                      >
                        {item.ok ? 'ok' : 'missing'}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
