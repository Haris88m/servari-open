import { useState, useEffect } from "react";
import { useLocation, useNavigate, useOutlet } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { TopBar } from "./TopBar";
import { Dock } from "./Dock";
import { ProcessTableOverlay } from "./ProcessTableOverlay";
import { AmbientBackground } from "./AmbientBackground";
import { BackgroundFX } from "./BackgroundFX";
import { FocusMode } from "./FocusMode";
import { GlobalVoice } from "./GlobalVoice";

// Stage transition: old stage fades + slides 12px down on the way out,
// new stage fades + slides up on the way in. Custom ease, never linear.
const STAGE_EASE = [0.22, 1, 0.36, 1] as const;
const DOCK_COLLAPSED_WIDTH = 64;
const DOCK_EXPANDED_WIDTH = 210;

export function Shell() {
  const [isDockExpanded, setIsDockExpanded] = useState(false);
  const [isDockPinned, setIsDockPinned] = useState(false);
  const [isProcessTableOpen, setIsProcessTableOpen] = useState(false);
  const [isFocusOpen, setIsFocusOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const dockWidth =
    isDockExpanded || isDockPinned ? DOCK_EXPANDED_WIDTH : DOCK_COLLAPSED_WIDTH;
  const isChatRoute = location.pathname === "/shell/chat";

  // Ctrl+Shift+F -> FocusMode toggle
  // Ctrl+K -> Open the chat route
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setIsFocusOpen((v) => !v);
      }
      if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        void navigate("/shell/chat");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

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
    if (path.includes("engine") || path.includes("runtime")) return "RUNTIME";
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

        {/* Stage content */}
        <main
          className="flex-1 relative overflow-auto"
          style={{
            marginLeft: dockWidth,
            transition: "margin-left 0.28s cubic-bezier(0.22,1,0.36,1)",
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
      <GlobalVoice showMiniChat={!isChatRoute} />

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
