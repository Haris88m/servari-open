import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Check, X } from "lucide-react";
import { API } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

// Each boot step pings a REAL endpoint. The green check appears only on a real
// success; a failed check goes red but the sequence still proceeds (graceful —
// the shell can boot even if one subsystem is degraded).
//
// DISPLAY SEAL: the boot checklist is CHROME. Its labels are professional
// outward words; any internal-only vocabulary is mapped/hidden at the render
// chokepoint by sealLabel so it never reaches the display.
const bootSteps: { label: string; delay: number; check: () => Promise<boolean> }[] = [
  {
    label: "core · the kernel",
    delay: 2.0,
    check: async () => {
      const r = await API.health();
      return !!r && r.verdict !== "error" && r.verdict !== undefined;
    },
  },
  {
    label: "memory · file system",
    delay: 2.35,
    check: async () => {
      const r = await API.state();
      return !!r && Array.isArray(r.turns);
    },
  },
  {
    label: "team · process table",
    delay: 2.7,
    check: async () => {
      const r = await API.grid();
      return !!r && typeof r.count === "number";
    },
  },
  {
    label: "approvals · the guardrails",
    delay: 3.05,
    check: async () => {
      const r = await API.autonomy();
      return !!r && !!r.levels;
    },
  },
  {
    label: "channel",
    delay: 3.4,
    check: async () => {
      const r = await API.voiceConfig();
      return !!r && r.ok === true;
    },
  },
];

type StepState = "pending" | "ok" | "fail";

// The wordmark, letter by letter. The A and the final I land in teal with a glow
// pulse — the brand's two accent letters.
const WORDMARK = ["S", "E", "R", "V", " ", "A", " ", "R", " ", "I"] as const;
const WORD_START = 1.05; // seconds — after the raven has materialized

// Custom easings — nothing linear anywhere in this ceremony.
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
const EASE_OUT_SOFT = [0.22, 1, 0.36, 1] as const;
const EASE_IRIS = [0.7, 0, 0.84, 0] as const;

export function BootSequence() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [stepStates, setStepStates] = useState<StepState[]>(
    () => bootSteps.map(() => "pending"),
  );
  const [dissolving, setDissolving] = useState(false);
  const navigatedRef = useRef(false);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    bootSteps.forEach((step, index) => {
      const t = setTimeout(() => {
        // run the REAL check at this step's moment; paint green/red on the result.
        step
          .check()
          .then((ok) => {
            setStepStates((prev) => {
              const next = [...prev];
              next[index] = ok ? "ok" : "fail";
              return next;
            });
          })
          .catch(() => {
            setStepStates((prev) => {
              const next = [...prev];
              next[index] = "fail";
              return next;
            });
          });
      }, step.delay * 1000);
      timers.push(t);
    });

    // Trigger the iris/ink dissolve, then hand off to the shell.
    // hold ~600ms after the last check fires, then dissolve ~520ms → /shell.
    const dissolveAt = reduce ? 200 : 4200;
    const navAt = reduce ? 400 : 4720;

    const dissolveTimer = setTimeout(() => setDissolving(true), dissolveAt);
    timers.push(dissolveTimer);

    const navTimer = setTimeout(() => {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      navigate("/shell");
    }, navAt);
    timers.push(navTimer);

    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [navigate, reduce]);

  return (
    <AnimatePresence>
      {!dissolving && (
        <motion.div
          key="boot"
          className="fixed inset-0 flex items-center justify-center overflow-hidden"
          style={{
            background: "var(--servari-ink)",
            fontFamily: "var(--font-mono)",
          }}
          initial={{ opacity: 1 }}
          // Iris/ink dissolve: the whole ceremony lifts slightly and irises out.
          exit={{
            opacity: 0,
            scale: 1.045,
            filter: "blur(8px)",
            transition: { duration: 0.52, ease: EASE_IRIS },
          }}
        >
          {/* Vignette — pulls focus to center, gives depth */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(circle at center, transparent 35%, rgba(8,10,14,0.55) 100%)",
            }}
          />

          {/* Slow ambient teal wash that breathes the whole time */}
          <motion.div
            className="absolute inset-0 pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.12, 0.08, 0.12] }}
            transition={{ duration: 5, ease: "easeInOut", times: [0, 0.3, 0.7, 1] }}
            style={{
              background:
                "radial-gradient(circle at center, var(--servari-teal) 0%, transparent 55%)",
            }}
          />

          {/* Main content */}
          <div className="relative z-10 flex flex-col items-center">
            {/* Raven + ink-bloom */}
            <div className="relative mb-10 flex items-center justify-center">
              {/* Teal radial ink-bloom: expands from the raven and dissipates */}
              <motion.div
                className="absolute pointer-events-none"
                style={{
                  width: 280,
                  height: 280,
                  borderRadius: "50%",
                  background:
                    "radial-gradient(circle, var(--servari-teal) 0%, transparent 65%)",
                  filter: "blur(28px)",
                }}
                initial={{ opacity: 0, scale: 0.2 }}
                animate={{ opacity: [0, 0.55, 0], scale: [0.2, 3, 3.4] }}
                transition={{ duration: 2.1, ease: EASE_OUT_EXPO, delay: 0.15 }}
              />

              {/* A second, tighter bloom pulse for layered depth */}
              <motion.div
                className="absolute pointer-events-none"
                style={{
                  width: 200,
                  height: 200,
                  borderRadius: "50%",
                  background:
                    "radial-gradient(circle, var(--servari-teal-soft) 0%, transparent 60%)",
                  filter: "blur(18px)",
                }}
                initial={{ opacity: 0, scale: 0.3 }}
                animate={{ opacity: [0, 0.4, 0], scale: [0.3, 2, 2.4] }}
                transition={{ duration: 1.8, ease: EASE_OUT_EXPO, delay: 0.45 }}
              />

              {/* THE RAVEN — the brand mark — materializes from blur + scale */}
              <motion.img
                src="/raven.png"
                alt="SERVARI"
                width={280}
                height={280}
                className="relative z-10 select-none"
                draggable={false}
                style={{
                  width: 280,
                  height: 280,
                  objectFit: "contain",
                  filter: "drop-shadow(0 0 36px rgba(20,156,150,0.35))",
                }}
                initial={{ opacity: 0, scale: 0.6, filter: "blur(22px)" }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  filter: "blur(0px)",
                }}
                transition={{
                  type: "spring",
                  stiffness: 90,
                  damping: 16,
                  mass: 1.1,
                  delay: 0.1,
                }}
              />
            </div>

            {/* SERVARI wordmark — writes on letter by letter, blur → sharp */}
            <div
              className="flex items-baseline mb-5"
              style={{
                fontFamily: "var(--font-wordmark)",
                fontSize: "2.75rem",
                letterSpacing: "6px",
              }}
            >
              {WORDMARK.map((letter, index) => {
                const isTeal = letter === "A" || (letter === "I" && index === 9);
                const landAt = WORD_START + index * 0.08;
                return (
                  <motion.span
                    key={index}
                    initial={{ opacity: 0, y: 6, filter: "blur(10px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    transition={{
                      duration: 0.5,
                      delay: landAt,
                      ease: EASE_OUT_SOFT,
                    }}
                    style={{
                      color: isTeal ? "var(--servari-teal)" : "var(--servari-ivory)",
                      display: "inline-block",
                    }}
                  >
                    {/* Glow pulse fires AFTER the accent letter lands */}
                    {isTeal ? (
                      <motion.span
                        style={{ display: "inline-block" }}
                        initial={{ textShadow: "0 0 0px rgba(20,156,150,0)" }}
                        animate={{
                          textShadow: [
                            "0 0 0px rgba(20,156,150,0)",
                            "0 0 22px rgba(20,156,150,0.9)",
                            "0 0 12px rgba(20,156,150,0.55)",
                          ],
                        }}
                        transition={{
                          duration: 0.9,
                          delay: landAt + 0.18,
                          ease: "easeOut",
                        }}
                      >
                        {letter === " " ? " " : letter}
                      </motion.span>
                    ) : letter === " " ? (
                      " "
                    ) : (
                      letter
                    )}
                  </motion.span>
                );
              })}
            </div>

            {/* Tagline — fades up */}
            <motion.div
              className="mb-11"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 0.55, y: 0 }}
              transition={{ delay: 1.95, duration: 0.7, ease: EASE_OUT_SOFT }}
              style={{
                color: "var(--servari-ivory)",
                fontSize: "0.9rem",
                letterSpacing: "5px",
                textTransform: "lowercase",
              }}
            >
              the keeper
            </motion.div>

            {/* Boot checklist — each row slides in from the left in sequence */}
            <div className="space-y-2.5" style={{ fontSize: "0.8125rem" }}>
              {bootSteps.map((step, index) => {
                const state = stepStates[index];
                const resolved = state === "ok" || state === "fail";
                const rowAt = 2.0 + index * 0.18;
                return (
                  <motion.div
                    key={index}
                    className="flex items-center gap-3"
                    initial={{ opacity: 0, x: -22 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      delay: rowAt,
                      duration: 0.45,
                      ease: EASE_OUT_SOFT,
                    }}
                    style={{ color: "var(--servari-dimmed)" }}
                  >
                    <span
                      className="w-48 text-right"
                      style={{ letterSpacing: "0.5px" }}
                    >
                      {/* Defense-in-depth: even though these constants are the
                          professional/outward labels, the seal runs at the
                          render chokepoint so no internal-only word can ever
                          reach the display if a label is later edited. */}
                      {sealLabel(step.label)}
                    </span>
                    <span
                      className="relative inline-flex items-center justify-center"
                      style={{ width: 18, height: 18 }}
                    >
                      {/* Pending: a faint pulsing dot until the real check resolves */}
                      <AnimatePresence mode="wait">
                        {!resolved ? (
                          <motion.span
                            key="pending"
                            className="rounded-full"
                            style={{
                              width: 5,
                              height: 5,
                              background: "var(--servari-dimmed)",
                            }}
                            initial={{ opacity: 0.2, scale: 0.8 }}
                            animate={{ opacity: [0.2, 0.7, 0.2], scale: [0.8, 1, 0.8] }}
                            exit={{ opacity: 0 }}
                            transition={{
                              duration: 1.1,
                              repeat: Infinity,
                              ease: "easeInOut",
                            }}
                          />
                        ) : (
                          <motion.span
                            key="resolved"
                            className="inline-flex"
                            // spring scale-pop 0 → 1.2 → 1
                            initial={{ scale: 0, rotate: -20 }}
                            animate={{ scale: [0, 1.25, 1], rotate: 0 }}
                            transition={{
                              duration: 0.5,
                              times: [0, 0.6, 1],
                              ease: EASE_OUT_EXPO,
                            }}
                            style={{
                              color:
                                state === "ok"
                                  ? "var(--servari-green)"
                                  : "var(--servari-red)",
                              filter:
                                state === "ok"
                                  ? "drop-shadow(0 0 6px rgba(63,185,80,0.6))"
                                  : "drop-shadow(0 0 6px rgba(248,81,73,0.5))",
                            }}
                          >
                            {state === "fail" ? <X size={15} /> : <Check size={15} />}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </span>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
