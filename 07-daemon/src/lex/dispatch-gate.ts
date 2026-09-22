/**
 * Dispatch confirm gate. Phase B of docs/spec/LAYER-1-CONTROL.md
 * ("Mechanical confirm gate on worker dispatch"), with the carve-out
 * from AUTO-CLEAR.md T10.2.
 *
 * Why the gate exists. Lex (Layer 2) is told in its prompt to state the
 * plan and get a go-ahead before it sends work to a worker session. A
 * prompt rule holds only as well as the model follows it on a given turn.
 * This registry makes the rule mechanical. With the dispatch_confirm_gate
 * knob on, a worker dispatch that Lex sends through
 * POST /lex/inject-cross-session is parked here instead of running; the
 * route hands Layer 1 the parked summary, Layer 1 speaks it, and the
 * operator answers by voice. The daemon then calls release() (the original
 * body is dispatched unchanged) or reject() (Lex is told to revise). A
 * parked item nobody answers within the ttl comes back from expire() so
 * the route can tell Lex it timed out.
 *
 * Why context-management callers are exempt (AUTO-CLEAR T10.2). The
 * auto-clear machinery drives the worker through the same inject route:
 * compaction, clear, resume and re-prime of a session the operator already
 * authorized. Those calls are context management, not new work, so they
 * bypass the gate; asking for a spoken yes on each of them would stall a
 * loop the operator is deliberately not watching. The carve-out is a short
 * explicit list (isContextManagementCaller) matched on the label prefix and
 * nothing else. It must stay that narrow: any broader exemption (every
 * non-voice label, anything that looks system-generated) would reopen the
 * exact unauthorized-dispatch hole the gate closes, because the caller
 * picks its own caller_label.
 *
 * This module is pure: no I/O, no timers, no logging, no database, no
 * awareness events. The route owns every side effect (reading the knob,
 * deciding what to park, notifying Layer 1, running the released dispatch,
 * injecting the rejection or timeout note into Lex, and the periodic
 * expire() sweep). Time and id generation are injected so behaviour is
 * deterministic under test.
 */
import { randomUUID } from 'node:crypto';

export interface PendingDispatch {
  /** Short id the operator's answer and the route's audit line refer to. */
  id: string;
  /** Lex anchor (brainstorm) whose Layer 2 asked for the dispatch. */
  anchorId: string;
  /** The original POST /lex/inject-cross-session body, verbatim. Released unchanged. */
  body: Record<string, unknown>;
  /** body.caller_label when it is a string, else null. */
  callerLabel: string | null;
  /** body.text collapsed to one line and capped for speech; '' when text is missing. */
  summary: string;
  /** Injected clock reading at park time; drives newest-wins and the ttl. */
  parkedAtMs: number;
}

/* Labels (exact match or prefix) whose dispatches bypass the gate. Keep this
 * list short and explicit (T10.2); do not generalise it to a pattern. */
const CONTEXT_MANAGEMENT_PREFIXES: readonly string[] = [
  'smart-compact:',
  'smart-clear',
  'event-supervisor',
  'auto-supervisor',
];

/* Longest summary Layer 1 is asked to read aloud. */
const SUMMARY_MAX_CHARS = 200;

/* How long a parked dispatch waits for an answer before expire() returns it. */
const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * True when the trimmed label equals or starts with one of the
 * context-management labels. null, undefined and '' are not exempt.
 */
export function isContextManagementCaller(label: string | null | undefined): boolean {
  const trimmed = (label ?? '').trim();
  if (trimmed === '') return false;
  return CONTEXT_MANAGEMENT_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(p));
}

/* One-line, trimmed, capped rendering of body.text for the spoken ask. */
function summarise(body: Record<string, unknown>): string {
  const text = typeof body.text === 'string' ? body.text : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);
}

export class DispatchGate {
  private readonly pending = new Map<string, PendingDispatch>();
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly ttlMs: number;
  /* Suffix counter used only when the id generator repeats a live id. */
  private seq = 0;

  constructor(deps: { now: () => number; id?: () => string; ttlMs?: number }) {
    this.now = deps.now;
    this.id = deps.id ?? (() => randomUUID().slice(0, 8));
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Park a dispatch for `anchorId`. The body is held by reference, not copied. */
  park(anchorId: string, body: Record<string, unknown>): PendingDispatch {
    const item: PendingDispatch = {
      id: this.freshId(),
      anchorId,
      body,
      callerLabel: typeof body.caller_label === 'string' ? body.caller_label : null,
      summary: summarise(body),
      parkedAtMs: this.now(),
    };
    this.pending.set(item.id, item);
    return item;
  }

  /** Newest parked item for the anchor by parkedAtMs, or null when none. */
  pendingFor(anchorId: string): PendingDispatch | null {
    let newest: PendingDispatch | null = null;
    for (const item of this.pending.values()) {
      if (item.anchorId !== anchorId) continue;
      /* >= so a same-millisecond tie goes to the later park (Map keeps insertion order). */
      if (newest === null || item.parkedAtMs >= newest.parkedAtMs) newest = item;
    }
    return newest;
  }

  /** Remove and return the item so the caller can dispatch it; null when unknown. */
  release(id: string): PendingDispatch | null {
    const item = this.pending.get(id);
    if (item === undefined) return null;
    this.pending.delete(id);
    return item;
  }

  /**
   * Remove and return the item so the caller can tell Lex to revise; null
   * when unknown. The reason is the caller's to log or inject; the gate
   * does not keep it.
   */
  reject(id: string, _reason: string): PendingDispatch | null {
    return this.release(id);
  }

  /** Remove and return every item parked ttlMs or longer ago as of `nowMs`. */
  expire(nowMs: number): PendingDispatch[] {
    const expired: PendingDispatch[] = [];
    for (const item of this.pending.values()) {
      if (nowMs - item.parkedAtMs >= this.ttlMs) expired.push(item);
    }
    for (const item of expired) this.pending.delete(item.id);
    return expired;
  }

  /** Number of parked items across all anchors. */
  size(): number {
    return this.pending.size;
  }

  /* An id the registry does not already hold. A generator that repeats a
   * live id would otherwise overwrite a parked dispatch silently, and that
   * dispatch would never get a release, a rejection note or a timeout. */
  private freshId(): string {
    let id = this.id();
    while (this.pending.has(id)) id = `${this.id()}-${++this.seq}`;
    return id;
  }
}
