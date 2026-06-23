/**
 * SERVARI OS — API client.
 *
 * Live data for the shell. Every method maps to a route on the shell server
 * (server/servari_server.py). In production the built app is served BY that
 * server at http://127.0.0.1:8911 — so all calls are SAME-ORIGIN (no base URL,
 * no CORS). In dev (`npm run dev`) vite.config.ts proxies /api + /raven.png to
 * the shell, so the same relative paths work there too.
 *
 * The server NEVER crashes: every route degrades gracefully and always returns
 * 200 with a JSON body (often carrying an `error` field + empty defaults when a
 * Python module is unavailable). So callers should render the shape, not assume
 * success — the types below mark optional fields accordingly.
 */

// ---------------------------------------------------------------------------
// Types — mirror the server's JSON shapes exactly.
// ---------------------------------------------------------------------------

export interface Turn {
  turn?: number;
  from: string;
  text: string;
  ts?: number | string;
  // Set by the server when a model call fails so the chat UI can render the
  // turn as a visibly-distinct error bubble instead of going silent.
  error?: boolean;
}

export interface Health {
  heartbeat?: unknown;
  roster?: unknown;
  integration?: unknown;
  [k: string]: unknown;
}

export interface ChannelSummary {
  turns: number;
  owes: number;
  [k: string]: unknown;
}

export interface StateResponse {
  turns: Turn[];
  health: Health;
  channels: Record<string, ChannelSummary>;
  open_gates: unknown[];
}

export interface OkResponse {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface AgentChannelResponse {
  name: string;
  turns: Turn[];
}

export interface GridPane {
  name: string;
  key: string;
  total: number;
  // The shell server returns `turns` as an ARRAY of turn objects (the recent
  // channel turns), NOT a count — the count lives in `total`. Typed as unknown
  // so callers MUST go through paneTurnCount()/paneTurnList() and never render
  // it as a React child (rendering a turn object → React error #31).
  turns: unknown;
  owes: number;
  last_ts: number | string | null;
  status: string;
  activity: unknown;
  [k: string]: unknown;
}

// Safe accessors for GridPane.turns (server sends an array; legacy callers
// expected a number). Use these everywhere instead of touching pane.turns raw.
export function paneTurnCount(pane: { turns?: unknown; total?: number }): number {
  if (Array.isArray(pane.turns)) return pane.turns.length;
  if (typeof pane.turns === "number") return pane.turns;
  if (typeof pane.total === "number") return pane.total;
  return 0;
}

export function paneTurnList(pane: { turns?: unknown }): Turn[] {
  return Array.isArray(pane.turns) ? (pane.turns as Turn[]) : [];
}

export interface GridResponse {
  panes: GridPane[];
  count: number;
}

export interface OrgResponse {
  chain?: unknown;
  reporting_chain?: unknown;
  comms_matrix?: unknown;
  gate_owners?: unknown;
  org_chart?: unknown;
  departments?: unknown;
  [k: string]: unknown;
}

export interface LaunchStage {
  stage: string;
  goal: string;
  status: string;
  gate: string;
  cls: string;
  [k: string]: unknown;
}

export interface LaunchResponse {
  stages: LaunchStage[];
  [k: string]: unknown;
}

export interface AgentBriefResponse {
  name: string;
  found: boolean;
  brief: string;
  path: string;
  [k: string]: unknown;
}

export interface ModelProviderStatus {
  id: string;
  label: string;
  available: boolean;
  runnable?: boolean;
  enabled?: boolean;
  binary?: string;
  path?: string | null;
  status?: unknown;
}

export interface ModelConfigResponse {
  ok: boolean;
  config: {
    backend?: string;
    provider?: string;
    base_url?: string;
    model?: string;
    workspace_home?: string;
    api_key_env?: string;
    theme?: string;
    has_key?: boolean;
    key_source?: string;
    cli?: Record<string, { enabled?: boolean; binary?: string; one_shot_args?: string[]; custom_one_shot?: boolean }>;
    [k: string]: unknown;
  };
  selected_backend: string;
  effective_backend: string;
  api?: unknown;
  cli?: Record<string, ModelProviderStatus>;
  providers: ModelProviderStatus[];
  workspace_home?: string;
  saved?: boolean;
  error?: string;
}

export interface GatewayStatus {
  id: string;
  label: string;
  binary?: string;
  path?: string | null;
  installed?: boolean;
  running?: boolean;
  managed?: boolean;
  pid?: number | null;
  port?: number | null;
  log?: string;
  status?: unknown;
  error?: string;
}

export interface GatewaysResponse {
  ok: boolean;
  mode?: string;
  gateways: GatewayStatus[];
  running?: number;
  updated_at?: string;
  error?: string;
}


export interface ObsidianVaultResponse {
  ok: boolean;
  path: string;
  exists?: boolean;
  notes?: number;
  uri?: string;
  synced?: boolean;
  opened?: string;
  updated_at?: string;
  error?: string;
}

export interface AgentMapNode {
  id: string;
  type?: "agent" | "memory" | string;
  label: string;
  name: string;
  role: string;
  group: string;
  workflow?: string;
  reports_to?: string | null;
  status: string;
  current_task: string;
  latest_reply: string;
  latest_reply_ts: string | null;
  turns: number;
  channel_exists: boolean;
  runtime_backend?: string;
  dashboard_ids?: string[];
  editable?: boolean;
  source_label?: string;
  has_source?: boolean;
  memory_files?: Array<{ label?: string; path?: string; exists?: boolean }>;
}

export interface AgentMapEdge {
  id: string;
  source: string;
  target: string;
  kind: "reports_to" | "workflow" | string;
}

export interface AgentMapResponse {
  agents: AgentMapNode[];
  edges: AgentMapEdge[];
  groups: Array<{ id: string; label: string; count?: number }>;
  workflows: unknown[];
  dashboards?: Array<{ id: string; label: string }>;
  updated_at?: string;
  error?: string;
}

export interface AgentProfileResponse {
  ok: boolean;
  profile: Partial<AgentMapNode> & { channel?: string } | null;
  brief?: AgentBriefResponse;
  error?: string;
}

export interface RssFeedItem {
  id?: string;
  title: string;
  source?: string;
  url?: string;
  published_at?: string;
  category?: string;
  summary?: string;
  priority?: string;
}

export interface RssFeedsResponse {
  ok?: boolean;
  items: RssFeedItem[];
  feeds?: unknown[];
  errors?: unknown[];
  last_sync?: string;
  error?: string;
}

export interface LocalStoreRow {
  id: string;
  name: string;
  kind: string;
  path: string;
  rows?: number | null;
  size_mb?: number;
  updated?: string;
  status?: string;
  description?: string;
}

export interface LocalStoresResponse {
  ok?: boolean;
  stores: LocalStoreRow[];
  last_scan?: string;
  error?: string;
}

export interface AgentWorkflowStep {
  id: string;
  label: string;
  owner: string;
  state: "ready" | "working" | "review" | "blocked" | "done" | string;
  summary: string;
  gate?: string;
}

export interface AgentWorkflow {
  id: string;
  title: string;
  status: string;
  current_step?: string;
  steps: AgentWorkflowStep[];
}

export interface AgentWorkflowsResponse {
  workflows: AgentWorkflow[];
  source?: string;
  note?: string;
}

export interface AutonomyResponse {
  levels: Record<string, number | string>;
  definitions: Record<string, { name: string; [k: string]: unknown }>;
  default_level?: number | string;
  error?: string;
  [k: string]: unknown;
}

export interface VerifyQueueItem {
  id: string;
  agent: string;
  gate: string;
  summary: string;
  action: string;
  [k: string]: unknown;
}

export interface VerifyQueueResponse {
  pending: VerifyQueueItem[];
  error?: string;
}

export interface HealthCheckResponse {
  verdict: string;
  checks: Record<string, unknown>;
  summary: string;
  [k: string]: unknown;
}

export interface RetentionResponse {
  pending: unknown[];
  history: unknown[];
  error?: string;
}

export interface ContextResponse {
  pressure: {
    pressure?: number | string;
    recommendation?: string;
    [k: string]: unknown;
  };
  survival: {
    pins?: unknown;
    all_ok?: boolean;
    missing?: unknown;
    [k: string]: unknown;
  };
  policy?: unknown;
  error?: string;
}

export interface TokenCounts {
  in: number;
  out: number;
  cache_write: number;
  cache_read: number;
}

export interface TokensLive {
  session?: string;
  msgs?: number;
  tokens?: TokenCounts;
  total_tokens?: number;
  cost_usd?: number;
  duration_min?: number;
  cost_per_hour?: number;
  [k: string]: unknown;
}

export interface TokensBucket {
  total_tokens: number;
  cost_usd: number;
  msgs?: number;
  transcripts?: number;
  [k: string]: unknown;
}

export interface TokensResponse {
  live: TokensLive;
  summary: {
    all_time?: TokensBucket;
    today?: TokensBucket;
    [k: string]: unknown;
  };
  error?: string;
}

export interface TokensSessionsResponse {
  sessions: unknown[];
  error?: string;
}

export interface TokensReportResponse {
  ok: boolean;
  path?: string;
  markdown?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Personal-world domain types — mirror the server provider modules
// (jobs.py, applications.py, career.py, inbox.py, finance.py, reports.py).
// ---------------------------------------------------------------------------

export interface JobRow {
  title: string;
  company: string;
  source: string;
  location: string;
  score: number;
  posted: string;
  tailored?: boolean;
  url?: string;
  notes?: string;
}

export interface JobsResponse {
  jobs: JobRow[];
  last_scan?: string;
  error?: string;
}

export interface AppRow {
  company: string;
  role: string;
  status: string;
  date: string;
  url?: string;
  notes?: string;
}

export interface ApplicationsResponse {
  applications: AppRow[];
  error?: string;
}

export interface CareerProfile {
  name?: string;
  headline?: string;
  summary?: string;
  location?: string;
  languages?: string;
  portfolio_path?: string;
  portfolio_file_count?: number;
  skills?: string[];
  error?: string;
}

export interface InboxThread {
  from: string;
  subject?: string;
  age_str: string;
  priority: "high" | "medium" | "low";
  thread_id?: string;
}

export interface InboxResponse {
  threads: InboxThread[];
  last_triage?: string;
  error?: string;
}

export interface InvoiceRow {
  inv_id: string;
  client: string;
  amount_eur: number;
  due_str: string;
}

export interface FinanceResponse {
  mtd_revenue_eur?: number;
  mtd_expenses_eur?: number;
  mtd_net_eur?: number;
  outstanding_eur?: number;
  invoices?: InvoiceRow[];
  as_of_iso?: string;
  error?: string;
}

export interface MemoryFile {
  file: string;
  path: string;
  entries: number | null;
  updated: string;
}

export interface MemorySurfaceResponse {
  files: MemoryFile[];
  error?: string;
}

export interface ReportRow {
  date: string;
  slug: string;
  path: string;
  desc: string;
  ext: string;
}

export interface ReportsResponse {
  reports: ReportRow[];
  error?: string;
}

// Orchestration — agent workspace grid
export interface AgentStatusCell {
  id: string;
  display_name: string;
  status: "live" | "working" | "idle" | "done" | "blocked" | "error" | "not_started";
  current_task: string;
  latest_reply: string;
  latest_reply_ts: string | null;
  channel_exists: boolean;
  role?: string;
  group?: string;
  workflow?: string;
  turns?: number;
}

export interface AgentsStatusResponse {
  status: string;
  agents: AgentStatusCell[];
  groups?: Array<{ id: string; label: string }>;
  error?: string;
}

export interface ActionsResponse {
  actions: string[];
  orders?: StandingOrder[];
}

export interface StandingOrder {
  id: string;
  action: string;
  title: string;
  purpose: string;
  owner: string;
  trigger: string;
  gate: string;
  enabled: boolean;
  last_run?: string;
  last_ok?: boolean | null;
}

export interface RunResponse {
  ok: boolean;
  action?: string;
  exit?: number;
  out?: string;
  error?: string;
  [k: string]: unknown;
}

export interface EngineConfig {
  home?: string;
  host?: string;
  port?: number | string;
  python?: string;
  auth_enabled?: boolean;
}

export interface EngineState {
  running: boolean;
  managed: boolean;
  pid: number | null;
  started_at: string | null;
  returncode: number | null;
  config: EngineConfig;
  probe_health?: unknown;
  probe_ready?: unknown;
}

export interface EngineActionResponse {
  ok: boolean;
  message?: string;
  error?: string;
  status?: EngineState;
  config?: EngineConfig;
}

export interface EngineStatusResponse {
  ok: boolean;
  status?: EngineState;
  error?: string;
}

export interface EngineLogsResponse {
  ok: boolean;
  logs: string[];
  count: number;
  error?: string;
}

export interface TtsVoiceInfo {
  name: string;
  culture?: string;
  gender?: string;
  age?: string;
}

export interface VoiceConfigResponse {
  ok: boolean;
  // The server returns a list of {name, culture, gender, age} dicts (Windows
  // System.Speech voices). Typed permissively so callers can read .name safely.
  tts_voices: TtsVoiceInfo[];
  stt_ready: boolean;
  stt_model?: string;
  stt_device?: string | null;
  stt_compute_type?: string | null;
  error?: string;
  [k: string]: unknown;
}

export interface VoiceTranscribeResponse {
  ok: boolean;
  text: string;
  error?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers.
// ---------------------------------------------------------------------------

async function readJSON<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${path} returned non-JSON response`);
    }
  }
  if (!res.ok) {
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    throw new Error(String(record.error || `${path} failed with HTTP ${res.status}`));
  }
  return data as T;
}

export interface TradingWorkbenchResponse {
  ok?: boolean;
  active_symbol?: string;
  timeframe?: string;
  position_plan?: Record<string, unknown>;
  watchlist: string[];
  alerts: Array<Record<string, unknown>>;
  risk_rules: Array<Record<string, unknown>>;
  research_queue: Array<Record<string, unknown>>;
  journal: Array<Record<string, unknown>>;
  updated_at?: string;
  error?: string;
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  return readJSON<T>(res, path);
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-SERVARI-Client': 'app' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readJSON<T>(res, path);
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// The API surface.
// ---------------------------------------------------------------------------

export const API = {
  // --- chat / state ---
  state(): Promise<StateResponse> {
    return getJSON<StateResponse>('/api/state');
  },
  say(text: string): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/say', { text });
  },
  agentSay(name: string, text: string): Promise<OkResponse> {
    return postJSON<OkResponse>(`/api/agent-say${qs({ name })}`, { text });
  },
  agentChannel(name: string): Promise<AgentChannelResponse> {
    return getJSON<AgentChannelResponse>(`/api/agent-channel${qs({ name })}`);
  },

  // --- the process grid ---
  grid(): Promise<GridResponse> {
    return getJSON<GridResponse>('/api/grid');
  },

  // --- org / launch / briefs ---
  org(): Promise<OrgResponse> {
    return getJSON<OrgResponse>('/api/org');
  },
  launch(): Promise<LaunchResponse> {
    return getJSON<LaunchResponse>('/api/launch');
  },
  agentBrief(name: string): Promise<AgentBriefResponse> {
    return getJSON<AgentBriefResponse>(`/api/agent-brief${qs({ name })}`);
  },
  saveAgentBrief(name: string, brief: string): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/agent-brief', { name, brief });
  },
  agentProfile(name: string): Promise<AgentProfileResponse> {
    return getJSON<AgentProfileResponse>(`/api/agent-profile${qs({ name })}`);
  },
  saveAgentProfile(profile: Record<string, unknown>): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/agent-profile', profile);
  },
  agentMap(): Promise<AgentMapResponse> {
    return getJSON<AgentMapResponse>('/api/agent-map');
  },
  agentWorkflows(): Promise<AgentWorkflowsResponse> {
    return getJSON<AgentWorkflowsResponse>('/api/agent-workflows');
  },
  modelConfig(): Promise<ModelConfigResponse> {
    return getJSON<ModelConfigResponse>('/api/model-config');
  },
  saveModelConfig(config: Record<string, unknown>): Promise<ModelConfigResponse> {
    return postJSON<ModelConfigResponse>('/api/model-config', config);
  },
  setModelSecret(action: 'set' | 'clear', apiKey = ''): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/settings/model-backend/secret', { action, api_key: apiKey });
  },
  testModelBackend(text?: string, backend?: string): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/settings/model-backend/test', { text, backend });
  },
  gateways(): Promise<GatewaysResponse> {
    return getJSON<GatewaysResponse>('/api/gateways');
  },
  gatewayAction(gateway: string, action: 'status' | 'start' | 'stop' | 'restart'): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/gateways/action', { gateway, action });
  },
  cliProviderAction(provider: string, action: 'session' | 'login' | 'configure' | 'dashboard' | 'doctor'): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/cli-provider/action', { provider, action });
  },
  obsidianVault(): Promise<ObsidianVaultResponse> {
    return getJSON<ObsidianVaultResponse>('/api/obsidian-vault');
  },
  obsidianAction(action: 'status' | 'sync' | 'open-folder' | 'open-obsidian'): Promise<ObsidianVaultResponse> {
    return postJSON<ObsidianVaultResponse>('/api/obsidian-vault/action', { action });
  },
  rssFeeds(): Promise<RssFeedsResponse> {
    return getJSON<RssFeedsResponse>('/api/rss-feeds');
  },
  tradingWorkbench(): Promise<TradingWorkbenchResponse> {
    return getJSON<TradingWorkbenchResponse>('/api/trading-workbench');
  },
  saveTradingWorkbench(payload: Partial<TradingWorkbenchResponse>): Promise<TradingWorkbenchResponse> {
    return postJSON<TradingWorkbenchResponse>('/api/trading-workbench', payload);
  },
  localStores(): Promise<LocalStoresResponse> {
    return getJSON<LocalStoresResponse>('/api/local-stores');
  },

  // --- autonomy dials ---
  autonomy(): Promise<AutonomyResponse> {
    return getJSON<AutonomyResponse>('/api/autonomy');
  },
  setAutonomy(agent: string, level: number | string): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/set-autonomy', { agent, level });
  },

  // --- fast-verify gate queue ---
  verifyQueue(): Promise<VerifyQueueResponse> {
    return getJSON<VerifyQueueResponse>('/api/verify-queue');
  },
  verifyDecide(id: string, decision: string, note = ''): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/verify-decision', { id, decision, note });
  },

  // --- service health ---
  health(): Promise<HealthCheckResponse> {
    return getJSON<HealthCheckResponse>('/api/health');
  },

  // --- metric-gated retention loop ---
  retention(): Promise<RetentionResponse> {
    return getJSON<RetentionResponse>('/api/retention');
  },
  retentionDecide(runId: string): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/retention-decide', { run_id: runId });
  },

  // --- context pressure + survival pins ---
  context(): Promise<ContextResponse> {
    return getJSON<ContextResponse>('/api/context');
  },
  contextCheckpoint(note = 'via SERVARI shell'): Promise<OkResponse> {
    return postJSON<OkResponse>('/api/context-checkpoint', { note });
  },

  // --- proof-of-work tokens ---
  tokens(): Promise<TokensResponse> {
    return getJSON<TokensResponse>('/api/tokens');
  },
  tokensSessions(limit = 20): Promise<TokensSessionsResponse> {
    return getJSON<TokensSessionsResponse>(`/api/tokens-sessions${qs({ limit })}`);
  },
  tokensReport(scope: string, sessionId?: string): Promise<TokensReportResponse> {
    return postJSON<TokensReportResponse>('/api/tokens-report', {
      scope,
      session_id: sessionId,
    });
  },

  // --- personal-world endpoints ---
  jobs(): Promise<JobsResponse> {
    return getJSON<JobsResponse>('/api/jobs');
  },
  saveJobs(payload: JobsResponse): Promise<JobsResponse & OkResponse> {
    return postJSON<JobsResponse & OkResponse>('/api/jobs', payload);
  },
  applications(): Promise<ApplicationsResponse> {
    return getJSON<ApplicationsResponse>('/api/applications');
  },
  saveApplications(payload: ApplicationsResponse): Promise<ApplicationsResponse & OkResponse> {
    return postJSON<ApplicationsResponse & OkResponse>('/api/applications', payload);
  },
  career(): Promise<CareerProfile> {
    return getJSON<CareerProfile>('/api/career');
  },
  saveCareer(payload: CareerProfile): Promise<{ ok: boolean; profile?: CareerProfile; error?: string }> {
    return postJSON<{ ok: boolean; profile?: CareerProfile; error?: string }>('/api/career', payload);
  },
  inbox(): Promise<InboxResponse> {
    return getJSON<InboxResponse>('/api/inbox');
  },
  finance(): Promise<FinanceResponse> {
    return getJSON<FinanceResponse>('/api/finance');
  },
  memorySurface(): Promise<MemorySurfaceResponse> {
    return getJSON<MemorySurfaceResponse>('/api/memory-surface');
  },
  reports(): Promise<ReportsResponse> {
    return getJSON<ReportsResponse>('/api/reports');
  },

  // --- orchestration workspace ---
  agentsStatus(): Promise<AgentsStatusResponse> {
    return getJSON<AgentsStatusResponse>('/api/agents/status');
  },

  // --- standing-order actions ---
  actions(): Promise<ActionsResponse> {
    return getJSON<ActionsResponse>('/api/actions');
  },
  run(action: string): Promise<RunResponse> {
    return getJSON<RunResponse>(`/api/run${qs({ action })}`);
  },
  // --- engine lifecycle ---
  engineStatus(): Promise<EngineStatusResponse> {
    return getJSON<EngineStatusResponse>('/api/engine/status');
  },
  engineLogs(lines?: number): Promise<EngineLogsResponse> {
    return getJSON<EngineLogsResponse>(`/api/engine/logs${qs({ lines })}`);
  },
  engineStart(config: EngineConfig = {}): Promise<EngineActionResponse> {
    return postJSON<EngineActionResponse>('/api/engine/start', config);
  },
  engineStop(): Promise<EngineActionResponse> {
    return postJSON<EngineActionResponse>('/api/engine/stop');
  },
  engineRestart(config: EngineConfig = {}): Promise<EngineActionResponse> {
    return postJSON<EngineActionResponse>('/api/engine/restart', config);
  },

  // --- voice ---
  voiceConfig(): Promise<VoiceConfigResponse> {
    return getJSON<VoiceConfigResponse>('/api/voice-config');
  },
  async voiceTranscribe(blob: Blob, lang = 'en'): Promise<VoiceTranscribeResponse> {
    // The server reads RAW audio bytes off the wire (NOT a JSON body).
    const res = await fetch(`/api/voice-transcribe${qs({ language: lang })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    return (await res.json()) as VoiceTranscribeResponse;
  },
};

export default API;
