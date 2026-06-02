import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { FileText, Inbox, Play, Loader2, CheckCircle2, XCircle, Terminal } from "lucide-react";
import { API, AgentBriefResponse, RunResponse } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

// A readable label from a channel key like "agent-1" / "data-export".
function labelFor(name: string) {
  return name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Action ids ("agent-audit", "git-status") -> a readable, sealed display label.
// Every label passes the display seal so no internal vocabulary can ever render
// on the SERVARI face, even if a future action carries one.
function actionLabel(action: string): string {
  const human = action.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return sealLabel(human) || human;
}

// One standing-order row + its run state. The run output is real command
// output (exit code + stdout from /api/run) and is passed through the seal
// before rendering, so any internal term in raw output is neutralized.
function OrderCard({ action, index }: { action: string; index: number }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [open, setOpen] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setOpen(true);
    try {
      const r = await API.run(action);
      setResult(r);
    } catch (e) {
      setResult({ ok: false, action, error: String(e) });
    } finally {
      setRunning(false);
    }
  }, [action]);

  const succeeded = result != null && result.ok && (result.exit === 0 || result.exit === undefined);
  const failed = result != null && !succeeded;
  const label = actionLabel(action);
  const rawOut = result?.out ?? result?.error ?? "";
  const sealedOut = rawOut ? sealLabel(rawOut) : "";

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04 }}
      className="rounded-xl overflow-hidden"
      style={{
        background: 'var(--servari-glass)',
        backdropFilter: 'blur(24px)',
        border: '1px solid rgba(250, 248, 243, 0.08)',
      }}
    >
      <div className="p-4 flex items-center gap-4">
        {/* Status icon — idle / running / ok / failed */}
        {running ? (
          <Loader2 size={20} className="animate-spin" style={{ color: 'var(--servari-teal)', flexShrink: 0 }} />
        ) : succeeded ? (
          <CheckCircle2 size={20} style={{ color: 'var(--servari-green)', flexShrink: 0 }} />
        ) : failed ? (
          <XCircle size={20} style={{ color: 'var(--servari-red)', flexShrink: 0 }} />
        ) : (
          <Terminal size={20} style={{ color: 'var(--servari-dimmed)', flexShrink: 0 }} />
        )}

        {/* Task details */}
        <div className="flex-1 min-w-0">
          <div
            style={{
              color: 'var(--servari-ivory)',
              fontSize: '0.9375rem',
              marginBottom: '0.25rem',
            }}
          >
            {label}
          </div>
          <div
            style={{
              color: 'var(--servari-dimmed)',
              fontSize: '0.8125rem',
            }}
          >
            {running
              ? 'Running…'
              : result != null
                ? `Last run: exit ${result.exit ?? (result.ok ? 0 : '-')}`
                : 'Ready to run'}
          </div>
        </div>

        {/* Status badge (mirrors the export's active/pending pill) */}
        <div
          className="px-3 py-1 rounded-full text-xs uppercase"
          style={{
            background: failed ? 'rgba(248, 81, 73, 0.1)' : 'rgba(63, 185, 80, 0.1)',
            color: failed ? 'var(--servari-red)' : 'var(--servari-green)',
            border: failed ? '1px solid var(--servari-red)' : '1px solid var(--servari-green)',
            letterSpacing: '0.5px',
            flexShrink: 0,
          }}
        >
          {failed ? 'failed' : 'active'}
        </div>

        {/* Run button */}
        <button
          onClick={run}
          disabled={running}
          className="px-3 py-1.5 rounded-lg flex items-center gap-2 text-xs uppercase"
          style={{
            background: running ? 'rgba(20, 156, 150, 0.08)' : 'rgba(20, 156, 150, 0.14)',
            color: 'var(--servari-teal)',
            border: '1px solid var(--servari-teal)',
            letterSpacing: '0.5px',
            flexShrink: 0,
            cursor: running ? 'default' : 'pointer',
            opacity: running ? 0.6 : 1,
          }}
        >
          <Play size={13} />
          Run
        </button>
      </div>

      {/* Run output — real {exit, out}, sealed before render */}
      <AnimatePresence>
        {open && (running || sealedOut) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ borderTop: '1px solid rgba(250, 248, 243, 0.08)' }}
          >
            <pre
              style={{
                margin: 0,
                padding: '1rem',
                maxHeight: '20rem',
                overflow: 'auto',
                color: 'var(--servari-dimmed)',
                fontSize: '0.75rem',
                lineHeight: '1.6',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {running ? 'running…' : sealedOut}
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

  // --- The standing-order actions (real, allow-listed runners) ---
  const [actions, setActions] = useState<string[] | null>(null);
  const [actionsError, setActionsError] = useState<string | null>(null);

  // --- Optional per-agent brief panel (?agent=) ---
  const [brief, setBrief] = useState<AgentBriefResponse | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);

  // Load the real action list once.
  useEffect(() => {
    let alive = true;
    API.actions()
      .then((d) => {
        if (!alive) return;
        setActions(Array.isArray(d.actions) ? d.actions : []);
      })
      .catch((e) => {
        if (!alive) return;
        setActionsError(String(e));
        setActions([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Load the optional agent brief when ?agent= is present.
  useEffect(() => {
    if (!agent) {
      setBrief(null);
      setBriefError(null);
      return;
    }
    let alive = true;
    setBriefLoading(true);
    setBriefError(null);
    API.agentBrief(agent)
      .then((d) => {
        if (!alive) return;
        setBrief(d);
        setBriefLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setBriefError(String(e));
        setBriefLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agent]);

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="max-w-4xl mx-auto">
        <div
          className={agent ? "mb-2" : "mb-8"}
          style={{
            color: 'var(--servari-ivory)',
            fontSize: '1.5rem',
            letterSpacing: '1px',
          }}
        >
          STANDING ORDERS
        </div>
        {agent && (
          <div
            className="mb-8"
            style={{ color: 'var(--servari-teal)', fontSize: '0.875rem' }}
          >
            {sealLabel(labelFor(agent)) || labelFor(agent)}
          </div>
        )}

        {/* ---- Optional agent-brief panel (only when ?agent= is set) ---- */}
        {agent && briefLoading && (
          <div
            className="p-6 rounded-xl mb-8"
            style={{
              background: 'var(--servari-glass)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.875rem',
            }}
          >
            Loading standing orders for {sealLabel(labelFor(agent)) || labelFor(agent)}…
          </div>
        )}

        {agent && !briefLoading && briefError && (
          <div
            className="p-6 rounded-xl mb-8"
            style={{
              background: 'var(--servari-glass)',
              border: '1px solid rgba(248, 81, 73, 0.2)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.8125rem',
            }}
          >
            Brief unavailable: {briefError}
          </div>
        )}

        {agent && !briefLoading && !briefError && brief && brief.found && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-6 rounded-xl mb-8"
            style={{
              background: 'var(--servari-glass)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
            }}
          >
            <div className="flex items-center gap-3 mb-4">
              <FileText size={20} style={{ color: 'var(--servari-teal)', flexShrink: 0 }} />
              <div style={{ color: 'var(--servari-ivory)', fontSize: '1rem', fontWeight: 500 }}>
                Agent brief
              </div>
            </div>
            <pre
              style={{
                color: 'var(--servari-ivory)',
                fontSize: '0.8125rem',
                lineHeight: '1.6',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
                margin: 0,
              }}
            >
              {sealLabel(brief.brief)}
            </pre>
            {brief.path && (
              <div
                className="mt-4 pt-4"
                style={{
                  borderTop: '1px solid rgba(250, 248, 243, 0.08)',
                  color: 'var(--servari-dimmed)',
                  fontSize: '0.75rem',
                }}
              >
                {brief.path}
              </div>
            )}
          </motion.div>
        )}

        {agent && !briefLoading && !briefError && brief && !brief.found && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-6 rounded-xl mb-8"
            style={{
              background: 'var(--servari-glass)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.875rem',
              lineHeight: '1.6',
            }}
          >
            {sealLabel((brief as { note?: string }).note || "") ||
              `No standing orders written yet for ${sealLabel(labelFor(agent)) || labelFor(agent)}.`}
            {brief.path && (
              <div className="mt-2" style={{ fontSize: '0.75rem' }}>
                {brief.path}
              </div>
            )}
          </motion.div>
        )}

        {/* ---- The standing-order actions list (real /api/actions) ---- */}

        {/* Loading skeleton */}
        {actions === null && (
          <div
            className="p-6 rounded-xl"
            style={{
              background: 'var(--servari-glass)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
              color: 'var(--servari-dimmed)',
              fontSize: '0.875rem',
            }}
          >
            Loading standing orders…
          </div>
        )}

        {/* Error state */}
        {actions !== null && actionsError && actions.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-10 rounded-xl flex flex-col items-center text-center gap-4"
            style={{
              background: 'var(--servari-glass)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(248, 81, 73, 0.2)',
            }}
          >
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(248, 81, 73, 0.1)',
                border: '1px solid rgba(248, 81, 73, 0.2)',
              }}
            >
              <XCircle size={28} style={{ color: 'var(--servari-red)' }} />
            </div>
            <div style={{ color: 'var(--servari-ivory)', fontSize: '1.125rem', fontWeight: 500 }}>
              Standing orders unavailable
            </div>
            <div style={{ color: 'var(--servari-dimmed)', fontSize: '0.875rem', maxWidth: '28rem', lineHeight: '1.6' }}>
              {actionsError}
            </div>
          </motion.div>
        )}

        {/* Honest empty state — no actions configured */}
        {actions !== null && !actionsError && actions.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-10 rounded-xl flex flex-col items-center text-center gap-4"
            style={{
              background: 'var(--servari-glass)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(250, 248, 243, 0.08)',
            }}
          >
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(138, 148, 162, 0.1)',
                border: '1px solid rgba(138, 148, 162, 0.2)',
              }}
            >
              <Inbox size={28} style={{ color: 'var(--servari-dimmed)' }} />
            </div>
            <div style={{ color: 'var(--servari-ivory)', fontSize: '1.125rem', fontWeight: 500 }}>
              No standing orders configured
            </div>
            <div style={{ color: 'var(--servari-dimmed)', fontSize: '0.875rem', maxWidth: '28rem', lineHeight: '1.6' }}>
              When standing orders are defined they appear here, ready to run.
            </div>
          </motion.div>
        )}

        {/* The list */}
        {actions !== null && actions.length > 0 && (
          <div className="space-y-3">
            {actions.map((action, index) => (
              <OrderCard key={action} action={action} index={index} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
