import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, CircleAlert, Clock3, ShieldCheck, Workflow } from "lucide-react";
import { API, type AgentWorkflow } from "../lib/api";
import { sealLabel } from "../lib/display_seal";

const STATE_STYLE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  ready: {
    label: "READY",
    color: "var(--servari-dimmed)",
    bg: "rgba(250, 248, 243, 0.035)",
    border: "rgba(250, 248, 243, 0.08)",
  },
  working: {
    label: "WORKING",
    color: "var(--servari-teal)",
    bg: "rgba(20, 156, 150, 0.09)",
    border: "rgba(20, 156, 150, 0.28)",
  },
  review: {
    label: "REVIEW",
    color: "var(--servari-amber)",
    bg: "rgba(224, 169, 42, 0.08)",
    border: "rgba(224, 169, 42, 0.26)",
  },
  blocked: {
    label: "BLOCKED",
    color: "var(--servari-red)",
    bg: "rgba(248, 81, 73, 0.08)",
    border: "rgba(248, 81, 73, 0.3)",
  },
  done: {
    label: "DONE",
    color: "var(--servari-green)",
    bg: "rgba(63, 185, 80, 0.08)",
    border: "rgba(63, 185, 80, 0.28)",
  },
};

function stateStyle(state: string) {
  return STATE_STYLE[state] || STATE_STYLE.ready;
}

function stateIcon(state: string) {
  if (state === "done") return Check;
  if (state === "blocked") return CircleAlert;
  if (state === "review") return ShieldCheck;
  return Clock3;
}

function display(text: string): string {
  return sealLabel(text) || text;
}

export function AgentWorkflowStrip() {
  const [workflows, setWorkflows] = useState<AgentWorkflow[]>([]);
  const [note, setNote] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      API.agentWorkflows()
        .then((res) => {
          if (!alive) return;
          setWorkflows(Array.isArray(res.workflows) ? res.workflows : []);
          setNote(res.note || "");
          setReady(true);
        })
        .catch((e) => {
          if (!alive) return;
          setNote(String(e));
          setReady(true);
        });
    load();
    const id = setInterval(load, 7000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!ready) {
    return (
      <div
        className="rounded-xl px-4 py-3 font-mono text-[0.65rem]"
        style={{ color: "var(--servari-dimmed)", border: "1px solid rgba(250,248,243,0.08)" }}
      >
        loading workflow lanes...
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div
        className="rounded-xl px-4 py-3 font-mono text-[0.65rem]"
        style={{ color: "var(--servari-dimmed)", border: "1px solid rgba(250,248,243,0.08)" }}
      >
        {note || "no workflow lanes registered"}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {workflows.map((workflow, wi) => (
        <motion.section
          key={workflow.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: wi * 0.06, duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-xl overflow-hidden"
          style={{
            background: "var(--servari-glass)",
            border: "1px solid rgba(250,248,243,0.08)",
            backdropFilter: "blur(18px)",
          }}
        >
          <div
            className="px-4 py-3 flex items-center gap-3"
            style={{ borderBottom: "1px solid rgba(250,248,243,0.06)" }}
          >
            <Workflow size={16} style={{ color: "var(--servari-teal)" }} />
            <div className="min-w-0 flex-1">
              <div
                className="truncate"
                style={{ color: "var(--servari-ivory)", fontSize: "0.84rem", fontWeight: 600 }}
                title={display(workflow.title)}
              >
                {display(workflow.title)}
              </div>
              <div
                className="truncate font-mono text-[0.62rem] uppercase tracking-widest"
                style={{ color: "var(--servari-dimmed)" }}
              >
                {display(workflow.status)}
              </div>
            </div>
          </div>

          <div className="px-3 py-3 grid grid-cols-1 md:grid-cols-2 gap-2">
            {workflow.steps.map((step, i) => {
              const style = stateStyle(step.state);
              const Icon = stateIcon(step.state);
              const active = workflow.current_step === step.id;
              return (
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.08 + i * 0.035, duration: 0.2 }}
                  className="rounded-lg px-3 py-2"
                  style={{
                    background: style.bg,
                    border: active ? `1px solid ${style.color}` : `1px solid ${style.border}`,
                    boxShadow: active ? "0 0 18px rgba(20,156,150,0.18)" : "none",
                  }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon size={13} style={{ color: style.color }} />
                    <span
                      className="truncate flex-1"
                      style={{ color: "var(--servari-ivory)", fontSize: "0.75rem", fontWeight: 600 }}
                      title={display(step.label)}
                    >
                      {display(step.label)}
                    </span>
                    <span
                      className="font-mono text-[0.55rem] uppercase tracking-widest"
                      style={{ color: style.color }}
                    >
                      {style.label}
                    </span>
                  </div>
                  <div
                    className="font-mono text-[0.6rem] uppercase tracking-widest mb-1"
                    style={{ color: "var(--servari-teal-soft)" }}
                  >
                    {display(step.owner)}
                  </div>
                  <div
                    className="line-clamp-2"
                    style={{ color: "var(--servari-dimmed)", fontSize: "0.68rem", lineHeight: 1.35 }}
                  >
                    {display(step.summary)}
                  </div>
                  {step.gate && (
                    <div
                      className="mt-2 inline-flex rounded px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-widest"
                      style={{
                        color: "var(--servari-amber)",
                        border: "1px solid rgba(224,169,42,0.26)",
                        background: "rgba(224,169,42,0.08)",
                      }}
                    >
                      {display(step.gate)}
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        </motion.section>
      ))}
    </div>
  );
}

export default AgentWorkflowStrip;
