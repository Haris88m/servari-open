import { useState } from "react";
import { useNavigate, useLocation } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import {
  LayoutDashboard,
  MessageSquare,
  Users2,
  Network,
  ClipboardList,
  Gauge,
  ShieldCheck,
  Heart,
  Coins,
  Briefcase,
  Building2,
  Cpu,
  Bot,
  BarChart3,
  FileText,
  Settings2,
  Workflow,
  Pin,
  PinOff,
} from "lucide-react";
import { SNAPPY, SPRING_SNAPPY } from "../lib/motion";

interface DockProps {
  isExpanded: boolean;
  isPinned: boolean;
  onExpandChange: (expanded: boolean) => void;
  onPinChange: (pinned: boolean) => void;
}

// ── Navigation groups ────────────────────────────────────────────────────────

interface DockItem {
  id: string;
  icon: React.ElementType;
  label: string;
  path: string;
}

interface DockGroup {
  label: string;
  items: DockItem[];
}

const DOCK_GROUPS: DockGroup[] = [
  {
    label: "COMMAND",
    items: [
      { id: "dashboard", icon: LayoutDashboard, label: "Dashboard", path: "/shell" },
      { id: "chat", icon: MessageSquare, label: "Chat", path: "/shell/chat" },
      { id: "agent-apps", icon: Bot, label: "Agent Apps", path: "/shell/agent-apps" },
    ],
  },
  {
    label: "WORKSPACE",
    items: [
      { id: "agents", icon: Users2, label: "Agents", path: "/shell/agents" },
      { id: "org-chart", icon: Network, label: "Agent Map", path: "/shell/org-chart" },
      { id: "projects", icon: Workflow, label: "Projects", path: "/shell/projects" },
      { id: "standing-orders", icon: ClipboardList, label: "Standing Orders", path: "/shell/standing-orders" },
    ],
  },
  {
    label: "OPERATIONS",
    items: [
      { id: "fast-verify", icon: ShieldCheck, label: "Gates", path: "/shell/fast-verify" },
      { id: "autonomy-dials", icon: Gauge, label: "Autonomy", path: "/shell/autonomy-dials" },
      { id: "health", icon: Heart, label: "Health", path: "/shell/health" },
      { id: "engine", icon: Cpu, label: "Runtime", path: "/shell/runtime" },
      { id: "tokens", icon: Coins, label: "Tokens", path: "/shell/tokens" },
      { id: "settings", icon: Settings2, label: "Settings", path: "/shell/settings" },
    ],
  },
  {
    label: "VENTURES",
    items: [
      { id: "trading", icon: BarChart3, label: "Trading", path: "/shell/trading" },
      { id: "cv-builder", icon: FileText, label: "CV Builder", path: "/shell/cv-builder" },
      { id: "company", icon: Building2, label: "The Company", path: "/shell/company" },
      { id: "personal", icon: Briefcase, label: "Personal", path: "/shell/personal" },
    ],
  },
];

export function Dock({ isExpanded, isPinned, onExpandChange, onPinChange }: DockProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const isActive = (path: string) => {
    if (path === "/shell") {
      return location.pathname === "/shell" || location.pathname === "/shell/";
    }
    return location.pathname === path;
  };

  // All items flat for stagger indexing
  const allItems = DOCK_GROUPS.flatMap((g) => g.items);

  return (
    <motion.div
      className="fixed left-0 top-[46px] bottom-0 z-40 flex flex-col"
      initial={false}
      animate={{ width: isExpanded ? 210 : 64 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      onMouseEnter={() => !isPinned && onExpandChange(true)}
      onMouseLeave={() => !isPinned && onExpandChange(false)}
      style={{
        background: "var(--s-glass)",
        backdropFilter: "blur(24px)",
        borderRight: "1px solid var(--s-edge-subtle)",
      }}
    >
      {/* Header: pin toggle + raven home */}
      <div className="flex flex-col items-center pt-3 pb-2 shrink-0">
        {/* Pin toggle — keeps the dock open */}
        <motion.button
          onClick={() => onPinChange(!isPinned)}
          className="p-2 rounded"
          whileHover={{ backgroundColor: "var(--s-hover-bg)" }}
          whileTap={{ scale: 0.95 }}
          transition={SNAPPY}
          style={{ color: isPinned ? "var(--s-text-teal)" : "var(--s-text-secondary)" }}
          title={isPinned ? "Unpin sidebar" : "Pin sidebar open"}
        >
          {isPinned ? <Pin size={16} /> : <PinOff size={16} />}
        </motion.button>

        {/* Raven home — breathes, returns to Dashboard */}
        <motion.button
          onClick={() => navigate("/shell")}
          className="mt-2 p-1.5 rounded relative group grid place-items-center"
          whileHover={{ backgroundColor: "var(--s-hover-bg)" }}
          whileTap={{ scale: 0.95 }}
          transition={SNAPPY}
          title="Home — Dashboard"
        >
          <motion.img
            src="/raven.png"
            alt="SERVARI home"
            draggable={false}
            className="select-none"
            style={{ width: 26, height: 26, objectFit: "contain", filter: "drop-shadow(0 0 6px rgba(20,156,150,0.45))" }}
            animate={{ scale: [1, 1.04, 1] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          />
        </motion.button>
      </div>

      {/* Hairline under the header */}
      <div className="mx-2 mb-1" style={{ height: 1, background: "var(--s-edge-subtle)" }} />

      {/* Navigation groups */}
      <div
        className="flex-1 overflow-y-auto py-2"
        style={{ scrollbarWidth: "none" }}
        onClick={() => {
          // clicking expanded area while pinned = unpin
          if (isPinned && isExpanded) onPinChange(false);
        }}
      >
        {DOCK_GROUPS.map((group, gi) => {
          return (
            <div key={group.label}>
              {/* Section label — only when expanded */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={SNAPPY}
                    className="px-4 pt-3 pb-1 select-none"
                    style={{
                      fontSize: "var(--t-10)",
                      color: "var(--s-text-secondary)",
                      letterSpacing: "var(--ls-caps)",
                      textTransform: "uppercase",
                    }}
                    title="Pin sidebar open"
                  >
                    {group.label}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Items */}
              {group.items.map((app) => {
                const Icon = app.icon;
                const active = isActive(app.path);
                const hovered = hoveredId === app.id;
                const itemIndex = allItems.findIndex((i) => i.id === app.id);

                return (
                  <motion.button
                    key={app.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(app.path);
                    }}
                    onMouseEnter={() => setHoveredId(app.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    className="w-full flex items-center gap-3 relative"
                    whileTap={{ scale: 0.97 }}
                    transition={SPRING_SNAPPY}
                    style={{
                      height: 40,
                      paddingLeft: isExpanded ? 16 : 0,
                      paddingRight: isExpanded ? 16 : 0,
                      justifyContent: isExpanded ? "flex-start" : "center",
                      background: active
                        ? "rgba(20,156,150,0.06)"
                        : hovered
                          ? "var(--s-hover-bg)"
                          : "transparent",
                    }}
                  >
                    {/* Active teal tick — shared-layout indicator (slides between items) */}
                    {active && (
                      <motion.span
                        layoutId="dockActiveIndicator"
                        className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r"
                        style={{ width: 2, height: 22, background: "var(--servari-teal)", boxShadow: "var(--s-glow-teal)" }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                      />
                    )}

                    {/* Icon */}
                    <motion.span
                      animate={{
                        filter:
                          active || hovered
                            ? "drop-shadow(0 0 6px rgba(20,156,150,0.7))"
                            : "drop-shadow(0 0 0px rgba(20,156,150,0))",
                      }}
                      transition={{ duration: 0.2 }}
                      style={{ display: "inline-flex", flexShrink: 0 }}
                    >
                      <Icon
                        size={16}
                        style={{
                          color: active ? "var(--s-text-teal)" : "var(--s-text-secondary)",
                        }}
                      />
                    </motion.span>

                    {/* Label */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.span
                          key="label"
                          initial={{ opacity: 0, x: -6 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -6 }}
                          transition={{ ...SNAPPY, delay: itemIndex * 0.025 }}
                          className="whitespace-nowrap truncate"
                          style={{
                            color: active ? "var(--s-text-teal)" : "var(--s-text-primary)",
                            fontSize: "var(--t-13)",
                          }}
                        >
                          {app.label}
                        </motion.span>
                      )}
                    </AnimatePresence>

                    {/* Collapsed active dot */}
                    {!isExpanded && active && (
                      <span
                        className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
                        style={{ background: "var(--servari-teal)" }}
                      />
                    )}
                  </motion.button>
                );
              })}

              {/* Hairline separator between groups (not after last) */}
              {gi < DOCK_GROUPS.length - 1 && (
                <div
                  className="mx-2 my-2"
                  style={{ height: 1, background: "var(--s-edge-subtle)" }}
                />
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
