import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { motion } from "motion/react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock3,
  Cpu,
  Database,
  ExternalLink,
  FileText,
  HardDrive,
  ListChecks,
  Loader2,
  RefreshCw,
  Rocket,
  Rss,
  Server,
  Settings,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  API,
  type GatewaysResponse,
  type GatewayStatus,
  paneTurnCount,
  paneTurnList,
  type EngineState,
  type FinanceResponse,
  type GridResponse,
  type GridPane,
  type HealthCheckResponse,
  type InboxResponse,
  type JobRow,
  type JobsResponse,
  type MemorySurfaceResponse,
  type ReportRow,
  type ReportsResponse,
  type RetentionResponse,
  type StateResponse,
  type TokensResponse,
  type VerifyQueueItem,
  type VerifyQueueResponse,
} from "../lib/api";
import { COMPOSED, SNAPPY, staggerItem } from "../lib/motion";

type LoadState = "loading" | "live" | "partial" | "offline";

interface RssFeedItem {
  id?: string;
  title: string;
  source?: string;
  url?: string;
  published_at?: string;
  ts?: number | string | null;
  priority?: "high" | "medium" | "low" | string;
  category?: string;
  summary?: string;
}

interface RssFeedsResponse {
  feeds?: RssFeedItem[];
  items?: RssFeedItem[];
  last_sync?: string;
  error?: string;
}

interface LocalStoreRow {
  id?: string;
  name: string;
  kind?: string;
  path?: string;
  rows?: number;
  size_mb?: number;
  updated?: string;
  status?: "ready" | "syncing" | "error" | string;
  description?: string;
}

interface LocalStoresResponse {
  stores?: LocalStoreRow[];
  databases?: LocalStoreRow[];
  last_scan?: string;
  error?: string;
}

type DashboardApi = typeof API & {
  rssFeeds?: () => Promise<RssFeedsResponse>;
  dataFeeds?: () => Promise<RssFeedsResponse>;
  gateways?: () => Promise<GatewaysResponse>;
  localDatabases?: () => Promise<LocalStoresResponse>;
  localStores?: () => Promise<LocalStoresResponse>;
};

interface DashboardSnapshot {
  loadState: LoadState;
  rss: RssFeedsResponse | null;
  stores: LocalStoresResponse | null;
  gateways: GatewaysResponse | null;
  verify: VerifyQueueResponse | null;
  retention: RetentionResponse | null;
  health: HealthCheckResponse | null;
  engine: EngineState | null;
  tokens: TokensResponse | null;
  state: StateResponse | null;
  grid: GridResponse | null;
  inbox: InboxResponse | null;
  jobs: JobsResponse | null;
  finance: FinanceResponse | null;
  memory: MemorySurfaceResponse | null;
  reports: ReportsResponse | null;
  errors: string[];
  loadedAt: Date | null;
}

interface FeedCard {
  id: string;
  title: string;
  source: string;
  meta: string;
  priority: "high" | "medium" | "low";
  url?: string;
}

interface StoreCard {
  id: string;
  name: string;
  kind: string;
  detail: string;
  metric: string;
  status: string;
  path?: string;
}

interface QueueItem {
  id: string;
  title: string;
  detail: string;
  tone: "ok" | "warn" | "error" | "neutral";
  icon: LucideIcon;
}

interface ActivityRow {
  id: string;
  title: string;
  detail: string;
  ts: number;
  icon: LucideIcon;
}

const EMPTY_SNAPSHOT: DashboardSnapshot = {
  loadState: "loading",
  rss: null,
  stores: null,
  gateways: null,
  verify: null,
  retention: null,
  health: null,
  engine: null,
  tokens: null,
  state: null,
  grid: null,
  inbox: null,
  jobs: null,
  finance: null,
  memory: null,
  reports: null,
  errors: [],
  loadedAt: null,
};

const QUICK_LAUNCH = [
  { label: "Agent apps", path: "/shell/agent-apps", icon: Bot },
  { label: "Trading", path: "/shell/trading", icon: BarChart3 },
  { label: "CV builder", path: "/shell/cv-builder", icon: FileText },
  { label: "Settings", path: "/shell/settings", icon: Settings },
  { label: "Runtime", path: "/shell/runtime", icon: Terminal },
];

const toneColor: Record<QueueItem["tone"], string> = {
  ok: "var(--s-status-ok)",
  warn: "var(--s-status-warn)",
  error: "var(--s-status-error)",
  neutral: "var(--s-text-secondary)",
};

function asDashboardApi(): DashboardApi {
  return API as DashboardApi;
}

async function maybeCall<T>(label: string, fn: (() => Promise<T>) | undefined): Promise<{ value: T | null; error?: string }> {
  if (!fn) return { value: null };
  try {
    return { value: await fn() };
  } catch {
    return { value: null, error: `${label} unavailable` };
  }
}

async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<{ value: T | null; error?: string }> {
  try {
    return { value: await fn() };
  } catch {
    return { value: null, error: `${label} unavailable` };
  }
}

function compactNumber(value: number | undefined | null): string {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatMoney(value: number | undefined | null, currency = "EUR"): string {
  const n = Number(value || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}

function toMillis(raw: number | string | null | undefined): number {
  if (!raw) return 0;
  if (typeof raw === "number") return raw > 10_000_000_000 ? raw : raw * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeTime(raw: number | string | null | undefined): string {
  const ms = toMillis(raw);
  if (!ms) return "no timestamp";
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function priorityOf(value: unknown): "high" | "medium" | "low" {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("high") || raw.includes("urgent") || raw.includes("critical")) return "high";
  if (raw.includes("low")) return "low";
  return "medium";
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("error") || s.includes("offline") || s.includes("failed")) return "var(--s-status-error)";
  if (s.includes("sync") || s.includes("warn") || s.includes("stale")) return "var(--s-status-warn)";
  if (s.includes("ready") || s.includes("live") || s.includes("ok") || s.includes("running")) return "var(--s-status-ok)";
  return "var(--s-text-secondary)";
}

function trimText(text: string, max = 96): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function getRssItems(rss: RssFeedsResponse | null): RssFeedItem[] {
  if (!rss) return [];
  return rss.items || rss.feeds || [];
}

function getStoreRows(stores: LocalStoresResponse | null): LocalStoreRow[] {
  if (!stores) return [];
  return stores.stores || stores.databases || [];
}

function Panel({
  title,
  icon: Icon,
  meta,
  children,
  className = "",
}: {
  title: string;
  icon: LucideIcon;
  meta?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.section
      className={`min-h-0 overflow-hidden rounded-lg ${className}`}
      style={{
        border: "1px solid var(--s-edge-subtle)",
        background: "var(--s-glass-light)",
      }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={COMPOSED}
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3"
        style={{ borderBottom: "1px solid var(--s-edge-subtle)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={16} style={{ color: "var(--s-text-teal)" }} />
          <h2
            className="truncate"
            style={{
              color: "var(--s-text-primary)",
              fontSize: "var(--t-14)",
              fontWeight: 650,
              letterSpacing: "0",
            }}
          >
            {title}
          </h2>
        </div>
        {meta ? (
          <span
            className="shrink-0 truncate"
            style={{
              color: "var(--s-text-secondary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-11)",
            }}
          >
            {meta}
          </span>
        ) : null}
      </div>
      {children}
    </motion.section>
  );
}

function EmptyState({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return (
    <div className="grid h-full min-h-[120px] place-items-center p-6 text-center">
      <div>
        <Icon size={22} className="mx-auto mb-3" style={{ color: "var(--s-text-secondary)" }} />
        <div style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 650 }}>{title}</div>
        <div className="mt-1 max-w-[22rem]" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: QueueItem["tone"];
}) {
  return (
    <div
      className="min-w-0 rounded-lg px-3 py-2"
      style={{
        border: "1px solid var(--s-edge-subtle)",
        background: "rgba(250,248,243,0.025)",
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon size={14} style={{ color: toneColor[tone] }} />
        <span
          className="truncate"
          style={{
            color: "var(--s-text-secondary)",
            fontSize: "var(--t-10)",
            letterSpacing: "var(--ls-caps)",
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
      </div>
      <div
        className="truncate"
        style={{
          color: "var(--s-text-primary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--t-16)",
          fontWeight: 750,
          letterSpacing: "0",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function HeaderBar({
  state,
  onRefresh,
  refreshing,
}: {
  state: DashboardSnapshot;
  onRefresh: () => void | Promise<void>;
  refreshing: boolean;
}) {
  const verdict = String(state.health?.verdict || (state.errors.length ? "PARTIAL" : "WARMING")).toUpperCase();
  const engineLabel = state.engine?.running ? `runtime pid ${state.engine.pid || "managed"}` : "runtime idle";
  const loadTone: QueueItem["tone"] =
    state.loadState === "live" ? "ok" : state.loadState === "partial" ? "warn" : state.loadState === "offline" ? "error" : "neutral";

  return (
    <motion.header
      className="rounded-lg px-4 py-4"
      style={{
        border: "1px solid var(--s-edge-accent)",
        background:
          "linear-gradient(135deg, rgba(20,156,150,0.16), rgba(18,22,30,0.7) 42%, rgba(250,248,243,0.025))",
        boxShadow: "var(--s-glow-primary)",
      }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={COMPOSED}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div
            className="mb-1 flex items-center gap-2"
            style={{
              color: "var(--s-text-secondary)",
              fontSize: "var(--t-11)",
              letterSpacing: "var(--ls-caps)",
              textTransform: "uppercase",
            }}
          >
            <Server size={14} style={{ color: toneColor[loadTone] }} />
            OS command surface
          </div>
          <h1
            className="truncate"
            style={{
              color: "var(--s-text-primary)",
              fontSize: "clamp(1.35rem, 2vw, 2rem)",
              fontWeight: 760,
              letterSpacing: "0",
              lineHeight: 1.08,
            }}
          >
            SERVARI dashboard
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span style={{ color: statusColor(verdict), fontSize: "var(--t-12)", fontWeight: 700 }}>{verdict}</span>
            <span style={{ color: "var(--s-edge)" }}>/</span>
            <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>{engineLabel}</span>
            <span style={{ color: "var(--s-edge)" }}>/</span>
            <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>
              synced {state.loadedAt ? state.loadedAt.toLocaleTimeString("en-US", { hour12: false }) : "pending"}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-3"
          style={{
            border: "1px solid var(--s-edge-subtle)",
            background: "rgba(250,248,243,0.05)",
            color: "var(--s-text-primary)",
            fontSize: "var(--t-12)",
          }}
          disabled={refreshing}
        >
          {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Refresh
        </button>
      </div>
    </motion.header>
  );
}

function FeedPane({ feeds }: { feeds: FeedCard[] }) {
  return (
    <Panel title="RSS and datafeeds" icon={Rss} meta={`${feeds.length} signals`} className="lg:col-span-7">
      {feeds.length === 0 ? (
        <EmptyState icon={Rss} title="No feed items yet" detail="No RSS items are available from the configured datafeed subscriptions." />
      ) : (
        <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
          {feeds.slice(0, 9).map((feed, index) => (
            <motion.a
              key={feed.id}
              href={feed.url || undefined}
              target={feed.url ? "_blank" : undefined}
              rel={feed.url ? "noreferrer" : undefined}
              className="group min-h-[112px] rounded-lg p-3 outline-none"
              style={{
                border: "1px solid var(--s-edge-subtle)",
                background: "rgba(250,248,243,0.025)",
                color: "inherit",
              }}
              whileHover={{ borderColor: "var(--s-edge-accent)", backgroundColor: "var(--s-hover-bg)" }}
              transition={SNAPPY}
              {...staggerItem(index)}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <span
                  className="truncate"
                  style={{
                    color: feed.priority === "high" ? "var(--s-status-warn)" : "var(--s-text-teal-soft)",
                    fontSize: "var(--t-11)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {feed.source}
                </span>
                {feed.url ? <ExternalLink size={13} style={{ color: "var(--s-text-secondary)" }} /> : null}
              </div>
              <div
                className="line-clamp-2"
                style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 650, lineHeight: 1.35 }}
              >
                {feed.title}
              </div>
              <div className="mt-3 flex items-center gap-2" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
                <Clock3 size={12} />
                <span className="truncate">{feed.meta}</span>
              </div>
            </motion.a>
          ))}
        </div>
      )}
    </Panel>
  );
}

function StoresPane({ stores }: { stores: StoreCard[] }) {
  return (
    <Panel title="Local databases and stores" icon={Database} meta={`${stores.length} stores`} className="lg:col-span-5">
      {stores.length === 0 ? (
        <EmptyState icon={Database} title="No stores indexed" detail="Ready for API.localDatabases(), with memory and report surfaces used as fallbacks." />
      ) : (
        <div className="divide-y" style={{ borderColor: "var(--s-edge-subtle)" }}>
          {stores.slice(0, 8).map((store, index) => (
            <motion.div key={store.id} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3" {...staggerItem(index)}>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: statusColor(store.status), boxShadow: store.status === "ready" ? "var(--s-glow-green)" : "none" }}
                  />
                  <span
                    className="truncate"
                    style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 650 }}
                  >
                    {store.name}
                  </span>
                </div>
                <div className="mt-1 truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
                  {store.kind} / {store.detail}
                </div>
              </div>
              <div className="text-right">
                <div style={{ color: "var(--s-text-teal-soft)", fontFamily: "var(--font-mono)", fontSize: "var(--t-12)" }}>
                  {store.metric}
                </div>
                <div style={{ color: statusColor(store.status), fontSize: "var(--t-10)", textTransform: "uppercase" }}>
                  {store.status}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function WorkQueuePane({
  items,
  completed,
  onToggle,
}: {
  items: QueueItem[];
  completed: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <Panel title="Work queue and priorities" icon={ListChecks} meta={`${items.length} open`} className="lg:col-span-5">
      {items.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="Queue clear" detail="No gates, retention reviews, or high-priority feed items are waiting." />
      ) : (
        <div className="space-y-2 p-3">
          {items.slice(0, 8).map((item, index) => {
            const done = completed.has(item.id);
            const Icon = item.icon;
            return (
              <motion.button
                key={item.id}
                type="button"
                onClick={() => onToggle(item.id)}
                className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg p-3 text-left"
                style={{
                  border: "1px solid var(--s-edge-subtle)",
                  background: done ? "rgba(63,185,80,0.06)" : "rgba(250,248,243,0.025)",
                  opacity: done ? 0.62 : 1,
                }}
                whileHover={{ borderColor: "var(--s-edge-accent)", backgroundColor: "var(--s-hover-bg)" }}
                transition={SNAPPY}
                {...staggerItem(index)}
              >
                <Icon size={16} style={{ color: toneColor[item.tone] }} />
                <span className="min-w-0">
                  <span
                    className="block truncate"
                    style={{
                      color: "var(--s-text-primary)",
                      fontSize: "var(--t-13)",
                      fontWeight: 650,
                      textDecoration: done ? "line-through" : "none",
                    }}
                  >
                    {item.title}
                  </span>
                  <span className="block truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
                    {item.detail}
                  </span>
                </span>
                <span
                  className="grid h-5 w-5 place-items-center rounded"
                  style={{
                    border: `1px solid ${done ? "var(--s-status-ok)" : "var(--s-edge-subtle)"}`,
                    color: done ? "var(--s-status-ok)" : "var(--s-text-secondary)",
                  }}
                >
                  {done ? <CheckCircle2 size={14} /> : null}
                </span>
              </motion.button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function QuickLaunchPane() {
  const navigate = useNavigate();
  return (
    <Panel title="Quick launch" icon={Rocket} meta="5 shells" className="lg:col-span-7">
      <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-5">
        {QUICK_LAUNCH.map((item, index) => {
          const Icon = item.icon;
          return (
            <motion.button
              key={item.path}
              type="button"
              onClick={() => navigate(item.path)}
              className="flex min-h-[88px] flex-col justify-between rounded-lg p-3 text-left"
              style={{
                border: "1px solid var(--s-edge-subtle)",
                background: "rgba(250,248,243,0.025)",
                color: "var(--s-text-primary)",
              }}
              whileHover={{
                y: -2,
                borderColor: "var(--s-edge-accent)",
                backgroundColor: "var(--s-hover-bg)",
              }}
              transition={SNAPPY}
              {...staggerItem(index)}
            >
              <Icon size={18} style={{ color: "var(--s-text-teal)" }} />
              <span className="truncate" style={{ fontSize: "var(--t-13)", fontWeight: 700 }}>
                {item.label}
              </span>
            </motion.button>
          );
        })}
      </div>
    </Panel>
  );
}

function GatewayPane({ gateways, onChanged }: { gateways: GatewayStatus[]; onChanged: () => void | Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const act = useCallback(
    async (id: string, action: "start" | "stop" | "restart") => {
      setBusy(`${id}:${action}`);
      try {
        const result = await API.gatewayAction(id, action);
        if (!result.ok) {
          setError(`${id}: ${String(result.error || `${action} failed`)}`);
          return;
        }
        setError("");
        await onChanged();
      } catch (err) {
        setError(`${id}: ${err instanceof Error ? err.message : String(err || `${action} failed`)}`);
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  return (
    <Panel title="Agent gateways" icon={Server} meta={`${gateways.filter((item) => item.running).length}/${gateways.length} live`} className="lg:col-span-7">
      {error ? (
        <div className="mx-3 mt-3 rounded-lg px-3 py-2" style={{ border: "1px solid rgba(255,82,82,0.35)", color: "var(--s-status-error)", background: "rgba(255,82,82,0.06)", fontSize: "var(--t-12)" }}>
          {error}
        </div>
      ) : null}
      {gateways.length === 0 ? (
        <EmptyState icon={Server} title="No gateways found" detail="Hermes and OpenClaw gateway controls will appear when the backend reports them." />
      ) : (
        <div className="grid gap-2 p-3 md:grid-cols-2">
          {gateways.map((gateway, index) => {
            const running = Boolean(gateway.running);
            const installed = Boolean(gateway.installed);
            const id = gateway.id;
            const actionBusy = busy?.startsWith(`${id}:`);
            return (
              <motion.div
                key={id}
                className="rounded-lg p-3"
                style={{
                  border: `1px solid ${running ? "rgba(63,185,80,0.35)" : installed ? "var(--s-edge-subtle)" : "rgba(255,82,82,0.35)"}`,
                  background: running ? "rgba(63,185,80,0.055)" : "rgba(250,248,243,0.025)",
                }}
                {...staggerItem(index)}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-14)", fontWeight: 760 }}>
                      {gateway.label || id}
                    </div>
                    <div className="truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
                      {gateway.path || gateway.binary || "CLI missing"}
                    </div>
                  </div>
                  <span
                    className="rounded-full px-2 py-1"
                    style={{
                      border: `1px solid ${running ? "rgba(63,185,80,0.35)" : "var(--s-edge-subtle)"}`,
                      color: running ? "var(--s-status-ok)" : installed ? "var(--s-text-secondary)" : "var(--s-status-error)",
                      fontSize: "var(--t-10)",
                      fontFamily: "var(--font-mono)",
                      textTransform: "uppercase",
                    }}
                  >
                    {running ? "live" : installed ? "stopped" : "missing"}
                  </span>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <MetricTile label="PID" value={gateway.pid ? String(gateway.pid) : "--"} icon={Cpu} tone={running ? "ok" : "neutral"} />
                  <MetricTile label="Port" value={gateway.port ? String(gateway.port) : "local"} icon={Terminal} tone={running ? "ok" : "neutral"} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void act(id, running ? "restart" : "start")}
                    disabled={!installed || actionBusy}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 disabled:opacity-45"
                    style={{ border: "1px solid rgba(20,156,150,0.35)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.08)", fontSize: "var(--t-12)" }}
                  >
                    {actionBusy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                    {running ? "Restart" : "Start"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void act(id, "stop")}
                    disabled={!installed || !running || actionBusy}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 disabled:opacity-45"
                    style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-secondary)", background: "rgba(250,248,243,0.035)", fontSize: "var(--t-12)" }}
                  >
                    Stop
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function BackendStatusPane({
  health,
  engine,
  tokens,
  feedCount,
  storeCount,
  errors,
}: {
  health: HealthCheckResponse | null;
  engine: EngineState | null;
  tokens: TokensResponse | null;
  feedCount: number;
  storeCount: number;
  errors: string[];
}) {
  const verdict = String(health?.verdict || (errors.length ? "partial" : "warming")).toUpperCase();
  const tokenCount = tokens?.live?.total_tokens || tokens?.summary?.all_time?.total_tokens || 0;
  const tokenCost = tokens?.live?.cost_usd || tokens?.summary?.all_time?.cost_usd || 0;
  const running = !!engine?.running;

  return (
    <Panel title="Backend status" icon={Cpu} meta={verdict} className="lg:col-span-5">
      <div className="grid gap-2 p-3 sm:grid-cols-2">
        <MetricTile label="Runtime" value={running ? `PID ${engine?.pid || "live"}` : "idle"} icon={Terminal} tone={running ? "ok" : "neutral"} />
        <MetricTile label="Health" value={verdict} icon={ShieldCheck} tone={verdict === "OK" ? "ok" : errors.length ? "warn" : "neutral"} />
        <MetricTile label="Feeds" value={compactNumber(feedCount)} icon={Rss} tone={feedCount ? "ok" : "neutral"} />
        <MetricTile label="Stores" value={compactNumber(storeCount)} icon={HardDrive} tone={storeCount ? "ok" : "neutral"} />
      </div>
      <div className="px-3 pb-3">
        <div
          className="rounded-lg px-3 py-2"
          style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}
        >
          <div className="flex items-center justify-between gap-3">
            <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Token meter</span>
            <span style={{ color: "var(--s-text-teal-soft)", fontFamily: "var(--font-mono)", fontSize: "var(--t-12)" }}>
              {compactNumber(tokenCount)} / ${tokenCost.toFixed(2)}
            </span>
          </div>
          {errors.length ? (
            <div className="mt-2 truncate" style={{ color: "var(--s-status-warn)", fontSize: "var(--t-11)" }}>
              {errors.slice(0, 2).join(", ")}
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function ActivityPane({ activity }: { activity: ActivityRow[] }) {
  return (
    <Panel title="Recent activity" icon={Activity} meta={`${activity.length} events`} className="lg:col-span-12">
      {activity.length === 0 ? (
        <EmptyState icon={Activity} title="No recent activity" detail="Channel turns, reports, and feed updates will appear here as they arrive." />
      ) : (
        <div className="divide-y" style={{ borderColor: "var(--s-edge-subtle)" }}>
          {activity.slice(0, 10).map((row, index) => {
            const Icon = row.icon;
            return (
              <motion.div key={row.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3" {...staggerItem(index)}>
                <Icon size={15} style={{ color: "var(--s-text-teal-soft)" }} />
                <div className="min-w-0">
                  <div className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 650 }}>
                    {row.title}
                  </div>
                  <div className="truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
                    {row.detail}
                  </div>
                </div>
                <span className="shrink-0" style={{ color: "var(--s-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--t-11)" }}>
                  {relativeTime(row.ts)}
                </span>
              </motion.div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function buildFeeds(snapshot: DashboardSnapshot): FeedCard[] {
  const rssFeeds = getRssItems(snapshot.rss).map((item, index): FeedCard => {
    const ts = item.published_at || item.ts || null;
    return {
      id: item.id || `rss-${item.source || "feed"}-${index}`,
      title: trimText(item.title || "Untitled feed item"),
      source: item.source || item.category || "RSS",
      meta: relativeTime(ts),
      priority: priorityOf(item.priority),
      url: item.url,
    };
  });

  const inboxFeeds = (snapshot.inbox?.threads || []).slice(0, 4).map((thread, index): FeedCard => ({
    id: `inbox-${thread.thread_id || index}`,
    title: trimText(thread.subject || `Message from ${thread.from}`),
    source: `Inbox / ${thread.from}`,
    meta: thread.age_str || "recent",
    priority: priorityOf(thread.priority),
  }));

  const jobFeeds = (snapshot.jobs?.jobs || []).slice(0, 4).map((job: JobRow, index): FeedCard => ({
    id: `job-${job.company}-${job.title}-${index}`,
    title: trimText(`${job.title} at ${job.company}`),
    source: job.source || "Jobs",
    meta: `${job.location || "remote"} / score ${job.score ?? 0}`,
    priority: Number(job.score || 0) >= 80 ? "high" : "medium",
  }));

  const financeFeeds: FeedCard[] = (snapshot.finance?.invoices || []).slice(0, 2).map((invoice, index) => ({
    id: `invoice-${invoice.inv_id || index}`,
    title: trimText(`${invoice.client} invoice due ${invoice.due_str}`),
    source: "Finance",
    meta: formatMoney(invoice.amount_eur, "EUR"),
    priority: "medium",
  }));

  return [...rssFeeds, ...inboxFeeds, ...jobFeeds, ...financeFeeds].slice(0, 12);
}

function buildStores(snapshot: DashboardSnapshot): StoreCard[] {
  const futureStores = getStoreRows(snapshot.stores).map((store, index): StoreCard => ({
    id: store.id || `store-${store.name}-${index}`,
    name: store.name || "Unnamed store",
    kind: store.kind || "database",
    detail: store.description || store.path || "local store",
    metric: store.rows !== undefined ? `${compactNumber(store.rows)} rows` : store.size_mb !== undefined ? `${store.size_mb.toFixed(1)} MB` : "indexed",
    status: store.status || "ready",
    path: store.path,
  }));

  const memoryStores = (snapshot.memory?.files || []).map((file, index): StoreCard => ({
    id: `memory-${file.path || file.file}-${index}`,
    name: file.file,
    kind: "memory",
    detail: file.path,
    metric: file.entries === null ? "file" : `${compactNumber(file.entries)} entries`,
    status: "ready",
    path: file.path,
  }));

  const reportStore: StoreCard[] = snapshot.reports?.reports?.length
    ? [
        {
          id: "reports-store",
          name: "Reports archive",
          kind: "documents",
          detail: "local generated reports",
          metric: `${compactNumber(snapshot.reports.reports.length)} files`,
          status: "ready",
        },
      ]
    : [];

  return [...futureStores, ...memoryStores, ...reportStore].slice(0, 10);
}

function queueFromVerify(item: VerifyQueueItem): QueueItem {
  return {
    id: `verify-${item.id}`,
    title: trimText(item.summary || item.action || `${item.agent} gate`),
    detail: `${item.agent || "agent"} / ${item.gate || "verification"}`,
    tone: "warn",
    icon: AlertTriangle,
  };
}

function buildQueue(snapshot: DashboardSnapshot, feeds: FeedCard[]): QueueItem[] {
  const verifyItems = (snapshot.verify?.pending || []).map(queueFromVerify);

  const retentionItems = (snapshot.retention?.pending || []).slice(0, 3).map((item, index): QueueItem => {
    const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const summary = String(record.summary || record.run_id || `Retention review ${index + 1}`);
    return {
      id: `retention-${String(record.run_id || index)}`,
      title: trimText(summary),
      detail: "retention queue",
      tone: "neutral",
      icon: ShieldCheck,
    };
  });

  const highSignalFeeds = feeds
    .filter((feed) => feed.priority === "high")
    .slice(0, 3)
    .map((feed): QueueItem => ({
      id: `feed-${feed.id}`,
      title: trimText(feed.title),
      detail: `high priority / ${feed.source}`,
      tone: "warn",
      icon: Rss,
    }));

  const engineItem: QueueItem[] = snapshot.engine && !snapshot.engine.running
    ? [
        {
          id: "runtime-idle",
          title: "Runtime is stopped",
          detail: "open Runtime from quick launch when backend work is needed",
          tone: "neutral",
          icon: Cpu,
        },
      ]
    : [];

  return [...verifyItems, ...retentionItems, ...highSignalFeeds, ...engineItem].slice(0, 10);
}

function activityFromPane(pane: GridPane, index: number): ActivityRow | null {
  if (!pane.last_ts) return null;
  const latest = paneTurnList(pane)[0];
  const turnCount = paneTurnCount(pane);
  return {
    id: `pane-${pane.key || pane.name}-${index}`,
    title: pane.name || "Workspace channel",
    detail: latest?.text ? trimText(latest.text, 84) : `${turnCount} turns / ${pane.status || "idle"}`,
    ts: toMillis(pane.last_ts),
    icon: Activity,
  };
}

function buildActivity(snapshot: DashboardSnapshot, feeds: FeedCard[]): ActivityRow[] {
  const paneRows = (snapshot.grid?.panes || [])
    .map(activityFromPane)
    .filter((row): row is ActivityRow => Boolean(row));

  const gridRows = Object.entries(snapshot.state?.channels || {}).map(([name, channel], index): ActivityRow => ({
    id: `channel-${name}-${index}`,
    title: name,
    detail: `${channel.turns || 0} turns / ${channel.owes || 0} owes`,
    ts: Date.now() - index * 60_000,
    icon: Zap,
  }));

  const reportRows = (snapshot.reports?.reports || []).slice(0, 4).map((report: ReportRow, index): ActivityRow => ({
    id: `report-${report.slug || index}`,
    title: report.desc || report.slug,
    detail: report.path || "local report",
    ts: toMillis(report.date) || Date.now() - (index + 1) * 300_000,
    icon: FileText,
  }));

  const feedRows = feeds.slice(0, 4).map((feed, index): ActivityRow => ({
    id: `feed-activity-${feed.id}`,
    title: feed.source,
    detail: feed.title,
    ts: Date.now() - (index + 1) * 120_000,
    icon: Rss,
  }));

  return [...paneRows, ...gridRows, ...reportRows, ...feedRows]
    .filter((row) => row.ts > 0)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12);
}

async function loadSnapshot(): Promise<DashboardSnapshot> {
  const dashApi = asDashboardApi();
  const rssMethod = dashApi.rssFeeds || dashApi.dataFeeds;
  const storesMethod = dashApi.localDatabases || dashApi.localStores;
  const gatewaysMethod = dashApi.gateways;

  const [
    rss,
    stores,
    gateways,
    verify,
    retention,
    health,
    engine,
    tokens,
    state,
    grid,
    inbox,
    jobs,
    finance,
    memory,
    reports,
  ] = await Promise.all([
    maybeCall("rss feeds", rssMethod),
    maybeCall("local stores", storesMethod),
    maybeCall("gateways", gatewaysMethod),
    safeCall("verify queue", API.verifyQueue),
    safeCall("retention", API.retention),
    safeCall("health", API.health),
    safeCall("engine status", API.engineStatus),
    safeCall("tokens", API.tokens),
    safeCall("state", API.state),
    safeCall("grid", API.grid),
    safeCall("inbox", API.inbox),
    safeCall("jobs", API.jobs),
    safeCall("finance", API.finance),
    safeCall("memory surface", API.memorySurface),
    safeCall("reports", API.reports),
  ]);

  const engineState = engine.value && engine.value.ok && engine.value.status ? engine.value.status : null;
  const errors = [
    rss.error,
    stores.error,
    verify.error,
    retention.error,
    health.error,
    engine.error,
    tokens.error,
    state.error,
    grid.error,
    inbox.error,
    jobs.error,
    finance.error,
    memory.error,
    reports.error,
    rss.value?.error ? `rss feeds: ${rss.value.error}` : undefined,
    stores.value?.error ? `local stores: ${stores.value.error}` : undefined,
    gateways.value?.error ? `gateways: ${gateways.value.error}` : undefined,
  ].filter(Boolean) as string[];

  const livePieces = [verify.value, health.value, state.value, grid.value, inbox.value, jobs.value, memory.value, reports.value, gateways.value].filter(Boolean).length;
  const loadState: LoadState = livePieces >= 4 ? (errors.length ? "partial" : "live") : livePieces > 0 ? "partial" : "offline";

  return {
    loadState,
    rss: rss.value,
    stores: stores.value,
    gateways: gateways.value,
    verify: verify.value,
    retention: retention.value,
    health: health.value,
    engine: engineState,
    tokens: tokens.value,
    state: state.value,
    grid: grid.value,
    inbox: inbox.value,
    jobs: jobs.value,
    finance: finance.value,
    memory: memory.value,
    reports: reports.value,
    errors,
    loadedAt: new Date(),
  };
}

export function OsDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(EMPTY_SNAPSHOT);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setRefreshing(true);
    try {
      const next = await loadSnapshot();
      if (seq === requestSeq.current) setSnapshot(next);
    } finally {
      if (seq === requestSeq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      const seq = requestSeq.current + 1;
      requestSeq.current = seq;
      setRefreshing(true);
      try {
        const next = await loadSnapshot();
        if (alive && seq === requestSeq.current) setSnapshot(next);
      } finally {
        inFlight = false;
        if (alive && seq === requestSeq.current) setRefreshing(false);
      }
    };
    void run();
    const id = window.setInterval(run, 7000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const feeds = useMemo(() => buildFeeds(snapshot), [snapshot]);
  const stores = useMemo(() => buildStores(snapshot), [snapshot]);
  const queue = useMemo(() => buildQueue(snapshot, feeds), [snapshot, feeds]);
  const activity = useMemo(() => buildActivity(snapshot, feeds), [snapshot, feeds]);

  const toggleCompleted = useCallback((id: string) => {
    setCompleted((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openQueueCount = queue.filter((item) => !completed.has(item.id)).length;
  const highFeeds = feeds.filter((feed) => feed.priority === "high").length;
  const revenue = snapshot.finance?.mtd_revenue_eur;

  return (
    <motion.div
      className="h-full overflow-auto p-4 md:p-6 xl:p-8"
      data-component="OsDashboard"
      style={{
        background:
          "linear-gradient(180deg, rgba(15,18,24,0.12), rgba(15,18,24,0.34)), var(--s-bg)",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={COMPOSED}
    >
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
        <HeaderBar state={snapshot} onRefresh={refresh} refreshing={refreshing} />

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile label="Open queue" value={compactNumber(openQueueCount)} icon={ListChecks} tone={openQueueCount ? "warn" : "ok"} />
          <MetricTile label="High signals" value={compactNumber(highFeeds)} icon={Rss} tone={highFeeds ? "warn" : "neutral"} />
          <MetricTile label="Local stores" value={compactNumber(stores.length)} icon={Database} tone={stores.length ? "ok" : "neutral"} />
          <MetricTile label="MTD revenue" value={revenue === undefined ? "--" : formatMoney(revenue)} icon={BarChart3} tone="ok" />
        </div>

        <div className="grid min-h-0 gap-4 lg:grid-cols-12">
          <FeedPane feeds={feeds} />
          <StoresPane stores={stores} />
          <WorkQueuePane items={queue} completed={completed} onToggle={toggleCompleted} />
          <QuickLaunchPane />
          <GatewayPane gateways={snapshot.gateways?.gateways || []} onChanged={refresh} />
          <BackendStatusPane
            health={snapshot.health}
            engine={snapshot.engine}
            tokens={snapshot.tokens}
            feedCount={feeds.length}
            storeCount={stores.length}
            errors={snapshot.errors}
          />
          <ActivityPane activity={activity} />
        </div>
      </div>
    </motion.div>
  );
}

export { OsDashboard as DashboardView };
export default OsDashboard;
