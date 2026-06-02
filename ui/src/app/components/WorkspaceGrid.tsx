import { motion } from "motion/react";
import { type GridPane, paneTurnCount } from "../lib/api";
import { staggerItem } from "../lib/motion";
import { sealLabel } from "../lib/display_seal";

interface WorkspaceGridProps {
  panes: GridPane[];
}

function statusDotColor(status: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "active" || s === "live" || s === "busy") return "var(--s-status-ok)";
  if (s === "idle") return "var(--s-status-warn)";
  if (s === "error" || s === "blocked") return "var(--s-status-error)";
  return "var(--s-text-secondary)";
}

function isActivePaneStatus(status: string, owes: number): boolean {
  const s = String(status || "").toLowerCase();
  return s === "active" || s === "live" || s === "busy" || owes > 0;
}

function money(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function AgentPane({ pane, index }: { pane: GridPane; index: number }) {
  const active = isActivePaneStatus(pane.status, Number(pane.owes) || 0);
  const dotColor = statusDotColor(pane.status);
  const owes = Number(pane.owes) || 0;
  // pane.turns is an ARRAY of turn objects from the server — never a number.
  // Use the safe count for display + arithmetic (rendering the array/objects
  // as a React child is what threw React error #31).
  const turnCount = paneTurnCount(pane);

  return (
    <motion.div
      {...staggerItem(index)}
      className="flex flex-col overflow-hidden rounded-xl"
      style={{
        minHeight: 200,
        background: "var(--s-glass-light)",
        border: "1px solid var(--s-edge-subtle)",
        transition: "border-color 150ms ease",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "var(--s-edge-accent)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "var(--s-edge-subtle)";
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 shrink-0"
        style={{ height: 36, borderBottom: "1px solid var(--s-edge-subtle)" }}
      >
        {/* Status dot */}
        <motion.span
          className="rounded-full shrink-0"
          style={{ width: 6, height: 6, background: dotColor }}
          animate={active ? { opacity: [1, 0.4, 1] } : { opacity: 0.5 }}
          transition={active ? { duration: 1.8, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
        />

        {/* Agent name — SEALED. pane.name is the raw channel key, which can carry
            internal display vocabulary; the display seal maps it to the clean
            outward form before it renders. */}
        <span
          className="flex-1 truncate"
          style={{ fontSize: "var(--t-13)", color: "var(--s-text-primary)", fontWeight: 600 }}
          title={sealLabel(pane.name) || pane.name}
        >
          {sealLabel(pane.name) || pane.name}
        </span>

        {/* Turns count */}
        <span style={{ fontSize: "var(--t-11)", color: "var(--s-text-secondary)", fontFamily: "var(--font-mono)" }}>
          {turnCount}t
        </span>

        {/* Owes badge */}
        {owes > 0 && (
          <span
            style={{
              fontSize: "var(--t-11)",
              color: "var(--s-text-teal)",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
            }}
          >
            {money(owes)}
          </span>
        )}
      </div>

      {/* Body — last activity placeholder */}
      <div className="flex-1 p-2 overflow-hidden">
        {turnCount > 0 ? (
          <div
            style={{
              fontSize: "var(--t-11)",
              fontFamily: "var(--font-mono)",
              color: "var(--s-text-secondary)",
              lineHeight: 1.55,
            }}
          >
            <span style={{ color: "var(--s-text-secondary)", opacity: 0.5 }}>
              {String(pane.status || "").toLowerCase()}
            </span>
            {" · "}
            {turnCount} turn{turnCount !== 1 ? "s" : ""}
            {pane.last_ts && (
              <>
                {" · "}
                {(() => {
                  const ms = typeof pane.last_ts === "string" ? Date.parse(pane.last_ts) : (pane.last_ts as number) * 1000;
                  if (!isFinite(ms)) return "—";
                  const diff = Math.floor((Date.now() - ms) / 1000);
                  if (diff < 60) return `${diff}s ago`;
                  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
                  return `${Math.floor(diff / 3600)}h ago`;
                })()}
              </>
            )}
          </div>
        ) : (
          <div
            className="h-full flex items-center justify-center"
            style={{ fontSize: "var(--t-11)", color: "var(--s-text-secondary)", fontFamily: "var(--font-mono)" }}
          >
            Waiting...
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function WorkspaceGrid({ panes }: WorkspaceGridProps) {
  if (panes.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center rounded-xl"
        style={{
          minHeight: 200,
          background: "var(--s-glass-light)",
          border: "1px solid var(--s-edge-subtle)",
        }}
      >
        <img
          src="/raven.png"
          alt=""
          style={{ width: 40, height: 40, opacity: 0.25, marginBottom: 12 }}
          draggable={false}
        />
        <div style={{ fontSize: "var(--t-14)", color: "var(--s-text-primary)", fontWeight: 500, marginBottom: 4 }}>
          No agents active
        </div>
        <div style={{ fontSize: "var(--t-11)", color: "var(--s-text-secondary)" }}>
          Start a session to see live agent activity
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 overflow-auto">
      {panes.map((pane, i) => (
        <AgentPane key={pane.key || pane.name} pane={pane} index={i} />
      ))}
    </div>
  );
}
