import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Coins, FileText, Loader2, CheckCircle2, FileType2, FileDown } from "lucide-react";
import { API } from "../lib/api";
import type { TokensResponse } from "../lib/api";

// The real session-row shape from the token server module's sessions(): we only
// render the fields the server guarantees. Marked permissive so a degraded
// server can't break the table.
interface SessionRow {
  session?: string;
  msgs?: number;
  subagent_transcripts?: number;
  total_tokens?: number;
  cost_usd?: number;
  last_activity?: string;
  [k: string]: unknown;
}

type ReportScope = "session" | "today" | "all";
type ReportFormat = "pdf" | "docx";

// The /api/tokens-report response carries the rendered-document fields
// (format/destination/opened) on top of the base shape. api.ts is owned by
// another surface, so we model the extended shape locally + POST directly.
interface ReportResult {
  ok: boolean;
  path?: string;
  format?: string;
  scope?: string;
  destination?: string;
  opened?: boolean;
  markdown?: string;
  error?: string;
}

function fmt(n: number | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

function fmtCost(n: number | undefined): string {
  return `$${(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtCompact(n: number | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

// Direct POST so we can pass format + destination without touching api.ts
// (which is owned by another surface). Same-origin in production; vite proxies
// /api in dev. Never throws past the caller's try/catch.
async function postReport(body: {
  scope: ReportScope;
  format: ReportFormat;
  destination: string;
}): Promise<ReportResult> {
  const res = await fetch("/api/tokens-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ReportResult;
}

export function TokensPanel() {
  const [data, setData] = useState<TokensResponse | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [reportBusy, setReportBusy] = useState<ReportScope | null>(null);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [format, setFormat] = useState<ReportFormat>("pdf");

  // LIVE strip + summary — refresh every 5s.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const t = await API.tokens();
        if (alive) setData(t);
      } catch {
        /* keep last values; server degrades gracefully */
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Sessions table — load once + light 30s refresh (heavier query).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await API.tokensSessions(20);
        if (alive) setSessions((res.sessions as SessionRow[]) || []);
      } catch {
        /* keep last */
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const runReport = useCallback(
    async (scope: ReportScope) => {
      setReportBusy(scope);
      setReport(null);
      try {
        const res = await postReport({ scope, format, destination: "desktop" });
        setReport(res);
      } catch {
        setReport({ ok: false, error: "report_request_failed" });
      } finally {
        setReportBusy(null);
      }
    },
    [format],
  );

  const live = data?.live ?? {};
  const counts = live.tokens ?? { in: 0, out: 0, cache_write: 0, cache_read: 0 };
  const allTime = data?.summary?.all_time;
  const today = data?.summary?.today;

  // Breakdown bar maxes (normalize against the largest bucket).
  const buckets = [
    { label: "Input", value: counts.in, color: "var(--servari-teal)" },
    { label: "Output", value: counts.out, color: "var(--servari-teal-soft)" },
    { label: "Cache write", value: counts.cache_write, color: "var(--servari-amber)" },
    { label: "Cache read", value: counts.cache_read, color: "var(--servari-green)" },
  ];
  const maxBucket = Math.max(1, ...buckets.map((b) => b.value ?? 0));

  const liveStats = [
    { label: "Messages", value: fmt(live.msgs), accent: false },
    { label: "Total tokens", value: fmt(live.total_tokens), accent: true },
    { label: "Cost (API-equiv)", value: fmtCost(live.cost_usd), accent: true },
    { label: "$ / hour", value: fmtCost(live.cost_per_hour), accent: false },
    { label: "Duration", value: `${live.duration_min ?? 0} min`, accent: false },
  ];

  const reportButtons: { scope: ReportScope; label: string }[] = [
    { scope: "session", label: "This session" },
    { scope: "today", label: "Today" },
    { scope: "all", label: "All time" },
  ];

  const formatOptions: { id: ReportFormat; label: string; Icon: typeof FileType2 }[] = [
    { id: "pdf", label: "PDF", Icon: FileDown },
    { id: "docx", label: "Word", Icon: FileType2 },
  ];

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="max-w-6xl mx-auto">
        {/* Title */}
        <div
          className="mb-2 flex items-center gap-3"
          style={{ color: "var(--servari-ivory)", fontSize: "1.5rem", letterSpacing: "1px" }}
        >
          <Coins size={26} style={{ color: "var(--servari-teal)" }} />
          TOKENS
        </div>
        <div
          className="mb-8"
          style={{ color: "var(--servari-dimmed)", fontSize: "0.8125rem", letterSpacing: "0.5px" }}
        >
          Proof of work — real-time spend. The cost is API-equivalent (the cost-to-serve), not necessarily cash.
        </div>

        {/* LIVE strip */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 p-6 rounded-xl"
          style={{
            background: "var(--servari-glass)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(20, 156, 150, 0.25)",
          }}
        >
          <div className="flex items-center justify-between mb-5">
            <div
              style={{
                color: "var(--servari-ivory)",
                fontSize: "0.9375rem",
                letterSpacing: "1px",
                textTransform: "uppercase",
              }}
            >
              This session
              <span style={{ color: "var(--servari-dimmed)", marginLeft: "0.75rem", fontSize: "0.75rem" }}>
                {live.session ? `· ${live.session}` : ""}
              </span>
            </div>
            <motion.div
              className="flex items-center gap-2"
              style={{ color: "var(--servari-teal)", fontSize: "0.75rem", letterSpacing: "0.5px" }}
            >
              <motion.span
                className="w-2 h-2 rounded-full inline-block"
                style={{ background: "var(--servari-green)" }}
                animate={{ opacity: [1, 0.4, 1] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              />
              LIVE
            </motion.div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {liveStats.map((stat, index) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1 + index * 0.05 }}
              >
                <div
                  className="mb-1"
                  style={{
                    color: "var(--servari-dimmed)",
                    fontSize: "0.6875rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  {stat.label}
                </div>
                <div
                  style={{
                    color: stat.accent ? "var(--servari-teal)" : "var(--servari-ivory)",
                    fontSize: "1.75rem",
                    fontWeight: 500,
                    lineHeight: 1.1,
                  }}
                >
                  {stat.value}
                </div>
              </motion.div>
            ))}
          </div>

          {/* Breakdown bars */}
          <div className="mt-6 space-y-3">
            <div
              style={{
                color: "var(--servari-dimmed)",
                fontSize: "0.6875rem",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Token breakdown
            </div>
            {buckets.map((b, index) => (
              <div key={b.label} className="flex items-center gap-3">
                <div style={{ color: "var(--servari-dimmed)", fontSize: "0.75rem", width: "92px" }}>
                  {b.label}
                </div>
                <div
                  className="flex-1 h-2 rounded-full overflow-hidden"
                  style={{ background: "rgba(250, 248, 243, 0.05)" }}
                >
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: b.color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${((b.value ?? 0) / maxBucket) * 100}%` }}
                    transition={{ duration: 0.6, delay: 0.2 + index * 0.08, ease: "easeOut" }}
                  />
                </div>
                <div
                  style={{ color: "var(--servari-ivory)", fontSize: "0.75rem", width: "72px", textAlign: "right" }}
                >
                  {fmtCompact(b.value)}
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* ALL-TIME + TODAY cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {[
            { title: "ALL TIME", bucket: allTime, extra: allTime?.transcripts, extraLabel: "transcripts" },
            { title: "TODAY", bucket: today, extra: today?.msgs, extraLabel: "messages" },
          ].map((card, index) => (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 + index * 0.1 }}
              className="p-6 rounded-xl"
              style={{
                background: "var(--servari-glass)",
                backdropFilter: "blur(24px)",
                border: "1px solid rgba(250, 248, 243, 0.08)",
              }}
            >
              <div
                className="mb-4"
                style={{
                  color: "var(--servari-ivory)",
                  fontSize: "0.9375rem",
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                }}
              >
                {card.title}
              </div>
              <div className="flex items-end justify-between">
                <div>
                  <div
                    className="mb-1"
                    style={{ color: "var(--servari-dimmed)", fontSize: "0.6875rem", textTransform: "uppercase" }}
                  >
                    Total tokens
                  </div>
                  <div style={{ color: "var(--servari-ivory)", fontSize: "2rem", fontWeight: 500 }}>
                    {fmtCompact(card.bucket?.total_tokens)}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className="mb-1"
                    style={{ color: "var(--servari-dimmed)", fontSize: "0.6875rem", textTransform: "uppercase" }}
                  >
                    Cost
                  </div>
                  <div style={{ color: "var(--servari-teal)", fontSize: "2rem", fontWeight: 500 }}>
                    {fmtCost(card.bucket?.cost_usd)}
                  </div>
                </div>
              </div>
              {card.extra !== undefined && (
                <div
                  className="mt-3 pt-3 flex justify-between"
                  style={{
                    borderTop: "1px solid rgba(250, 248, 243, 0.05)",
                    color: "var(--servari-dimmed)",
                    fontSize: "0.75rem",
                  }}
                >
                  <span style={{ textTransform: "capitalize" }}>{card.extraLabel}</span>
                  <span style={{ color: "var(--servari-teal)" }}>{fmt(card.extra)}</span>
                </div>
              )}
            </motion.div>
          ))}
        </div>

        {/* SESSIONS table */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="mb-8 p-6 rounded-xl"
          style={{
            background: "var(--servari-glass)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(250, 248, 243, 0.08)",
          }}
        >
          <div
            className="mb-4"
            style={{
              color: "var(--servari-ivory)",
              fontSize: "0.9375rem",
              letterSpacing: "1px",
              textTransform: "uppercase",
            }}
          >
            Recent Sessions
          </div>

          {sessions.length === 0 ? (
            <div style={{ color: "var(--servari-dimmed)", fontSize: "0.8125rem" }}>No sessions recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full" style={{ fontSize: "0.8125rem" }}>
                <thead>
                  <tr style={{ color: "var(--servari-dimmed)", textAlign: "left" }}>
                    <th className="pb-3 pr-4" style={{ fontWeight: 400, textTransform: "uppercase", fontSize: "0.6875rem", letterSpacing: "0.5px" }}>Session</th>
                    <th className="pb-3 px-4" style={{ fontWeight: 400, textTransform: "uppercase", fontSize: "0.6875rem", letterSpacing: "0.5px", textAlign: "right" }}>Msgs</th>
                    <th className="pb-3 px-4" style={{ fontWeight: 400, textTransform: "uppercase", fontSize: "0.6875rem", letterSpacing: "0.5px", textAlign: "right" }}>Sub</th>
                    <th className="pb-3 px-4" style={{ fontWeight: 400, textTransform: "uppercase", fontSize: "0.6875rem", letterSpacing: "0.5px", textAlign: "right" }}>Tokens</th>
                    <th className="pb-3 pl-4" style={{ fontWeight: 400, textTransform: "uppercase", fontSize: "0.6875rem", letterSpacing: "0.5px", textAlign: "right" }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s, index) => (
                    <motion.tr
                      key={(s.session ?? "row") + index}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.05 * Math.min(index, 10) }}
                      style={{ borderTop: "1px solid rgba(250, 248, 243, 0.05)" }}
                    >
                      <td className="py-2.5 pr-4" style={{ color: "var(--servari-ivory)", fontFamily: "var(--font-mono)" }}>
                        {(s.session ?? "—").slice(0, 18)}
                      </td>
                      <td className="py-2.5 px-4" style={{ color: "var(--servari-dimmed)", textAlign: "right" }}>{fmt(s.msgs)}</td>
                      <td className="py-2.5 px-4" style={{ color: "var(--servari-dimmed)", textAlign: "right" }}>{fmt(s.subagent_transcripts)}</td>
                      <td className="py-2.5 px-4" style={{ color: "var(--servari-ivory)", textAlign: "right" }}>{fmtCompact(s.total_tokens)}</td>
                      <td className="py-2.5 pl-4" style={{ color: "var(--servari-teal)", textAlign: "right" }}>{fmtCost(s.cost_usd)}</td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </motion.div>

        {/* REPORT — branded export card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="relative overflow-hidden p-6 rounded-xl"
          style={{
            background: "var(--servari-glass)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(20, 156, 150, 0.22)",
          }}
        >
          {/* faint raven watermark — the brand mark, not an icon */}
          <img
            src="/raven.png"
            alt=""
            aria-hidden="true"
            style={{
              position: "absolute",
              right: "-28px",
              top: "-22px",
              width: "168px",
              height: "168px",
              opacity: 0.05,
              pointerEvents: "none",
              filter: "grayscale(1)",
            }}
          />

          <div
            className="mb-1 flex items-center gap-2"
            style={{
              color: "var(--servari-ivory)",
              fontSize: "0.9375rem",
              letterSpacing: "1px",
              textTransform: "uppercase",
            }}
          >
            <FileText size={16} style={{ color: "var(--servari-teal)" }} />
            Generate Report
          </div>
          <div
            className="mb-5"
            style={{ color: "var(--servari-dimmed)", fontSize: "0.75rem", letterSpacing: "0.3px" }}
          >
            A full SERVARI-designed document, saved to your Desktop — opens the moment it’s ready.
          </div>

          {/* format toggle: PDF | Word */}
          <div className="mb-5">
            <div
              className="mb-2"
              style={{
                color: "var(--servari-dimmed)",
                fontSize: "0.6875rem",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Format
            </div>
            <div
              className="inline-flex p-1 rounded-lg"
              style={{ background: "rgba(250, 248, 243, 0.04)", border: "1px solid rgba(250, 248, 243, 0.07)" }}
            >
              {formatOptions.map(({ id, label, Icon }) => {
                const active = format === id;
                return (
                  <motion.button
                    key={id}
                    onClick={() => setFormat(id)}
                    disabled={reportBusy !== null}
                    className="relative px-4 py-1.5 rounded-md flex items-center gap-1.5"
                    style={{
                      color: active ? "var(--servari-ink)" : "var(--servari-dimmed)",
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      letterSpacing: "0.3px",
                      cursor: reportBusy !== null ? "default" : "pointer",
                      zIndex: 1,
                    }}
                    whileTap={reportBusy === null ? { scale: 0.96 } : {}}
                  >
                    {active && (
                      <motion.span
                        layoutId="format-pill"
                        className="absolute inset-0 rounded-md"
                        style={{ background: "var(--servari-teal)", zIndex: -1 }}
                        transition={{ type: "spring", stiffness: 480, damping: 34 }}
                      />
                    )}
                    <Icon size={14} />
                    {label}
                  </motion.button>
                );
              })}
            </div>
          </div>

          {/* the three scope buttons */}
          <div className="flex flex-wrap gap-3 mb-5">
            {reportButtons.map((btn) => {
              const busy = reportBusy === btn.scope;
              return (
                <motion.button
                  key={btn.scope}
                  onClick={() => runReport(btn.scope)}
                  disabled={reportBusy !== null}
                  className="py-2.5 px-5 rounded-lg flex items-center gap-2"
                  style={{
                    background: busy ? "rgba(20, 156, 150, 0.22)" : "rgba(20, 156, 150, 0.1)",
                    border: "1px solid var(--servari-teal)",
                    color: "var(--servari-teal)",
                    fontSize: "0.875rem",
                    fontWeight: 500,
                    letterSpacing: "0.3px",
                    opacity: reportBusy !== null && !busy ? 0.4 : 1,
                    cursor: reportBusy !== null ? "default" : "pointer",
                  }}
                  whileHover={reportBusy === null ? { background: "rgba(20, 156, 150, 0.2)", scale: 1.03, y: -1 } : {}}
                  whileTap={reportBusy === null ? { scale: 0.97 } : {}}
                  transition={{ type: "spring", stiffness: 420, damping: 26 }}
                >
                  {busy ? (
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                      className="flex items-center"
                    >
                      <Loader2 size={14} />
                    </motion.span>
                  ) : (
                    <FileDown size={14} />
                  )}
                  {busy ? "Rendering…" : btn.label}
                </motion.button>
              );
            })}
          </div>

          {/* Result: success toast + saved path */}
          <AnimatePresence mode="wait">
            {report && (
              <motion.div
                key={report.ok ? `ok-${report.path ?? ""}` : `err-${report.error ?? ""}`}
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ type: "spring", stiffness: 360, damping: 28 }}
              >
                {report.ok ? (
                  <div
                    className="p-4 rounded-lg"
                    style={{
                      background: "rgba(63, 185, 80, 0.08)",
                      border: "1px solid var(--servari-green)",
                    }}
                  >
                    <div className="flex items-center gap-2" style={{ color: "var(--servari-green)", fontSize: "0.875rem", fontWeight: 500 }}>
                      <motion.span
                        initial={{ scale: 0, rotate: -20 }}
                        animate={{ scale: 1, rotate: 0 }}
                        transition={{ type: "spring", stiffness: 500, damping: 18 }}
                        className="flex items-center"
                      >
                        <CheckCircle2 size={18} />
                      </motion.span>
                      {report.opened ? "Report opened on your Desktop" : "Report saved to your Desktop"}
                      <span
                        className="ml-1 px-2 py-0.5 rounded"
                        style={{
                          background: "rgba(20, 156, 150, 0.15)",
                          color: "var(--servari-teal)",
                          fontSize: "0.6875rem",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                        }}
                      >
                        {(report.format ?? format).toUpperCase()}
                      </span>
                    </div>
                    {report.path && (
                      <div
                        className="mt-2"
                        style={{
                          color: "var(--servari-dimmed)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.75rem",
                          wordBreak: "break-all",
                        }}
                      >
                        {report.path}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    className="p-4 rounded-lg flex items-center gap-2"
                    style={{
                      background: "rgba(248, 81, 73, 0.1)",
                      border: "1px solid var(--servari-red)",
                      color: "var(--servari-red)",
                      fontSize: "0.8125rem",
                    }}
                  >
                    Report failed: {report.error ?? "unknown error"}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}
