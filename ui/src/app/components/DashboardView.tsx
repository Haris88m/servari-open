import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import {
  Server,
  PlayCircle,
  BarChart2,
  Map,
  AlertCircle,
  CheckSquare,
  Activity,
  Cpu,
} from "lucide-react";
import {
  API,
  type TokensResponse,
  type GridResponse,
  type HealthCheckResponse,
  type VerifyQueueResponse,
  type RetentionResponse,
  type ContextResponse,
  type LaunchResponse,
  type StateResponse,
  type RunResponse,
  type EngineState,
  paneTurnCount,
} from "../lib/api";
import { sealLabel } from "../lib/display_seal";
import { COMPOSED, SNAPPY, staggerItem } from "../lib/motion";
import { StatStrip } from "./StatStrip";
import { VentureStrip } from "./VentureStrip";
import { WorkspaceGrid } from "./WorkspaceGrid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function money(n: number): string {
  if (!isFinite(n)) return "$0.00";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtRelative(ts: number | string | null | undefined): string {
  if (!ts) return "—";
  const ms = typeof ts === "string" ? Date.parse(ts) : (ts as number) * 1000;
  if (!isFinite(ms)) return "—";
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtTime(ts: number | string | null | undefined): string {
  if (!ts) return "—";
  const ms = typeof ts === "string" ? Date.parse(ts) : (ts as number) * 1000;
  if (!isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function readPressure(p: number | string | undefined): string {
  if (p === undefined || p === null) return "UNKNOWN";
  if (typeof p === "string") {
    const up = p.toUpperCase();
    if (up.startsWith("LOW")) return "LOW";
    if (up.startsWith("MOD") || up.startsWith("MED")) return "MODERATE";
    if (up.startsWith("HIGH")) return "HIGH";
    if (up.startsWith("CRIT")) return "CRITICAL";
    const num = Number(p);
    if (!isNaN(num)) return readPressure(num);
    return up || "UNKNOWN";
  }
  const f = p > 1 ? p / 100 : p;
  if (f < 0.4) return "LOW";
  if (f < 0.7) return "MODERATE";
  if (f < 0.9) return "HIGH";
  return "CRITICAL";
}

function splitNum(stage: string): string {
  const m = (stage || "").match(/^\s*([0-9]+)\s+/);
  return m ? m[1] : "—";
}

function splitName(stage: string): string {
  const m = (stage || "").match(/^\s*[0-9]+\s+(.*)$/);
  const raw = m ? m[1].trim() : (stage || "").trim() || "stage";
  return sealLabel(raw) || raw;
}

// ---------------------------------------------------------------------------
// Panel base — ivory title (NOT teal)
// ---------------------------------------------------------------------------

function Panel({
  title,
  meta,
  children,
  index = 0,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...COMPOSED, delay: 0.1 + index * 0.06 }}
      className="rounded-xl overflow-hidden flex flex-col"
      style={{
        background: "var(--s-glass-light)",
        border: "1px solid var(--s-edge-subtle)",
      }}
    >
      <div
        className="px-4 py-2.5 flex items-center justify-between shrink-0"
        style={{ borderBottom: "1px solid var(--s-edge-subtle)" }}
      >
        <div className="flex items-baseline gap-3">
          <span
            style={{
              color: "var(--s-text-primary)",
              fontSize: "var(--t-14)",
              fontWeight: 500,
              letterSpacing: "var(--ls-tight)",
            }}
          >
            {title}
          </span>
          {meta && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--s-text-secondary)",
                fontSize: "var(--t-11)",
              }}
            >
              {meta}
            </span>
          )}
        </div>
      </div>
      <div className="p-4 flex-1">{children}</div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// SectionHeader
// ---------------------------------------------------------------------------

function SectionHeader({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span
        style={{
          fontSize: "var(--t-11)",
          color: "var(--s-text-secondary)",
          letterSpacing: "var(--ls-caps)",
          textTransform: "uppercase" as const,
        }}
      >
        {label}
      </span>
      {meta && (
        <span
          style={{
            fontSize: "var(--t-11)",
            fontFamily: "var(--font-mono)",
            color: "var(--s-text-secondary)",
          }}
        >
          {meta}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrioritiesPanel
// ---------------------------------------------------------------------------

const TAG_COLORS: Record<string, { color: string; border: string }> = {
  GATE: { color: "var(--s-status-warn)", border: "rgba(224,169,42,0.3)" },
  RETAIN: { color: "var(--s-text-teal-soft)", border: "rgba(95,184,179,0.3)" },
  OPEN: { color: "var(--s-status-error)", border: "rgba(248,81,73,0.3)" },
  INFO: { color: "var(--s-text-secondary)", border: "rgba(250,248,243,0.1)" },
  MAINT: { color: "var(--s-text-secondary)", border: "rgba(250,248,243,0.1)" },
  COST: { color: "var(--s-status-warn)", border: "rgba(224,169,42,0.3)" },
};

function PrioritiesPanel({
  items,
  checked,
  onToggle,
  index,
}: {
  items: Array<{ id: string; label: string; tag: string }>;
  checked: Set<string>;
  onToggle: (id: string) => void;
  index: number;
}) {
  return (
    <Panel title="Priorities" meta={`${items.length} items`} index={index}>
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2" style={{ minHeight: 80 }}>
          <CheckSquare size={20} style={{ color: "var(--s-text-secondary)" }} />
          <div style={{ fontSize: "var(--t-13)", color: "var(--s-text-primary)" }}>All clear</div>
          <div style={{ fontSize: "var(--t-11)", color: "var(--s-text-secondary)" }}>No pending gates</div>
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((item, i) => {
            const done = checked.has(item.id);
            const tagStyle = TAG_COLORS[item.tag] || TAG_COLORS.INFO;
            return (
              <motion.div
                key={item.id}
                {...staggerItem(i)}
                className="flex items-start gap-3 cursor-pointer"
                style={{ minHeight: 40, paddingTop: 6, paddingBottom: 6 }}
                onClick={() => onToggle(item.id)}
              >
                <span
                  className="shrink-0 flex items-center justify-center"
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    border: done ? "1.5px solid var(--servari-teal)" : "1.5px solid var(--s-edge)",
                    background: done ? "var(--servari-teal)" : "transparent",
                    marginTop: 1,
                    transition: "all 0.2s",
                    flexShrink: 0,
                  }}
                >
                  {done && (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                      <path
                        d="M1 4L3.5 6.5L9 1"
                        stroke="var(--servari-ink)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span
                  className="flex-1 leading-snug"
                  style={{
                    fontSize: "var(--t-13)",
                    color: done ? "var(--s-text-secondary)" : "var(--s-text-primary)",
                    textDecoration: done ? "line-through" : "none",
                    opacity: done ? 0.6 : 1,
                    transition: "all 0.2s",
                  }}
                >
                  {item.label}
                </span>
                <span
                  className="shrink-0"
                  style={{
                    fontSize: "var(--t-10)",
                    color: tagStyle.color,
                    border: `1px solid ${tagStyle.border}`,
                    borderRadius: 4,
                    padding: "2px 6px",
                    letterSpacing: "var(--ls-caps)",
                    textTransform: "uppercase" as const,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {item.tag}
                </span>
              </motion.div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// ActivityPanel
// ---------------------------------------------------------------------------

function ActivityPanel({
  items,
  index,
}: {
  items: Array<{ channel: string; text: string; ts: number | string | null }>;
  index: number;
}) {
  return (
    <Panel title="Activity" meta="live · last 8" index={index}>
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2" style={{ minHeight: 80 }}>
          <Activity size={20} style={{ color: "var(--s-text-secondary)" }} />
          <div style={{ fontSize: "var(--t-13)", color: "var(--s-text-primary)" }}>No activity yet</div>
          <div style={{ fontSize: "var(--t-11)", color: "var(--s-text-secondary)" }}>
            Agent channel events appear here
          </div>
        </div>
      ) : (
        <div>
          {items.map((item, i) => (
            <motion.div
              key={`${item.channel}-${i}`}
              {...staggerItem(i)}
              className="flex items-baseline gap-2"
              style={{
                height: 32,
                borderBottom: i < items.length - 1 ? "1px solid var(--s-edge-subtle)" : "none",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-10)",
                  color: "var(--s-text-teal)",
                  width: 44,
                  flexShrink: 0,
                }}
              >
                {fmtTime(item.ts)}
              </span>
              <span
                className="truncate"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-11)",
                  color: "var(--s-text-primary)",
                  fontWeight: 500,
                  width: 80,
                  flexShrink: 0,
                }}
              >
                {item.channel}
              </span>
              <span
                className="flex-1 truncate"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-11)",
                  color: "var(--s-text-secondary)",
                }}
              >
                {item.text}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-10)",
                  color: "var(--s-text-secondary)",
                  width: 48,
                  flexShrink: 0,
                  textAlign: "right" as const,
                }}
              >
                {fmtRelative(item.ts)}
              </span>
            </motion.div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// QuickActionsPanel — fires the demo /api/run actions exposed by the server.
// Titles are display copy; the `action` ids must match the server's allow-list.
// ---------------------------------------------------------------------------

const QUICK_ACTIONS = [
  { icon: Server, title: "Say Hello", action: "echo-hello", color: "var(--servari-teal)" },
  { icon: PlayCircle, title: "List Agents", action: "list-demo-agents", color: "var(--servari-teal-soft)" },
  { icon: BarChart2, title: "Disk Free", action: "disk-free", color: "var(--servari-amber)" },
  { icon: Map, title: "Python Version", action: "python-version", color: "var(--servari-green)" },
] as const;

type ActionResult = RunResponse | "loading" | "error" | null;

function EnginePanel({
  status,
  error,
  index,
  onOpenPanel,
}: {
  status: EngineState | null;
  error: string;
  index: number;
  onOpenPanel: () => void;
}) {
  const running = Boolean(status?.running);
  const pid = status?.pid ?? null;
  const cfg = status?.config || {};
  const host = String(cfg.host || "127.0.0.1");
  const port = typeof cfg.port === "number" ? cfg.port : Number.parseInt(String(cfg.port || "7000"), 10) || 7000;
  const launched = status?.started_at
    ? new Date(status.started_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "";
  const badgeColor = running ? "var(--s-status-ok)" : "var(--s-text-secondary)";
  const probeReady =
    typeof status?.probe_ready === "object" && status?.probe_ready !== null
      ? (status.probe_ready as Record<string, unknown>)
      : null;
  const readyLabel = probeReady && typeof probeReady.ok === "boolean" ? (probeReady.ok ? "READY" : "NOT READY") : running ? "STARTING" : "OFF";
  const indicatorGlow = running ? "var(--s-glow-green)" : "none";

  const openService = () => {
    if (!running) return;
    window.open(`http://${host}:${port}`, "_blank", "noopener,noreferrer");
  };

  return (
    <Panel title="SERVARI Runtime" meta="managed runtime" index={index}>
      <div className="space-y-3">
        <div
          className="rounded-lg px-3 py-2 flex items-center justify-between"
          style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass)" }}
        >
          <span
            className="inline-flex items-center gap-2"
            style={{ color: badgeColor, fontSize: "var(--t-12)", fontFamily: "var(--font-mono)" }}
          >
            <span
              className="inline-block rounded-full"
              style={{
                width: 8,
                height: 8,
                background: running ? "var(--s-status-ok)" : "var(--s-text-secondary)",
                boxShadow: indicatorGlow,
              }}
            />
            <Cpu size={14} />
            {running ? `RUNNING ${host}:${port}` : "STOPPED"}
          </span>
          <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-10)", fontFamily: "var(--font-mono)" }}>
            {status ? `pid ${pid ?? "n/a"}` : "not managed"}
          </span>
        </div>

        <div
          className="rounded-lg px-3 py-2"
          style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250, 248, 243, 0.03)" }}
        >
          <div
            className="grid"
            style={{
              gap: 4,
              fontSize: "var(--t-11)",
              color: "var(--s-text-secondary)",
              gridTemplateColumns: "1fr 1fr",
            }}
          >
            <span>Ready probe</span>
            <span style={{ color: "var(--s-text-primary)", textAlign: "right" }}>{running ? readyLabel : "off"}</span>
            <span>Started</span>
            <span style={{ color: "var(--s-text-primary)", textAlign: "right" }}>{launched || "--"}</span>
            <span>Home</span>
            <span
              style={{
                color: "var(--s-text-primary)",
                textAlign: "right",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {cfg.home || "--"}
            </span>
            <span>Status note</span>
            <span style={{ color: "var(--s-text-primary)", textAlign: "right" }}>{error || (status ? "ok" : "unavailable")}</span>
          </div>
        </div>

        {error && <div style={{ color: "var(--s-status-error)", fontSize: "var(--t-11)" }}>{error}</div>}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onOpenPanel}
            className="rounded-lg px-3 py-1.5 text-xs"
            style={{
              border: "1px solid var(--s-edge-subtle)",
              color: "var(--s-text-primary)",
              background: "rgba(250, 248, 243, 0.04)",
              boxShadow: running ? "0 0 16px rgba(20, 156, 150, 0.2)" : "none",
            }}
          >
            Open control
          </button>
          <button
            type="button"
            onClick={openService}
            disabled={!running}
            className="rounded-lg px-3 py-1.5 text-xs"
            style={{
              border: `1px solid ${running ? "var(--s-status-ok)" : "var(--s-edge-subtle)"}`,
              color: running ? "var(--s-status-ok)" : "var(--s-text-secondary)",
              background: running ? "rgba(63,185,80,0.12)" : "rgba(250, 248, 243, 0.02)",
            }}
          >
            Open service
          </button>
        </div>
      </div>
    </Panel>
  );
}

function QuickActionsPanel({ index }: { index: number }) {
  const [results, setResults] = useState<Record<string, ActionResult>>({});
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fire = useCallback(async (action: string) => {
    setResults((prev) => ({ ...prev, [action]: "loading" }));
    try {
      const res = await API.run(action);
      setResults((prev) => ({ ...prev, [action]: res }));
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast({
        msg: res.ok ? (res.out ? String(res.out).slice(0, 80) : "done") : (res.error || "failed"),
        ok: !!res.ok,
      });
      toastTimer.current = setTimeout(() => {
        setToast(null);
        setResults((prev) => ({ ...prev, [action]: null }));
      }, 4000);
    } catch {
      setResults((prev) => ({ ...prev, [action]: "error" }));
      setToast({ msg: "Network error", ok: false });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => {
        setToast(null);
        setResults((prev) => ({ ...prev, [action]: null }));
      }, 4000);
    }
  }, []);

  return (
    <div className="relative">
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={SNAPPY}
            className="absolute bottom-full mb-2 left-0 right-0 z-20 rounded-lg px-3 py-2"
            style={{
              background: "var(--s-glass)",
              border: "1px solid var(--s-edge-subtle)",
              backdropFilter: "blur(16px)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--t-12)",
                color: toast.ok ? "var(--s-status-ok)" : "var(--s-status-error)",
              }}
            >
              {toast.msg}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <Panel title="Quick Actions" meta="fire + forget" index={index}>
        <div className="space-y-1">
          {QUICK_ACTIONS.map((q, i) => {
            const res = results[q.action];
            const loading = res === "loading";
            return (
              <motion.button
                key={q.action}
                {...staggerItem(i)}
                onClick={() => fire(q.action)}
                disabled={loading}
                className="w-full flex items-center gap-3 rounded-lg"
                style={{
                  height: 44,
                  paddingLeft: 12,
                  paddingRight: 12,
                  cursor: loading ? "wait" : "pointer",
                  opacity: loading ? 0.7 : 1,
                }}
                whileHover={{ backgroundColor: "var(--s-hover-bg)" }}
                whileTap={{ scale: 0.98 }}
              >
                <span
                  className="grid place-items-center shrink-0"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: `${q.color}1A`,
                    border: `1px solid ${q.color}40`,
                    color: q.color,
                  }}
                >
                  {loading ? (
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                      className="rounded-full border-2"
                      style={{ width: 12, height: 12, borderColor: `${q.color}40`, borderTopColor: q.color, display: "block" }}
                    />
                  ) : (
                    <q.icon size={14} />
                  )}
                </span>
                <span
                  className="flex-1 text-left"
                  style={{ fontSize: "var(--t-13)", color: "var(--s-text-primary)" }}
                >
                  {q.title}
                </span>
                {(() => {
                  if (loading) return null;
                  if (res && res !== "loading" && res !== "error") {
                    const r = res as RunResponse;
                    return (
                      <span
                        className="rounded-full shrink-0"
                        style={{
                          width: 8,
                          height: 8,
                          background: r.ok ? "var(--s-status-ok)" : "var(--s-status-error)",
                          display: "inline-block",
                        }}
                      />
                    );
                  }
                  if (res === "error") {
                    return <AlertCircle size={14} style={{ color: "var(--s-status-error)" }} />;
                  }
                  return null;
                })()}
              </motion.button>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DashboardView — 3-zone OS layout
// ---------------------------------------------------------------------------

export function DashboardView() {
  const navigate = useNavigate();

  const [tokens, setTokens] = useState<TokensResponse | null>(null);
  const [grid, setGrid] = useState<GridResponse | null>(null);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [verify, setVerify] = useState<VerifyQueueResponse | null>(null);
  const [retention, setRetention] = useState<RetentionResponse | null>(null);
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [launch, setLaunch] = useState<LaunchResponse | null>(null);
  const [state, setState] = useState<StateResponse | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [engineError, setEngineError] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
      try {
        return await p;
      } catch {
        return null;
      }
    };
    const load = async () => {
      const [t, g, h, v, r, c, l, s, engineResp] = await Promise.all([
        safe(API.tokens()),
        safe(API.grid()),
        safe(API.health()),
        safe(API.verifyQueue()),
        safe(API.retention()),
        safe(API.context()),
        safe(API.launch()),
        safe(API.state()),
        safe(API.engineStatus()),
      ]);
      if (!alive) return;
      if (t) setTokens(t);
      if (g) setGrid(g);
      if (h) setHealth(h);
      if (v) setVerify(v);
      if (r) setRetention(r);
      if (c) setContext(c);
      if (l) setLaunch(l);
      if (s) setState(s);
      if (engineResp && engineResp.ok && engineResp.status) {
        setEngine(engineResp.status);
        setEngineError("");
      } else if (engineResp && engineResp.error) {
        setEngine(null);
        setEngineError(engineResp.error);
      } else if (!engineResp) {
        setEngine(null);
        setEngineError("engine status endpoint unavailable");
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // ── Derived values ────────────────────────────────────────────────────────

  const liveTotal = tokens?.live?.total_tokens ?? 0;
  const liveCost = tokens?.live?.cost_usd ?? 0;
  const allTime = tokens?.summary?.all_time;
  const tokVal = liveTotal > 0 ? liveTotal : (allTime?.total_tokens ?? 0);
  const tokCost = liveTotal > 0 ? liveCost : (allTime?.cost_usd ?? 0);

  const panes = grid?.panes ?? [];
  const activeAgents = panes.filter((p) => {
    const st = String(p.status || "").toLowerCase();
    return st === "active" || st === "live" || st === "busy" || Number(p.owes) > 0;
  }).length;

  const verdict = String(health?.verdict || "UNKNOWN").toUpperCase();
  const healthWord =
    verdict === "OK" ? "HEALTHY" : verdict === "DEGRADED" ? "DEGRADED" : verdict || "UNKNOWN";
  const healthColor =
    verdict === "OK"
      ? "var(--servari-green)"
      : verdict === "DEGRADED"
        ? "var(--servari-amber)"
        : "var(--servari-dimmed)";

  const verifyPending = verify?.pending ?? [];
  const retentionPending = retention?.pending ?? [];
  // The "GATES" counter has ONE source of truth: verify_queue.list_pending()
  // (exposed at /api/verify-queue and reconciled identically in server/health.py).
  // Retention runs are a SEPARATE queue with their own RETAIN concept — folding
  // them in here is what made the status bar (2) disagree with /api/verify-queue (1).
  // The stale nervous-system.json open_gates list is no longer counted as a gate.
  const gatesPending = verifyPending.length;

  const rawPressure = context?.pressure?.pressure;
  const pressureWord = readPressure(rawPressure);
  const pressureColor =
    pressureWord === "LOW"
      ? "var(--servari-green)"
      : pressureWord === "MODERATE"
        ? "var(--servari-teal-soft)"
        : pressureWord === "HIGH"
          ? "var(--servari-amber)"
          : pressureWord === "CRITICAL"
            ? "var(--servari-red)"
            : "var(--servari-dimmed)";

  const stages = launch?.stages ?? [];
  const current = stages.find((s) => s.cls !== "done") ?? stages[stages.length - 1];
  const launchNum = current ? splitNum(current.stage) : "—";
  const launchName = current ? splitName(current.stage) : "no arc";

  const channels = state?.channels ?? {};

  // ── Priority items ────────────────────────────────────────────────────────

  const priorityItems: Array<{ id: string; label: string; tag: string }> = [];
  verifyPending.slice(0, 3).forEach((item) => {
    priorityItems.push({
      id: `vq-${item.id}`,
      label: sealLabel(item.summary || `${item.agent}: ${item.gate}`) || `${item.agent}: ${item.gate}`,
      tag: "GATE",
    });
  });
  retentionPending.slice(0, 2).forEach((item, i) => {
    const txt =
      typeof item === "object" && item !== null
        ? String(
            (item as Record<string, unknown>).summary ||
              (item as Record<string, unknown>).run_id ||
              `Retention run ${i + 1}`,
          )
        : `Retention run ${i + 1}`;
    priorityItems.push({ id: `ret-${i}`, label: sealLabel(txt) || txt, tag: "RETAIN" });
  });
  // GATE priority items come ONLY from the verify-queue (the single source of truth
  // above). The legacy nervous-system.json open_gates list is intentionally NOT
  // surfaced here — it disagreed with the live queue and double-counted gates.
  // All real sources empty — single honest state (no fake MAINT/COST items).
  if (priorityItems.length === 0) {
    priorityItems.push({ id: "sys-clear", label: "No priority items — all queues clear", tag: "INFO" });
  }

  // ── Activity items ────────────────────────────────────────────────────────

  const activityItems: Array<{ channel: string; text: string; ts: number | string | null }> = [];
  for (const pane of panes) {
    if (pane.last_ts) {
      const sealed = sealLabel(pane.name) || pane.name;
      // pane.turns is an ARRAY of turn objects, not a count — use paneTurnCount.
      const turnCount = paneTurnCount(pane);
      activityItems.push({
        channel: sealed,
        text: `${turnCount} turn${turnCount !== 1 ? "s" : ""} · ${money(Number(pane.owes) || 0)}`,
        ts: pane.last_ts,
      });
    }
  }
  activityItems.sort((a, b) => {
    const ta = typeof a.ts === "string" ? Date.parse(a.ts) : ((a.ts as number) ?? 0) * 1000;
    const tb = typeof b.ts === "string" ? Date.parse(b.ts) : ((b.ts as number) ?? 0) * 1000;
    return tb - ta;
  });
  const recent = activityItems.slice(0, 8);

  // ── Toggle ────────────────────────────────────────────────────────────────

  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <motion.div
      className="flex flex-col overflow-hidden"
      data-component="DashboardView"
      style={{ height: "100%" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={COMPOSED}
    >
      {/* MAIN BODY */}
      <div className="flex flex-1 min-h-0 gap-6 p-8 pb-4">
        {/* WORKSPACE 2/3 */}
        <div className="flex-[2] min-w-0 flex flex-col gap-4">
          <SectionHeader label="Workspace" meta={`${activeAgents} active · ${panes.length} total`} />
          <div className="flex-1 min-h-0">
            <WorkspaceGrid panes={panes} />
          </div>
        </div>

        {/* SIDEBAR 1/3 */}
        <div className="flex flex-col gap-4 overflow-auto" style={{ width: 320, flexShrink: 0 }}>
          <PrioritiesPanel items={priorityItems} checked={checked} onToggle={toggleChecked} index={0} />
          <ActivityPanel items={recent} index={1} />
          <EnginePanel status={engine} error={engineError} index={2} onOpenPanel={() => navigate("/shell/runtime")} />
          <QuickActionsPanel index={3} />
        </div>
      </div>

      {/* STAT STRIP */}
      <StatStrip
        tokVal={tokVal}
        tokCost={tokCost}
        activeAgents={activeAgents}
        paneCount={panes.length}
        healthWord={healthWord}
        healthColor={healthColor}
        gatesPending={gatesPending}
        pressureWord={pressureWord}
        pressureColor={pressureColor}
        launchNum={launchNum}
        launchName={launchName}
        onNavigate={navigate}
      />

      {/* VENTURE STRIP */}
      <VentureStrip channels={channels} />
    </motion.div>
  );
}

export default DashboardView;

