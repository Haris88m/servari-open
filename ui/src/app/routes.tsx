import { Suspense, lazy } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { Shell } from "./components/Shell";
import { BootSequence } from "./components/BootSequence";
import { ChatStage } from "./components/ChatStage";
import { OsDashboard as DashboardView } from "./components/OsDashboard";
import { Company } from "./components/Company";
import { OrgChart } from "./components/OrgChart";
import { StandingOrders } from "./components/StandingOrders";
import { LaunchArc } from "./components/LaunchArc";
import { AutonomyDials } from "./components/AutonomyDials";
import { FastVerifyGates } from "./components/FastVerifyGates";
import { Retention } from "./components/Retention";
import { ContextPressure } from "./components/ContextPressure";
import { Health } from "./components/Health";
import { TokensPanel } from "./components/TokensPanel";
import { PersonalView } from "./components/PersonalView";
import { EngineRuntimeView } from "./components/EngineRuntimeView";
import { AgentApps } from "./components/AgentApps";
import { TradingDesk } from "./components/TradingDesk";
import { CvBuilder } from "./components/CvBuilder";
import { ModelSettingsView } from "./components/ModelSettingsView";
import { ProjectsWorkbench } from "./components/ProjectsWorkbench";

// AgentsView is lazy-loaded so this route file compiles even if the module
// lands slightly later in the build.
const AgentsView = lazy(() =>
  import("./components/AgentsView").then((m) => ({ default: m.AgentsView }))
);

// A minimal teal-tinted suspense fallback (no layout shift).
function StageFallback() {
  return (
    <div
      className="h-full flex items-center justify-center"
      style={{ color: "var(--servari-dimmed)", fontFamily: "var(--font-mono)", letterSpacing: "1px" }}
    >
      loading…
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <BootSequence />,
  },
  {
    path: "/shell",
    element: <Shell />,
    children: [
      { index: true, element: <DashboardView /> },
      { path: "chat", element: <ChatStage /> },
      { path: "agent-apps", element: <AgentApps /> },
      { path: "trading", element: <TradingDesk /> },
      { path: "cv-builder", element: <CvBuilder /> },
      { path: "projects", element: <ProjectsWorkbench /> },
      { path: "settings", element: <ModelSettingsView /> },
      {
        path: "agents",
        element: (
          <Suspense fallback={<StageFallback />}>
            <AgentsView />
          </Suspense>
        ),
      },
      { path: "company", element: <Company /> },
      { path: "org-chart", element: <OrgChart /> },
      { path: "standing-orders", element: <StandingOrders /> },
      { path: "launch-arc", element: <LaunchArc /> },
      { path: "autonomy-dials", element: <AutonomyDials /> },
      { path: "fast-verify", element: <FastVerifyGates /> },
      { path: "retention", element: <Retention /> },
      { path: "context-pressure", element: <ContextPressure /> },
      { path: "health", element: <Health /> },
      { path: "tokens", element: <TokensPanel /> },
      { path: "runtime", element: <EngineRuntimeView /> },
      { path: "engine", element: <Navigate to="/shell/runtime" replace /> },
      { path: "personal", element: <PersonalView /> },
    ],
  },
]);
