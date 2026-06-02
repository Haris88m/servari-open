import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Activity, Users, Zap, AlertCircle, Gauge } from "lucide-react";
import { API, type HealthCheckResponse } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

type CheckStatus = "healthy" | "warning" | "error" | "unknown";

interface SystemCard {
  id: string;
  name: string;
  status: CheckStatus;
  rawStatus: string;
  icon: typeof Activity;
  details: string;
  rows: { label: string; value: string; color?: string }[];
}

interface MetricCard {
  label: string;
  value: string;
  good: boolean;
}

// Map a backend per-check status (OK / DEGRADED / UNKNOWN) onto the design's
// visual statuses (healthy / warning / unknown).
function mapStatus(s: string): CheckStatus {
  switch ((s || "").toUpperCase()) {
    case "OK": return "healthy";
    case "DEGRADED": return "warning";
    case "UNKNOWN": return "unknown";
    default: return "unknown";
  }
}

// NOTE: the backend check KEYS (network / agents / gate_queue) are the internal
// data contract and never render. The DISPLAYED title comes from TITLES below.
const ICONS: Record<string, typeof Activity> = {
  network: Activity,
  agents: Users,
  gate_queue: Zap,
  gauges: Gauge,
};

const TITLES: Record<string, string> = {
  network: "Network",
  agents: "Team",
  gate_queue: "Approval Queue",
  gauges: "System Gauges",
};

function str(v: unknown): string {
  if (v === undefined || v === null) return "—";
  return String(v);
}

// Build the per-check card rows from each check's REAL extra fields. Any text
// derived from the backend note/verdict is sealed before it reaches the display.
function buildCard(key: string, c: Record<string, unknown>): SystemCard {
  const status = mapStatus(String(c.status));
  const rows: { label: string; value: string; color?: string }[] = [];
  let details = sealLabel((c.note as string) || "");

  if (key === "network") {
    if (c.skills !== undefined) rows.push({ label: "Capabilities", value: str(c.skills) });
    if (c.connected !== undefined) rows.push({ label: "Connected", value: str(c.connected) });
    if (c.disconnected !== undefined)
      rows.push({
        label: "Disconnected",
        value: str(c.disconnected),
        color: Number(c.disconnected) > 0 ? "var(--servari-amber)" : undefined,
      });
    if (c.channels !== undefined) rows.push({ label: "Channels", value: str(c.channels) });
    if (!details) details = `Integration verdict: ${str(c.verdict)}`;
  } else if (key === "agents") {
    if (c.members !== undefined)
      rows.push({ label: "Members", value: str(c.members) });
    if (c.orchestrator !== undefined) rows.push({ label: "Orchestrator", value: str(c.orchestrator) });
    if (c.roles !== undefined) rows.push({ label: "Roles", value: str(c.roles) });
    if (!details) details = `${str(c.members)} members in the registry`;
  } else if (key === "gate_queue") {
    if (c.pending !== undefined && c.pending !== null)
      rows.push({
        label: "Pending",
        value: str(c.pending),
        color: Number(c.pending) > 0 ? "var(--servari-amber)" : undefined,
      });
    if (c.total !== undefined) rows.push({ label: "Audit lines", value: str(c.total) });
    if (!details)
      details =
        Number(c.pending) > 0
          ? `${str(c.pending)} approval(s) awaiting a human decision`
          : "No approvals awaiting a decision";
  } else if (key === "gauges") {
    if (c.heartbeat !== undefined) rows.push({ label: "Heartbeat", value: str(c.heartbeat) });
    if (c.skills !== undefined) rows.push({ label: "Capabilities", value: str(c.skills) });
    if (c.gauge_errors !== undefined && c.gauge_errors !== null)
      rows.push({
        label: "Gauge errors",
        value: str(c.gauge_errors),
        color: Number(c.gauge_errors) > 0 ? "var(--servari-amber)" : undefined,
      });
    if (!details) details = `Cached self-state gauge`;
  }

  if (!details) details = `Status: ${str(c.status)}`;

  return {
    id: key,
    name: TITLES[key] || sealLabel(key.replace(/_/g, " ")) || key.replace(/_/g, " "),
    status,
    rawStatus: String(c.status || ""),
    icon: ICONS[key] || Activity,
    details,
    rows,
  };
}

export function Health() {
  const [data, setData] = useState<HealthCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = await API.health();
      setError(null);
      setData(d);
    } catch {
      setError("health unavailable");
      setData(null);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "healthy": return 'var(--servari-green)';
      case "warning": return 'var(--servari-amber)';
      case "error": return 'var(--servari-red)';
      case "unknown": return 'var(--servari-dimmed)';
      default: return 'var(--servari-dimmed)';
    }
  };

  // Overall verdict: OK -> HEALTHY (green); anything else -> DEGRADED (amber).
  const verdict = String(data?.verdict || (error ? "DEGRADED" : "UNKNOWN")).toUpperCase();
  const overall: CheckStatus =
    verdict === "OK" ? "healthy" : verdict === "DEGRADED" ? "warning" : "unknown";
  const overallText = verdict === "OK" ? "HEALTHY" : verdict === "DEGRADED" ? "DEGRADED" : "UNKNOWN";
  const summary = sealLabel((data?.summary as string) || "") || error || "";

  const checks = (data?.checks as Record<string, Record<string, unknown>>) || {};
  const order = ["network", "agents", "gate_queue", "gauges"];
  const keys = [
    ...order.filter((k) => k in checks),
    ...Object.keys(checks).filter((k) => !order.includes(k)),
  ];
  const systems: SystemCard[] = keys.map((k) => buildCard(k, checks[k] || {}));

  // System metrics grid from the real check extras (proof-of-state, not mock).
  const ns = checks.network || {};
  const ag = checks.agents || {};
  const gq = checks.gate_queue || {};
  const cg = checks.gauges || {};
  const okCount = systems.filter((s) => s.status === "healthy").length;
  const metrics: MetricCard[] = [
    { label: "Verdict", value: overallText, good: verdict === "OK" },
    { label: "Checks OK", value: `${okCount}/${systems.length}`, good: okCount === systems.length },
    { label: "Capabilities", value: str(ns.skills ?? cg.skills), good: true },
    { label: "Channels", value: str(ns.channels), good: Number(ns.channels) > 0 },
    { label: "Team", value: str(ag.members), good: Number(ag.members) >= 5 },
    {
      label: "Pending Approvals",
      value: str(gq.pending ?? 0),
      good: !(Number(gq.pending) > 0),
    },
  ];

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="max-w-6xl mx-auto">
        <div
          className="mb-8"
          style={{
            color: 'var(--servari-ivory)',
            fontSize: '1.5rem',
            letterSpacing: '1px'
          }}
        >
          HEALTH
        </div>

        {/* Overall status */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 p-8 rounded-xl text-center"
          style={{
            background: 'var(--servari-glass)',
            backdropFilter: 'blur(24px)',
            border: `2px solid ${getStatusColor(overall)}`,
          }}
        >
          <motion.div
            key={overallText}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring" }}
            style={{
              color: getStatusColor(overall),
              fontSize: '3rem',
              fontWeight: 500,
              letterSpacing: '2px',
              marginBottom: '0.5rem'
            }}
          >
            {overallText}
          </motion.div>
          <div
            style={{
              color: 'var(--servari-dimmed)',
              fontSize: '0.9375rem'
            }}
          >
            {summary || 'All systems operational'}
          </div>
        </motion.div>

        {/* System statuses */}
        {systems.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mb-8 p-6 rounded-xl flex items-center gap-3"
            style={{
              background: 'var(--servari-glass)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.8125rem',
            }}
          >
            <AlertCircle size={16} style={{ color: 'var(--servari-amber)' }} />
            {error ? `Health module unavailable — ${error}` : 'No system checks reporting yet.'}
          </motion.div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {systems.map((system, index) => {
            const Icon = system.icon;
            return (
              <motion.div
                key={system.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + index * 0.1 }}
                className="p-6 rounded-xl"
                style={{
                  background: 'var(--servari-glass)',
                  backdropFilter: 'blur(24px)',
                  border: '1px solid rgba(250, 248, 243, 0.08)',
                }}
              >
                {/* Icon and status */}
                <div className="flex items-center justify-between mb-4">
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center"
                    style={{
                      background: `${getStatusColor(system.status)}20`,
                      border: `1px solid ${getStatusColor(system.status)}`,
                    }}
                  >
                    <Icon size={24} style={{ color: getStatusColor(system.status) }} />
                  </div>
                  <motion.div
                    className="w-3 h-3 rounded-full"
                    style={{ background: getStatusColor(system.status) }}
                    animate={{
                      opacity: [1, 0.5, 1],
                    }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  />
                </div>

                {/* Name */}
                <div
                  className="mb-2"
                  style={{
                    color: 'var(--servari-ivory)',
                    fontSize: '1.125rem',
                    fontWeight: 500
                  }}
                >
                  {system.name}
                </div>

                {/* Details */}
                <div
                  className="mb-3"
                  style={{
                    color: 'var(--servari-dimmed)',
                    fontSize: '0.8125rem',
                    lineHeight: '1.5'
                  }}
                >
                  {system.details}
                </div>

                {/* Metrics (real check extras) */}
                <div className="space-y-1">
                  {system.rows.map((row) => (
                    <div
                      key={row.label}
                      className="flex justify-between"
                      style={{
                        color: 'var(--servari-dimmed)',
                        fontSize: '0.75rem'
                      }}
                    >
                      <span>{row.label}</span>
                      <span style={{ color: row.color || 'var(--servari-teal)' }}>{row.value}</span>
                    </div>
                  ))}
                  <div
                    className="flex justify-between"
                    style={{
                      color: 'var(--servari-dimmed)',
                      fontSize: '0.75rem'
                    }}
                  >
                    <span>Status</span>
                    <span style={{ color: getStatusColor(system.status) }}>
                      {system.rawStatus || 'UNKNOWN'}
                    </span>
                  </div>
                </div>

                {/* Warning footer if not healthy */}
                {system.status === 'warning' && (
                  <div
                    className="mt-3 pt-3 flex items-center gap-2"
                    style={{
                      borderTop: '1px solid rgba(250, 248, 243, 0.05)',
                      color: 'var(--servari-amber)',
                      fontSize: '0.75rem'
                    }}
                  >
                    <AlertCircle size={14} />
                    Monitoring
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>

        {/* Metrics grid */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="p-6 rounded-xl"
          style={{
            background: 'var(--servari-glass)',
            backdropFilter: 'blur(24px)',
            border: '1px solid rgba(250, 248, 243, 0.08)',
          }}
        >
          <div
            className="mb-4"
            style={{
              color: 'var(--servari-ivory)',
              fontSize: '0.9375rem',
              letterSpacing: '1px',
              textTransform: 'uppercase'
            }}
          >
            System Metrics
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {metrics.map((metric, index) => (
              <motion.div
                key={metric.label}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.7 + index * 0.05 }}
                className="p-4 rounded-lg"
                style={{
                  background: 'rgba(250, 248, 243, 0.02)',
                  border: '1px solid rgba(250, 248, 243, 0.05)',
                }}
              >
                <div
                  className="mb-2"
                  style={{
                    color: 'var(--servari-dimmed)',
                    fontSize: '0.75rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                  }}
                >
                  {metric.label}
                </div>
                <div
                  style={{
                    color: metric.good ? 'var(--servari-teal)' : 'var(--servari-amber)',
                    fontSize: '1.5rem',
                    fontWeight: 500
                  }}
                >
                  {metric.value}
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
