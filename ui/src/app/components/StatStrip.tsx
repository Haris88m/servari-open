import { motion } from "motion/react";
import { Coins, Users, Heart, ShieldCheck, Activity, Rocket } from "lucide-react";
import { staggerItem } from "../lib/motion";

interface StatStripProps {
  // Tokens
  tokVal: number;
  tokCost: number;
  // Agents
  activeAgents: number;
  paneCount: number;
  // Health
  healthWord: string;
  healthColor: string;
  // Gates
  gatesPending: number;
  // Context pressure
  pressureWord: string;
  pressureColor: string;
  // Launch
  launchNum: string;
  launchName: string;
  onNavigate: (path: string) => void;
}

function compact(n: number): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return Math.round(n).toLocaleString("en-US");
}

function money(n: number): string {
  if (!isFinite(n)) return "$0.00";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface ChipProps {
  children: React.ReactNode;
  index: number;
  onClick: () => void;
  last?: boolean;
}

function Chip({ children, index, onClick, last }: ChipProps) {
  return (
    <motion.button
      {...staggerItem(index)}
      onClick={onClick}
      className="flex items-center gap-2 h-full px-5 cursor-pointer relative transition-colors"
      style={{
        borderRight: last ? "none" : "1px solid var(--s-edge-subtle)",
        flex: "1 1 0",
      }}
      whileHover={{ backgroundColor: "var(--s-hover-bg)" }}
      whileTap={{ scale: 0.98 }}
    >
      {children}
    </motion.button>
  );
}

export function StatStrip({
  tokVal,
  tokCost,
  activeAgents,
  paneCount,
  healthWord,
  healthColor,
  gatesPending,
  pressureWord,
  pressureColor,
  launchNum,
  launchName,
  onNavigate,
}: StatStripProps) {
  return (
    <div
      className="flex items-stretch shrink-0"
      style={{
        height: 72,
        borderTop: "1px solid var(--s-edge-subtle)",
        background: "var(--s-panel)",
      }}
    >
      {/* TOKENS — 2-line special chip */}
      <Chip index={0} onClick={() => onNavigate("/shell/tokens")}>
        <Coins size={14} style={{ color: "var(--s-text-teal)", flexShrink: 0 }} />
        <div className="flex flex-col items-start">
          <span
            className="tabular-nums leading-none"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-16)",
              fontWeight: 700,
              color: "var(--s-text-teal)",
            }}
          >
            {money(tokCost)}
          </span>
          <span
            className="tabular-nums leading-none mt-0.5"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-11)",
              color: "var(--s-text-secondary)",
              letterSpacing: "var(--ls-caps)",
              textTransform: "uppercase",
            }}
          >
            {compact(tokVal)} tok
          </span>
        </div>
      </Chip>

      {/* AGENTS */}
      <Chip index={1} onClick={() => onNavigate("/shell/agents")}>
        <Users size={14} style={{ color: "var(--s-text-teal-soft)", flexShrink: 0 }} />
        <div className="flex items-baseline gap-1.5">
          <span
            className="tabular-nums"
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-16)", fontWeight: 700, color: "var(--s-text-primary)" }}
          >
            {activeAgents}
          </span>
          <span style={{ fontSize: "var(--t-10)", color: "var(--s-text-secondary)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
            ACTIVE · {paneCount} total
          </span>
        </div>
      </Chip>

      {/* HEALTH */}
      <Chip index={2} onClick={() => onNavigate("/shell/health")}>
        <Heart size={14} style={{ color: healthColor, flexShrink: 0 }} />
        <div className="flex items-baseline gap-1.5">
          <span
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-16)", fontWeight: 700, color: healthColor, letterSpacing: "0.02em" }}
          >
            {healthWord}
          </span>
        </div>
      </Chip>

      {/* GATES */}
      <Chip index={3} onClick={() => onNavigate("/shell/fast-verify")}>
        <ShieldCheck
          size={14}
          style={{ color: gatesPending > 0 ? "var(--s-status-warn)" : "var(--s-text-secondary)", flexShrink: 0 }}
        />
        <div className="flex items-baseline gap-1.5">
          <span
            className="tabular-nums"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-16)",
              fontWeight: 700,
              color: gatesPending > 0 ? "var(--s-status-warn)" : "var(--s-text-secondary)",
            }}
          >
            {gatesPending}
          </span>
          <span style={{ fontSize: "var(--t-10)", color: "var(--s-text-secondary)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
            GATES
          </span>
        </div>
      </Chip>

      {/* CONTEXT */}
      <Chip index={4} onClick={() => onNavigate("/shell/context-pressure")}>
        <Activity size={14} style={{ color: pressureColor, flexShrink: 0 }} />
        <div className="flex items-baseline gap-1.5">
          <span
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-16)", fontWeight: 700, color: pressureColor, letterSpacing: "0.02em" }}
          >
            {pressureWord}
          </span>
          <span style={{ fontSize: "var(--t-10)", color: "var(--s-text-secondary)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
            CTX
          </span>
        </div>
      </Chip>

      {/* LAUNCH */}
      <Chip index={5} onClick={() => onNavigate("/shell/launch-arc")} last>
        <Rocket size={14} style={{ color: "var(--s-text-teal)", flexShrink: 0 }} />
        <div className="flex items-baseline gap-1.5">
          <span
            className="tabular-nums"
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-16)", fontWeight: 700, color: "var(--s-text-teal)" }}
          >
            {launchNum}
          </span>
          <span
            className="truncate"
            style={{ fontSize: "var(--t-11)", color: "var(--s-text-secondary)", maxWidth: 80 }}
          >
            {launchName}
          </span>
        </div>
      </Chip>
    </div>
  );
}
