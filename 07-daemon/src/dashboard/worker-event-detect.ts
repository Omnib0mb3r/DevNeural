/**
 * Jsonl-tail event detection
 * (EVENT-DRIVEN-SUPERVISION.md, the producer side of routeWorkerEvent).
 *
 * Pure functions. The chokidar listener feeds a freshly-read tail of
 * the worker's jsonl on every change; this module turns that bytes
 * blob into a set of WorkerEvent instances ready for the router.
 *
 * State is carried per-anchor across calls so we can detect idle
 * (last assistant message older than threshold) without re-scanning
 * the full transcript every tick.
 */
import type { ProjectSessionRow } from '../store/index-db.js';
import {
  detectCommit,
  detectIdle,
  detectPermissionDenied,
  detectTestFailure,
  type WorkerEvent,
} from './worker-event-router.js';
import { extractEventSnippet } from './worker-event-snippet.js';

export interface AnchorTailState {
  /** Most recent assistant-message ts seen so far. Used by the
   * idle detector via detectIdle. */
  lastAssistantMs: number | null;
  /** Most recent tool_use ts seen so far. Idle suppresses while
   * this is recent. */
  lastToolMs: number | null;
  /** True between a tool_use line and the matching tool_result. The
   * idle detector ignores transcripts in flight. */
  pendingToolUse: boolean;
  /** Hash-ish of the last tail we processed, so a chokidar event
   * that fires twice for the same write is a no-op. The listener
   * passes through bytes; this module just owns the dedupe field. */
  lastTailSig: string;
  /** Events already fired during this anchor's runtime lifetime;
   * the route gate dedupes by type+anchor, but tracking last-fired
   * timestamps here lets us tell "a fresh occurrence" from "the
   * same permission-denial still sitting in the tail". */
  lastFiredAt: Partial<Record<WorkerEvent['type'], number>>;
}

export function newAnchorTailState(): AnchorTailState {
  return {
    lastAssistantMs: null,
    lastToolMs: null,
    pendingToolUse: false,
    lastTailSig: '',
    lastFiredAt: {},
  };
}

interface ParsedLine {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  uuid?: string;
}

function parseTs(s: string | undefined): number | null {
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

export interface ParsedTail {
  /** Most recent assistant ts in this tail. null if none. */
  newestAssistantMs: number | null;
  newestToolMs: number | null;
  /** True if the last tool_use line in the tail does not have a
   * matching tool_result after it. */
  trailingToolUse: boolean;
  /** Raw text we pass through to the WorkerEvent snippet field. */
  snippet: string;
}

export function parseJsonlTail(tail: string, snippetMaxBytes = 2048): ParsedTail {
  const lines = tail.split('\n').filter((l) => l.trim());
  let newestAssistantMs: number | null = null;
  let newestToolMs: number | null = null;
  let trailingToolUse = false;
  for (const line of lines) {
    let rec: ParsedLine;
    try {
      rec = JSON.parse(line) as ParsedLine;
    } catch {
      continue;
    }
    const ts = parseTs(rec.timestamp);
    const role = rec.role ?? rec.message?.role;
    if (role === 'assistant' && ts !== null) {
      if (newestAssistantMs === null || ts > newestAssistantMs) {
        newestAssistantMs = ts;
      }
    }
    /* Tool tracking: lines that mention tool_use bump newestToolMs
     * and flag trailingToolUse; tool_result clears the trailing
     * flag. The exact JSON shape varies (CC v1, v2, hooks), so we
     * grep loosely on the raw line. */
    if (/"type":"tool_use"|"tool_use_id"/.test(line)) {
      trailingToolUse = true;
      if (ts !== null && (newestToolMs === null || ts > newestToolMs)) {
        newestToolMs = ts;
      }
    }
    if (/"type":"tool_result"|"is_error"/.test(line)) {
      trailingToolUse = false;
    }
  }
  const snippet =
    tail.length <= snippetMaxBytes
      ? tail
      : tail.slice(tail.length - snippetMaxBytes);
  return { newestAssistantMs, newestToolMs, trailingToolUse, snippet };
}

export interface DeriveOptions {
  /** Per-event-type minimum gap between fires from this module. The
   * router's gate enforces the global cap; this nearby duplicate
   * is just to avoid emitting the same permission_denied twice in a
   * row when the tail still contains the same line. */
  perTypeMinFireGapMs?: number;
  idleThresholdMs?: number;
}

export interface DeriveResult {
  events: WorkerEvent[];
  nextState: AnchorTailState;
}

const DEFAULT_GAP_MS = 30_000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

function shouldFire(
  state: AnchorTailState,
  type: WorkerEvent['type'],
  now: number,
  gapMs: number,
): boolean {
  const last = state.lastFiredAt[type];
  if (last === undefined) return true;
  return now - last >= gapMs;
}

export function deriveEvents(
  parsed: ParsedTail,
  prev: AnchorTailState,
  anchor: ProjectSessionRow,
  now: number,
  tailSig: string,
  opts: DeriveOptions = {},
): DeriveResult {
  /* Carry state forward; only bump from newer signals. The merge is
   * non-destructive so an empty tail does not blow away history. */
  const lastAssistantMs =
    parsed.newestAssistantMs !== null &&
    (prev.lastAssistantMs === null ||
      parsed.newestAssistantMs > prev.lastAssistantMs)
      ? parsed.newestAssistantMs
      : prev.lastAssistantMs;
  const lastToolMs =
    parsed.newestToolMs !== null &&
    (prev.lastToolMs === null || parsed.newestToolMs > prev.lastToolMs)
      ? parsed.newestToolMs
      : prev.lastToolMs;
  const pendingToolUse = parsed.trailingToolUse;
  const nextState: AnchorTailState = {
    lastAssistantMs,
    lastToolMs,
    pendingToolUse,
    lastTailSig: tailSig,
    lastFiredAt: { ...prev.lastFiredAt },
  };

  if (tailSig && tailSig === prev.lastTailSig) {
    return { events: [], nextState };
  }

  const gap = opts.perTypeMinFireGapMs ?? DEFAULT_GAP_MS;
  const idleMs = opts.idleThresholdMs ?? DEFAULT_IDLE_MS;
  const ccSessionId = anchor.current_session_id ?? '';
  const stamp = new Date(now).toISOString();
  const events: WorkerEvent[] = [];

  function pushIfFireable(type: WorkerEvent['type']): void {
    if (!shouldFire(nextState, type, now, gap)) return;
    /* Fix 34d.1 addendum (2026-05-26): replace raw-tail-bytes snippet
     * with per-event-type high-signal extraction. The raw tail was
     * usually CC's SessionStart skill-catalog or hook_additional_context
     * payload — noise that Lex could not act on. extractEventSnippet
     * walks the same meaningful-line predicate the jsonl-ingestor uses
     * and formats per event.type. */
    events.push({
      type,
      anchor_id: anchor.id,
      worker_session_id: ccSessionId,
      timestamp: stamp,
      snippet: extractEventSnippet(type, parsed.snippet, { now }),
    });
    nextState.lastFiredAt[type] = now;
  }

  if (detectPermissionDenied(parsed.snippet)) {
    pushIfFireable('permission_denied');
  }
  if (detectTestFailure(parsed.snippet)) {
    pushIfFireable('test_failure');
  }
  if (detectCommit(parsed.snippet)) {
    pushIfFireable('commit');
  }
  if (
    detectIdle({
      lastAssistantMs,
      pendingToolUse,
      now,
      thresholdMs: idleMs,
    })
  ) {
    pushIfFireable('idle');
  }

  return { events, nextState };
}
