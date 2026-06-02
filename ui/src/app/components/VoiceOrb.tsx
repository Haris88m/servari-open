import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * SERVARI VoiceOrb — the speaking animation.
 *
 * Pure presentational voice visual using the SERVARI brand tokens
 * (--servari-teal / --servari-ink): rotating dashed rings + a 24-bar equalizer
 * + pulse rings.
 *
 *   - State-driven: `state` is the live ConversationState
 *     ('idle' | 'listening' | 'transcribing' | 'speaking').
 *   - RAVEN MODE: when idle, the orb center shows the raven mark (served at
 *     /raven.png) with a slow breathing scale — NOT bars.
 *   - REAL amplitude: when an `amplitude` prop (0..1) is provided, the listening
 *     bars are driven by the actual mic level (centered wave shaping), not random.
 *   - SPEAKING bars use a deterministic sine-wave animation (smooth easing), not
 *     Math.random jitter — it reads as "the voice is flowing", not static noise.
 *   - pulse-ring is inlined via motion/react so the component owns no global CSS.
 *
 * Pure presentational — no voice wiring lives here. The caller feeds it `state`
 * + `amplitude` from Voice.onStateChange / onAmplitude.
 */

const NUM_BARS = 24;

export interface VoiceOrbProps {
  /** Live conversation state. Drives bars, rings, raven, glow. */
  state: "idle" | "listening" | "transcribing" | "speaking";
  /** 0..1 mic loudness — drives the listening bars when present. */
  amplitude?: number;
  /** Overall orb diameter in px. Default 180; compact callers use 140. */
  size?: number;
}

const TEAL = "var(--servari-teal)";
const TEAL_SOFT = "var(--servari-teal-soft)";

export function VoiceOrb({ state, amplitude = 0, size = 180 }: VoiceOrbProps) {
  const active = state !== "idle";
  const [bars, setBars] = useState<number[]>(Array(NUM_BARS).fill(4));
  // Monotonic phase clock for the deterministic speaking sine wave.
  const phaseRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  // Live amplitude read inside the RAF so a changing mic level does NOT tear
  // down and rebuild the animation loop ~30x/sec (the effect depends on `state`
  // only; amplitude flows through the ref).
  const ampRef = useRef(amplitude);
  ampRef.current = amplitude;

  // The bar height engine. Three regimes:
  //   listening    -> REAL mic amplitude, shaped into a centered wave.
  //   speaking      -> deterministic multi-frequency sine wave (flowing, smooth).
  //   transcribing  -> a gentle, low "thinking" shimmer (small steady sine).
  //   idle          -> bars collapse to baseline (raven shows instead).
  useEffect(() => {
    if (state === "idle") {
      setBars(Array(NUM_BARS).fill(4));
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // advance the phase clock; speaking runs faster than transcribing.
      const speed = state === "speaking" ? 6.5 : state === "transcribing" ? 2.2 : 4;
      phaseRef.current += dt * speed;
      const p = phaseRef.current;

      const center = (NUM_BARS - 1) / 2;
      const next = Array.from({ length: NUM_BARS }, (_, i) => {
        const dist = Math.abs(i - center) / center; // 0 center .. 1 edges
        const shape = 1 - dist * 0.55; // center bars react most

        if (state === "listening") {
          // REAL amplitude (0..1). A small per-bar sine ripple keeps it alive
          // even at low levels, but the height is driven by the mic.
          const live = ampRef.current;
          const ripple = 0.18 * Math.sin(p * 1.4 + i * 0.5);
          const amp = Math.max(0, Math.min(1, live + ripple * live));
          return 4 + amp * 34 * shape;
        }
        if (state === "speaking") {
          // Deterministic, smooth, multi-frequency sine — a flowing voice wave.
          const a = Math.sin(p * 1.0 + i * 0.55);
          const b = Math.sin(p * 1.7 + i * 0.28);
          const wave = (a * 0.6 + b * 0.4 + 1) / 2; // 0..1
          return 4 + wave * 30 * shape;
        }
        // transcribing — low gentle thinking shimmer.
        const s = (Math.sin(p * 1.0 + i * 0.7) + 1) / 2; // 0..1
        return 4 + s * 12 * shape;
      });
      setBars(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [state]);

  // Geometry scaled off `size` so the orb is crisp at 140 or 180.
  const ringInset3 = Math.round(size * 0.017);
  const inset6 = Math.round(size * 0.033);
  const inset8 = Math.round(size * 0.044);
  const ravenPx = Math.round(size * 0.27); // ~48px at 180

  return (
    <div
      className="relative flex items-center justify-center"
      data-component="VoiceOrb"
      style={{ width: size, height: size }}
    >
      {/* Outer rotating dashed ring */}
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 22, repeat: Infinity, ease: "linear" }}
        className="absolute inset-0 rounded-full"
        style={{ border: `1px dashed ${TEAL}`, opacity: 0.4 }}
      />
      {/* Inner counter-rotating solid ring */}
      <motion.div
        animate={{ rotate: -360 }}
        transition={{ duration: 16, repeat: Infinity, ease: "linear" }}
        className="absolute rounded-full"
        style={{
          inset: ringInset3,
          border: `1px solid ${TEAL}`,
          opacity: 0.25,
        }}
      />

      {/* Pulse rings — only while active. Inlined via motion (no global CSS). */}
      {active && (
        <>
          <motion.span
            className="absolute rounded-full"
            style={{ inset: inset6, background: TEAL }}
            animate={{ scale: [1, 1.35, 1.35], opacity: [0.22, 0, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
          />
          <motion.span
            className="absolute rounded-full"
            style={{ inset: inset6, background: TEAL }}
            animate={{ scale: [1, 1.35, 1.35], opacity: [0.22, 0, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut", delay: 0.6 }}
          />
        </>
      )}

      {/* The core disc: gradient + teal rim + glow. Holds bars OR the raven. */}
      <div
        className="absolute rounded-full grid place-items-center overflow-hidden"
        style={{
          inset: inset8,
          background:
            "radial-gradient(circle, rgba(20,156,150,0.18), rgba(15,18,24,0.92))",
          border: `1px solid ${TEAL}`,
          boxShadow: `0 0 30px rgba(20,156,150,0.34), inset 0 0 30px rgba(20,156,150,0.20)`,
        }}
      >
        {state === "idle" ? (
          // RAVEN MODE — breathing raven mark (served at /raven.png).
          <motion.img
            src="/raven.png"
            alt="SERVARI"
            width={ravenPx}
            height={ravenPx}
            draggable={false}
            animate={{ scale: [1, 1.08, 1], opacity: [0.78, 1, 0.78] }}
            transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
            style={{
              width: ravenPx,
              height: ravenPx,
              objectFit: "contain",
              filter: "drop-shadow(0 0 8px rgba(20,156,150,0.45))",
            }}
          />
        ) : (
          // EQUALIZER — 24 bars. Heights from the regime engine above.
          <div className="flex items-end gap-[2px]" style={{ height: size * 0.22 }}>
            {bars.map((b, i) => (
              <div
                key={i}
                style={{
                  width: 2,
                  height: Math.max(3, b),
                  background: state === "transcribing" ? TEAL_SOFT : TEAL,
                  opacity: 0.9,
                  borderRadius: 1,
                  transition: "height 60ms linear",
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default VoiceOrb;
