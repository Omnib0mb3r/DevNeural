/**
 * Worker event router (EVENT-DRIVEN-SUPERVISION.md).
 *
 * Replaces polling-based Lex supervision with daemon-driven push.
 * When a worker session hits a watched event (idle, permission
 * denied, pending prompt, test failure, commit, bridge disconnect)
 * the daemon emits a synthetic prompt into Lex's brainstorm session
 * via the existing cross-session inject pipeline.
 *
 * This module owns three concerns:
 *   1. Event detection from a jsonl tail and bridge state changes.
 *   2. Debounce + per-anchor rate limit so a misbehaving worker
 *      cannot spam Lex's context.
 *   3. Payload assembly (the `[supervisor-event]` text that lands in
 *      Lex's prompt buffer).
 *
 * The actual chokidar subscription + cross-session inject call live
 * at the boundary in routes/daemon; this file stays pure so it is
 * trivially testable.
 */
import type { IndexDb, ProjectSessionRow } from '../store/index-db.js';
import { recordWorkerEventDiagnostic } from './worker-event-diagnostics.js';
import { emitNotification } from './notifications.js';

export type WorkerEventType =
  | 'idle'
  | 'permission_denied'
  | 'pending_prompt'
  | 'test_failure'
  | 'commit'
  | 'bridge_disconnect'
  /* Brainstorm-as-durable-primary-entity (2026-05-22, plan section L
   * reconcile). The expectation supervisor emits this when the LLM
   * judges the worker's recent activity is NOT aligned with the
   * expected outcome. Routing through WorkerEventGate keeps the
   * per-anchor 12/hour cap honest so a misbehaving evaluator cannot
   * spam Lex with corrections. */
  | 'expectation_drift'
  /* Fix 34d.2 (2026-05-26): false-shipment detector. Worker assistant
   * text claims "shipped" / "done" / "landed" / etc., but git HEAD
   * has not advanced for >=60 s since the claim. Cron-driven Lex
   * supervision was trusting narration over git; this surfaces the
   * mismatch so Lex can challenge rather than rubber-stamp. */
  | 'narrated_success_no_commit';

export interface WorkerEvent {
  type: WorkerEventType;
  anchor_id: string;
  worker_session_id: string;
  timestamp: string;
  snippet: string;
}

export interface DetectorDefaults {
  idleThresholdMs: number;
  snippetMaxBytes: number;
}

export function detectorDefaults(): DetectorDefaults {
  const num = (key: string, fb: number): number => {
    const raw = process.env[key];
    if (!raw) return fb;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fb;
  };
  return {
    idleThresholdMs: num('DEVNEURAL_WORKER_IDLE_THRESHOLD_MS', 10 * 60 * 1000),
    snippetMaxBytes: num('DEVNEURAL_WORKER_SNIPPET_BYTES', 2048),
  };
}

const PERMISSION_DENIED_RE =
  /Permission to use [\w_-]+ has been denied/;

/* True when the jsonl tail contains a recent tool_result whose content
 * matches the CC permission-denied phrase. The router fires once per
 * appearance; debouncing handles back-to-back denials of the same
 * tool. */
export function detectPermissionDenied(jsonlTail: string): boolean {
  return PERMISSION_DENIED_RE.test(jsonlTail);
}

const TEST_RUNNER_RE =
  /(?:\bvitest\b|\bjest\b|\bpytest\b|"args":\s*\[[^\]]*"test"|npm\s+(?:run\s+)?test\b|"command"\s*:\s*"test")/i;
/* Heuristic: jsonl tail mentions a test runner AND a non-zero exit
 * marker. Conservative on false positives; the spec says "informational
 * if the snippet is wrong, Lex pulls the full jsonl". */
export function detectTestFailure(jsonlTail: string): boolean {
  if (!TEST_RUNNER_RE.test(jsonlTail)) return false;
  if (/exit\s+(?:code\s+)?[1-9]\d*/i.test(jsonlTail)) return true;
  if (/Tests failed/i.test(jsonlTail)) return true;
  if (/FAIL\b.*\.(?:test|spec)\.[jt]sx?\b/.test(jsonlTail)) return true;
  return false;
}

/* Bash tool_result for `git commit` succeeded. Pattern lifted from
 * the existing capture pipeline. */
const COMMIT_RE = /\bgit\s+commit\b[\s\S]{0,400}?\b(\d+)\s+files?\s+changed\b/;
export function detectCommit(jsonlTail: string): boolean {
  if (COMMIT_RE.test(jsonlTail)) return true;
  if (/\[(?:main|master|[\w/-]+)\s+[a-f0-9]{7,}\]/.test(jsonlTail)) return true;
  return false;
}

export interface IdleInput {
  lastAssistantMs: number | null;
  pendingToolUse: boolean;
  now: number;
  thresholdMs: number;
}
export function detectIdle(input: IdleInput): boolean {
  if (input.pendingToolUse) return false;
  if (input.lastAssistantMs === null) return false;
  return input.now - input.lastAssistantMs > input.thresholdMs;
}

/* ── Debounce + rate limit ─────────────────────────────────────────── */

export interface DebounceConfig {
  /** Per-event-type minimum gap (ms) for the same anchor. */
  perTypeMinGapMs: number;
  /** Per-anchor hourly cap of events forwarded to Lex. */
  perAnchorHourlyCap: number;
  /** Runaway kill-switch: more than this many events in 10 min flips
   * supervision_mode to 'polling' for the offending anchor. */
  killSwitchPerTenMinutes: number;
}

export function debounceDefaults(): DebounceConfig {
  return {
    perTypeMinGapMs: 5 * 60 * 1000,
    perAnchorHourlyCap: 12,
    killSwitchPerTenMinutes: 20,
  };
}

export type RouteDecision =
  | { decision: 'accept' }
  | { decision: 'debounce'; reason: 'per-type-gap' | 'hourly-cap' }
  | { decision: 'kill-switch' };

export class WorkerEventGate {
  /* anchor_id -> event_type -> last-emit timestamp ms. */
  private lastFire = new Map<string, Map<WorkerEventType, number>>();
  /* anchor_id -> rolling list of emit timestamps. */
  private window = new Map<string, number[]>();

  constructor(private readonly cfg: DebounceConfig = debounceDefaults()) {}

  /* Decide whether `event` should be forwarded to Lex. Records the
   * acceptance internally so subsequent calls within the gap return
   * 'debounce'. The caller is expected to drop the event on
   * 'debounce' (queueing happens at the batch layer in the spec; left
   * for v2). */
  evaluate(event: WorkerEvent, now: number): RouteDecision {
    const last = this.lastFire.get(event.anchor_id) ?? new Map();
    const lastForType = last.get(event.type);
    if (
      lastForType !== undefined &&
      now - lastForType < this.cfg.perTypeMinGapMs
    ) {
      return { decision: 'debounce', reason: 'per-type-gap' };
    }
    const rolling = (this.window.get(event.anchor_id) ?? []).filter(
      (t) => now - t < 60 * 60 * 1000,
    );
    if (rolling.length >= this.cfg.perAnchorHourlyCap) {
      return { decision: 'debounce', reason: 'hourly-cap' };
    }
    const recent10 = rolling.filter((t) => now - t < 10 * 60 * 1000);
    if (recent10.length >= this.cfg.killSwitchPerTenMinutes) {
      return { decision: 'kill-switch' };
    }
    last.set(event.type, now);
    this.lastFire.set(event.anchor_id, last);
    rolling.push(now);
    this.window.set(event.anchor_id, rolling);
    return { decision: 'accept' };
  }

  /* Test helper: drop all state for an anchor. */
  reset(anchorId?: string): void {
    if (anchorId === undefined) {
      this.lastFire.clear();
      this.window.clear();
    } else {
      this.lastFire.delete(anchorId);
      this.window.delete(anchorId);
    }
  }
}

/* Brainstorm-as-durable-primary-entity (2026-05-22, plan section L
 * reconcile). Shared module-level WorkerEventGate so the legacy
 * worker-event-listener + the new expectation-supervisor share one
 * per-anchor rate-limit window. Without this, the supervisor's
 * expectation_drift fires would bypass the listener's 12/hour cap
 * and could spam corrections. Tests can replace via
 * setSharedWorkerEventGate. */
let sharedGate: WorkerEventGate | null = null;
export function getSharedWorkerEventGate(): WorkerEventGate {
  if (!sharedGate) sharedGate = new WorkerEventGate();
  return sharedGate;
}
export function setSharedWorkerEventGate(gate: WorkerEventGate | null): void {
  sharedGate = gate;
}

/* ── Payload assembly ──────────────────────────────────────────────── */

export interface PayloadInput {
  anchorLabel: string;
  event: WorkerEvent;
}

export function buildSupervisorPrompt(input: PayloadInput): string {
  const snippet = input.event.snippet.trim() || '(no snippet)';
  return [
    `[supervisor-event] worker=${input.anchorLabel} event=${input.event.type} at ${input.event.timestamp}`,
    '',
    'Snippet:',
    snippet,
    '',
    'Decide: re-inject worker, widen permissions, escalate to user, or no-op.',
  ].join('\n');
}

/* ── Lex target session resolver ───────────────────────────────────── */

interface CachedTarget {
  ccSessionId: string | null;
  resolvedAtMs: number;
}
/* Per-anchor cache. The pre-Fix-34 resolver kept a single global
 * cache, which meant the first call's verdict (often null when no
 * Lex was alive yet) leaked across every other project anchor for
 * 60 s. Keyed by the project anchor_id supplied by the caller so a
 * miss on one project does not poison the others; the unscoped
 * lookup (no anchor_id) uses the literal '__global__' key for
 * backward compatibility with /lex/inject-cross-session callers that
 * do not know which project they belong to. */
const cachedTargets = new Map<string, CachedTarget>();
const GLOBAL_KEY = '__global__';
const TARGET_CACHE_TTL_MS = 60_000;

export interface ResolveLexTargetSessionOptions {
  now?: number;
  ttlMs?: number;
  /** Fix 34: project anchor whose supervising Lex session should be
   * resolved. When provided, the resolver filters lex_session rows
   * by supervises_project_anchor_id = anchorId AND status = 'live'.
   * When omitted, falls back to the legacy "most recent live
   * lex_session globally" pick so callers outside the event-driven
   * supervisor keep working. */
  anchorId?: string | null;
}

export function resolveLexTargetSession(
  db: IndexDb,
  opts: ResolveLexTargetSessionOptions = {},
): string | null {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? TARGET_CACHE_TTL_MS;
  const cacheKey = opts.anchorId ?? GLOBAL_KEY;
  const cached = cachedTargets.get(cacheKey);
  if (cached && now - cached.resolvedAtMs < ttl) {
    return cached.ccSessionId;
  }
  let ccSessionId: string | null = null;
  try {
    /* Fix 34: anchor-scoped resolution. The supervisor pipeline now
     * threads the project anchor through, so this branch picks the
     * Lex session that has explicitly bound to that anchor via
     * lex_session.supervises_project_anchor_id. Pre-fix the resolver
     * picked the most recent live lex_session globally, which left
     * the wire silently no-op whenever the project's true supervisor
     * was not the most-recently-created lex row.
     *
     * Anchor-scoped pass tries supervising-Lex first. If none is
     * bound, falls back to the legacy global-pick so unbound projects
     * still get supervision (existing behaviour). */
    let candidates = opts.anchorId
      ? db.listLexSessionsBySupervises(opts.anchorId, {
          status: 'live',
          limit: 5,
        })
      : [];
    if (candidates.length === 0) {
      candidates = db
        .listLexSessions({ status: 'live', limit: 50 })
        .slice()
        .sort((a, b) => b.created_ms - a.created_ms);
    }
    for (const row of candidates) {
      const refs = db.listLexTranscriptRefs(row.id);
      /* Fix 34c: listLexTranscriptRefs returns refs ORDER BY ordering
       * ASC. In production every brainstorm ref has ended_ms === null
       * because the per-ref close-out never runs (separate cleanup
       * task). The pre-fix `find(r => r.ended_ms === null)` therefore
       * matched ORDERING=0 -- the oldest cc_session, often weeks
       * stale and with no bridge presence, so the inject path bailed
       * with no_deliverable_bridge. Walk newest-first so the most
       * recent open ref wins; the open-first intent is preserved for
       * when close-out is eventually wired. */
      const openRef =
        [...refs].reverse().find((r) => r.ended_ms === null) ??
        refs[refs.length - 1];
      if (openRef?.cc_session_id) {
        ccSessionId = openRef.cc_session_id;
        break;
      }
    }
  } catch {
    ccSessionId = null;
  }
  cachedTargets.set(cacheKey, { ccSessionId, resolvedAtMs: now });
  return ccSessionId;
}

export function resetLexTargetCacheForTest(): void {
  cachedTargets.clear();
}

/* ── Side-effect entry ─────────────────────────────────────────────── */

export interface RouteDeps {
  gate: WorkerEventGate;
  /** Resolves the Lex target CC session id. Defaults to
   * resolveLexTargetSession against the bound IndexDb. */
  resolveTarget?: () => string | null;
  /** Caller for the cross-session inject pipeline. Tests inject a
   * spy; production binds to the real endpoint client. */
  inject: (target: string, text: string) => { ok: boolean; reason?: string };
  /** Anchor lookup so we can derive a label for the payload. */
  anchor: ProjectSessionRow;
  /** Kill-switch handler. Called when the gate trips. Production sets
   * supervision_mode='polling' on the anchor and emits a notification. */
  onKillSwitch?: (anchorId: string) => void;
  /** Notification emitter for the no-target verdict (R1 fix, 2026-07-14:
   * for 26 days every worker event that resolved to no live lex_session
   * was silently discarded -- only the kill-switch path notified).
   * Defaults to the real dashboard emitter; tests inject a spy the same
   * way KillSwitchDeps.emit does. */
  emit?: typeof emitNotification;
  now?: number;
  /** Fix 34 diagnostics. When provided, the router records gate +
   * route-resolved verdicts to worker_event_diagnostic_log so a dead
   * branch surfaces in /dashboard/worker-event-stats. */
  db?: IndexDb;
}

export type RouteOutcome =
  | 'sent'
  | 'debounced'
  | 'no-target'
  | 'kill-switch'
  | 'inject-failed';

export interface RouteResult {
  outcome: RouteOutcome;
  decision: RouteDecision;
}

/* R1 fix (2026-07-14): 26 days of worker events silently routed to
 * verdict 'no-target' (no live lex_session) with zero operator
 * signal -- only the kill-switch path notified. Mirrors
 * WorkerEventGate's per-anchor debounce style: a module-level map of
 * anchor_id -> last-notified-ms, gapped at 60 minutes so a project
 * stuck without a live Lex session gets exactly one notification per
 * cooldown window instead of spamming the bell on every dropped
 * event. */
const NO_TARGET_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
const noTargetLastNotifiedMs = new Map<string, number>();

export function resetNoTargetNotifyStateForTest(): void {
  noTargetLastNotifiedMs.clear();
}

function notifyNoTarget(
  emit: typeof emitNotification | undefined,
  anchor: ProjectSessionRow,
  now: number,
): void {
  const last = noTargetLastNotifiedMs.get(anchor.id);
  if (last !== undefined && now - last < NO_TARGET_NOTIFY_COOLDOWN_MS) return;
  noTargetLastNotifiedMs.set(anchor.id, now);
  const label = anchor.title || anchor.project_slug || anchor.id.slice(0, 8);
  const doEmit = emit ?? emitNotification;
  doEmit({
    severity: 'warn',
    source: 'supervision',
    notify_class: 'signal',
    title: `Worker event dropped for ${label}`,
    body: `No live Lex session to deliver to; the event was discarded. Bind a Lex brainstorm to ${label} so future worker events reach a supervisor.`,
    link: '/projects',
  });
}

export function routeWorkerEvent(
  event: WorkerEvent,
  deps: RouteDeps,
): RouteResult {
  const now = deps.now ?? Date.now();
  const decision = deps.gate.evaluate(event, now);
  /* Per-event gate verdict instrumentation. Kept off the hot path
   * in production via the diagnostics writer's debug gate; here the
   * call is unconditional so the writer's gate logic stays the
   * single source of truth. */
  if (deps.db) {
    recordGateVerdict(
      deps.db,
      event.anchor_id,
      decision,
      event.type,
    );
  }
  if (decision.decision === 'kill-switch') {
    deps.onKillSwitch?.(event.anchor_id);
    return { outcome: 'kill-switch', decision };
  }
  if (decision.decision === 'debounce') {
    return { outcome: 'debounced', decision };
  }
  const target = deps.resolveTarget?.() ?? null;
  if (deps.db) {
    recordRouteResolved(deps.db, event.anchor_id, target, event.type);
  }
  if (!target) {
    notifyNoTarget(deps.emit, deps.anchor, now);
    return { outcome: 'no-target', decision };
  }
  const text = buildSupervisorPrompt({
    anchorLabel: deps.anchor.title || deps.anchor.project_slug,
    event,
  });
  const r = deps.inject(target, text);
  if (!r.ok) return { outcome: 'inject-failed', decision };
  return { outcome: 'sent', decision };
}

/* Diagnostics callers split out so the recordWorkerEventDiagnostic
 * import lives in a single place. The router module deliberately stays
 * minimal; the writer module owns the DEVNEURAL_SUPERVISOR_DEBUG gate. */
function recordGateVerdict(
  db: IndexDb,
  anchorId: string,
  decision: RouteDecision,
  eventType: WorkerEventType,
): void {
  recordWorkerEventDiagnostic({
    db,
    stage: 'gate.evaluated',
    anchorId,
    verdict:
      decision.decision === 'accept'
        ? 'accept'
        : decision.decision === 'kill-switch'
          ? 'kill-switch'
          : `debounce-${decision.reason}`,
    detail: `type=${eventType}`,
  });
}

function recordRouteResolved(
  db: IndexDb,
  anchorId: string,
  target: string | null,
  eventType: WorkerEventType,
): void {
  recordWorkerEventDiagnostic({
    db,
    stage: 'route.resolved',
    anchorId,
    verdict: target ? 'resolved' : 'no-target',
    detail: target
      ? `target=${target.slice(0, 16)} type=${eventType}`
      : `type=${eventType}`,
  });
}
