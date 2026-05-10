/**
 * Wave 2 day 5 step 24b (LX-7 + LX-8 + spec Appendix R). Lex
 * three-level awareness scaffolding.
 *
 * L1 broadcaster: structured event stream that pushes diff-only
 *     state to Lex. Idle suppression (no events when nothing
 *     changed), token-budget gate (drop events when the per-minute
 *     budget is exhausted), per-mode verbosity (meeting mode
 *     disables every emit).
 *
 * L2 recent_context(): callable helper exposing the last N
 *     awareness events as a snapshot Lex can ask for explicitly.
 *
 * L3 push-on-change: the broadcaster emits a synthetic event
 *     whenever an actionable change crosses a threshold (audit
 *     finding lands, reminder due, draft auto-dropped, canary
 *     fails). The actual hooks land in their producer modules in
 *     follow-ups; this scaffolding accepts the events.
 *
 * The actual delivery channel to Lex is out of scope for Wave 2
 * day 5; this module provides the in-process buffer + per-mode
 * gate + token budget so future PTY-side wiring (Wave 3) can pick
 * up a stable API.
 */

export type AwarenessEventKind =
  | 'audit-finding'
  | 'reminder-due'
  | 'draft-auto-dropped'
  | 'canary-fail'
  | 'session-start'
  | 'session-end'
  | 'capture'
  | 'manual';

export interface AwarenessEvent {
  ts: string;
  kind: AwarenessEventKind;
  /* Short label rendered into Lex's recent_context() snapshot.
   * Token-counted against the per-minute budget. */
  label: string;
  /* Optional fuller payload for L2 lookups. Not counted against the
   * budget because it is only emitted when Lex explicitly calls
   * recent_context() with detail=true. */
  detail?: Record<string, unknown>;
  /* When the producer is associated with a brainstorm/meeting, scope
   * the event so meeting mode can reliably suppress its own state. */
  brainstorm_id?: string | null;
}

export type LexMode = 'conversation' | 'push-to-talk' | 'notes';

const MAX_EVENTS = 200;
/* Token budget: roughly one short label + timestamp per event, ~25
 * tokens. Default budget = 400 tokens/min ≈ 16 events/min. */
const BUDGET_PER_MIN = Number(
  process.env.DEVNEURAL_AWARENESS_BUDGET_PER_MIN ?? 400,
);
const APPROX_TOKENS_PER_EVENT = 25;

interface AwarenessState {
  events: AwarenessEvent[];
  mode: LexMode;
  /* Sliding-window emit log for the budget gate. Each entry is a
   * timestamp ms; older entries get pruned on every emit attempt. */
  budgetWindowMs: number[];
  /* Last-emitted per kind so identical events from a chatty producer
   * collapse to one emit (idle suppression). */
  lastByKind: Map<AwarenessEventKind, string>;
}

const state: AwarenessState = {
  events: [],
  mode: 'conversation',
  budgetWindowMs: [],
  lastByKind: new Map(),
};

export function setAwarenessMode(mode: LexMode): void {
  state.mode = mode;
}

export function getAwarenessMode(): LexMode {
  return state.mode;
}

function isIdleDuplicate(kind: AwarenessEventKind, label: string): boolean {
  /* Suppress identical labels of the same kind back-to-back; the
   * goal is "Lex should not see the same message twice in a row"
   * even when a producer fires every 30 seconds with no real change. */
  return state.lastByKind.get(kind) === label;
}

function withinBudget(): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  state.budgetWindowMs = state.budgetWindowMs.filter((t) => t >= cutoff);
  const projected = (state.budgetWindowMs.length + 1) * APPROX_TOKENS_PER_EVENT;
  return projected <= BUDGET_PER_MIN;
}

export interface EmitResult {
  emitted: boolean;
  reason?: 'meeting_mode' | 'idle_duplicate' | 'budget_exhausted';
}

export function emitAwarenessEvent(
  ev: Omit<AwarenessEvent, 'ts'>,
): EmitResult {
  /* Meeting mode suppresses every awareness emit (spec Appendix R:
   * "meeting mode disables all awareness"). Manual events from a
   * test or admin trigger still land so debugging works while a
   * meeting is in progress. */
  if (state.mode === 'notes' && ev.kind !== 'manual') {
    return { emitted: false, reason: 'meeting_mode' };
  }
  if (isIdleDuplicate(ev.kind, ev.label)) {
    return { emitted: false, reason: 'idle_duplicate' };
  }
  if (!withinBudget()) {
    return { emitted: false, reason: 'budget_exhausted' };
  }
  const full: AwarenessEvent = {
    ts: new Date().toISOString(),
    ...ev,
  };
  state.events.push(full);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  state.lastByKind.set(ev.kind, ev.label);
  state.budgetWindowMs.push(Date.now());
  return { emitted: true };
}

export interface RecentContextResult {
  mode: LexMode;
  events: AwarenessEvent[];
  /* Per-minute budget headroom expressed as approx remaining tokens. */
  budget_remaining_tokens: number;
}

export function recentContext(opts: { limit?: number; detail?: boolean } = {}): RecentContextResult {
  const limit = Math.min(MAX_EVENTS, Math.max(1, opts.limit ?? 20));
  const slice = state.events.slice(-limit);
  const events = opts.detail
    ? slice
    : slice.map((e) => ({
        ts: e.ts,
        kind: e.kind,
        label: e.label,
        ...(e.brainstorm_id ? { brainstorm_id: e.brainstorm_id } : {}),
      }));
  const used = state.budgetWindowMs.length * APPROX_TOKENS_PER_EVENT;
  return {
    mode: state.mode,
    events,
    budget_remaining_tokens: Math.max(0, BUDGET_PER_MIN - used),
  };
}

/* Test-only: clear the buffer + reset the budget window. */
export function _resetAwareness(): void {
  state.events = [];
  state.budgetWindowMs = [];
  state.lastByKind.clear();
  state.mode = 'conversation';
}
