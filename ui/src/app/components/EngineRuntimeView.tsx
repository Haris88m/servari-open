import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Cpu,
  Play,
  Square,
  RotateCw,
  FileTerminal,
  RefreshCcw,
  ShieldCheck,
  MapPinned,
  X,
} from "lucide-react";
import { API, type EngineConfig, type EngineState } from "../lib/api";

type ControlMode = "idle" | "starting" | "stopping";

function formatStartedAt(raw: string | null): string {
  if (!raw) return "--";
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  return new Date(t).toLocaleString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function parseProbe(value: unknown): { ok: boolean; detail: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, detail: "not checked" };
  }
  const anyValue = value as Record<string, unknown>;
  const ok = anyValue.ok === true;
  if (ok) return { ok: true, detail: `${anyValue.status_code ?? ""}`.trim() || "ready" };
  const err = anyValue.error || anyValue.detail || "offline";
  return { ok: false, detail: String(err) };
}

export function EngineRuntimeView() {
  const [state, setState] = useState<EngineState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [mode, setMode] = useState<ControlMode>("idle");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [config, setConfig] = useState<EngineConfig>({
    home: "",
    host: "127.0.0.1",
    port: 7000,
    python: "",
    auth_enabled: true,
  });

  const load = async () => {
    try {
      const [statusResp, logsResp] = await Promise.all([API.engineStatus(), API.engineLogs(240)]);
      if (statusResp.ok && statusResp.status) {
        setState(statusResp.status);
        setConfig((cur) => ({
          ...cur,
          ...statusResp.status.config,
          auth_enabled:
            statusResp.status?.config?.auth_enabled !== undefined
              ? !!statusResp.status.config?.auth_enabled
              : cur.auth_enabled,
        }));
        setError("");
      } else {
        setError(statusResp.error || "runtime status unavailable");
      }
      if (logsResp.ok) {
        setLogs(logsResp.logs || []);
      }
    } catch {
      setError("runtime endpoints unavailable");
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const running = !!state?.running;
  const hasPid = Boolean(state?.pid);
  const cfgHome = state?.config?.home || config.home || "not set";
  const cfgHost = state?.config?.host || config.host || "127.0.0.1";
  const cfgPort = state?.config?.port || config.port || 7000;

  const stateSummary = useMemo(() => {
    if (!state) {
      return {
        label: "STATE WARMING",
        status: "waiting for first poll",
        color: "var(--s-status-warn)",
      };
    }
    if (state.running && hasPid) {
      return {
        label: `RUNNING PID ${state.pid}`,
        status: `started ${formatStartedAt(state.started_at)}`,
        color: "var(--s-status-ok)",
      };
    }
    if (state.running) {
      return {
        label: "MANAGED (stale)",
        status: "managed process died",
        color: "var(--s-status-warn)",
      };
    }
    return {
      label: "STOPPED",
      status: state.started_at ? `last run ${formatStartedAt(state.started_at)}` : "ready for startup",
      color: "var(--s-text-secondary)",
    };
  }, [state, hasPid]);

  const probeReady = parseProbe(state?.probe_ready);
  const probeHealth = parseProbe(state?.probe_health);

  const runAction = async (type: "start" | "stop" | "restart") => {
    setMode(type === "stop" ? "stopping" : "starting");
    setMsg("");
    setError("");
    try {
      let resp: Awaited<ReturnType<typeof API.engineStart>>;
      if (type === "start") {
        resp = await API.engineStart(config);
      } else if (type === "restart") {
        resp = await API.engineRestart(config);
      } else {
        resp = await API.engineStop();
      }
      if (resp.ok) {
        setMsg(resp.message || `${type} accepted`);
      } else {
        setError(resp.error || `${type} failed`);
      }
      await load();
    } catch {
      setError(`${type} failed`);
    } finally {
      setMode("idle");
    }
  };

  const handleChange = (field: keyof EngineConfig, value: string | boolean | number) => {
    setConfig((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const safePort = (value: string) => {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : "";
  };

  const actionsBusy = mode !== "idle";

  return (
    <div className="h-full p-8 overflow-auto">
      <div className="max-w-6xl mx-auto space-y-6">
        <motion.div
          className="flex items-start justify-between gap-4 rounded-xl p-4"
          style={{
            border: "1px solid rgba(20, 156, 150, 0.3)",
            background: "linear-gradient(130deg, rgba(20,156,150,0.12), rgba(15,18,24,0.75))",
            boxShadow: "var(--s-glow-primary)",
          }}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="flex items-center gap-3">
            <div
              className="grid place-items-center rounded-lg"
              style={{
                width: 36,
                height: 36,
                border: "1px solid rgba(20,156,150,0.45)",
                background: "rgba(15,18,24,0.5)",
              }}
            >
              <Cpu size={20} style={{ color: "var(--servari-teal)" }} />
            </div>
            <div>
              <div style={{ color: "var(--servari-ivory)", fontSize: "1.35rem", letterSpacing: "0.06em" }}>
                SERVARI RUNTIME
              </div>
              <div style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)", letterSpacing: "var(--ls-wide)" }}>
                managed runtime service, local subprocess control plane
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => load()}
            className="rounded-lg px-3 py-2 text-xs inline-flex items-center gap-2"
            style={{
              border: "1px solid var(--s-edge-subtle)",
              color: "var(--s-text-primary)",
              background: "rgba(250, 248, 243, 0.04)",
              opacity: actionsBusy ? 0.6 : 1,
            }}
            disabled={actionsBusy}
          >
            <RefreshCcw size={13} />
            sync status
          </button>
        </motion.div>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl overflow-hidden"
            style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}
          >
            <div className="p-4 border-b" style={{ borderColor: "rgba(250, 248, 243, 0.08)" }}>
              <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
                <span style={{ color: "var(--s-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--t-12)" }}>
                  CONTROL SURFACE
                </span>
                <div
                  className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full"
                  style={{
                    border: "1px solid rgba(250, 248, 243, 0.15)",
                    color: stateSummary.color,
                    background: "rgba(250, 248, 243, 0.06)",
                    fontSize: "var(--t-11)",
                  }}
                >
                  <span
                    className="inline-block rounded-full"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "9999px",
                      background: stateSummary.color,
                      boxShadow: `0 0 10px ${stateSummary.color}88`,
                    }}
                  />
                  {stateSummary.label}
                </div>
              </div>

              <div className="mt-3 rounded-lg px-3 py-2" style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass)" }}>
                <div className="text-xs" style={{ color: "var(--s-text-secondary)" }}>
                  HEALTH SNAPSHOT
                </div>
                <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2" style={{ fontSize: "var(--t-11)" }}>
                  <div className="rounded-lg px-2 py-1.5" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}>
                    <span style={{ color: "var(--s-text-secondary)" }}>READY probe</span>
                    <span
                      className="float-right"
                      style={{
                        color: probeReady.ok ? "var(--s-status-ok)" : "var(--s-status-error)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {running ? probeReady.detail : "off"}
                    </span>
                  </div>
                  <div className="rounded-lg px-2 py-1.5" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}>
                    <span style={{ color: "var(--s-text-secondary)" }}>HEALTH check</span>
                    <span
                      className="float-right"
                      style={{
                        color: probeHealth.ok ? "var(--s-status-ok)" : "var(--s-status-error)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {running ? probeHealth.detail : "off"}
                    </span>
                  </div>
                  <div style={{ color: "var(--s-text-secondary)" }}>
                    pid / home
                  </div>
                  <div className="text-right" style={{ color: "var(--s-text-primary)" }}>
                    {(state?.pid ?? "n/a")} | {cfgHome}
                  </div>
                  <div style={{ color: "var(--s-text-secondary)" }}>
                    endpoint
                  </div>
                  <div className="text-right" style={{ color: "var(--s-text-primary)" }}>
                    {cfgHost}:{cfgPort}
                  </div>
                  <div style={{ color: "var(--s-text-secondary)" }}>
                    runtime state
                  </div>
                  <div className="text-right" style={{ color: "var(--s-text-primary)" }}>
                    {stateSummary.status}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-2">
                <label htmlFor="runtime-home" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}>
                  Runtime workspace path
                </label>
                <input
                  id="runtime-home"
                  value={config.home || ""}
                  onChange={(e) => handleChange("home", e.target.value)}
                  placeholder="C:\\path\\to\\runtime-workspace"
                  className="rounded-lg px-3 py-2 outline-none"
                  style={{
                    border: "1px solid var(--s-edge-subtle)",
                    background: "rgba(250, 248, 243, 0.04)",
                    color: "var(--s-text-primary)",
                  }}
                />
              </div>

              <div className="mt-3 grid gap-2 grid-cols-1 sm:grid-cols-3">
                <label className="block">
                  <span style={{ color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}>Host</span>
                  <input
                    value={config.host || ""}
                    onChange={(e) => handleChange("host", e.target.value)}
                    className="mt-1 block w-full rounded-lg px-3 py-2 outline-none"
                    style={{
                      border: "1px solid var(--s-edge-subtle)",
                      background: "rgba(250, 248, 243, 0.04)",
                      color: "var(--s-text-primary)",
                    }}
                  />
                </label>
                <label className="block">
                  <span style={{ color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}>Port</span>
                  <input
                    value={config.port ?? ""}
                    onChange={(e) => handleChange("port", safePort(e.target.value))}
                    className="mt-1 block w-full rounded-lg px-3 py-2 outline-none"
                    style={{
                      border: "1px solid var(--s-edge-subtle)",
                      background: "rgba(250, 248, 243, 0.04)",
                      color: "var(--s-text-primary)",
                    }}
                  />
                </label>
                <label className="block">
                  <span style={{ color: "var(--s-text-primary)", fontSize: "var(--t-12)" }}>Python</span>
                  <input
                    value={config.python || ""}
                    onChange={(e) => handleChange("python", e.target.value)}
                    className="mt-1 block w-full rounded-lg px-3 py-2 outline-none"
                    style={{
                      border: "1px solid var(--s-edge-subtle)",
                      background: "rgba(250, 248, 243, 0.04)",
                      color: "var(--s-text-primary)",
                    }}
                  />
                </label>
              </div>

              <label className="mt-3 flex items-center gap-2 text-sm" style={{ color: "var(--s-text-secondary)" }}>
                <input
                  type="checkbox"
                  checked={!!config.auth_enabled}
                  onChange={(e) => handleChange("auth_enabled", e.target.checked)}
                />
                Enforce service auth
              </label>
            </div>

            <div className="p-4 border-t" style={{ borderColor: "rgba(250, 248, 243, 0.08)" }}>
              <div className="flex flex-wrap gap-2">
                <motion.button
                  type="button"
                  onClick={() => runAction("start")}
                  disabled={actionsBusy || running}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.98 }}
                  className="rounded-lg px-3 py-2 inline-flex items-center gap-2 text-sm"
                  style={{
                    minWidth: 112,
                    border: "1px solid var(--s-status-ok)",
                    color: "var(--s-status-ok)",
                    background: "rgba(63, 185, 80, 0.12)",
                    opacity: actionsBusy || running ? 0.65 : 1,
                  }}
                >
                  <Play size={14} />
                  {actionsBusy ? "Starting..." : "Start Runtime"}
                </motion.button>

                <motion.button
                  type="button"
                  onClick={() => runAction("stop")}
                  disabled={actionsBusy || !running}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.98 }}
                  className="rounded-lg px-3 py-2 inline-flex items-center gap-2 text-sm"
                  style={{
                    minWidth: 112,
                    border: "1px solid var(--s-status-error)",
                    color: "var(--s-status-error)",
                    background: "rgba(248, 81, 73, 0.12)",
                    opacity: actionsBusy || !running ? 0.65 : 1,
                  }}
                >
                  <Square size={14} />
                  {actionsBusy ? "Stopping..." : "Stop Runtime"}
                </motion.button>

                <motion.button
                  type="button"
                  onClick={() => runAction("restart")}
                  disabled={actionsBusy || !state}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.98 }}
                  className="rounded-lg px-3 py-2 inline-flex items-center gap-2 text-sm"
                  style={{
                    minWidth: 112,
                    border: "1px solid var(--servari-teal)",
                    color: "var(--servari-teal)",
                    background: "rgba(20, 156, 150, 0.12)",
                    opacity: actionsBusy || !state ? 0.65 : 1,
                  }}
                >
                  <RotateCw size={14} />
                  {actionsBusy ? "Restarting..." : "Restart"}
                </motion.button>
              </div>

              {msg && <div style={{ color: "var(--s-status-ok)", fontSize: "var(--t-12)", marginTop: 10 }}>{msg}</div>}
              {error && <div style={{ color: "var(--s-status-error)", fontSize: "var(--t-12)", marginTop: 10 }}>{error}</div>}
            </div>
          </motion.div>

          <div className="space-y-4">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl p-4 overflow-hidden"
              style={{
                border: "1px solid var(--s-edge-subtle)",
                background: "var(--s-glass-light)",
              }}
            >
              <div className="flex items-center justify-between">
                <div className="inline-flex items-center gap-2" style={{ color: "var(--s-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--t-12)" }}>
                  <MapPinned size={14} /> OPS
                </div>
                <div className="inline-flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLogs([])}
                    className="rounded-lg px-2 py-1 text-xs"
                    style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-secondary)", background: "rgba(250, 248, 243, 0.04)" }}
                  >
                    <span className="inline-flex items-center gap-1">
                      <X size={12} /> clear
                    </span>
                  </button>
                </div>
              </div>
              <p style={{ color: "var(--s-text-primary)", fontSize: "var(--t-12)", marginTop: 10 }}>
                Runtime operations metadata, local probes, and config notes for one place to tune startup.
              </p>
              <ul
                className="mt-3 space-y-2"
                style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}
              >
                <li className="rounded-lg px-2 py-1.5 border" style={{ borderColor: "var(--s-edge-subtle)" }}>
                  Host: {cfgHost} | Port: {cfgPort}
                </li>
                <li className="rounded-lg px-2 py-1.5 border" style={{ borderColor: "var(--s-edge-subtle)" }}>
                  Python: {state?.config?.python || config.python || "default"}
                </li>
                <li className="rounded-lg px-2 py-1.5 border" style={{ borderColor: "var(--s-edge-subtle)" }}>
                  Auth token: {config.auth_enabled ? "enabled" : "disabled"}
                </li>
              </ul>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl overflow-hidden"
              style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass)" }}
            >
              <div className="px-4 py-3 border-b" style={{ borderColor: "rgba(250, 248, 243, 0.1)" }}>
                <div className="flex items-center gap-2" style={{ color: "var(--s-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--t-12)" }}>
                  <FileTerminal size={14} /> LIVE LOGS
                </div>
              </div>
              <div className="p-3">
                <pre
                  className="w-full rounded-lg p-3 text-xs leading-5 overflow-auto"
                  style={{
                    minHeight: 260,
                    background: "rgba(2, 10, 14, 0.65)",
                    border: "1px solid var(--s-edge-subtle)",
                    color: "var(--s-text-secondary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {logs.length ? logs.join("\n") : "No logs yet"}
                </pre>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl p-4"
              style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250, 248, 243, 0.02)" }}
            >
              <div className="inline-flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)" }}>
                <ShieldCheck size={14} />
                Safety note
              </div>
              <p style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-12)", marginTop: 6 }}>
                SERVARI Runtime controls only start local processes under the active Servari home/workspace.
                Endpoints are served on localhost and are never forwarded to your remote devices.
              </p>
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default EngineRuntimeView;
