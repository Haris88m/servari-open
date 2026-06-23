import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { ClipboardList, GitPullRequest, ShieldCheck, Workflow } from "lucide-react";
import { API, type AgentMapResponse, type AgentWorkflow } from "../lib/api";
import { COMPOSED, staggerItem } from "../lib/motion";

function stateColor(state: string): string {
  if (state === "done") return "var(--s-status-ok)";
  if (state === "review") return "var(--s-text-teal-soft)";
  if (state === "blocked") return "var(--s-status-error)";
  if (state === "working") return "var(--s-status-warn)";
  return "var(--s-text-secondary)";
}

export function ProjectsWorkbench() {
  const [workflows, setWorkflows] = useState<AgentWorkflow[]>([]);
  const [map, setMap] = useState<AgentMapResponse | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([API.agentWorkflows(), API.agentMap().catch(() => null)]).then(([wf, nextMap]) => {
      if (!alive) return;
      setWorkflows(wf.workflows || []);
      if (nextMap) setMap(nextMap);
    });
    return () => {
      alive = false;
    };
  }, []);

  const projectAgents = useMemo(
    () => (map?.agents || []).filter((agent) => (agent.dashboard_ids || []).includes("projects")),
    [map],
  );
  const reviewSteps = workflows.flatMap((wf) => wf.steps.map((step) => ({ ...step, workflowTitle: wf.title }))).filter((step) => step.state === "review" || step.gate);

  return (
    <div className="h-full overflow-auto p-4 md:p-6 xl:p-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <motion.header className="rounded-lg px-4 py-4" style={{ border: "1px solid var(--s-edge-accent)", background: "var(--s-glass-light)" }} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={COMPOSED}>
          <div className="mb-1 flex items-center gap-2" style={{ color: "var(--s-text-teal)", fontSize: "var(--t-11)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
            <Workflow size={15} />
            Project studio
          </div>
          <h1 style={{ color: "var(--s-text-primary)", fontSize: "var(--t-24)", fontWeight: 780, letterSpacing: 0 }}>Workflow lanes, gates, and delivery agents</h1>
        </motion.header>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}>
            <Workflow size={18} style={{ color: "var(--s-text-teal)" }} />
            <div className="mt-3" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-20)", fontWeight: 780 }}>{workflows.length}</div>
            <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>workflow lanes</div>
          </div>
          <div className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}>
            <GitPullRequest size={18} style={{ color: "var(--s-status-warn)" }} />
            <div className="mt-3" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-20)", fontWeight: 780 }}>{reviewSteps.length}</div>
            <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>review and gate steps</div>
          </div>
          <div className="rounded-lg p-4" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}>
            <ClipboardList size={18} style={{ color: "var(--s-status-ok)" }} />
            <div className="mt-3" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-20)", fontWeight: 780 }}>{projectAgents.length}</div>
            <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>project agents</div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {workflows.map((workflow, index) => (
            <motion.section key={workflow.id} className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }} {...staggerItem(index)}>
              <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--s-edge-subtle)" }}>
                <div style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>{workflow.title}</div>
                <div className="mt-1" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>{workflow.status}</div>
              </div>
              {workflow.steps.map((step) => (
                <div key={step.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--s-edge-subtle)" }}>
                  <span className="mt-1 h-2.5 w-2.5 rounded-full" style={{ background: stateColor(step.state) }} />
                  <div className="min-w-0">
                    <div className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 700 }}>{step.label}</div>
                    <div className="mt-1 line-clamp-2" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)", lineHeight: 1.45 }}>{step.summary}</div>
                  </div>
                  {step.gate ? <ShieldCheck size={15} style={{ color: "var(--s-status-warn)" }} /> : <span style={{ color: stateColor(step.state), fontSize: "var(--t-10)", textTransform: "uppercase" }}>{step.state}</span>}
                </div>
              ))}
            </motion.section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ProjectsWorkbench;
