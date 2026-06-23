import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import {
  CheckCircle2,
  ClipboardList,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react";
import { API, type AgentBriefResponse, type RunResponse, type StandingOrder } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

function labelFor(name: string) {
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fallbackOrder(action: string): StandingOrder {
  return {
    id: action,
    action,
    title: action.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    purpose: "Local allow-listed SERVARI operation.",
    owner: "Operator",
    trigger: "manual",
    gate: "allow-listed action",
    enabled: true,
  };
}

function OrderCard({ order, index, onAfterRun }: { order: StandingOrder; index: number; onAfterRun: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [open, setOpen] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setOpen(true);
    try {
      const next = await API.run(order.action);
      setResult(next);
      onAfterRun();
    } catch (error) {
      setResult({ ok: false, action: order.action, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  }, [onAfterRun, order.action]);

  const succeeded = result != null && result.ok && (result.exit === 0 || result.exit === undefined);
  const failed = result != null && !succeeded;
  const output = result?.out ?? result?.error ?? "";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.035 }}
      className="overflow-hidden rounded-lg"
      style={{ background: "var(--s-glass-light)", border: "1px solid var(--s-edge-subtle)" }}
    >
      <div className="grid gap-4 p-4 lg:grid-cols-[auto_1fr_auto] lg:items-center">
        <div className="grid h-10 w-10 place-items-center rounded-lg" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}>
          {running ? <Loader2 size={18} className="animate-spin" style={{ color: "var(--s-text-teal)" }} /> : failed ? <XCircle size={18} style={{ color: "var(--s-status-error)" }} /> : succeeded ? <CheckCircle2 size={18} style={{ color: "var(--s-status-ok)" }} /> : <Terminal size={18} style={{ color: "var(--s-text-secondary)" }} />}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-16)", fontWeight: 780, letterSpacing: 0 }}>
              {order.title}
            </h2>
            <span className="rounded-full px-2 py-1" style={{ border: "1px solid rgba(63,185,80,0.32)", color: "var(--s-status-ok)", fontSize: "var(--t-10)", fontFamily: "var(--font-mono)", textTransform: "uppercase" }}>
              {order.enabled ? "enabled" : "disabled"}
            </span>
          </div>
          <p className="mt-1" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)", lineHeight: 1.55 }}>
            {order.purpose}
          </p>
          <div className="mt-2 flex flex-wrap gap-2" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
            <span>Owner: {order.owner}</span>
            <span>Trigger: {order.trigger}</span>
            <span>Gate: {order.gate}</span>
            {order.last_run && <span>Last run: {order.last_run}</span>}
          </div>
        </div>
        <button
          onClick={run}
          disabled={running || !order.enabled}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 disabled:opacity-45"
          style={{ border: "1px solid rgba(20,156,150,0.45)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.10)" }}
        >
          <Play size={14} />
          Run
        </button>
      </div>

      <AnimatePresence>
        {open && (running || output) && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} style={{ borderTop: "1px solid var(--s-edge-subtle)" }}>
            <pre
              style={{
                margin: 0,
                padding: "1rem",
                maxHeight: "22rem",
                overflow: "auto",
                color: failed ? "var(--s-status-error)" : "var(--s-text-secondary)",
                fontSize: "var(--t-12)",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                background: "rgba(5,8,12,0.55)",
              }}
            >
              {running ? "running..." : output}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function StandingOrders() {
  const [searchParams] = useSearchParams();
  const agent = searchParams.get("agent") || "";
  const [orders, setOrders] = useState<StandingOrder[]>([]);
  const [brief, setBrief] = useState<AgentBriefResponse | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const actions = await API.actions();
      const nextOrders = actions.orders?.length ? actions.orders : (actions.actions || []).map(fallbackOrder);
      setOrders(nextOrders);
    } catch (error) {
      setMessage(`Standing orders unavailable: ${error instanceof Error ? error.message : String(error)}`);
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    if (!agent) {
      setBrief(null);
      return;
    }
    API.agentBrief(agent)
      .then((next) => {
        if (alive) setBrief(next);
      })
      .catch(() => {
        if (alive) setBrief(null);
      });
    return () => {
      alive = false;
    };
  }, [agent]);

  const stats = useMemo(() => {
    const ran = orders.filter((order) => order.last_run).length;
    const ok = orders.filter((order) => order.last_ok === true).length;
    return { total: orders.length, ran, ok };
  }, [orders]);

  return (
    <div className="h-full overflow-auto p-4 md:p-6 xl:p-8">
      <div className="mx-auto max-w-6xl space-y-4">
        <motion.header
          className="flex flex-col gap-3 rounded-lg px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
          style={{ border: "1px solid var(--s-edge-accent)", background: "var(--s-glass-light)" }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div>
            <div className="mb-1 flex items-center gap-2" style={{ color: "var(--s-text-teal)", fontSize: "var(--t-11)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
              <ClipboardList size={15} />
              Standing Orders
            </div>
            <h1 style={{ color: "var(--s-text-primary)", fontSize: "var(--t-24)", fontWeight: 780, letterSpacing: 0 }}>
              Safe recurring operations and local readiness checks
            </h1>
          </div>
          <button type="button" onClick={() => void load()} className="inline-flex h-10 items-center gap-2 rounded-lg px-3" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)", background: "rgba(250,248,243,0.035)" }}>
            <RefreshCw size={15} />
            Refresh
          </button>
        </motion.header>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}>
            <Terminal size={18} style={{ color: "var(--s-text-teal)" }} />
            <div className="mt-3" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-20)", fontWeight: 780 }}>{stats.total}</div>
            <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>allow-listed orders</div>
          </div>
          <div className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}>
            <Play size={18} style={{ color: "var(--s-status-warn)" }} />
            <div className="mt-3" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-20)", fontWeight: 780 }}>{stats.ran}</div>
            <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>run from this workspace</div>
          </div>
          <div className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}>
            <ShieldCheck size={18} style={{ color: "var(--s-status-ok)" }} />
            <div className="mt-3" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-20)", fontWeight: 780 }}>{stats.ok}</div>
            <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>last runs clean</div>
          </div>
        </div>

        {agent && brief && (
          <section className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}>
            <div className="mb-3 flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>
              <FileText size={16} style={{ color: "var(--s-text-teal)" }} />
              {sealLabel(labelFor(agent)) || labelFor(agent)}
            </div>
            <pre style={{ margin: 0, maxHeight: 260, overflow: "auto", color: "var(--s-text-secondary)", fontSize: "var(--t-12)", lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
              {brief.found ? sealLabel(brief.brief) : "No START.md found for this profile."}
            </pre>
          </section>
        )}

        {message && <div className="rounded-lg px-3 py-2" style={{ border: "1px solid rgba(248,81,73,0.26)", color: "var(--s-status-error)", background: "rgba(248,81,73,0.06)", fontSize: "var(--t-12)" }}>{message}</div>}

        {loading ? (
          <div className="rounded-lg p-6" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-secondary)", background: "var(--s-glass-light)" }}>Loading standing orders...</div>
        ) : orders.length ? (
          <div className="space-y-3">
            {orders.map((order, index) => <OrderCard key={order.id} order={order} index={index} onAfterRun={() => void load()} />)}
          </div>
        ) : (
          <div className="rounded-lg p-10 text-center" style={{ border: "1px dashed var(--s-edge-subtle)", color: "var(--s-text-secondary)", background: "var(--s-glass-light)" }}>
            No standing orders configured.
          </div>
        )}
      </div>
    </div>
  );
}

