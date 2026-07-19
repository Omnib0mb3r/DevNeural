/**
 * Thin daemon client.
 *
 * In dev, every request hits the Next dev server which rewrites to the daemon
 * (see next.config.mjs). The browser sees a single origin, so any cookies set
 * by the daemon flow normally.
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
  /* Only send Content-Type: application/json when there's an actual
   * JSON body to ship. Fastify v5's default content-type parser
   * rejects any request that declares Content-Type: application/json
   * but carries no body with FST_ERR_CTP_EMPTY_JSON_BODY -> 400. That
   * blew up body-less DELETEs like ptyKill (DELETE /pty/<id>), so
   * clicking "+ new brainstorm" got a 400 trying to kill the active
   * PTY and the resume / new-session flow died on the first step. */
  const hasJsonBody = !isForm && opts.body !== undefined;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
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
  // Guard against the daemon serving the SPA index.html (or any other
  // non-JSON body) for a path that's expected to return JSON. Without
  // this check the caller would receive HTML typed as `T` and crash on
  // the first property access. Surface a clear DaemonError instead.
  if (!ct.includes("application/json")) {
    throw new DaemonError(
      res.status,
      payload,
      `daemon ${res.status} on ${path}: expected JSON, got ${ct || "unknown content-type"}`,
    );
  }
  return payload as T;
}

// ── dashboard ────────────────────────────────────────────────────
export interface DashboardHealth {
  ok: boolean;
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
  /** Bounded plain-text preview of what was injected (injection
   * events written after 2026-07-16; older lines lack it). */
  preview?: string;
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
    models: {
      ingest: string;
      lint: string;
      reconcile: string;
      selfQuery: string;
      distillation: string;
    };
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
  /** Lex anchor uuid for sessions backed by a brainstorm anchor.
   * Stream Deck dedupes the underlying CC session against the
   * anchor tile feed using this id. Null for non-brainstorm
   * sessions. */
  lex_anchor_id: string | null;
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

/* Fix 39 (2026-05-26): workers no longer accept --dangerously-skip-
 * permissions. The daemon's /projects/:id/start-claude endpoint ignores
 * any `dangerous` flag and always emits the plain `claude` command;
 * the dashboard button shape stops passing the field entirely so a
 * stale UI cannot quietly suggest a permission bypass that no longer
 * exists. */
export const startClaude = (
  projectId: string,
): Promise<{ ok: boolean; project_id?: string; root?: string; command?: string; warnings?: string[]; error?: string }> =>
  request(`/projects/${encodeURIComponent(projectId)}/start-claude`, {
    method: "POST",
    body: { dangerous: false },
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
  /* Diagnostic fields stamped by pty-host on exit / inject error.
   * Surfaced by TerminalMirror as an expandable error block so a
   * silent PTY death isn't invisible to the user. exit_* are null
   * while the PTY is alive; last_command + last_error track the most
   * recent inject for post-mortem context. output_tail is the trailing
   * ~1 KB of merged stdout/stderr the process printed before
   * exit / error. */
  exit_code?: number | null;
  exit_signal?: number | null;
  exited_at?: number | null;
  last_error?: string | null;
  last_error_class?: string | null;
  last_command?: string | null;
  last_command_at?: number | null;
  output_tail?: string;
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
    models: {
      ingest: string;
      lint: string;
      reconcile: string;
      selfQuery: string;
      distillation: string;
    };
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

/* CI-6 Curator Health KPI card. Endpoint shape mirrors spec
 * section 4.1 GET /stats/curator-health. */
export interface CuratorHealthStats {
  ok: boolean;
  window_days: number;
  injections_per_day: number[];
  hit_rate: number;
  correction_rate: number;
  silence_rate: number;
  click_through_rate: number;
  canary_status: "green" | "red" | "unknown";
  canary_last_run: string | null;
  flagged_pages_count: number;
}
export const statsCuratorHealth = (windowDays?: number) => {
  const qs = windowDays ? `?window=${windowDays}` : "";
  return request<CuratorHealthStats>(`/stats/curator-health${qs}`);
};

/* BF-12 brainstorm KPI tiles. Endpoint shape mirrors spec section
 * 4.1 GET /stats/brainstorm-kpi. */
export interface BrainstormKpiStats {
  ok: boolean;
  total_brainstorms: number;
  hours_captured: number;
  artifacts_per_brainstorm_avg: number;
  wiki_lineage_coverage: number;
  project_less_ratio: number;
  active_today: number;
}
export const statsBrainstormKpi = () =>
  request<BrainstormKpiStats>("/stats/brainstorm-kpi");

/* PB-3 outbound dashboard tile. Endpoint shape mirrors spec section
 * 4.1 GET /stats/outbound. brainstorm_outbound_count_alltime is
 * always 0 by contract; the field exists so the card can render
 * the "0 ever, by design" assertion. */
export interface OutboundStats {
  ok: boolean;
  today: {
    calls_total: number;
    calls_by_destination: Record<string, number>;
    bytes_total: number;
    cap: number;
    cap_remaining: number;
    paused: boolean;
  };
  last_7_days: Array<{ date: string; calls: number; bytes: number }>;
  brainstorm_outbound_count_alltime: number;
}
export const statsOutbound = () => request<OutboundStats>("/stats/outbound");

/* spawnLex retired in step 6 of PLAN-lex-session-rewrite.md. The
 * /pty/spawn-lex POST is still served by the daemon as a backstop
 * for legacy callers (replay-pty harness etc.); the dashboard now
 * spawns Lex exclusively through createLexAnchor / openLexAnchor
 * below, both of which go through spawn-lex-session.ts on the
 * daemon side. */
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
  /* Brainstorm-as-durable-primary-entity (2026-05-22, migration 033).
   * Optional on the type so legacy daemons that have not run
   * migration 033 yet still parse. */
  runtime_mode?: "cc-pty" | "direct-llm" | "detached";
  lifecycle_state?: "idle" | "attached" | "speaking" | "ended";
  attached_worker_session_id?: string | null;
}
/* lexSessions / lexSession / patchLexSession retired in step 6;
 * past-sessions list now goes through lexAnchors below.
 * BrainstormSessionRow stays exported because MeetingRow extends
 * it and the meetings surface still uses the legacy table. */

/* ── Lex anchors (PLAN-lex-session-rewrite.md, step 4) ─────────────
 * New past-sessions surface. Each anchor is the durable session id
 * the dashboard surfaces everywhere; opening one either binds to
 * the live PTY (when status='live') or spawns a fresh CC session
 * with the reopen-variant system prompt (when status='dormant'). */
export interface LexAnchor {
  id: string;
  title: string | null;
  derived_title: string | null;
  status: "live" | "dormant";
  current_pty_id: string | null;
  cwd: string;
  created_ms: number;
  last_activity_ms: number;
  transcript_count: number;
  /* Phase C: project anchor this brainstorm supervises. NULL when
   * unbound. Cross-session inject falls back to the bound project's
   * current_session_id when target_session is omitted. */
  supervises_project_anchor_id?: string | null;
  /* Brainstorm-as-durable-primary-entity (2026-05-22 reconcile).
   * Surface the bound brainstorm's runtime_mode so the resume
   * button can branch direct-llm (voice-connect-by-brainstorm-id)
   * vs cc-pty (kill-then-spawn-with-resume). Undefined on legacy
   * anchors that pre-date migration 033; treat as cc-pty. */
  runtime_mode?: "cc-pty" | "direct-llm" | "detached";
}
export interface LexAnchorTranscriptRef {
  id: number;
  lex_session_id: string;
  cc_session_id: string;
  transcript_path: string;
  started_ms: number;
  ended_ms: number | null;
  ordering: number;
}
export const lexAnchors = (opts: { status?: "live" | "dormant"; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<{ ok: boolean; anchors: LexAnchor[] }>(
    `/lex/anchors${q ? `?${q}` : ""}`,
  );
};
export const lexAnchor = (id: string) =>
  request<{
    ok: boolean;
    anchor: LexAnchor & { transcripts: LexAnchorTranscriptRef[] };
    error?: string;
  }>(`/lex/anchors/${encodeURIComponent(id)}`);
export const createLexAnchor = (
  opts: {
    cwd?: string;
    title?: string;
    /* Phase C binding. Pass a project_session id to bind the new
     * anchor on create; null/omitted leaves the brainstorm unbound. */
    supervises_project_anchor_id?: string | null;
  } = {},
) =>
  request<{
    ok: boolean;
    anchor_id?: string;
    cc_session_id?: string;
    pty_id?: string;
    transcript_path?: string;
    prompt_version?: string;
    supervises_project_anchor_id?: string | null;
    error?: string;
  }>(`/lex/anchors`, { method: "POST", body: opts });
export const openLexAnchor = (id: string) =>
  request<{
    ok: boolean;
    mode?: "bind" | "spawn";
    anchor_id?: string;
    cc_session_id?: string;
    pty_id?: string;
    transcript_path?: string;
    prompt_version?: string;
    prior_transcript_count?: number;
    error?: string;
  }>(`/lex/anchors/${encodeURIComponent(id)}/open`, {
    method: "POST",
    body: {},
  });
export const patchLexAnchor = (
  id: string,
  patch: {
    title?: string | null;
    derived_title?: string | null;
    /* Phase C binding. Pass null to clear. */
    supervises_project_anchor_id?: string | null;
  },
) =>
  request<{ ok: boolean; anchor?: LexAnchor; error?: string }>(
    `/lex/anchors/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
  );
export const endLexAnchor = (id: string) =>
  request<{ ok: boolean; error?: string }>(
    `/lex/anchors/${encodeURIComponent(id)}/end`,
    { method: "POST", body: {} },
  );
export const deleteLexAnchor = (id: string) =>
  request<{ ok: boolean; error?: string }>(
    `/lex/anchors/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

/* Stream Deck anchor tile feed. Each live anchor renders as a
 * read-only tile alongside CC project tiles; phase reuses the
 * /sessions vocab. The 'dormant' status is included for
 * completeness but the daemon endpoint only returns live anchors. */
export interface AnchorTile {
  anchor_id: string;
  title: string | null;
  derived_title: string | null;
  status: "live" | "dormant";
  current_pty_id: string | null;
  current_cc_session_id: string | null;
  transcript_path: string | null;
  phase: "thinking" | "tool" | "permission" | "idle" | "unknown";
  pending_prompt: PendingPrompt | null;
  last_activity_ms: number;
  transcript_count: number;
  /** project_slug of the worker anchor this brainstorm supervises.
   * Retained for display/diagnostics; the deck no longer nests off
   * this (tile/session slug formats differ). */
  supervised_project_slug: string | null;
  /** Live worker SESSION ID of the anchor this brainstorm supervises.
   * The deck nests the worker under the brainstorm by matching this
   * against the session tiles, the authoritative binding id. */
  supervised_worker_session_id: string | null;
}
export const lexAnchorTiles = () =>
  request<{ ok: boolean; tiles: AnchorTile[] }>(`/lex/anchor-tiles`);

/* Wave 2 day 2 (BF-5 / A1, BF-7 review / A2). The /brainstorms +
 * /drafts route family lives alongside the older /lex/sessions
 * surface; the two share the same underlying brainstorm_sessions and
 * wiki_drafts tables. New consumers should prefer these typed
 * helpers; the older lexSessions* helpers stay until /lex itself
 * gets retired (out of scope for Wave 2). */
export interface BrainstormDecorated {
  brainstorm: BrainstormSessionRow & {
    project_slug?: string | null;
    audio_path?: string | null;
    distilled_at?: string | null;
    kind?: "brainstorm" | "meeting";
    consent_acked?: number;
    keep_audio?: number;
    provenance?: "voice" | "audit-document" | "synthetic";
  };
  audio_url: string | null;
  cues_url: string | null;
}
export interface BrainstormFilter {
  kind?: "brainstorm" | "meeting";
  project?: string;
  mode?: string;
  date?: string;
  limit?: number;
}
export const listBrainstormsApi = (opts: BrainstormFilter = {}) => {
  const qs = new URLSearchParams();
  if (opts.kind) qs.set("kind", opts.kind);
  if (opts.project) qs.set("project", opts.project);
  if (opts.mode) qs.set("mode", opts.mode);
  if (opts.date) qs.set("date", opts.date);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<{ ok: boolean; brainstorms: BrainstormDecorated[] }>(
    `/brainstorms${q ? `?${q}` : ""}`,
  );
};
/* Brainstorm-as-durable-primary-entity (2026-05-22, plan section L
 * + N). Open lex_worker_expectation rows joined into the brainstorm
 * detail response. */
export interface WorkerExpectationRow {
  id: string;
  brainstorm_id: string;
  anchor_id: string;
  expected_outcome: string;
  expected_files: string;
  expected_duration_ms: number | null;
  created_at: string;
  closed_at: string | null;
  closed_reason:
    | "completed"
    | "drifted"
    | "superseded"
    | "cancelled"
    | null;
  last_evaluated_at: string | null;
  last_alignment_score: number | null;
  last_drift_summary: string | null;
  last_suggested_correction: string | null;
}

export interface BrainstormStaleness {
  fresh: number;
  stale: number;
  total: number;
  oldest_stale_ms: number | null;
}

export const getBrainstormApi = (id: string) =>
  request<{
    ok: boolean;
    brainstorm: BrainstormDecorated;
    open_expectations?: WorkerExpectationRow[];
    staleness?: BrainstormStaleness;
    error?: string;
  }>(`/brainstorms/${encodeURIComponent(id)}`);

/* Brainstorm-as-durable-primary-entity (2026-05-22, Path B). */
export const createStandaloneBrainstormApi = (body: {
  user_label?: string;
  mode?: "conversation" | "notes" | "push-to-talk";
}) =>
  request<{ ok: boolean; brainstorm: BrainstormDecorated; error?: string }>(
    "/brainstorms/standalone",
    {
      method: "POST",
      body,
    },
  );

export const attachBrainstormWorkerApi = (id: string, ccSessionId: string) =>
  request<{ ok: boolean; brainstorm: BrainstormDecorated; error?: string }>(
    `/brainstorms/${encodeURIComponent(id)}/attach-worker`,
    {
      method: "POST",
      body: { cc_session_id: ccSessionId },
    },
  );

export const detachBrainstormWorkerApi = (id: string) =>
  request<{ ok: boolean; brainstorm: BrainstormDecorated; error?: string }>(
    `/brainstorms/${encodeURIComponent(id)}/detach-worker`,
    { method: "POST" },
  );

export interface AudioCue {
  turn_index: number;
  start_ms: number;
  end_ms: number;
}
export interface BrainstormCues {
  session_id: string;
  sample_rate: number;
  channels: number;
  bits_per_sample: number;
  cues: AudioCue[];
}
export const getBrainstormCuesApi = (id: string) =>
  request<BrainstormCues>(`/brainstorms/${encodeURIComponent(id)}/cues`);

/* Wave 3 fixup (bug: 2026-05-10-brainstorm-picker-and-transcripts).
 * BrainstormChunkRow shape mirrors the daemon's table. The text
 * surface (BrainstormTranscript component) renders these as
 * user/lex/tool turns; embeddings are not transferred over the wire. */
export interface BrainstormChunkRow {
  id: string;
  brainstorm_id: string;
  turn_index: number;
  role: "user" | "lex" | "tool";
  mode: "conversation" | "notes" | "push-to-talk";
  text: string;
  model_id: string;
  no_decay: number;
  created_at: string;
}
export const getBrainstormChunksApi = (
  id: string,
  limit = 200,
  opts: { order?: 'asc' | 'desc'; offset?: number } = {},
) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.order) params.set('order', opts.order);
  if (typeof opts.offset === 'number') params.set('offset', String(opts.offset));
  return request<{ ok: boolean; chunks: BrainstormChunkRow[]; total?: number }>(
    `/brainstorms/${encodeURIComponent(id)}/chunks?${params.toString()}`,
  );
};

/* Wave 2 day 3 step 13. Borderline-band candidates from
 * `npm run backfill-brainstorms` await one-click link / reject. */
export interface BackfillReviewRow {
  id: string;
  brainstorm_id: string;
  candidate_page_slug: string;
  cosine: number;
  band: "high" | "borderline" | "low";
  status: "pending" | "linked" | "rejected" | "skipped";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}
export const listBackfillReview = (
  opts: {
    status?: BackfillReviewRow["status"];
    band?: BackfillReviewRow["band"];
    limit?: number;
  } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.band) qs.set("band", opts.band);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<{ ok: boolean; candidates: BackfillReviewRow[] }>(
    `/brainstorms/backfill-review${q ? `?${q}` : ""}`,
  );
};
export const linkBackfillReview = (id: string) =>
  request<{ ok: boolean; row?: BackfillReviewRow; error?: string; conflict?: string }>(
    `/brainstorms/backfill-review/${encodeURIComponent(id)}/link`,
    { method: "POST" },
  );
export const rejectBackfillReview = (id: string) =>
  request<{ ok: boolean; row?: BackfillReviewRow; error?: string; conflict?: string }>(
    `/brainstorms/backfill-review/${encodeURIComponent(id)}/reject`,
    { method: "POST" },
  );
/* Wave 2 day 4 audit_findings + curator/wrong + runtime_config. */
export interface AuditFindingRow {
  id: string;
  source: "lint" | "self-audit" | "canary" | "user-flag" | "schema-regression";
  severity: "low" | "medium" | "high";
  page_slug: string | null;
  brainstorm_id: string | null;
  finding: string;
  detail: string | null;
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  created_at: string;
  resolved_at: string | null;
}
export const listAuditFindings = (
  opts: {
    status?: AuditFindingRow["status"];
    source?: AuditFindingRow["source"];
    severity?: AuditFindingRow["severity"];
    page?: string;
    limit?: number;
  } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.source) qs.set("source", opts.source);
  if (opts.severity) qs.set("severity", opts.severity);
  if (opts.page) qs.set("page", opts.page);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<{ ok: boolean; findings: AuditFindingRow[] }>(
    `/audit-findings${q ? `?${q}` : ""}`,
  );
};
export const updateAuditFinding = (
  id: string,
  action: "acknowledge" | "resolve" | "dismiss",
) =>
  request<{ ok: boolean; finding?: AuditFindingRow; error?: string }>(
    `/audit-findings/${encodeURIComponent(id)}/${action}`,
    { method: "POST" },
  );
export const triggerLintNow = () =>
  request<{ ok: boolean; result?: unknown }>(`/admin/lint/run`, {
    method: "POST",
  });
export const triggerSelfAudit = (sample = 10) =>
  request<{ ok: boolean; result?: unknown }>(`/admin/self-audit/run`, {
    method: "POST",
    body: { sample },
  });
export const curatorWrong = (page_id: string, opts: { curator_log_id?: string; note?: string } = {}) =>
  request<{ ok: boolean; weight?: number; corrections?: number; archived?: boolean; error?: string }>(
    `/curator/wrong`,
    { method: "POST", body: { page_id, ...opts } },
  );

export interface RuntimeConfigRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}
export const listRuntimeConfig = () =>
  request<{ ok: boolean; config: RuntimeConfigRow[] }>(`/runtime-config`);
/* Wave 2 day 5: meetings + lex feedback + lex prompts + lex replay
 * + lex awareness. */
export interface MeetingRow extends BrainstormSessionRow {
  project_slug?: string | null;
  audio_path?: string | null;
  consent_acked?: number;
  consent_acked_at?: string | null;
  consent_acked_by?: string | null;
  keep_audio?: number;
  attendees?: string | null;
  meeting_topic?: string | null;
  kind?: "brainstorm" | "meeting";
}
export interface MeetingActionItem {
  id: string;
  meeting_id: string;
  text: string;
  assignee: string | null;
  due: string | null;
  reminder_id: string | null;
  status: "open" | "done" | "dismissed" | "superseded";
  source_turn_index: number | null;
  created_at: string;
  resolved_at: string | null;
}
export const listMeetings = (
  opts: { project?: string; date?: string; consent?: "acked" | "pending"; limit?: number } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.project) qs.set("project", opts.project);
  if (opts.date) qs.set("date", opts.date);
  if (opts.consent) qs.set("consent", opts.consent);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<{ ok: boolean; meetings: MeetingRow[] }>(
    `/meetings${q ? `?${q}` : ""}`,
  );
};
export const getMeeting = (id: string) =>
  request<{
    ok: boolean;
    meeting: MeetingRow;
    action_items: MeetingActionItem[];
    audio_purges_at: string | null;
    error?: string;
  }>(`/meetings/${encodeURIComponent(id)}`);
/* Meeting-notes fixes (2026-07), task 4 (F4): attendees + meeting_topic
 * had columns and no write endpoint. Pass null to clear a field;
 * omit a key to leave it unchanged. */
export const patchMeeting = (
  id: string,
  body: { attendees?: string | null; meeting_topic?: string | null },
) =>
  request<{ ok: boolean; meeting?: MeetingRow; error?: string }>(
    `/meetings/${encodeURIComponent(id)}`,
    { method: "PATCH", body },
  );
export const consentAckMeeting = (id: string, acked_by?: string) =>
  request<{ ok: boolean; meeting?: MeetingRow; error?: string }>(
    `/meetings/${encodeURIComponent(id)}/consent-ack`,
    { method: "POST", body: { acked_by } },
  );
export const setMeetingKeepAudio = (id: string, keep: boolean) =>
  request<{ ok: boolean; meeting?: MeetingRow; error?: string }>(
    `/meetings/${encodeURIComponent(id)}/keep-audio`,
    { method: "POST", body: { keep } },
  );
export const addMeetingActionItem = (
  id: string,
  body: { text: string; assignee?: string; due?: string },
) =>
  request<{ ok: boolean; action_items: MeetingActionItem[]; error?: string }>(
    `/meetings/${encodeURIComponent(id)}/action-items`,
    { method: "POST", body },
  );
export const updateMeetingActionItem = (
  meetingId: string,
  itemId: string,
  status: MeetingActionItem["status"],
) =>
  request<{ ok: boolean; action_item?: MeetingActionItem; error?: string }>(
    `/meetings/${encodeURIComponent(meetingId)}/action-items/${encodeURIComponent(itemId)}`,
    { method: "PATCH", body: { status } },
  );
export const promoteMeetingToWiki = (
  id: string,
  body: { slug?: string; title?: string } = {},
) =>
  request<{ ok: boolean; wiki_page_id?: string; error?: string }>(
    `/meetings/${encodeURIComponent(id)}/promote-to-wiki`,
    { method: "POST", body },
  );

export const lexFeedback = (body: {
  turn_id: string;
  prompt_version: string;
  vote: "up" | "down";
  reason?: string;
  brainstorm_id?: string | null;
}) =>
  request<{ ok: boolean; id?: string; error?: string }>(`/lex/feedback`, {
    method: "POST",
    body,
  });

export const listLexPromptVersions = () =>
  request<{ ok: boolean; versions: string[] }>(`/lex/prompts/versions`);

export interface LexAwarenessEvent {
  ts: string;
  kind: string;
  label: string;
  brainstorm_id?: string | null;
  detail?: Record<string, unknown>;
}
export const lexAwarenessRecent = (limit = 20, detail = false) =>
  request<{ ok: boolean; mode: string; events: LexAwarenessEvent[]; budget_remaining_tokens: number }>(
    `/lex/awareness/recent?limit=${limit}${detail ? "&detail=true" : ""}`,
  );

export const triggerLexReplay = (body: {
  input_path: string;
  version_a: string;
  version_b: string;
}) =>
  request<{ ok: boolean; result?: unknown; error?: string }>(
    `/admin/lex-replay`,
    { method: "POST", body },
  );

export const setRuntimeConfig = (key: string, value: string) =>
  request<{ ok: boolean; key?: string; value?: string; error?: string }>(
    `/runtime-config/${encodeURIComponent(key)}`,
    { method: "POST", body: { value } },
  );

export const triggerBackfillBrainstorms = () =>
  request<{
    ok: boolean;
    result?: {
      scanned: number;
      ingested: number;
      chunks_written: number;
      high_links: number;
      borderline_queued: number;
      low_logged: number;
      meetings_skipped_for_lineage: number;
      errors: string[];
    };
    error?: string;
  }>(`/admin/backfill/brainstorms`, { method: "POST" });

export interface WikiDraftRow {
  id: string;
  brainstorm_id: string;
  page_slug: string;
  page_title: string;
  body_markdown: string;
  confidence: number;
  status:
    | "pending"
    | "promoted"
    | "discarded"
    | "auto-promoted"
    | "auto-dropped"
    | "superseded";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}
export const listDrafts = (
  opts: { status?: WikiDraftRow["status"]; limit?: number } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<{ ok: boolean; drafts: WikiDraftRow[] }>(
    `/drafts${q ? `?${q}` : ""}`,
  );
};
export const getDraft = (id: string) =>
  request<{ ok: boolean; draft: WikiDraftRow; error?: string }>(
    `/drafts/${encodeURIComponent(id)}`,
  );
export const patchDraft = (
  id: string,
  patch: Partial<Pick<WikiDraftRow, "page_slug" | "page_title" | "body_markdown">>,
) =>
  request<{ ok: boolean; draft?: WikiDraftRow; error?: string; conflict?: string }>(
    `/drafts/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
  );
export const discardDraft = (id: string) =>
  request<{ ok: boolean; draft?: WikiDraftRow; error?: string; conflict?: string }>(
    `/drafts/${encodeURIComponent(id)}/discard`,
    { method: "POST" },
  );
export interface PromoteDraftBody {
  resolution?: "rename" | "merge" | "overwrite";
  new_slug?: string;
  force?: boolean;
  expected_resolved_at?: string | null;
}
export interface PromoteDraftResult {
  ok: boolean;
  draft?: WikiDraftRow;
  wiki_page_id?: string;
  wiki_page_path?: string;
  conflict?:
    | "slug_collision"
    | "frozen_target"
    | "superseded"
    | "target_drift"
    | "already_resolved";
  existing_page_id?: string;
  existing_status?: string;
  promoted_id?: string;
  error?: string;
}
export const promoteDraft = (id: string, body: PromoteDraftBody = {}) =>
  request<PromoteDraftResult>(`/drafts/${encodeURIComponent(id)}/promote`, {
    method: "POST",
    body,
  });

export interface LexArtifactItem {
  kind: string;
  category: string;
  id: string;
  title: string;
  created_ms: number;
  path: string;
  preview: string;
  /** Claude-Code assistant message uuid for the turn that produced
   * this artifact. Used as turn_id by LexThumbs. */
  turn_id?: string;
}
export const lexSessionArtifacts = (id: string) =>
  request<{
    ok: boolean;
    artifacts: LexArtifactItem[];
    /** System-prompt version archived at spawn time (Wave 2 day 5
     * step 20). Same value for every artifact in the session; surfaced
     * once so LexThumbs can pin it on every per-turn vote. */
    session_prompt_version?: string;
  }>(
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
/** Surface gate for /notifications. 'bell' drops notify_class=
 * 'conversation' rows so the top-bar dropdown stays high-signal;
 * 'activity' returns every row for the right-rail live feed. The
 * daemon-side default (no `surface` param) returns every row. */
export type NotificationSurface = "bell" | "activity";
export const notifications = (
  limit = 50,
  surface?: NotificationSurface,
) =>
  request<{ ok: boolean; notifications: Notification[] }>(
    `/notifications?limit=${limit}${surface ? `&surface=${surface}` : ""}`,
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

/* Clear-all for one surface (2026-07-16: the bell needs a sweep). */
export const dismissAllNotifications = (scope: NotificationScope) =>
  request<{ ok: boolean; cleared: number }>(`/notifications/dismiss-all`, {
    method: "POST",
    body: { scope },
  });

/* Regenerate the whats-new digest behind the daily brief (cheap file
 * aggregation daemon-side; the brief's refresh button drives this). */
export const regenerateWhatsNew = (days: number = 7) =>
  request<{ ok: boolean }>(`/whats-new`, {
    method: "POST",
    body: { days },
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
/* Callers must handle the rejection (react-query's isError, etc). A silent
 * .catch(() => ({ projects: [] })) used to live here, which meant a daemon
 * that was actually unreachable rendered identically to a daemon with zero
 * registered projects - ProjectsGrid had no way to tell "empty" from
 * "broken" and always showed the "No projects registered yet" empty state. */
export const projects = () => request<{ projects: ProjectRecord[] }>("/projects");
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

// ── knowledge index (doc browse, DRIVE-QUEUE 2B) ────────────────
export interface DocChunkPointer {
  heading: string;
  line: number;
  snippet: string;
}
export interface DocFile {
  store: string;
  path: string;
  name: string;
  chunks: DocChunkPointer[];
}
export interface DocIndexResponse {
  ok: boolean;
  project_id: string;
  total_files: number;
  total_chunks: number;
  files: DocFile[];
}
/** Browse the project-doc knowledge index for one project (strict-scoped
 * by the daemon). Returns an empty payload on any failure so the orb
 * renders an empty state instead of throwing. */
export const docIndex = (projectId: string) =>
  request<DocIndexResponse>(
    `/lex/doc-index?project_id=${encodeURIComponent(projectId)}`,
  ).catch(() => ({
    ok: false,
    project_id: projectId,
    total_files: 0,
    total_chunks: 0,
    files: [] as DocFile[],
  }));

// ── project lifecycle (DRIVE-QUEUE 3) ───────────────────────────
export interface LifecycleGate {
  satisfied: boolean;
  reason: string;
}
export interface LifecycleResponse {
  ok: boolean;
  project_session_id: string | null;
  cwd: string;
  stage: string;
  stage_label: string;
  gate: LifecycleGate;
  can_advance: boolean;
  next_stage: string | null;
  next_label: string | null;
  needs: string;
  signals: Record<string, unknown>;
}
/** Read a project's lifecycle stage + gate. By default runs cheap fs
 * probes; pass runTests to actually run the suite for the test gate.
 * Returns null on failure so the rail falls back to the cold-start view. */
export const lifecycle = (opts: {
  cwd?: string;
  project_session_id?: string;
  runTests?: boolean;
}) => {
  const qs = new URLSearchParams();
  if (opts.project_session_id) qs.set("project_session_id", opts.project_session_id);
  if (opts.cwd) qs.set("cwd", opts.cwd);
  if (opts.runTests) qs.set("run_tests", "1");
  return request<LifecycleResponse>(`/lex/lifecycle?${qs.toString()}`).catch(
    () => null,
  );
};
/** Set a project's stage (state-machine validated server-side). */
export const setLifecycleStage = (input: {
  project_session_id?: string;
  cwd?: string;
  stage: string;
  force?: boolean;
}) =>
  request<{
    ok: boolean;
    stage?: string;
    stage_label?: string;
    previous?: string;
    error?: string;
    from?: string;
    allowed?: string[];
  }>("/lex/lifecycle", { method: "POST", body: input });

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

// ── unified graph (all 4 node kinds) ───────────────────────────
export type UnifiedNodeKind = "brainstorm" | "wiki" | "project" | "meeting";
export type UnifiedEdgeKind = "lineage" | "wiki-cross-ref" | "project-spawn";
export interface UnifiedGraphNode {
  id: string;
  kind: UnifiedNodeKind;
  title: string;
  weight: number;
  last_active: string;
  wiki_status?: "canonical" | "pending" | "archived";
  is_draft?: boolean;
  project_slug?: string | null;
  source_brainstorms?: string[];
  source_meetings?: string[];
}
export interface UnifiedGraphEdge {
  source: string;
  target: string;
  kind: UnifiedEdgeKind;
  weight: number;
}
export interface UnifiedGraphResponse {
  ok: boolean;
  nodes: UnifiedGraphNode[];
  edges: UnifiedGraphEdge[];
}
export const graphUnified = () => request<UnifiedGraphResponse>("/graph/unified");

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
  /* Phase Two frontmatter (Wave 2 day 3 step 12). Optional on legacy
   * pages that pre-date migration 009; reads default to safe values
   * via the daemon's response builder. */
  schema_version?: number | null;
  last_verified?: string | null;
  frozen?: boolean;
  source_brainstorms?: string[];
  source_meetings?: string[];
  derived_from_brainstorm?: boolean;
  derived_from_meeting?: boolean;
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

// ── Panic button ────────────────────────────────────────────────
export interface PanicResponse {
  ok: boolean;
  result: "accepted" | "pty_not_found" | "no_target";
  target_anchor_id: string | null;
  log_id: string;
}
export interface PanicLogRow {
  id: string;
  ts: string;
  target_anchor_id: string | null;
  target_pty_id: string | null;
  target_session_id: string | null;
  clicked_ms: number;
  caller: string;
  result: "accepted" | "pty_not_found" | "no_target";
}
export const firePanic = (caller: string = "dashboard") =>
  request<PanicResponse>("/panic", {
    method: "POST",
    body: { caller, clicked_ms: Date.now() },
  });
export const fireProjectInterrupt = (
  anchorId: string,
  caller: string = "dashboard",
) =>
  request<PanicResponse>(
    `/projects/${encodeURIComponent(anchorId)}/interrupt`,
    { method: "POST", body: { caller, clicked_ms: Date.now() } },
  );
export const recentPanics = (limit: number = 20) =>
  request<{ ok: boolean; panics: PanicLogRow[] }>(
    `/panic/recent?limit=${limit}`,
  );

// ── Project anchor PATCH (supervision_mode + title) ─────────────
export type SupervisionMode = "polling" | "event" | "off";
export interface ProjectAnchorView {
  id: string;
  project_slug: string;
  cwd: string;
  title: string | null;
  status: "live" | "dormant";
  current_session_id: string | null;
  current_bridge_id: string | null;
  bridge_connection_count: number;
  current_pty_id: string | null;
  created_ms: number;
  last_seen_ms: number;
  exists_on_disk: boolean;
  supervision_mode: SupervisionMode;
}
export const patchProjectAnchor = (
  anchorId: string,
  patch: { title?: string | null; supervision_mode?: SupervisionMode },
) =>
  request<{ ok: boolean; anchor?: ProjectAnchorView; error?: string }>(
    `/projects/${encodeURIComponent(anchorId)}`,
    { method: "PATCH", body: patch },
  );

export interface ProjectAnchorTile {
  anchor_id: string;
  project_slug: string;
  title: string | null;
  cwd: string;
  status: "live" | "dormant";
  current_session_id: string | null;
  current_bridge_id: string | null;
  bridge_connection_count: number;
  current_pty_id: string | null;
  transcript_path: string | null;
  phase: "thinking" | "tool" | "permission" | "idle" | "unknown";
  pending_prompt: { text: string; ts: number } | null;
  last_activity_ms: number;
  transcript_count: number;
  supervision_mode: SupervisionMode;
}
export const listProjectAnchorTiles = (opts?: { status?: "live" | "all" }) =>
  request<{ ok: boolean; tiles: ProjectAnchorTile[] }>(
    opts?.status === "all"
      ? "/projects/anchor-tiles?status=all"
      : "/projects/anchor-tiles",
  );

// ── Smart-compact audit ─────────────────────────────────────────
export interface SmartCompactLogRow {
  id: string;
  ts: string;
  anchor_id: string | null;
  cc_session_id: string | null;
  caller: string;
  reason: string;
  /* clear-and-paste / wrap-paste are the Lex-driven v2 actions the
   * daemon has written since the policy-out endpoints landed; the
   * union previously missed them and the audit panel fell through
   * to unstyled raw tokens. */
  action:
    | "fire"
    | "wrap"
    | "shadow"
    | "noop"
    | "clear-and-paste"
    | "wrap-paste";
  pre_ctx_pct: number | null;
  post_ctx_pct: number | null;
  summary_preview: string | null;
  payload_text: string | null;
}
export const recentSmartCompacts = (limit: number = 20) =>
  request<{ ok: boolean; rows: SmartCompactLogRow[] }>(
    `/lex/smart-compact/recent?limit=${limit}`,
  );

// ── Auto-advance supervisor runtime toggle (phase 4) ────────────
export type AutoAdvanceMode = "off" | "shadow" | "live";

export interface AutoAdvanceToggle {
  ok: boolean;
  mode: AutoAdvanceMode;
  runtime_value: string | null;
  env_value: string | null;
  default_mode: AutoAdvanceMode;
}
export const autoAdvanceToggle = () =>
  request<AutoAdvanceToggle>(`/lex/auto-advance/toggle`);
export const setAutoAdvanceToggle = (mode: AutoAdvanceMode) =>
  request<AutoAdvanceToggle>(`/lex/auto-advance/toggle`, {
    method: "POST",
    body: { mode },
  });

export interface AutoAdvanceLogRow {
  id: string;
  created_at: string;
  anchor_id: string | null;
  turn_uuid: string | null;
  item_id: string | null;
  mode: AutoAdvanceMode;
  decision: "shadow" | "would-inject" | "accepted" | "skip" | "error";
  reason: string | null;
  would_inject_preview: string | null;
  footer_status: string | null;
  footer_needs_attention: number | null;
  epoch: number | null;
}
export const recentAutoAdvance = (
  opts: {
    limit?: number;
    anchor_id?: string;
    mode?: AutoAdvanceMode;
    decision?: AutoAdvanceLogRow["decision"];
  } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.anchor_id) qs.set("anchor_id", opts.anchor_id);
  if (opts.mode) qs.set("mode", opts.mode);
  if (opts.decision) qs.set("decision", opts.decision);
  const q = qs.toString();
  return request<{ ok: boolean; rows: AutoAdvanceLogRow[] }>(
    `/lex/auto-advance/recent${q ? `?${q}` : ""}`,
  );
};

// ── Smart-compact runtime toggle ────────────────────────────────
export type SmartCompactMode = "off" | "shadow" | "live";

export interface SmartCompactToggle {
  ok: boolean;
  mode: SmartCompactMode;
  runtime_value: string | null;
  env_value: string | null;
  default_mode: SmartCompactMode;
}
export const smartCompactToggle = () =>
  request<SmartCompactToggle>(`/lex/smart-compact/toggle`);
export const setSmartCompactToggle = (mode: SmartCompactMode) =>
  request<SmartCompactToggle>(`/lex/smart-compact/toggle`, {
    method: "POST",
    body: { mode },
  });

// ── Lex cold-start preload toggle ───────────────────────────────
export type ColdStartPreloadMode = "off" | "shadow" | "live";

export interface ColdStartPreloadToggle {
  ok: boolean;
  mode: ColdStartPreloadMode;
  runtime_value: string | null;
  env_value: string | null;
  default_mode: ColdStartPreloadMode;
}
export const coldStartPreloadToggle = () =>
  request<ColdStartPreloadToggle>(`/lex/cold-start-preload/toggle`);
export const setColdStartPreloadToggle = (mode: ColdStartPreloadMode) =>
  request<ColdStartPreloadToggle>(`/lex/cold-start-preload/toggle`, {
    method: "POST",
    body: { mode },
  });

export interface InjectionLogRow {
  id: string;
  ts: string;
  target_session: string;
  caller_label: string | null;
  text_preview: string;
  text_length: number;
  decision:
    | "accepted"
    | "rejected_auth"
    | "rejected_allowlist"
    | "rejected_pty"
    | "shadow";
  reject_reason: string | null;
  brainstorm_id: string | null;
}
export const injectionLog = (opts: {
  caller_label?: string;
  decision?: InjectionLogRow["decision"];
  limit?: number;
} = {}) => {
  const params = new URLSearchParams();
  if (opts.caller_label) params.set("caller_label", opts.caller_label);
  if (opts.decision) params.set("decision", opts.decision);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<{ ok: boolean; logs: InjectionLogRow[] }>(
    `/lex/injection-log${qs ? `?${qs}` : ""}`,
  );
};

export interface ColdStartPreloadEvent {
  ts: string;
  brainstorm_id: string;
  cc_session_id: string | null;
  sibling_count: number;
  last_distilled_ms: number | null;
  recent_turns_appended: number;
  preloaded_ids: string[];
  already_present_ids: string[];
  failure_reason: string | null;
  preamble: string;
  /* Codex item 6 freshness barrier counters. Default 0/0/false on
   * legacy rows so the dashboard chip renders only when at least one
   * field is non-zero. */
  stale_refs_count?: number;
  synced_refs_count?: number;
  partial_sync?: boolean;
  /* Fix 55 cold-start vetting. Verdict + last-child metadata mirror
   * the new fields on the daemon-side summary so the panel renders
   * the same view Lex sees. Optional for legacy rows. */
  context_verdict?: "fresh" | "stale" | "partial" | "outdated" | "empty";
  last_child_session_id?: string | null;
  last_child_session_title?: string | null;
  last_child_session_ended_ms?: number | null;
  distillation_gap_ms?: number | null;
}

export interface ColdStartPreloadEventGroup {
  brainstorm_id: string;
  cc_session_id: string | null;
  rows: ColdStartPreloadEvent[];
}

export const coldStartPreloadEvents = (
  opts: { brainstorm_id?: string; limit?: number } = {},
) => {
  const params = new URLSearchParams();
  if (opts.brainstorm_id) params.set("brainstorm_id", opts.brainstorm_id);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<
    | { ok: boolean; rows: ColdStartPreloadEvent[] }
    | { ok: boolean; groups: ColdStartPreloadEventGroup[] }
  >(`/lex/cold-start-preload/events${qs ? `?${qs}` : ""}`);
};

/* Phase 5 of LEX-STANDALONE-SUPERVISION: idle activity panel. The
 * daemon exposes one row per brainstorm whose lifecycle_state is
 * 'idle' or 'attached' with silence + pending grooming pass. */
export type IdleActivityGroomingKind = 'light' | 'mid' | 'cold' | 'day-cap';

export interface IdleActivityRow {
  brainstormId: string;
  user_label: string | null;
  lifecycle_state: 'idle' | 'attached';
  runtime_mode: 'cc-pty' | 'direct-llm' | 'detached' | null;
  last_user_utterance_at: string | null;
  last_grooming_pass_at: string | null;
  last_grooming_kind: IdleActivityGroomingKind | null;
  silence_ms: number;
  baseline_ms: number;
  pending_pass: IdleActivityGroomingKind | null;
}

export const idleActivity = () =>
  request<{ ok: boolean; rows: IdleActivityRow[]; generated_at: string }>(
    '/lex/idle-activity',
  );

export const uploadReference = (file: File, opts: { project_id?: string; tags?: string[] } = {}) => {
  const fd = new FormData();
  fd.append("file", file);
  if (opts.project_id) fd.append("project_id", opts.project_id);
  if (opts.tags?.length) fd.append("tags", opts.tags.join(","));
  return request<{ ok: boolean; doc_id?: string; error?: string }>("/upload", { body: fd });
};
