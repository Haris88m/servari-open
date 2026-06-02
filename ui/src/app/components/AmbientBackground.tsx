import { useMemo } from "react";
import { motion } from "motion/react";

// Deterministic-but-varied seeds so particles/feathers feel organic without a
// re-render storm. Computed once per mount.
function useField<T>(count: number, make: (i: number) => T): T[] {
  return useMemo(() => Array.from({ length: count }, (_, i) => make(i)), [count, make]);
}

// Slow-drifting ink dust: tiny dim motes that wander and breathe. Calm, alive.
const INK_PARTICLES = 18;

// Faint teal "feather" streaks that drift diagonally and fade. Max 3 visible at
// once is enforced by long fade-out tails + staggered cycles across 6 lanes.
const FEATHER_LANES = 6;

export function AmbientBackground() {
  const particles = useField(INK_PARTICLES, (i) => {
    // pseudo-random but stable per index
    const r = (n: number) => ((Math.sin(i * 99.13 + n * 7.7) + 1) / 2);
    return {
      left: 4 + r(1) * 92, // vw %
      top: 6 + r(2) * 88, // vh %
      size: 1.5 + r(3) * 2.5,
      drift: 18 + r(4) * 34, // px wander
      dur: 14 + r(5) * 16, // seconds
      delay: r(6) * 8,
      baseOpacity: 0.06 + r(7) * 0.12,
      teal: r(8) > 0.72, // a few motes carry faint teal
    };
  });

  const feathers = useField(FEATHER_LANES, (i) => {
    const r = (n: number) => ((Math.sin(i * 41.7 + n * 13.3) + 1) / 2);
    return {
      startTop: 8 + r(1) * 70, // vh %
      dur: 16 + r(2) * 12, // seconds
      delay: i * 4.5 + r(3) * 3, // long stagger → rarely >3 concurrent
      scale: 0.7 + r(4) * 0.6,
      driftY: -40 - r(5) * 60,
    };
  });

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden">
      {/* Base radial glow — two soft teal pools, very low */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 30% 40%, rgba(20, 156, 150, 0.08) 0%, transparent 50%), radial-gradient(circle at 70% 60%, rgba(20, 156, 150, 0.05) 0%, transparent 50%)",
        }}
      />

      {/* A single, very slow breathing wash so the whole field feels alive */}
      <motion.div
        className="absolute inset-0"
        animate={{ opacity: [0.5, 0.85, 0.5] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        style={{
          background:
            "radial-gradient(circle at 50% 45%, rgba(20,156,150,0.05) 0%, transparent 55%)",
        }}
      />

      {/* Signal grid pattern — kept subtle, the structural calm */}
      <svg className="absolute inset-0 w-full h-full opacity-10">
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke="var(--servari-teal)"
              strokeWidth="0.5"
              opacity="0.3"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Slow-drifting ink particles */}
      {particles.map((p, i) => (
        <motion.span
          key={`p-${i}`}
          className="absolute rounded-full"
          style={{
            left: `${p.left}%`,
            top: `${p.top}%`,
            width: p.size,
            height: p.size,
            background: p.teal ? "var(--servari-teal-soft)" : "var(--servari-ivory)",
            boxShadow: p.teal ? "0 0 6px rgba(95,184,179,0.5)" : "none",
          }}
          animate={{
            x: [0, p.drift, -p.drift * 0.6, 0],
            y: [0, -p.drift * 0.8, p.drift * 0.4, 0],
            opacity: [
              p.baseOpacity,
              p.baseOpacity * 1.8,
              p.baseOpacity * 0.6,
              p.baseOpacity,
            ],
          }}
          transition={{
            duration: p.dur,
            repeat: Infinity,
            ease: "easeInOut",
            delay: p.delay,
          }}
        />
      ))}

      {/* Occasional faint teal feather streaks — diagonal drift + fade */}
      {feathers.map((f, i) => (
        <motion.div
          key={`f-${i}`}
          className="absolute"
          style={{ left: "-6%", top: `${f.startTop}%` }}
          initial={{ opacity: 0, x: 0, y: 0, rotate: -18 }}
          animate={{
            // sweep diagonally across, peaking faint mid-flight, then gone
            x: ["-6vw", "62vw", "112vw"],
            y: [0, f.driftY * 0.5, f.driftY],
            opacity: [0, 0.16, 0.16, 0],
            rotate: [-18, -10, -6],
          }}
          transition={{
            duration: f.dur,
            repeat: Infinity,
            repeatDelay: 9 + i * 2,
            delay: f.delay,
            ease: "easeInOut",
            times: [0, 0.4, 0.75, 1],
          }}
        >
          <svg
            width={24 * f.scale}
            height={48 * f.scale}
            viewBox="0 0 24 48"
            style={{ filter: "drop-shadow(0 0 4px rgba(20,156,150,0.25))" }}
          >
            <path
              d="M12 2 Q8 12, 6 24 Q8 36, 12 46 Q16 36, 18 24 Q16 12, 12 2 Z M12 2 Q10 8, 4 20 M12 10 Q8 16, 3 24 M12 20 Q9 24, 5 30"
              fill="none"
              stroke="var(--servari-teal)"
              strokeWidth="1"
              strokeLinecap="round"
              opacity="0.7"
            />
          </svg>
        </motion.div>
      ))}
    </div>
  );
}
