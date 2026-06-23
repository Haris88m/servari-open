import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  CheckCircle2,
  Cpu,
  ExternalLink,
  KeyRound,
  Loader2,
  PlayCircle,
  Save,
  Settings,
  Terminal,
  XCircle,
} from "lucide-react";
import { API, type ModelConfigResponse, type ModelProviderStatus } from "../lib/api";
import { COMPOSED, SNAPPY } from "../lib/motion";

const BACKENDS = ["auto", "api", "codex", "claude", "hermes", "openclaw"];
const THEMES = [
  { id: "default", label: "Deep Teal" },
  { id: "graphite", label: "Graphite" },
  { id: "ember", label: "Ember" },
];
const CLI_IDS = ["codex", "claude", "hermes", "openclaw"] as const;
type CliId = (typeof CLI_IDS)[number];
type CliAction = "session" | "login" | "configure" | "dashboard" | "doctor";

interface CliFormValue {
  enabled: boolean;
  binary: string;
  oneShot: string;
}


const CLI_ACTIONS: Record<CliId, Array<{ action: CliAction; label: string }>> = {
  codex: [
    { action: "login", label: "Login" },
    { action: "session", label: "Open" },
    { action: "doctor", label: "Doctor" },
  ],
  claude: [
    { action: "login", label: "Open/Login" },
  ],
  hermes: [
    { action: "session", label: "Open" },
  ],
  openclaw: [
    { action: "configure", label: "Configure" },
    { action: "session", label: "Chat" },
    { action: "dashboard", label: "Dashboard" },
    { action: "doctor", label: "Doctor" },
  ],
};

const DEFAULT_CLI_BINARY: Record<CliId, string> = {
  codex: "codex",
  claude: "claude",
  hermes: "hermes",
  openclaw: "openclaw",
};

const DEFAULT_CLI_ARGS: Record<CliId, string> = {
  codex: "built-in Codex exec harness",
  claude: "built-in Claude print harness",
  hermes: "--oneshot {prompt}",
  openclaw: "agent --local --json --agent main --message {prompt}",
};

function backendLabel(id: string): string {
  if (id === "api") return "OpenAI-compatible API";
  if (id === "codex") return "OpenAI Codex CLI";
  if (id === "claude") return "Claude CLI";
  if (id === "hermes") return "Hermes CLI";
  if (id === "openclaw") return "OpenClaw CLI";
  if (id === "none") return "No ready backend";
  return "Auto";
}

function normalizeTheme(raw: string | undefined): string {
  return raw === "graphite" || raw === "ember" ? raw : "default";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function testResultMessage(result: { ok?: boolean; error?: string; result?: unknown }): string {
  const nested = result.result && typeof result.result === "object" ? (result.result as Record<string, unknown>) : {};
  if (result.ok) return "Backend test completed.";
  return String(nested.error || result.error || "Backend test failed.");
}

function defaultCliForm(): Record<CliId, CliFormValue> {
  return CLI_IDS.reduce(
    (acc, id) => ({
      ...acc,
      [id]: {
        enabled: true,
        binary: DEFAULT_CLI_BINARY[id],
        oneShot: DEFAULT_CLI_ARGS[id],
      },
    }),
    {} as Record<CliId, CliFormValue>,
  );
}

function argLine(args: unknown): string {
  return Array.isArray(args) ? args.map((item) => String(item)).join(" ") : "";
}

function parseArgLine(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of raw.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function buildCliForm(status: ModelConfigResponse): Record<CliId, CliFormValue> {
  const next = defaultCliForm();
  const cliCfg = status.config.cli || {};
  for (const id of CLI_IDS) {
    const cfg = cliCfg[id] || {};
    const provider = status.cli?.[id] || status.providers.find((item) => item.id === id);
    next[id] = {
      enabled: cfg.enabled !== false,
      binary: cfg.binary || provider?.binary || DEFAULT_CLI_BINARY[id],
      oneShot: argLine(cfg.one_shot_args) || DEFAULT_CLI_ARGS[id],
    };
  }
  return next;
}

function buildCliPayload(cliConfig: Record<CliId, CliFormValue>): Record<string, unknown> {
  return CLI_IDS.reduce((acc, id) => {
    const value = cliConfig[id];
    const row: Record<string, unknown> = {
      enabled: value.enabled,
      binary: value.binary.trim() || DEFAULT_CLI_BINARY[id],
    };
    if (id === "hermes" || id === "openclaw") {
      const parsed = parseArgLine(value.oneShot || DEFAULT_CLI_ARGS[id]);
      row.one_shot_args = parsed.length ? parsed : parseArgLine(DEFAULT_CLI_ARGS[id]);
    }
    acc[id] = row;
    return acc;
  }, {} as Record<string, unknown>);
}

function CliEditorRow({
  id,
  provider,
  value,
  onChange,
  onAction,
  busyAction,
}: {
  id: CliId;
  provider?: ModelProviderStatus;
  value: CliFormValue;
  onChange: (patch: Partial<CliFormValue>) => void;
  onAction: (id: CliId, action: CliAction) => void;
  busyAction: string;
}) {
  const ready = Boolean(provider?.available);
  const supportsArgs = id === "hermes" || id === "openclaw";
  return (
    <div
      className="grid gap-3 rounded-lg px-3 py-3"
      style={{ border: "1px solid var(--s-edge-subtle)", background: "rgba(250,248,243,0.025)" }}
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
        {ready ? (
          <CheckCircle2 size={16} style={{ color: "var(--s-status-ok)" }} />
        ) : (
          <XCircle size={16} style={{ color: "var(--s-text-secondary)" }} />
        )}
        <div className="min-w-0">
          <div className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-13)", fontWeight: 700 }}>
            {provider?.label || backendLabel(id)}
          </div>
          <div className="truncate" style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>
            {provider?.path || provider?.binary || value.binary}
          </div>
        </div>
        <span
          className="rounded-full px-2 py-1"
          style={{
            border: `1px solid ${ready ? "rgba(63,185,80,0.35)" : "var(--s-edge-subtle)"}`,
            color: ready ? "var(--s-status-ok)" : "var(--s-text-secondary)",
            fontSize: "var(--t-10)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
          }}
        >
          {ready ? "ready" : "missing"}
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-[auto_1fr]">
        <label className="inline-flex h-10 items-center gap-2 rounded-lg px-3" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>
          <input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
          Enabled
        </label>
        <label className="grid gap-1">
          <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Binary</span>
          <input value={value.binary} onChange={(event) => onChange({ binary: event.target.value })} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }} />
        </label>
      </div>
      <label className="grid gap-1">
        <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>One-shot args</span>
        <input
          value={supportsArgs ? value.oneShot : DEFAULT_CLI_ARGS[id]}
          onChange={(event) => onChange({ oneShot: event.target.value })}
          disabled={!supportsArgs}
          className="rounded-lg px-3 py-2 outline-none disabled:opacity-60"
          style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {CLI_ACTIONS[id].map((item) => {
          const busy = busyAction === `${id}:${item.action}`;
          return (
            <button
              key={item.action}
              type="button"
              onClick={() => onAction(id, item.action)}
              disabled={busy}
              className="inline-flex h-8 items-center gap-2 rounded-lg px-2 disabled:opacity-45"
              title={ready ? `${item.label} ${provider?.label || backendLabel(id)}` : `Binary not detected yet; save a valid path for ${backendLabel(id)} if this fails.`}
              style={{
                border: "1px solid rgba(20,156,150,0.35)",
                color: ready ? "var(--s-text-teal)" : "var(--s-text-secondary)",
                background: ready ? "rgba(20,156,150,0.08)" : "rgba(250,248,243,0.03)",
                fontSize: "var(--t-11)",
              }}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ModelSettingsView() {
  const [status, setStatus] = useState<ModelConfigResponse | null>(null);
  const [backend, setBackend] = useState("auto");
  const [provider, setProvider] = useState("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("OPENAI_API_KEY");
  const [theme, setTheme] = useState("default");
  const [cliConfig, setCliConfig] = useState<Record<CliId, CliFormValue>>(() => defaultCliForm());
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [providerBusy, setProviderBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await API.modelConfig();
      const nextTheme = normalizeTheme(next.config.theme);
      setStatus(next);
      setBackend(next.config.backend || next.selected_backend || "auto");
      setProvider(next.config.provider || "openai-compatible");
      setBaseUrl(next.config.base_url || "");
      setModel(next.config.model || "");
      setWorkspace(next.config.workspace_home || next.workspace_home || "");
      setApiKeyEnv(next.config.api_key_env || "OPENAI_API_KEY");
      setTheme(nextTheme);
      setCliConfig(buildCliForm(next));
      document.documentElement.setAttribute("data-servari-theme", nextTheme === "default" ? "" : nextTheme);
    } catch (error) {
      setMessage(`Settings unavailable: ${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = status?.providers || [];
  const cliProviders = useMemo(() => providers.filter((p) => !["auto", "api"].includes(p.id)), [providers]);
  const effective = status?.effective_backend || "pending";

  const save = useCallback(async () => {
    setSaving(true);
    setMessage("");
    try {
      const next = await API.saveModelConfig({
        backend,
        provider,
        base_url: baseUrl,
        model,
        workspace_home: workspace,
        api_key_env: apiKeyEnv,
        theme,
        cli: buildCliPayload(cliConfig),
      });
      setStatus(next);
      document.documentElement.setAttribute("data-servari-theme", theme === "default" ? "" : theme);
      setMessage(next.error ? String(next.error) : "Settings saved.");
    } catch (error) {
      setMessage(`Save failed: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }, [apiKeyEnv, backend, baseUrl, cliConfig, model, provider, theme, workspace]);

  const updateCliConfig = useCallback((id: CliId, patch: Partial<CliFormValue>) => {
    setCliConfig((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }, []);

  const runCliAction = useCallback(async (id: CliId, action: CliAction) => {
    const key = `${id}:${action}`;
    setProviderBusy(key);
    setMessage("");
    try {
      const result = await API.cliProviderAction(id, action);
      setMessage(result.ok ? `${backendLabel(id)} ${action} launched.` : `${backendLabel(id)} ${action} failed: ${String(result.error || "unknown error")}`);
    } catch (error) {
      setMessage(`${backendLabel(id)} ${action} failed: ${errorMessage(error)}`);
    } finally {
      setProviderBusy("");
      void load();
    }
  }, [load]);

  const saveSecret = useCallback(async () => {
    if (!secret.trim()) return;
    setSaving(true);
    try {
      await API.setModelSecret("set", secret.trim());
      setSecret("");
      setMessage("API key replaced. It will not be displayed again.");
      await load();
    } catch (error) {
      setMessage(`Secret update failed: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }, [load, secret]);

  const clearSecret = useCallback(async () => {
    setSaving(true);
    try {
      await API.setModelSecret("clear");
      setMessage("API key cleared from config.json.");
      await load();
    } catch (error) {
      setMessage(`Secret clear failed: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }, [load]);

  const test = useCallback(async () => {
    setTesting(true);
    setMessage("");
    try {
      const result = await API.testModelBackend("Reply with exactly: SERVARI_BACKEND_OK", backend);
      setMessage(testResultMessage(result));
    } catch (error) {
      setMessage(`Backend test failed: ${errorMessage(error)}`);
    } finally {
      setTesting(false);
      void load();
    }
  }, [backend, load]);

  return (
    <div className="h-full overflow-auto p-4 md:p-6 xl:p-8">
      <div className="mx-auto max-w-6xl space-y-4">
        <motion.header
          className="rounded-lg px-4 py-4"
          style={{ border: "1px solid var(--s-edge-accent)", background: "var(--s-glass-light)" }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={COMPOSED}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2" style={{ color: "var(--s-text-teal)", fontSize: "var(--t-11)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>
                <Settings size={15} />
                Application settings
              </div>
              <h1 className="truncate" style={{ color: "var(--s-text-primary)", fontSize: "var(--t-24)", fontWeight: 780, letterSpacing: 0 }}>
                Model backend, CLI providers, and theme
              </h1>
            </div>
            <div
              className="rounded-lg px-3 py-2"
              style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-secondary)", fontSize: "var(--t-12)" }}
            >
              Effective: <span style={{ color: "var(--s-text-teal-soft)", fontFamily: "var(--font-mono)" }}>{loading ? "loading" : backendLabel(effective)}</span>
            </div>
          </div>
        </motion.header>

        <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
          <motion.section
            className="rounded-lg p-4"
            style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={COMPOSED}
          >
            <div className="mb-4 flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>
              <Cpu size={16} style={{ color: "var(--s-text-teal)" }} />
              Backend
            </div>
            <div className="grid gap-3">
              <label className="grid gap-1">
                <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Selected backend</span>
                <select value={backend} onChange={(event) => setBackend(event.target.value)} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}>
                  {BACKENDS.map((id) => (
                    <option key={id} value={id}>
                      {backendLabel(id)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1">
                  <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Provider</span>
                  <input value={provider} onChange={(event) => setProvider(event.target.value)} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }} />
                </label>
                <label className="grid gap-1">
                  <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Model</span>
                  <input value={model} onChange={(event) => setModel(event.target.value)} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }} />
                </label>
              </div>
              <label className="grid gap-1">
                <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Base URL</span>
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }} />
              </label>
              <label className="grid gap-1">
                <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Workspace for CLI providers</span>
                <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }} />
              </label>
              <label className="grid gap-1">
                <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Theme</span>
                <select value={theme} onChange={(event) => setTheme(event.target.value)} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }}>
                  {THEMES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </motion.section>

          <motion.section
            className="rounded-lg p-4"
            style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={COMPOSED}
          >
            <div className="mb-4 flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>
              <Terminal size={16} style={{ color: "var(--s-text-teal)" }} />
              CLI providers
            </div>
            <div className="space-y-2">
              {CLI_IDS.map((id) => (
                <CliEditorRow
                  key={id}
                  id={id}
                  provider={cliProviders.find((item) => item.id === id)}
                  value={cliConfig[id]}
                  onChange={(patch) => updateCliConfig(id, patch)}
                  onAction={runCliAction}
                  busyAction={providerBusy}
                />
              ))}
            </div>
          </motion.section>
        </div>

        <motion.section
          className="rounded-lg p-4"
          style={{ border: "1px solid var(--s-edge-subtle)", background: "var(--s-glass-light)" }}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={COMPOSED}
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2" style={{ color: "var(--s-text-primary)", fontWeight: 750 }}>
              <KeyRound size={16} style={{ color: "var(--s-text-teal)" }} />
              API secret
            </div>
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-2 rounded-lg px-2" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-secondary)", background: "rgba(250,248,243,0.035)", fontSize: "var(--t-11)" }}>
              <ExternalLink size={13} />
              OpenAI keys
            </a>
          </div>
          <form
            className="grid gap-3 lg:grid-cols-[1fr_1fr_auto_auto] lg:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSecret();
            }}
          >
            <label className="grid gap-1">
              <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Environment key name</span>
              <input name="servari-api-key-env" autoComplete="username" value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }} />
            </label>
            <label className="grid gap-1">
              <span style={{ color: "var(--s-text-secondary)", fontSize: "var(--t-11)" }}>Replace local key</span>
              <input name="servari-api-key" autoComplete="current-password" value={secret} onChange={(event) => setSecret(event.target.value)} type="password" placeholder={status?.config.has_key ? `Stored via ${status.config.key_source}` : "write-only"} className="rounded-lg px-3 py-2 outline-none" style={{ background: "var(--s-glass)", border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)" }} />
            </label>
            <button type="submit" disabled={!secret.trim() || saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 disabled:opacity-45" style={{ border: "1px solid rgba(20,156,150,0.35)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.08)" }}>
              <KeyRound size={15} />
              Set
            </button>
            <button type="button" onClick={() => void clearSecret()} disabled={saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 disabled:opacity-45" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-secondary)", background: "rgba(250,248,243,0.035)" }}>
              Clear
            </button>
          </form>
        </motion.section>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div style={{ color: message.includes("failed") ? "var(--s-status-error)" : "var(--s-text-secondary)", fontSize: "var(--t-12)" }}>
            {message || "Secrets are never returned by the settings API."}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void test()} disabled={!status || testing} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 disabled:opacity-45" style={{ border: "1px solid var(--s-edge-subtle)", color: "var(--s-text-primary)", background: "rgba(250,248,243,0.035)" }}>
              {testing ? <Loader2 size={15} className="animate-spin" /> : <PlayCircle size={15} />}
              Test reply
            </button>
            <motion.button type="button" onClick={() => void save()} disabled={!status || saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 disabled:opacity-45" style={{ border: "1px solid rgba(20,156,150,0.45)", color: "var(--s-text-teal)", background: "rgba(20,156,150,0.10)" }} whileTap={{ scale: 0.98 }} transition={SNAPPY}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Save
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ModelSettingsView;
