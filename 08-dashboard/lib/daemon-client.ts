/**
 * Thin daemon client.
 *
 * In dev, every request hits the Next dev server which rewrites to the daemon
 * (see next.config.mjs). The browser sees a single origin, so HttpOnly cookies
 * set by the daemon (dn_session) flow normally.
 *
 * In prod the daemon serves the static export directly, so all paths
 * resolve to the same origin without any rewriting.
 */

export class DaemonError extends Error {
  constructor(public status: number, public payload: unknown, message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const isForm = opts.body instanceof FormData;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(isForm ? {} : { "Content-Type": "application/json" }),
    ...(opts.headers ?? {}),
  };
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: isForm
      ? (opts.body as FormData)
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined,
    credentials: "include",
    signal: opts.signal,
  });

  let payload: unknown = undefined;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    payload = await res.json();
  } else {
    payload = await res.text();
  }

  if (!res.ok) {
    throw new DaemonError(res.status, payload, `daemon ${res.status} on ${path}`);
  }
  return payload as T;
}

// ── auth ──────────────────────────────────────────────────────────
export const authStatus = () =>
  request<{ pin_set: boolean; locked: boolean }>("/auth/status");

export const setPin = (pin: string, current_pin?: string) =>
  request<{ ok: boolean; error?: string }>("/auth/pin", {
    method: "POST",
    body: current_pin ? { pin, current_pin } : { pin },
  });

export const unlock = (pin: string) =>
  request<{ ok: boolean; reason?: string; retry_after_ms?: number }>(
    "/auth/unlock",
    { method: "POST", body: { pin } },
  );

export const lock = () => request("/auth/lock", { method: "POST" });

// ── dashboard ────────────────────────────────────────────────────
export interface DashboardHealth {
  ok: boolean;
  pin_set: boolean;
  rollup: "ok" | "warn" | "fail";
  services_total: number;
  services_failing: number;
  unread_notifications: number;
  cpu_percent: number;
  memory_percent: number;
  generated_at: string;
}
export const dashboardHealth = () => request<DashboardHealth>("/dashboard/health");

export interface DailyBriefSummary {
  generated_at: string;
  projects_total: number;
  active_sessions: number;
  unread_notifications: number;
  whats_new_present: boolean;
  whats_new_age_hours: number | null;
}
export interface DailyBriefResponse {
  summary: DailyBriefSummary;
  whats_new_markdown: string;
}
export const dailyBrief = () =>
  request<DailyBriefResponse>("/dashboard/daily-brief");

/* Reinforcement event shape. Server writes JSON-per-line; we render
 * whichever fields are present per kind. */
export interface ReinforcementEvent {
  ts: string;
  kind:
    | "injection"
    | "hit"
    | "no-hit"
    | "promote"
    | "correction"
    | "raw-hit"
    | "raw-no-hit"
    | "raw-correction"
    | "raw-hit-ingest"
    | "decay-archive"
    | "archive";
  session?: string;
  page?: string;
  chunk?: string;
  project?: string;
  source?: "wiki" | "raw";
  cosine?: number;
  weight?: number;
  pages_created?: number;
  pages_updated?: number;
  skipped_reason?: string;
}
export interface ReinforcementResponse {
  ok: boolean;
  events: ReinforcementEvent[];
  total_bytes: number;
}
export const reinforcement = (limit = 50) =>
  request<ReinforcementResponse>(`/dashboard/reinforcement?limit=${limit}`);

export interface SystemMetrics {
  cpu: { usage_percent: number; cores: number; load_avg?: number[] };
  memory: { total_bytes: number; used_bytes: number; used_percent: number };
  disks: Array<{ mount: string; total_bytes: number; used_bytes: number; used_percent: number }>;
  ollama: { reachable: boolean; model?: string; version?: string };
  data_root_bytes: number;
  timestamp: string;
}
export const systemMetrics = () => request<SystemMetrics>("/dashboard/system-metrics");

export interface LogTail {
  ok: boolean;
  lines: string[];
  total_bytes: number;
  truncated?: boolean;
}
export const logTail = (n = 200, filter = "") =>
  request<LogTail>(
    `/dashboard/log-tail?n=${n}${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`,
  );

export interface CollectionStats {
  name: string;
  dim: number;
  count: number;
  dirty: boolean;
  vec_bytes: number;
  meta_bytes: number;
}
export interface DiagnosticsResponse {
  ok: boolean;
  store: {
    raw_chunks: CollectionStats;
    wiki_pages: CollectionStats;
    reference_chunks: CollectionStats;
  };
  lint_queue: {
    ready: boolean;
    running: boolean;
    pending: boolean;
    last_run_at: string | null;
    debounce_ms: number;
    pending_reasons: string[];
  };
  llm: {
    name: string;
    configured: boolean;
    hint: string;
    models: { ingest: string; lint: string; reconcile: string; selfQuery: string };
  } | null;
  embedder: {
    model: string;
    dim: number;
    warmed_at: string | null;
    warm_ms: number | null;
    embed_calls: number;
    embed_items: number;
    total_embed_ms: number;
    last_batch_size: number;
    last_batch_ms: number;
    last_error: string | null;
  };
  sessions: {
    total: number;
    active: number;
    by_phase: Record<string, number>;
  };
  generated_at: string;
}
export const diagnostics = () => request<DiagnosticsResponse>("/dashboard/diagnostics");

// ── backfill (admin) ────────────────────────────────────────────
export interface BackfillVerification {
  ok: boolean;
  query_preview: string;
  top_score: number;
  threshold: number;
  top_hit_preview: string;
  generated_at: string;
}
export interface BackfillRunStatus {
  mode: "raw" | "wiki";
  running: boolean;
  cancel_requested: boolean;
  started_at: string | null;
  completed_at: string | null;
  files_total: number;
  files_done: number;
  files_skipped: number;
  bytes_processed: number;
  chunks_or_pages: number;
  errors: number;
  last_error: string | null;
  current_file: string | null;
  verification: BackfillVerification | null;
}
export interface BackfillStatusResponse {
  ok: boolean;
  raw: BackfillRunStatus;
  wiki: BackfillRunStatus;
}
export const backfillStatus = () =>
  request<BackfillStatusResponse>("/admin/backfill/status");
export const backfillStart = (mode: "raw" | "wiki", reset = false) =>
  request<{ ok: boolean; started?: boolean; already_running?: boolean }>(
    `/admin/backfill/${mode}`,
    { method: "POST", body: { reset } },
  );
export const backfillCancel = (mode: "raw" | "wiki") =>
  request<{ ok: boolean }>(`/admin/backfill/${mode}/cancel`, { method: "POST" });

/* Trigger a daemon self-restart. The endpoint spawns a detached relauncher
 * that waits ~2s then runs start-daemon.ps1, and the running daemon exits
 * shortly after responding 200. The dashboard should treat the immediate
 * connection drop as expected and poll /health to detect the new instance.
 *
 * Pass an empty `{}` body so the Content-Type: application/json header
 * the request helper sets has matching bytes; Fastify's default JSON
 * parser rejects "empty body + JSON content-type" with FST_ERR_CTP_
 * EMPTY_JSON_BODY (HTTP 400 Bad Request) and the UI displays it as the
 * "Bad Request" failure. */
export const daemonRestart = () =>
  request<{ ok: boolean; restarting?: boolean; error?: string }>(
    "/admin/daemon/restart",
    { method: "POST", body: {} },
  );

// ── services ────────────────────────────────────────────────────
export interface ServiceStatus {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  checked_at: string;
}
export const services = () =>
  request<{ ok: boolean; services: ServiceStatus[]; rollup: "ok" | "warn" | "fail" }>(
    "/services",
  );

// ── sessions ────────────────────────────────────────────────────
// Shape mirrors 07-daemon/src/dashboard/sessions.ts SessionListItem exactly.
export type SessionPhase =
  | "thinking"
  | "tool"
  | "permission"
  | "idle"
  | "unknown";
export interface PendingPrompt {
  message: string;
  kind: string;
  received_at: number;
}
export interface ContextUsage {
  tokens: number;
  max: number;
}
export interface SessionSummary {
  session_id: string;
  project_slug: string;
  jsonl_path: string;
  bytes: number;
  last_modified_ms: number;
  active: boolean;
  has_summary: boolean;
  has_task: boolean;
  phase: SessionPhase;
  pending_prompt: PendingPrompt | null;
  context: ContextUsage | null;
  user_label: string | null;
  derived_label: string | null;
}
export interface IdleProject {
  id: string;
  name: string;
  root: string;
  last_seen: string;
}
export const sessions = () =>
  request<{
    ok: boolean;
    sessions: SessionSummary[];
    idle_projects?: IdleProject[];
  }>("/sessions");

export const startClaude = (
  projectId: string,
  dangerous: boolean,
): Promise<{ ok: boolean; project_id?: string; root?: string; command?: string; warnings?: string[]; error?: string }> =>
  request(`/projects/${encodeURIComponent(projectId)}/start-claude`, {
    method: "POST",
    body: JSON.stringify({ dangerous }),
  });

// ── Daemon-PTY (Lex) ─────────────────────────────────────────────
export interface PtyEntry {
  ptyId: string;
  sessionId: string | null;
  cwd: string;
  command: string;
  startedAt: number;
  lastActivity: number;
  exited: boolean;
}
export const listPtys = () =>
  request<{ ok: boolean; ptys: PtyEntry[] }>("/pty");
export interface LocStats {
  ok: boolean;
  total: number;
  by_project: { id: string; name: string; lines: number }[];
  computed_at: string;
  cache?: "hit" | "miss";
}
export const statsLoc = () => request<LocStats>("/stats/loc");

export interface KpiStats {
  ok: boolean;
  computed_at: string;
  store: {
    raw_chunks: number;
    wiki_vectors: number;
    reference_chunks: number;
  };
  sessions: {
    total: number;
    active: number;
    by_phase: Record<string, number>;
  };
  brainstorm: {
    total: number;
    active: number;
    by_mode: Record<string, number>;
  } | null;
  wiki: {
    canonical: number;
    pending: number;
    archived: number;
    avg_weight: number | null;
    flagged_for_review: number;
    cross_project: number;
  } | null;
  artifacts: {
    research_notes: number;
    wiki_drafts: number;
    project_intents: number;
    notes_summaries: number;
    total: number;
  } | null;
  reinforcement: {
    hits_7d: number;
    corrections_7d: number;
    raw_hits_7d: number;
  } | null;
  git: { commits_7d: number } | null;
  backup: { last_run_at: string | null; days_ago: number | null } | null;
  llm: {
    name: string;
    configured: boolean;
    hint: string;
    models: { ingest: string; lint: string; reconcile: string; selfQuery: string };
  } | null;
  embedder: {
    warmed_at: string | null;
    warm_ms: number;
    embed_calls: number;
    embed_items: number;
    total_embed_ms: number;
    last_batch_size: number;
    last_batch_ms: number;
    last_error: string | null;
    model: string;
    dim: number;
  };
  daemon: { uptime_s: number; node_pid: number };
}
export const statsKpi = () => request<KpiStats>("/stats/kpi");

export const spawnLex = (cwd?: string, resumeSessionId?: string) =>
  request<{ ok: boolean; ptyId?: string; pid?: number; cwd?: string; resumed?: boolean; error?: string }>(
    "/pty/spawn-lex",
    {
      method: "POST",
      body: JSON.stringify({
        ...(cwd ? { cwd } : {}),
        ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
      }),
    },
  );
export const ptyInject = (id: string, text: string, commit = true) =>
  request<{ ok: boolean; error?: string }>(
    `/pty/${encodeURIComponent(id)}/inject`,
    { method: "POST", body: { text, commit } },
  );
export const ptyKill = (id: string) =>
  request<{ ok: boolean }>(`/pty/${encodeURIComponent(id)}`, { method: "DELETE" });

// ── Lex brainstorm sessions + artifacts ─────────────────────────
export interface BrainstormSessionRow {
  id: string;
  claude_session_id: string | null;
  pty_id: string | null;
  cwd: string;
  user_label: string | null;
  derived_label: string | null;
  mode: string;
  status: string;
  started_ms: number;
  ended_ms: number | null;
  turn_count: number;
  topic_tags_json: string;
  artifacts_json: string;
  last_summary: string | null;
  last_summary_ms: number | null;
}
export const lexSessions = (opts: { status?: "active" | "ended"; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<{ ok: boolean; sessions: BrainstormSessionRow[] }>(
    `/lex/sessions${q ? `?${q}` : ""}`,
  );
};
export const lexSession = (id: string) =>
  request<{ ok: boolean; session: BrainstormSessionRow; error?: string }>(
    `/lex/sessions/${encodeURIComponent(id)}`,
  );
export const patchLexSession = (
  id: string,
  patch: {
    user_label?: string | null;
    derived_label?: string | null;
    mode?: string;
    status?: "ended";
    summary?: string;
  },
) =>
  request<{ ok: boolean; session?: BrainstormSessionRow; error?: string }>(
    `/lex/sessions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
  );

export interface LexArtifactItem {
  kind: string;
  category: string;
  id: string;
  title: string;
  created_ms: number;
  path: string;
  preview: string;
}
export const lexSessionArtifacts = (id: string) =>
  request<{ ok: boolean; artifacts: LexArtifactItem[] }>(
    `/lex/sessions/${encodeURIComponent(id)}/artifacts`,
  );

export interface LexArtifactDetail {
  id: string;
  kind: string;
  brainstorm_id: string | null;
  created_ms: number;
  data: Record<string, unknown>;
}
export const lexArtifact = (kind: string, id: string) =>
  request<{ ok: boolean; artifact: LexArtifactDetail; error?: string }>(
    `/lex/artifacts/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
  );

export interface SessionChunk {
  role: string;
  text: string;
  timestamp?: string;
}
export interface SessionDetail extends SessionSummary {
  summary: string;
  task: string;
  recent_chunks: SessionChunk[];
}
export const sessionDetail = (id: string, query?: string) =>
  request<{ ok: boolean; session: SessionDetail }>(
    `/sessions/${id}${query ? `?q=${encodeURIComponent(query)}` : ""}`,
  );

export interface BridgeStatus {
  alive: boolean;
  last_seen_ms: number | null;
  age_ms: number | null;
}
export const bridgeStatus = () =>
  request<{ ok: boolean } & BridgeStatus>("/dashboard/bridge-status");

export interface QueuePromptResult {
  ok: boolean;
  queued_at?: string;
  error?: string;
  bridge?: BridgeStatus;
}
export const queuePrompt = (id: string, text: string) =>
  request<QueuePromptResult>(`/sessions/${id}/prompt`, {
    method: "POST",
    body: { text },
  });

export const focusSession = (id: string) =>
  request<{ ok: boolean }>(`/sessions/${id}/focus`, { method: "POST" });

export interface ScreenshotUploadResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}
export function uploadScreenshot(blob: Blob, filename = "paste.png") {
  const fd = new FormData();
  fd.append("file", blob, filename);
  return request<ScreenshotUploadResult>("/uploads/screenshot", {
    method: "POST",
    body: fd,
  });
}

/* Pending permission prompt: dashboard reads via SessionSummary.pending_prompt
 * (rides on /sessions). After the user picks an answer, queuePrompt sends the
 * digit + commits, then clearPendingPrompt drops the pending struct so the
 * badge disappears immediately instead of waiting for the next hook fire. */
export const clearPendingPrompt = (id: string) =>
  request<{ ok: boolean }>(`/sessions/${id}/pending-prompt`, {
    method: "DELETE",
  });

export type NavKey =
  | "up" | "down" | "left" | "right"
  | "enter" | "backspace"
  | "1" | "2" | "3" | "4" | "5"
  | "mic";
export const sendSessionKey = (id: string, key: NavKey) =>
  request<{ ok: boolean; queued_at?: string }>(
    `/sessions/${id}/key`,
    { method: "POST", body: { key } },
  );

// ── search ──────────────────────────────────────────────────────
export interface SearchHit {
  source: "wiki_page" | "raw_chunk" | "reference_chunk";
  score: number;
  title?: string;
  preview: string;
  url?: string;
  doc_id?: string;
  page_id?: string;
  /** Full metadata from the underlying vector store record. For
   * raw_chunk this carries session_id, project_id, role, kind, and
   * text_preview - enough to deep-link from the Wiki search row to
   * /sessions/detail with the original transcript turn highlighted. */
  metadata?: Record<string, unknown>;
  id?: string;
}
export const searchAll = (
  q: string,
  opts: {
    project_id?: string;
    /** @deprecated use limit + offset */
    top_k?: number;
    limit?: number;
    offset?: number;
    collections?: Array<"wiki_page" | "raw_chunk" | "reference_chunk">;
  } = {},
) =>
  request<{
    ok: boolean;
    results: SearchHit[];
    total?: number;
    offset?: number;
    limit?: number;
  }>("/search/all", {
    method: "POST",
    body: { q, ...opts },
  });

// ── reminders ────────────────────────────────────────────────────
export interface Reminder {
  id: string;
  title: string;
  due_at?: string;
  project_id?: string;
  tags?: string[];
  completed_at?: string;
  archived_at?: string;
}
export const reminders = () => request<{ ok: boolean; reminders: Reminder[] }>("/reminders");
export const createReminder = (input: { title: string; due_at?: string; project_id?: string; tags?: string[] }) =>
  request<{ ok: boolean; reminder: Reminder }>("/reminders", { method: "POST", body: input });
export const completeReminder = (id: string, complete: boolean) =>
  request<{ ok: boolean }>(`/reminders/${id}`, { method: "PATCH", body: { complete } });
export const deleteReminder = (id: string) =>
  request<{ ok: boolean }>(`/reminders/${id}`, { method: "DELETE" });

// ── notifications ────────────────────────────────────────────────
export type NotificationScope = "bell" | "activity";
export interface Notification {
  id: string;
  severity: "info" | "warn" | "alert";
  source: string;
  title: string;
  body?: string;
  link?: string;
  ts: string;
  /** True once dismissed in BOTH scopes. Per-scope visibility lives in
   * dismissed_scopes; check that one when filtering for a specific
   * surface (e.g. the top-bar bell vs the right-rail activity). */
  dismissed: boolean;
  dismissed_scopes: NotificationScope[];
}
export const notifications = (limit = 50) =>
  request<{ ok: boolean; notifications: Notification[] }>(
    `/notifications?limit=${limit}`,
  );
/* Scope optional. 'bell' clears just the top-bar dropdown row, 'activity'
 * clears just the right-rail row, omitted clears both (legacy). */
export const dismissNotification = (
  id: string,
  scope?: NotificationScope,
) =>
  request<{ ok: boolean }>(`/notifications/${id}/dismiss`, {
    method: "POST",
    ...(scope ? { body: { scope } } : {}),
  });

/* One-click correction on a wiki page. Used by the live activity rail
 * when the user spots a curator injection that was bad recall. Daemon
 * lowers weight + increments corrections; archives at 3+ corrections. */
export const correctWikiPage = (pageId: string) =>
  request<{
    ok: boolean;
    weight?: number;
    corrections?: number;
    archived?: boolean;
    error?: string;
  }>(`/admin/wiki/correct/${encodeURIComponent(pageId)}`, { method: "POST" });

// ── projects ────────────────────────────────────────────────────
export interface ProjectRecord {
  id: string;
  name: string;
  root: string;
  remote: string | null;
  first_seen: string;
  last_seen: string;
}
export const projects = () =>
  request<{ projects: ProjectRecord[] }>("/projects").catch(() => ({
    projects: [] as ProjectRecord[],
  }));
export const createProject = (input: {
  name: string;
  stage?: "alpha" | "beta" | "deployed" | "archived";
  tags?: string[];
  description?: string;
  open_vscode?: boolean;
}) =>
  request<{ ok: boolean; project?: ProjectRecord; error?: string }>(
    "/projects/new",
    { method: "POST", body: input },
  );

// ── graph (orb) ────────────────────────────────────────────────
export type GraphNodeStatus = "canonical" | "pending" | "archived";
export interface GraphNode {
  id: string;
  title: string;
  status: GraphNodeStatus;
  project_id?: string;
  last_modified: string;
  promoted_at?: string;
  weight: number;
}
export interface GraphEdge {
  source: string;
  target: string;
  kind?: "reference" | "sibling" | "glossary";
  weight: number;
}
export interface GraphResponse {
  ok: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export const graph = () => request<GraphResponse>("/graph");

// ── single wiki page (for search-result modal) ─────────────────
export interface WikiPageDetail {
  id: string;
  title: string;
  trigger: string;
  insight: string;
  summary: string;
  status: "canonical" | "pending" | "archived";
  weight: number;
  hits: number;
  corrections: number;
  created: string;
  last_touched: string;
  projects: string[];
  pattern: string;
  cross_refs: string[];
  evidence: string[];
  log: string[];
}
export const wikiPage = (id: string) =>
  request<{ ok: boolean; page: WikiPageDetail; error?: string }>(`/wiki/page/${encodeURIComponent(id)}`);

// ── push (VAPID) ──────────────────────────────────────────────
export const vapidPublicKey = () =>
  request<{ ok: boolean; public_key: string }>("/push/vapid-public-key");

export const subscribePush = (input: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user_agent?: string;
}) =>
  request<{ ok: boolean; id?: string; error?: string }>("/push/subscribe", {
    method: "POST",
    body: input,
  });

export const unsubscribePush = (id: string) =>
  request<{ ok: boolean }>(`/push/subscribe/${id}`, { method: "DELETE" });

// ── reference docs ──────────────────────────────────────────────
export interface ReferenceDoc {
  doc_id: string;
  filename: string;
  kind: string;
  project_id: string;
  tags: string[];
  uploaded_at: string;
  chunk_count?: number;
}
export const referenceDocs = (project_id?: string) =>
  request<{ ok: boolean; docs: ReferenceDoc[] }>(
    `/reference${project_id ? `?project_id=${encodeURIComponent(project_id)}` : ""}`,
  );

export const uploadReference = (file: File, opts: { project_id?: string; tags?: string[] } = {}) => {
  const fd = new FormData();
  fd.append("file", file);
  if (opts.project_id) fd.append("project_id", opts.project_id);
  if (opts.tags?.length) fd.append("tags", opts.tags.join(","));
  return request<{ ok: boolean; doc_id?: string; error?: string }>("/upload", { body: fd });
};
