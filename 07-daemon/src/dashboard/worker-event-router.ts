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
  | 'expectation_drift';

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
let cachedTarget: CachedTarget | null = null;
const TARGET_CACHE_TTL_MS = 60_000;

export function resolveLexTargetSession(
  db: IndexDb,
  opts: { now?: number; ttlMs?: number } = {},
): string | null {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? TARGET_CACHE_TTL_MS;
  if (cachedTarget && now - cachedTarget.resolvedAtMs < ttl) {
    return cachedTarget.ccSessionId;
  }
  let ccSessionId: string | null = null;
  try {
    const rows = db.listLexSessions({ status: 'live', limit: 50 });
    /* Pick the most recently created live lex_session. The legacy
     * mode column lived on brainstorm_sessions; lex_session rows
     * inherit "conversation" by default and notes mode lives on the
     * legacy table only, so live lex_session rows are all
     * conversation-mode for supervision purposes. */
    const ordered = rows
      .slice()
      .sort((a, b) => b.created_ms - a.created_ms);
    const first = ordered[0];
    if (first) {
      const refs = db.listLexTranscriptRefs(first.id);
      const openRef = refs.find((r) => r.ended_ms === null) ??
        refs[refs.length - 1];
      ccSessionId = openRef?.cc_session_id ?? null;
    }
  } catch {
    ccSessionId = null;
  }
  cachedTarget = { ccSessionId, resolvedAtMs: now };
  return ccSessionId;
}

export function resetLexTargetCacheForTest(): void {
  cachedTarget = null;
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
  now?: number;
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

export function routeWorkerEvent(
  event: WorkerEvent,
  deps: RouteDeps,
): RouteResult {
  const now = deps.now ?? Date.now();
  const decision = deps.gate.evaluate(event, now);
  if (decision.decision === 'kill-switch') {
    deps.onKillSwitch?.(event.anchor_id);
    return { outcome: 'kill-switch', decision };
  }
  if (decision.decision === 'debounce') {
    return { outcome: 'debounced', decision };
  }
  const target = deps.resolveTarget?.() ?? null;
  if (!target) {
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
