import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Check, Play, Pause } from "lucide-react";

/**
 * FocusMode — the distraction-free deep-work overlay, skinned to SERVARI tokens.
 *
 * Opens on Ctrl+Shift+F (the keybind lives in the shell). Everything dims to an
 * ink void; you pick the ONE thing you're shipping, and a deep-work timer runs
 * inside a rotating-ring HUD core. Calm, total focus.
 *
 * Self-contained: the caller may pass `projects`; if omitted we use a generic
 * demo set so there is never a missing-import dependency on another file.
 *
 * DISPLAY SEAL: these project labels are CHROME. Drive them from your own data
 * to reflect a real portfolio.
 */

export interface FocusProject {
  name: string;
  client: string;
}

const DEFAULT_PROJECTS: FocusProject[] = [
  { name: "PLATFORM", client: "The core platform" },
  { name: "DEMO CRM", client: "Business" },
  { name: "STUDIO", client: "Design & content" },
  { name: "RETAIL", client: "Store management" },
  { name: "LABS", client: "Research" },
  { name: "SERVARI", client: "The product" },
];

export function FocusMode({
  onExit,
  projects = DEFAULT_PROJECTS,
}: {
  onExit: () => void;
  projects?: FocusProject[];
}) {
  const [task, setTask] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);

  // Tick the deep-work timer once a second while running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Esc also exits the overlay (the X button + the host keybind are the others).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  const fmt = (s: number) => {
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60]"
      style={{
        background:
          "radial-gradient(ellipse at center, rgba(15,18,24,0.95), var(--servari-ink) 70%)",
        backdropFilter: "blur(8px)",
        fontFamily: "var(--font-mono)",
      }}
    >
      {/* scoped scanline + keyframes — teal-translated, no external dependency */}
      <style>{`
        .servari-focus-scan::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          background: repeating-linear-gradient(
            to bottom,
            rgba(20,156,150,0.025) 0px, rgba(20,156,150,0.025) 1px,
            transparent 1px, transparent 3px);
          mix-blend-mode: screen;
        }
      `}</style>
      <div className="servari-focus-scan absolute inset-0 pointer-events-none" />

      <button
        onClick={onExit}
        className="absolute top-6 right-6 w-9 h-9 grid place-items-center rounded transition-colors hover:bg-white/5"
        style={{
          border: "1px solid var(--servari-edge-2)",
          color: "var(--servari-dimmed)",
        }}
        title="Exit focus (Esc)"
      >
        <X size={16} />
      </button>

      <div className="h-full flex items-center justify-center">
        <div className="relative w-[680px] max-w-[90vw]">
          <AnimatePresence mode="wait">
            {!task ? (
              <motion.div
                key="select"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
              >
                <div
                  className="text-center text-[14px] mb-2"
                  style={{ color: "var(--servari-dimmed)", letterSpacing: "0.4em" }}
                >
                  FOCUS PROTOCOL
                </div>
                <div
                  className="text-center text-[42px] mb-10"
                  style={{
                    color: "var(--servari-teal)",
                    fontFamily: "var(--font-wordmark)",
                    letterSpacing: "0.08em",
                    textShadow: "0 0 12px rgba(20,156,150,0.45), 0 0 28px rgba(20,156,150,0.18)",
                  }}
                >
                  I AM WORKING TODAY
                </div>
                <div className="text-[12px] mb-3" style={{ color: "var(--servari-dimmed)" }}>
                  Pick the one project you're shipping today. Everything else dissolves.
                </div>
                <div className="grid grid-cols-2 gap-2 max-h-[40vh] overflow-y-auto pr-2">
                  {projects.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => {
                        setProject(p.name);
                        setTask(p.client);
                        setRunning(true);
                      }}
                      className="text-left p-3 rounded transition group hover:bg-white/5"
                      style={{
                        background: "var(--servari-panel)",
                        border: "1px solid var(--servari-edge-1)",
                      }}
                    >
                      <div className="text-[12px]" style={{ color: "var(--servari-teal)" }}>
                        {p.name}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: "var(--servari-dimmed)" }}>
                        {p.client}
                      </div>
                    </button>
                  ))}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="run"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center"
              >
                <div className="text-[11px]" style={{ color: "var(--servari-dimmed)" }}>
                  NOW SHIPPING
                </div>
                <div className="text-[18px] mt-2" style={{ color: "var(--servari-ivory)" }}>
                  {task}
                </div>
                <div
                  className="text-[36px] mt-1"
                  style={{
                    color: "var(--servari-teal)",
                    fontFamily: "var(--font-wordmark)",
                    letterSpacing: "0.08em",
                  }}
                >
                  {project}
                </div>

                <div className="relative w-[360px] h-[360px] max-w-[80vw] mx-auto mt-8">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 26, repeat: Infinity, ease: "linear" }}
                    className="absolute inset-0 rounded-full"
                    style={{ border: "1px dashed var(--servari-teal)", opacity: 0.4 }}
                  />
                  <motion.div
                    animate={{ rotate: -360 }}
                    transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
                    className="absolute inset-6 rounded-full"
                    style={{ border: "1px solid var(--servari-teal-soft)", opacity: 0.3 }}
                  />
                  <div
                    className="absolute inset-12 rounded-full grid place-items-center"
                    style={{
                      background: "radial-gradient(circle, rgba(20,156,150,0.18), transparent 70%)",
                      border: "1px solid var(--servari-teal)",
                      boxShadow:
                        "0 0 60px rgba(20,156,150,0.35), inset 0 0 60px rgba(20,156,150,0.10)",
                    }}
                  >
                    <div>
                      <div
                        className="text-[44px]"
                        style={{
                          color: "var(--servari-teal)",
                          fontFamily: "var(--font-wordmark)",
                          letterSpacing: "0.08em",
                          textShadow:
                            "0 0 8px rgba(20,156,150,0.5), 0 0 18px rgba(20,156,150,0.18)",
                        }}
                      >
                        {fmt(seconds)}
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: "var(--servari-dimmed)" }}>
                        SESSION · DEEP WORK
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-center gap-2 mt-8">
                  <button
                    onClick={() => setRunning((r) => !r)}
                    className="px-4 py-2 rounded text-[12px] flex items-center gap-2"
                    style={{ background: "var(--servari-teal)", color: "#04121a" }}
                  >
                    {running ? (
                      <>
                        <Pause size={12} /> PAUSE
                      </>
                    ) : (
                      <>
                        <Play size={12} /> RESUME
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setTask(null);
                      setProject(null);
                      setSeconds(0);
                      setRunning(false);
                    }}
                    className="px-4 py-2 rounded text-[12px] flex items-center gap-2 hover:bg-white/5"
                    style={{
                      background: "var(--servari-panel)",
                      color: "var(--servari-ivory)",
                      border: "1px solid var(--servari-edge-1)",
                    }}
                  >
                    <Check size={12} /> FINISH
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
