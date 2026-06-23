import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { motion } from "motion/react";
import { BarChart3, Bot, BriefcaseBusiness, FileText, Network, Settings, Workflow } from "lucide-react";
import { API, type AgentMapResponse } from "../lib/api";
import { COMPOSED, SNAPPY, staggerItem } from "../lib/motion";

const APPS = [
  { id: "agent-map", label: "Agent Neural Map", path: "/shell/org-chart", icon: Network, detail: "Edit profiles, runtime, and START.md files." },
  { id: "trading", label: "Trading Desk", path: "/shell/trading", icon: BarChart3, detail: "Research-only market workflows and risk gates." },
  { id: "cv-builder", label: "CV Builder", path: "/shell/cv-builder", icon: FileText, detail: "Career profile, jobs, applications, and resume preview." },
  { id: "projects", label: "Project Studio", path: "/shell/projects", icon: Workflow, detail: "Delivery, platform, product, and paid project lanes." },
  { id: "settings", label: "Settings", path: "/shell/settings", icon: Settings, detail: "Codex, Claude, Hermes, OpenClaw, API, and themes." },
];

function countFor(data: AgentMapResponse | null, appId: string): number {
  return (data?.agents || []).filter((agent) => (agent.dashboard_ids || []).includes(appId)).length;
}

export function AgentApps() {
  const navigate = useNavigate();
  const [data, setData] = useState<AgentMapResponse | null>(null);

  useEffect(() => {
    let alive = true;
    API.agentMap()
      .then((next) => {
        if (alive) setData(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const groupRows = useMemo(() => (data?.groups || []).filter((group) => Number(group.count || 0) > 0), [data]);

  return (
    <div className="h-full overflow-auto p-4 md:p-6 xl:p-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <motion.header
          className="rounded-lg px-4 py-4"
          style={{ border: "1px solid var(--s-edge-accent)", background: "var(--s-glass-light)" }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={COMPOSED}
        >
          <div className="mb-1 flex items-center gap-2" style={{ color: "var(--s-text-teal)", fontSize: "var(--t-11)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
            <Bot size={15} />
            Agent apps
          </div>
          <h1 style={{ color: "var(--s-text-primary)", fontSize: "var(--t-24)", fontWeight: 780, letterSpacing: 0 }}>
            Capability workbench
          </h1>
        </motion.header>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {APPS.map((app, index) => {
            const Icon = app.icon;
            const count = app.id === "agent-map" ? data?.agents?.length || 0 : countFor(data, app.id);
            return (
              <motion.button
                key={app.id}
                type="button"
                onClick={() => navigate(app.path)}
                className="min-h-[170px] rounded-lg p-4 text-left"
                style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}
                whileHover={{ y: -3, borderColor: "var(--s-edge-accent)", backgroundColor: "var(--s-hover-bg)" }}
                transition={SNAPPY}
                {...staggerItem(index)}
              >
                <Icon size={22} style={{ color: "var(--s-text-teal)" }} />
                <div className="mt-4" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-16)", fontWeight: 750 }}>
                  {app.label}
                </div>
                <div className="mt-2" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)", lineHeight: 1.45 }}>
                  {app.detail}
                </div>
                <div className="mt-4" style={{ color: "var(--s-text-teal-soft)", fontFamily: "var(--font-mono)", fontSize: "var(--t-11)" }}>
                  {count} linked agents
                </div>
              </motion.button>
            );
          })}
        </div>

        <section className="rounded-lg" style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}>
          <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)", fontWeight: 750 }}>
            <BriefcaseBusiness size={16} style={{ color: "var(--s-text-teal)" }} />
            Agent groups
          </div>
          <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-4">
            {groupRows.map((group, index) => (
              <motion.div key={group.id} className="rounded-lg px-3 py-3" style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }} {...staggerItem(index)}>
                <div style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 700 }}>{group.label}</div>
                <div className="mt-1" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>{group.count || 0} profiles</div>
              </motion.div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default AgentApps;
