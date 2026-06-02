import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Briefcase,
  CheckSquare,
  GraduationCap,
  Mail,
  DollarSign,
  Brain,
  BarChart2,
} from "lucide-react";
import { API } from "../lib/api";

/**
 * SERVARI OS — PersonalView
 *
 * The personal-world dashboard. Every section calls a real API endpoint or
 * renders an honest empty-state ("no data yet") when the endpoint/file is absent.
 *
 * Backend modules (server/providers/*) read from the bundled demo-data dir:
 *   /api/jobs           → server/providers/jobs.py        → demo-data/jobs.json
 *   /api/applications   → server/providers/applications.py → demo-data/applications.json
 *   /api/career         → server/providers/career.py       → demo-data/career.json
 *   /api/inbox          → server/providers/inbox.py        → demo-data/inbox.json
 *   /api/finance        → server/providers/finance.py      → demo-data/finance.json
 *   /api/memory-surface → server/providers/memory_surface.py → demo-data/memory/
 *   /api/reports        → server/providers/reports.py      → demo-data/reports/
 */

// ---------------------------------------------------------------------------
// Shared mini-panel wrapper
// ---------------------------------------------------------------------------
function Panel({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "rgba(250, 248, 243, 0.03)",
        border: "1px solid rgba(250, 248, 243, 0.07)",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <span
          className="font-mono text-[0.65rem] tracking-widest uppercase"
          style={{ color: "var(--servari-teal)" }}
        >
          {title}
        </span>
        {note && (
          <span
            className="font-mono text-[0.58rem]"
            style={{ color: "var(--servari-dimmed)" }}
          >
            {note}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      className="rounded-xl p-3 flex flex-col gap-1"
      style={{
        background: "rgba(20, 156, 150, 0.05)",
        border: "1px solid rgba(20, 156, 150, 0.12)",
      }}
    >
      <span
        className="font-mono text-[1.25rem] font-semibold leading-none"
        style={{ color: accent ?? "var(--servari-ivory)" }}
      >
        {value}
      </span>
      <span
        className="font-mono text-[0.6rem] uppercase tracking-widest"
        style={{ color: "var(--servari-dimmed)" }}
      >
        {label}
      </span>
    </div>
  );
}

// Shown when the backing data file/endpoint does not yet exist.
function EmptyState({ label }: { label: string }) {
  return (
    <div
      className="rounded-lg px-3 py-3 font-mono text-[0.65rem] text-center"
      style={{
        background: "rgba(250, 248, 243, 0.02)",
        border: "1px solid rgba(250, 248, 243, 0.06)",
        color: "var(--servari-dimmed)",
      }}
    >
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------
type TabId = "jobs" | "apps" | "career" | "inbox" | "finance" | "memory" | "reports";

const TABS: { id: TabId; label: string; Icon: React.ElementType }[] = [
  { id: "jobs", label: "Jobs", Icon: Briefcase },
  { id: "apps", label: "Applications", Icon: CheckSquare },
  { id: "career", label: "Career", Icon: GraduationCap },
  { id: "inbox", label: "Inbox", Icon: Mail },
  { id: "finance", label: "Finance", Icon: DollarSign },
  { id: "memory", label: "Memory", Icon: Brain },
  { id: "reports", label: "Reports", Icon: BarChart2 },
];

// ---------------------------------------------------------------------------
// Section content components — all real data, no seeds
// ---------------------------------------------------------------------------

// --- JOBS ---
interface JobRow {
  title: string;
  company: string;
  source: string;
  location: string;
  score: number;
  posted: string;
  tailored?: boolean;
}
interface JobsData {
  jobs: JobRow[];
  last_scan?: string;
  error?: string;
}

function JobsSection() {
  const [data, setData] = useState<JobsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.jobs()
      .then((d) => setData(d))
      .catch(() => setData({ jobs: [], error: "endpoint offline" }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <EmptyState label="loading jobs…" />;

  const jobs = data?.jobs ?? [];
  const high = jobs.filter((j) => j.score >= 80).length;
  const tailored = jobs.filter((j) => j.tailored).length;
  const lastScan = data?.last_scan ? new Date(data.last_scan).toLocaleTimeString() : "—";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Discovered" value={String(jobs.length)} />
        <Stat label="High Match ≥80" value={String(high)} accent="var(--servari-teal)" />
        <Stat label="Tailored" value={String(tailored)} />
        <Stat label="Last Scan" value={lastScan} />
      </div>
      {jobs.length === 0 ? (
        <EmptyState label={data?.error ? `no data — ${data.error}` : "no data yet — populate demo-data/jobs.json"} />
      ) : (
        <Panel title="Scored Jobs" note={`${jobs.length} results`}>
          <div className="grid grid-cols-2 gap-2">
            {jobs.map((j, i) => {
              const scoreColor =
                j.score >= 80
                  ? "var(--servari-teal)"
                  : j.score >= 60
                    ? "#60a5fa"
                    : "#f59e0b";
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  whileHover={{ y: -2 }}
                  className="rounded-lg p-3"
                  style={{
                    background: "rgba(250, 248, 243, 0.03)",
                    border: "1px solid rgba(250, 248, 243, 0.07)",
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className="text-[0.75rem] leading-tight"
                      style={{ color: "var(--servari-ivory)" }}
                    >
                      {j.title}
                    </span>
                    <span
                      className="font-mono text-[0.65rem] font-semibold shrink-0 px-1.5 py-0.5 rounded"
                      style={{
                        color: scoreColor,
                        background: "rgba(0,0,0,0.25)",
                        border: `1px solid ${scoreColor}44`,
                      }}
                    >
                      {j.score}
                    </span>
                  </div>
                  <div
                    className="font-mono text-[0.6rem] mt-1"
                    style={{ color: "var(--servari-dimmed)" }}
                  >
                    {j.company} · {j.source} · {j.location}
                  </div>
                  <div
                    className="font-mono text-[0.58rem] mt-2"
                    style={{ color: "var(--servari-dimmed)", opacity: 0.6 }}
                  >
                    posted {j.posted} ago
                  </div>
                </motion.div>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}

// --- APPLICATIONS ---
interface AppRow {
  company: string;
  role: string;
  status: string;
  date: string;
  url?: string;
}
interface AppsData {
  applications: AppRow[];
  error?: string;
}

function AppsSection() {
  const [data, setData] = useState<AppsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.applications()
      .then((d) => setData(d))
      .catch(() => setData({ applications: [], error: "endpoint offline" }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <EmptyState label="loading applications…" />;

  const apps = data?.applications ?? [];

  const statusColor = (s: string) => {
    if (s.startsWith("interview")) return "var(--servari-teal)";
    if (s.startsWith("rejected")) return "var(--servari-red)";
    if (s === "acknowledged") return "#60a5fa";
    return "var(--servari-dimmed)";
  };

  return (
    <div className="space-y-4">
      {apps.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Submitted" value={String(apps.length)} />
          <Stat
            label="In Pipeline"
            value={String(apps.filter((a) => !a.status.startsWith("rejected")).length)}
            accent="var(--servari-teal)"
          />
          <Stat label="Rejected" value={String(apps.filter((a) => a.status.startsWith("rejected")).length)} />
        </div>
      )}
      {apps.length === 0 ? (
        <EmptyState label={data?.error ? `no data — ${data.error}` : "no data yet — populate demo-data/applications.json"} />
      ) : (
        <Panel title="Application Tracker" note={`${apps.length} entries`}>
          <div className="space-y-2">
            {apps.map((a, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                className="flex items-center justify-between rounded-lg px-3 py-2"
                style={{
                  background: "rgba(250, 248, 243, 0.025)",
                  border: "1px solid rgba(250, 248, 243, 0.06)",
                }}
              >
                <div>
                  <div className="text-[0.75rem]" style={{ color: "var(--servari-ivory)" }}>
                    {a.company}
                    <span
                      className="font-mono text-[0.65rem] ml-2"
                      style={{ color: "var(--servari-dimmed)" }}
                    >
                      {a.role}
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <div
                    className="font-mono text-[0.62rem]"
                    style={{ color: statusColor(a.status) }}
                  >
                    {a.status}
                  </div>
                  <div
                    className="font-mono text-[0.58rem]"
                    style={{ color: "var(--servari-dimmed)", opacity: 0.5 }}
                  >
                    {a.date}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// --- CAREER ---
interface CareerProfile {
  name?: string;
  headline?: string;
  location?: string;
  languages?: string;
  portfolio_path?: string;
  portfolio_file_count?: number;
  skills?: string[];
  error?: string;
}

function CareerSection() {
  const [data, setData] = useState<CareerProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.career()
      .then((d) => setData(d))
      .catch(() => setData({ error: "endpoint offline" }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <EmptyState label="loading career profile…" />;
  if (!data || data.error) {
    return (
      <div className="space-y-4">
        <EmptyState label={data?.error ? `no data — ${data.error}` : "no data yet — create demo-data/career.json"} />
      </div>
    );
  }

  const profileRows: [string, string][] = [
    ["Name", data.name ?? "—"],
    ["Headline", data.headline ?? "—"],
    ["Location", data.location ?? "—"],
    ["Languages", data.languages ?? "—"],
    [
      "Portfolio",
      data.portfolio_path
        ? `${data.portfolio_file_count ?? "?"} files — ${data.portfolio_path}`
        : "—",
    ],
  ];
  const skills = data.skills ?? [];

  return (
    <div className="space-y-4">
      <Panel title="Profile">
        <div className="space-y-2">
          {profileRows.map(([label, value]) => (
            <div key={label} className="flex gap-3">
              <span
                className="font-mono text-[0.62rem] uppercase tracking-wide w-24 shrink-0 pt-0.5"
                style={{ color: "var(--servari-dimmed)" }}
              >
                {label}
              </span>
              <span
                className="font-mono text-[0.7rem] leading-snug"
                style={{ color: "var(--servari-ivory)" }}
              >
                {value}
              </span>
            </div>
          ))}
        </div>
      </Panel>
      {skills.length > 0 && (
        <Panel title="Skills">
          <div className="flex flex-wrap gap-1.5">
            {skills.map((s) => (
              <span
                key={s}
                className="font-mono text-[0.62rem] px-2 py-0.5 rounded"
                style={{
                  background: "rgba(20, 156, 150, 0.1)",
                  border: "1px solid rgba(20, 156, 150, 0.2)",
                  color: "var(--servari-teal-soft)",
                }}
              >
                {s}
              </span>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// --- INBOX ---
interface InboxThread {
  from: string;
  subject?: string;
  age_str: string;
  priority: "high" | "medium" | "low";
  thread_id?: string;
}
interface InboxData {
  threads: InboxThread[];
  last_triage?: string;
  error?: string;
}

function InboxSection() {
  const [data, setData] = useState<InboxData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.inbox()
      .then((d) => setData(d))
      .catch(() => setData({ threads: [], error: "endpoint offline" }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <EmptyState label="loading inbox…" />;

  const threads = data?.threads ?? [];
  const lastTriage = data?.last_triage ? new Date(data.last_triage).toLocaleTimeString() : "—";

  const priorityColor = (p: string) =>
    p === "high" ? "var(--servari-red)" : p === "medium" ? "#f59e0b" : "var(--servari-dimmed)";

  return (
    <div className="space-y-4">
      {threads.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Awaiting Reply" value={String(threads.length)} />
          <Stat
            label="High Priority"
            value={String(threads.filter((t) => t.priority === "high").length)}
            accent="var(--servari-red)"
          />
          <Stat label="Last Triage" value={lastTriage} />
        </div>
      )}
      {threads.length === 0 ? (
        <EmptyState label={data?.error ? `no data — ${data.error}` : "inbox empty or endpoint not yet active"} />
      ) : (
        <Panel title="Threads Awaiting Reply" note={`${threads.length} threads`}>
          <div className="space-y-1.5">
            {threads.map((t, i) => (
              <motion.div
                key={t.thread_id ?? i}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03 }}
                className="flex items-center justify-between rounded-lg px-3 py-2"
                style={{
                  background: "rgba(250, 248, 243, 0.025)",
                  border: "1px solid rgba(250, 248, 243, 0.06)",
                }}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-[0.73rem] block truncate" style={{ color: "var(--servari-ivory)" }}>
                    {t.from}
                  </span>
                  {t.subject && (
                    <span className="font-mono text-[0.6rem] block truncate" style={{ color: "var(--servari-dimmed)" }}>
                      {t.subject}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: priorityColor(t.priority) }}
                  />
                  <span
                    className="font-mono text-[0.6rem]"
                    style={{ color: "var(--servari-dimmed)" }}
                  >
                    {t.age_str}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// --- FINANCE ---
interface InvoiceRow {
  inv_id: string;
  client: string;
  amount_eur: number;
  due_str: string;
}
interface FinanceData {
  mtd_revenue_eur?: number;
  mtd_expenses_eur?: number;
  mtd_net_eur?: number;
  outstanding_eur?: number;
  invoices?: InvoiceRow[];
  as_of_iso?: string;
  error?: string;
}

function fmtEur(n: number | undefined): string {
  if (n == null) return "—";
  return `€ ${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function FinanceSection() {
  const [data, setData] = useState<FinanceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.finance()
      .then((d) => setData(d))
      .catch(() => setData({ error: "endpoint offline" }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <EmptyState label="loading finance…" />;
  if (!data || data.error) {
    return (
      <div className="space-y-4">
        <EmptyState label={data?.error ? `no data — ${data.error}` : "no data yet — create demo-data/finance.json"} />
      </div>
    );
  }

  const invoices = data.invoices ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="MTD Revenue" value={fmtEur(data.mtd_revenue_eur)} accent="var(--servari-teal)" />
        <Stat label="MTD Expenses" value={fmtEur(data.mtd_expenses_eur)} />
        <Stat label="MTD Net" value={fmtEur(data.mtd_net_eur)} accent="var(--servari-teal)" />
        <Stat label="Outstanding" value={fmtEur(data.outstanding_eur)} />
      </div>
      {invoices.length === 0 ? (
        <EmptyState label="no outstanding invoices" />
      ) : (
        <Panel title="Outstanding Invoices" note={`${invoices.length} invoices`}>
          {invoices.map((inv, i) => (
            <div
              key={inv.inv_id}
              className="flex items-center justify-between py-2"
              style={{
                borderBottom: i < invoices.length - 1 ? "1px solid rgba(250,248,243,0.06)" : undefined,
              }}
            >
              <div>
                <span
                  className="font-mono text-[0.68rem]"
                  style={{ color: "var(--servari-ivory)" }}
                >
                  {inv.inv_id}
                </span>
                <span
                  className="font-mono text-[0.62rem] ml-2"
                  style={{ color: "var(--servari-dimmed)" }}
                >
                  {inv.client}
                </span>
              </div>
              <div className="text-right">
                <div
                  className="font-mono text-[0.7rem]"
                  style={{ color: "var(--servari-ivory)" }}
                >
                  {fmtEur(inv.amount_eur)}
                </div>
                <div
                  className="font-mono text-[0.58rem]"
                  style={{
                    color: inv.due_str === "overdue" ? "var(--servari-red)" : "var(--servari-dimmed)",
                  }}
                >
                  {inv.due_str}
                </div>
              </div>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

// --- MEMORY ---
interface MemoryFile {
  file: string;
  path: string;
  entries: number | null;
  updated: string;
}
interface MemoryData {
  files: MemoryFile[];
  error?: string;
}

function MemorySection() {
  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.memorySurface()
      .then((d) => setData(d))
      .catch(() => setData({ files: [], error: "endpoint offline" }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <EmptyState label="loading memory files…" />;

  const files = data?.files ?? [];

  return (
    <div className="space-y-4">
      {files.length === 0 ? (
        <EmptyState label={data?.error ? `no data — ${data.error}` : "no data yet — populate demo-data/memory/"} />
      ) : (
        <Panel title="Persistent State Files" note={`${files.length} files`}>
          <div className="space-y-1.5">
            {files.map((m, i) => (
              <motion.div
                key={m.path}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="flex items-center justify-between rounded-lg px-3 py-2"
                style={{
                  background: "rgba(250, 248, 243, 0.025)",
                  border: "1px solid rgba(250, 248, 243, 0.06)",
                }}
              >
                <span
                  className="font-mono text-[0.68rem]"
                  style={{ color: "var(--servari-ivory)" }}
                >
                  {m.file}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  {m.entries !== null && (
                    <span
                      className="font-mono text-[0.62rem] px-1.5 py-0.5 rounded"
                      style={{
                        background: "rgba(20, 156, 150, 0.1)",
                        color: "var(--servari-teal-soft)",
                      }}
                    >
                      {m.entries} entries
                    </span>
                  )}
                  <span
                    className="font-mono text-[0.6rem]"
                    style={{ color: "var(--servari-dimmed)" }}
                  >
                    {m.updated}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// --- REPORTS ---
interface ReportRow {
  date: string;
  slug: string;
  path: string;
  desc: string;
  ext: string;
}
interface ReportsData {
  reports: ReportRow[];
  error?: string;
}

function ReportsSection() {
  const [data, setData] = useState<ReportsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.reports()
      .then((d) => setData(d))
      .catch(() => setData({ reports: [], error: "endpoint offline" }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <EmptyState label="loading reports…" />;

  const reports = data?.reports ?? [];

  return (
    <div className="space-y-4">
      {reports.length === 0 ? (
        <EmptyState label={data?.error ? `no data — ${data.error}` : "no reports yet — demo-data/reports/ is empty"} />
      ) : (
        <Panel
          title="Generated Reports"
          note={`${reports.length} files`}
        >
          <div className="space-y-1.5">
            {reports.map((r, i) => (
              <motion.div
                key={r.path}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                className="flex items-center justify-between rounded-lg px-3 py-2"
                style={{
                  background: "rgba(250, 248, 243, 0.025)",
                  border: "1px solid rgba(250, 248, 243, 0.06)",
                }}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="font-mono text-[0.58rem] shrink-0"
                    style={{ color: "var(--servari-dimmed)", opacity: 0.7 }}
                  >
                    {r.date}
                  </span>
                  <span
                    className="font-mono text-[0.7rem]"
                    style={{ color: "var(--servari-ivory)" }}
                  >
                    {r.slug}
                  </span>
                </div>
                <span
                  className="font-mono text-[0.62rem] shrink-0"
                  style={{ color: "var(--servari-dimmed)" }}
                >
                  {r.desc}
                </span>
              </motion.div>
            ))}
          </div>
        </Panel>
      )}
      <Panel title="Token Reports" note="live via /api/tokens-report">
        <div
          className="font-mono text-[0.65rem] py-2 text-center"
          style={{ color: "var(--servari-dimmed)" }}
        >
          use the{" "}
          <span style={{ color: "var(--servari-teal-soft)" }}>Tokens</span>{" "}
          panel to generate a session report
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab content switcher
// ---------------------------------------------------------------------------
function TabContent({ tab }: { tab: TabId }) {
  switch (tab) {
    case "jobs":
      return <JobsSection />;
    case "apps":
      return <AppsSection />;
    case "career":
      return <CareerSection />;
    case "inbox":
      return <InboxSection />;
    case "finance":
      return <FinanceSection />;
    case "memory":
      return <MemorySection />;
    case "reports":
      return <ReportsSection />;
  }
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------
export function PersonalView() {
  const [activeTab, setActiveTab] = useState<TabId>("jobs");

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="shrink-0 px-8 pt-7 pb-4"
        style={{ borderBottom: "1px solid rgba(250, 248, 243, 0.06)" }}
      >
        <div
          className="text-[1.5rem] font-semibold tracking-tight"
          style={{ color: "var(--servari-teal)", fontFamily: "var(--font-display)" }}
        >
          Personal
        </div>
        <div
          className="font-mono text-[0.7rem] mt-1"
          style={{ color: "var(--servari-dimmed)" }}
        >
          personal world · jobs · inbox · finance · memory · reports
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Tab bar                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="shrink-0 flex items-center gap-0.5 px-6 pt-3 pb-0"
        style={{ borderBottom: "1px solid rgba(250, 248, 243, 0.06)" }}
      >
        {TABS.map(({ id, label, Icon }) => {
          const active = id === activeTab;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className="relative flex items-center gap-1.5 px-3 pb-2.5 pt-1 rounded-t transition-colors"
              style={{
                color: active ? "var(--servari-teal)" : "var(--servari-dimmed)",
                background: "transparent",
                fontSize: "0.75rem",
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.02em",
              }}
            >
              <Icon size={13} />
              {label}
              {/* Active underline */}
              {active && (
                <motion.div
                  layoutId="personal-tab-underline"
                  className="absolute bottom-0 left-0 right-0 h-px rounded-full"
                  style={{ background: "var(--servari-teal)" }}
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Tab content — scrollable                                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 overflow-y-auto px-8 py-5" style={{ scrollbarWidth: "thin" }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <TabContent tab={activeTab} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export default PersonalView;
