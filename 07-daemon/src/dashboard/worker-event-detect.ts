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
  /** ts of the last turn_summary sent, so the same turn never fires
   * twice off a re-read tail. Optional for older state literals. */
  lastSummaryTs?: number | null;
  /** BUG-034: ts of the newest Bash tool_result that fired each
   * command-evidenced event, so one denial, failure or commit fires
   * once and never again off a re-read tail. */
  lastMatchTs?: Partial<Record<WorkerEvent['type'], number>>;
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
  /* Legacy top-level tool_result shape (hooks, older CC). */
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/* BUG-035: a command the worker actually RAN, with what it printed.
 * Only Bash tool_results evidence a denial, a test run or a commit;
 * a file it read or wrote may contain the same words and proves
 * nothing. */
export interface BashResult {
  ts: number | null;
  /** The command from the originating tool_use, when the tail holds it. */
  command: string | null;
  /** The tool_result text. */
  text: string;
  /** The tool_use line and the tool_result line, for the snippet extractor. */
  rawLines: string;
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return (c as Array<{ type?: string; text?: string }>)
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
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
  /** The newest assistant turn-end text (not a pre-tool ack) and its
   * ts, for the turn_summary event. null when the tail has none. */
  newestSummary: { text: string; ts: number } | null;
  /** BUG-035: Bash tool_results in tail order (oldest first). The
   * command-evidenced detectors (permission_denied, test_failure,
   * commit) read these and nothing else. */
  bashResults: BashResult[];
}

/* A turn-end record worth reading out: text, not a tool_use ack, at
 * least this long. */
export const TURN_SUMMARY_MIN_CHARS = 80;
export const TURN_SUMMARY_HEAD_CHARS = 600;

function assistantText(rec: ParsedLine): string {
  const c = rec.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return (c as Array<{ type?: string; text?: string }>)
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

export function parseJsonlTail(tail: string, snippetMaxBytes = 2048): ParsedTail {
  const lines = tail.split('\n').filter((l) => l.trim());
  let newestAssistantMs: number | null = null;
  let newestToolMs: number | null = null;
  let trailingToolUse = false;
  let newestSummary: { text: string; ts: number } | null = null;
  const bashResults: BashResult[] = [];
  /* tool_use id -> the Bash command and its raw line, so a tool_result
   * can be tied to the command that produced it (BUG-035). */
  const bashUses = new Map<string, { command: string | null; rawLine: string }>();
  for (const line of lines) {
    let rec: ParsedLine;
    try {
      rec = JSON.parse(line) as ParsedLine;
    } catch {
      continue;
    }
    const ts = parseTs(rec.timestamp);
    const role = rec.role ?? rec.message?.role;
    const content = rec.message?.content;
    if (role === 'assistant' && ts !== null) {
      if (newestAssistantMs === null || ts > newestAssistantMs) {
        newestAssistantMs = ts;
      }
      const stop = (rec.message as { stop_reason?: string } | undefined)?.stop_reason;
      const text = assistantText(rec).trim();
      if (stop !== 'tool_use' && text.length >= TURN_SUMMARY_MIN_CHARS) {
        if (newestSummary === null || ts >= newestSummary.ts) {
          newestSummary = { text: text.replace(/\s+/g, ' ').slice(0, TURN_SUMMARY_HEAD_CHARS), ts };
        }
      }
    }
    if (role === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
        if (b && b.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string') {
          const cmd = (b.input as { command?: unknown } | undefined)?.command;
          bashUses.set(b.id, { command: typeof cmd === 'string' ? cmd : null, rawLine: line });
        }
      }
    }
    /* tool_result blocks inside a user record, or the legacy top-level
     * shape; only those tied to a Bash tool_use count. */
    const results: Array<{ tool_use_id?: string; content?: unknown }> = [];
    if (role === 'user' && Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (b && b.type === 'tool_result') results.push(b);
      }
    } else if (rec.type === 'tool_result' && typeof rec.tool_use_id === 'string') {
      results.push({ tool_use_id: rec.tool_use_id, content: rec.content });
    }
    for (const r of results) {
      const use = r.tool_use_id ? bashUses.get(r.tool_use_id) : undefined;
      if (!use) continue;
      bashResults.push({
        ts,
        command: use.command,
        text: contentText(r.content),
        rawLines: `${use.rawLine}\n${line}`,
      });
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
  return { newestAssistantMs, newestToolMs, trailingToolUse, snippet, newestSummary, bashResults };
}

/* BUG-034: a Bash result older than this is history, not an event. */
export const RECENT_RESULT_MS = 5 * 60_000;

/* A later test run that went green clears a red predecessor. */
export function reportsPass(text: string): boolean {
  return /\b\d+\s+passed\b/i.test(text) && !/\b\d+\s+failed\b|\bFAIL\b|×/.test(text);
}

/* turn_summary's own gap: one per minute per anchor is plenty to keep
 * Lex current without narrating every tool call. */
export const TURN_SUMMARY_GAP_MS = 60_000;

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
    lastMatchTs: { ...(prev.lastMatchTs ?? {}) },
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
    snippetSource: string = parsed.snippet,
  ): boolean {
    if (!shouldFire(nextState, type, now, gap)) return false;
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
      snippet: extractEventSnippet(type, snippetSource, {
        now,
        ...extraSnippetOpts,
      }),
    });
    nextState.lastFiredAt[type] = now;
    return true;
  }

  /* BUG-034 / BUG-035 (2026-09-23): the command-evidenced events read
   * Bash tool_results only, newest first, within RECENT_RESULT_MS, and
   * each result fires at most once (ts latch). A file the worker read
   * or wrote never counts, however many alarm words it holds. */
  function fireFromBash(
    type: 'permission_denied' | 'test_failure' | 'commit',
    detect: (text: string) => boolean,
    guard?: (match: BashResult, index: number) => boolean,
  ): void {
    for (let i = parsed.bashResults.length - 1; i >= 0; i--) {
      const r = parsed.bashResults[i]!;
      if (r.ts !== null && now - r.ts > RECENT_RESULT_MS) continue;
      if (!detect(`${r.command ?? ''}\n${r.text}`)) continue;
      const last = prev.lastMatchTs?.[type] ?? null;
      if (r.ts !== null && last !== null && r.ts <= last) return;
      if (guard && !guard(r, i)) return;
      if (pushIfFireable(type, {}, r.rawLines) && r.ts !== null) {
        nextState.lastMatchTs![type] = r.ts;
      }
      return;
    }
  }

  fireFromBash('permission_denied', detectPermissionDenied);
  fireFromBash('test_failure', detectTestFailure, (m, i) => {
    /* A later run that reports a pass clears this failure. */
    for (let j = i + 1; j < parsed.bashResults.length; j++) {
      const later = parsed.bashResults[j]!;
      if ((later.ts ?? 0) >= (m.ts ?? 0) && reportsPass(later.text)) return false;
    }
    return true;
  });
  fireFromBash('commit', detectCommit);
  /* Operator, 2026-09-22: the worker's own end-of-turn words reach Lex
   * so she reads what it reported instead of improvising. Fires once
   * per turn (ts latch), at most once per TURN_SUMMARY_GAP_MS. */
  if (
    parsed.newestSummary &&
    parsed.newestSummary.ts !== (prev.lastSummaryTs ?? null) &&
    shouldFire(nextState, 'turn_summary', now, TURN_SUMMARY_GAP_MS)
  ) {
    events.push({
      type: 'turn_summary',
      anchor_id: anchor.id,
      worker_session_id: ccSessionId,
      timestamp: stamp,
      snippet: parsed.newestSummary.text,
    });
    nextState.lastFiredAt.turn_summary = now;
    nextState.lastSummaryTs = parsed.newestSummary.ts;
  } else {
    nextState.lastSummaryTs = prev.lastSummaryTs ?? null;
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
