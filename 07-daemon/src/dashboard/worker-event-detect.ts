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
import {
  extractEventSnippet,
  parseMeaningfulLines,
  type MeaningfulLine,
} from './worker-event-snippet.js';
import type { RecentCommit } from './worker-event-git.js';

export interface PendingSuccessClaim {
  /** Matched assistant text (the line that contained the claim). */
  text: string;
  /** Wall-clock ms of the claim line. */
  ts: number;
  /** Anchor's git HEAD sha at the moment the claim was observed.
   * Null when the git helper returned no value (not a git repo, or
   * the cwd is missing). The detector only fires when both this and
   * the current HEAD are non-null AND equal. */
  headShaAtClaim: string | null;
  /** Latched after the narrated_success_no_commit event has fired
   * for this claim, so a chatty worker that keeps claiming "done"
   * without advancing HEAD does not re-fire on every tick. */
  fired: boolean;
}

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
  /** Fix 34d.2: in-flight narrated-success claim being watched for
   * a follow-up git commit. Null when no claim is pending. Cleared
   * when HEAD advances (commit landed) or replaced when a newer
   * claim is observed. */
  pendingSuccessClaim: PendingSuccessClaim | null;
}

export function newAnchorTailState(): AnchorTailState {
  return {
    lastAssistantMs: null,
    lastToolMs: null,
    pendingToolUse: false,
    lastTailSig: '',
    lastFiredAt: {},
    pendingSuccessClaim: null,
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
  /** Fix 34d.2: current git HEAD sha for the anchor's cwd, used by
   * the narrated-success-no-commit detector. When undefined or
   * null, the detector is disabled (e.g. anchors outside a git
   * working tree). */
  currentHeadSha?: string | null;
  /** Fix 34d.2: grace window after the claim before firing if
   * HEAD has not advanced. Default 60_000 (60 s) per spec. */
  successClaimGraceMs?: number;
  /** Fix 34d.2: recent commit subjects to include in the snippet
   * payload for forensic context. The default helper fills this
   * via `git log -n3`; tests can pass a synthetic value. */
  recentCommits?: RecentCommit[];
}

export interface DeriveResult {
  events: WorkerEvent[];
  nextState: AnchorTailState;
}

const DEFAULT_GAP_MS = 30_000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_SUCCESS_CLAIM_GRACE_MS = 60_000;

/* Word-bounded, case-insensitive success-claim pattern. Broad on
 * purpose; the no-commit-in-60-s gate downstream is what prevents
 * false fires on legitimate "ready to verify" / "are we done?"
 * phrasing without a fresh git commit to match. */
const SUCCESS_CLAIM_RE =
  /\b(?:shipped|landed|completed?|done|ready|deployed|merged)\b/i;

/* Scan the meaningful lines newest-first; return the newest
 * assistant turn whose stop_reason is NOT 'tool_use' (pre-tool acks
 * like "On it..." should never count as a success narration) and
 * whose text matches the claim pattern. */
export function detectNarratedSuccess(
  lines: MeaningfulLine[],
): { text: string; ts: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l.type !== 'assistant') continue;
    if (l.stopReason === 'tool_use') continue;
    if (!l.text) continue;
    if (SUCCESS_CLAIM_RE.test(l.text)) {
      return { text: l.text, ts: l.ts ?? Date.now() };
    }
  }
  return null;
}

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
  /* Fix 34d.2: carry the pending narrated-success claim forward by
   * default; the block below mutates it as events land. */
  const nextState: AnchorTailState = {
    lastAssistantMs,
    lastToolMs,
    pendingToolUse,
    lastTailSig: tailSig,
    lastFiredAt: { ...prev.lastFiredAt },
    pendingSuccessClaim: prev.pendingSuccessClaim
      ? { ...prev.pendingSuccessClaim }
      : null,
  };

  if (tailSig && tailSig === prev.lastTailSig) {
    return { events: [], nextState };
  }

  const gap = opts.perTypeMinFireGapMs ?? DEFAULT_GAP_MS;
  const idleMs = opts.idleThresholdMs ?? DEFAULT_IDLE_MS;
  const ccSessionId = anchor.current_session_id ?? '';
  const stamp = new Date(now).toISOString();
  const events: WorkerEvent[] = [];

  function pushIfFireable(
    type: WorkerEvent['type'],
    extraSnippetOpts: Parameters<typeof extractEventSnippet>[2] = {},
  ): void {
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
      snippet: extractEventSnippet(type, parsed.snippet, {
        now,
        ...extraSnippetOpts,
      }),
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

  /* Fix 34d.2: narrated-success-no-commit. Three-step state machine
   * driven by the (claim, head, time) tuple:
   *   1. Observe newest assistant claim in the tail. If it is newer
   *      than the pending claim being tracked (or no claim is being
   *      tracked), seed pendingSuccessClaim with the current HEAD.
   *   2. If HEAD advanced since the claim was seeded, clear the
   *      pending claim (a commit landed for it, no false shipment).
   *   3. If the grace window has elapsed AND HEAD has not advanced
   *      AND the claim has not already fired, emit the event and
   *      latch fired=true so a chatty worker cannot re-fire on the
   *      same tail. */
  const currentHead = opts.currentHeadSha ?? null;
  const claimGraceMs =
    opts.successClaimGraceMs ?? DEFAULT_SUCCESS_CLAIM_GRACE_MS;
  const lines = parseMeaningfulLines(parsed.snippet);
  const observed = detectNarratedSuccess(lines);
  let pending = nextState.pendingSuccessClaim;

  if (observed && (!pending || pending.ts < observed.ts)) {
    pending = {
      text: observed.text,
      ts: observed.ts,
      headShaAtClaim: currentHead,
      fired: false,
    };
  }

  if (
    pending &&
    pending.headShaAtClaim !== null &&
    currentHead !== null &&
    currentHead !== pending.headShaAtClaim
  ) {
    pending = null;
  }

  if (
    pending &&
    !pending.fired &&
    currentHead !== null &&
    pending.headShaAtClaim !== null &&
    currentHead === pending.headShaAtClaim &&
    now - pending.ts >= claimGraceMs
  ) {
    const recentCommits = opts.recentCommits ?? [];
    pushIfFireable('narrated_success_no_commit', {
      narratedSuccess: {
        claimText: pending.text,
        headShaAtClaim: pending.headShaAtClaim,
        recentCommits: recentCommits.map(
          (c) => `${c.sha} ${c.subject}`,
        ),
      },
    });
    pending = { ...pending, fired: true };
  }

  nextState.pendingSuccessClaim = pending;

  return { events, nextState };
}
