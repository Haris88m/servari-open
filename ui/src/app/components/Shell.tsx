import { useState, useEffect } from "react";
import { useLocation, useOutlet } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { TopBar } from "./TopBar";
import { Dock } from "./Dock";
import { ProcessTableOverlay } from "./ProcessTableOverlay";
import { AmbientBackground } from "./AmbientBackground";
import { BackgroundFX } from "./BackgroundFX";
import { FocusMode } from "./FocusMode";
import { GlobalVoice } from "./GlobalVoice";
import { ChatPanel } from "./ChatPanel";

// Stage transition: old stage fades + slides 12px down on the way out,
// new stage fades + slides up on the way in. Custom ease, never linear.
const STAGE_EASE = [0.22, 1, 0.36, 1] as const;

export function Shell() {
  const [isDockExpanded, setIsDockExpanded] = useState(false);
  const [isDockPinned, setIsDockPinned] = useState(false);
  const [isProcessTableOpen, setIsProcessTableOpen] = useState(false);
  const [isFocusOpen, setIsFocusOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const location = useLocation();

  // Ctrl+Shift+F → FocusMode toggle
  // Ctrl+K → ChatPanel toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setIsFocusOpen((v) => !v);
      }
      if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setIsChatOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const outlet = useOutlet();

  const getActiveAppName = () => {
    const path = location.pathname;
    if (path === "/shell" || path === "/shell/") return "DASHBOARD";
    if (path.includes("chat")) return "CHAT";
    if (path.includes("agents")) return "AGENTS";
    if (path.includes("company")) return "THE COMPANY";
    if (path.includes("org-chart")) return "ORG CHART";
    if (path.includes("standing-orders")) return "STANDING ORDERS";
    if (path.includes("launch-arc")) return "LAUNCH ARC";
    if (path.includes("autonomy-dials")) return "AUTONOMY DIALS";
    if (path.includes("fast-verify")) return "FAST-VERIFY GATES";
    if (path.includes("retention")) return "RETENTION";
    if (path.includes("context-pressure")) return "CONTEXT PRESSURE";
    if (path.includes("health")) return "HEALTH";
    if (path.includes("tokens")) return "TOKENS";
    if (path.includes("personal")) return "PERSONAL";
    return "CHAT";
  };

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{
        background: "var(--servari-ink)",
        fontFamily: "var(--font-mono)",
      }}
    >
      {/* Ambient background */}
      <AmbientBackground />

      {/* High-tech HUD layer */}
      <BackgroundFX />

      {/* Top bar */}
      <TopBar
        activeAppName={getActiveAppName()}
        onProcessTableClick={() => setIsProcessTableOpen(true)}
      />

      {/* Layout grid */}
      <div className="flex h-full pt-[46px]">
        {/* Dock */}
        <Dock
          isExpanded={isDockExpanded || isDockPinned}
          isPinned={isDockPinned}
          onExpandChange={setIsDockExpanded}
          onPinChange={setIsDockPinned}
        />

        {/* Stage — shrinks right margin when chat panel is open */}
        <main
          className="flex-1 relative overflow-auto"
          style={{
            marginRight: isChatOpen ? 380 : 0,
            transition: "margin-right 0.38s cubic-bezier(0.22,1,0.36,1)",
          }}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              className="min-h-full"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.25, ease: STAGE_EASE }}
            >
              {outlet}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* GLOBAL VOICE — survives navigation */}
      <GlobalVoice />

      {/* CHAT PANEL — slide-in from right, Ctrl+K toggles */}
      <ChatPanel isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />

      {/* Floating chat trigger — bottom-right, above GlobalVoice */}
      <AnimatePresence>
        {!isChatOpen && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => setIsChatOpen(true)}
            className="fixed bottom-20 right-5 z-30 rounded-full grid place-items-center"
            style={{
              width: 48,
              height: 48,
              background: "var(--s-panel)",
              border: "1px solid var(--s-edge-accent)",
              boxShadow: "var(--s-glow-teal)",
            }}
            whileHover={{ scale: 1.08, boxShadow: "var(--s-glow-primary)" }}
            whileTap={{ scale: 0.95 }}
            title="Open SERVARI chat (Ctrl+K)"
          >
            <img
              src="/raven.png"
              alt="Chat"
              style={{ width: 24, height: 24, objectFit: "contain", filter: "drop-shadow(0 0 4px rgba(20,156,150,0.6))" }}
              draggable={false}
            />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Process Table Overlay */}
      {isProcessTableOpen && (
        <ProcessTableOverlay onClose={() => setIsProcessTableOpen(false)} />
      )}

      {/* FocusMode — Ctrl+Shift+F */}
      <AnimatePresence>
        {isFocusOpen && <FocusMode onExit={() => setIsFocusOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
