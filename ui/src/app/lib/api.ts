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
}

export interface ApplicationsResponse {
  applications: AppRow[];
  error?: string;
}

export interface CareerProfile {
  name?: string;
  headline?: string;
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
}

export interface AgentsStatusResponse {
  status: string;
  agents: AgentStatusCell[];
  error?: string;
}

export interface ActionsResponse {
  actions: string[];
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

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
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
  applications(): Promise<ApplicationsResponse> {
    return getJSON<ApplicationsResponse>('/api/applications');
  },
  career(): Promise<CareerProfile> {
    return getJSON<CareerProfile>('/api/career');
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
