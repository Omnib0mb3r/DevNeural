/**
 * Grooming watch (LEX-AUTONOMY codex item 11 / Fix 48).
 *
 * 30-min tick that walks every live brainstorm anchor, detects six
 * gap classes (per investigation Q3), and emits notify_class='signal'
 * notifications with per-(anchor, class) 30-min debounce.
 *
 * Gap classes:
 *   distill_failure_persistent   (warn)
 *   parked_question_persistent   (alert)
 *   distill_error_repeat         (alert)
 *   loose_ends_block_persistent  (alert) - via cache hook
 *   grooming_gap                 (info)  - artifact-vs-corpus
 *   idle_no_distill              (info)
 *
 * Pure helper module aside from emit + clock; tests drive every
 * branch deterministically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IndexDb, LexTranscriptRefRow } from '../store/index-db.js';
import { readTranscriptFile } from './loose-ends-gate.js';

export type GroomingGapClass =
  | 'distill_failure_persistent'
  | 'parked_question_persistent'
  | 'distill_error_repeat'
  | 'loose_ends_block_persistent'
  | 'grooming_gap'
  | 'idle_no_distill';

export type GroomingSeverity = 'info' | 'warn' | 'alert';

export interface GroomingGap {
  class: GroomingGapClass;
  anchor_id: string;
  severity: GroomingSeverity;
  detail: string;
  evidence_ms?: number | null;
}

export interface GroomingTickResult {
  evaluated: number;
  gaps: GroomingGap[];
  emitted: GroomingGap[];
  skipped_debounce: GroomingGap[];
}

export interface GroomingEmitInput {
  severity: GroomingSeverity;
  source: string;
  title: string;
  body?: string;
  link?: string;
  notify_class?: 'signal';
  push?: 'auto' | 'force' | 'suppress';
}

export interface GroomingTickDeps {
  db: IndexDb;
  now?: () => number;
  emit?: (input: GroomingEmitInput) => unknown;
  readMtime?: (p: string) => number | null;
  scanDir?: (dir: string) => string[];
  /** Reads the bound worker jsonl. Defaults to the shared
   * readTranscriptFile helper exported from loose-ends-gate.ts so
   * the grooming tick and the loose-ends gate hit disk through the
   * same code path (Fix 48 codex 11b). Tests inject a string-table
   * stub so detection is deterministic. */
  readTranscript?: (p: string) => string | null;
  state?: Map<string, number>;
  thresholds?: {
    distillFailurePersistentMs?: number;
    parkedQuestionPersistentMs?: number;
    distillErrorRepeatCount?: number;
    distillErrorWindowMs?: number;
    looseEndsBlockPersistentMs?: number;
    groomingGapMs?: number;
    idleNoDistillMs?: number;
    debounceMs?: number;
  };
  /** Anchors whose worker spawn is currently blocked by the loose-ends
   * gate. Caller passes the map from the gate's report cache. */
  looseEndsBlockedAt?: Map<string, number>;
}

export const GROOMING_TICK_MS_DEFAULT = 30 * 60_000;
export const GROOMING_DEBOUNCE_MS_DEFAULT = 30 * 60_000;
const SEV_RANK: Record<GroomingSeverity, number> = { alert: 3, warn: 2, info: 1 };

/* Word-bounded phrases that signal an explicit prompt-for-input
 * even when the assistant turn does not literally end with '?'.
 * Held narrow on purpose: a rhetorical "should I trust this?"
 * inside a paragraph is already covered by the trailing-'?' check
 * on the last sentence; this list catches the imperative ask shape
 * where the question mark is missing or appears mid-line. */
const PARKED_QUESTION_PHRASES = [
  'let me know',
  'should i',
  'want me to',
  'which one',
];
const PARKED_QUESTION_PHRASE_RE = new RegExp(
  `\\b(?:${PARKED_QUESTION_PHRASES.join('|')})\\b`,
  'i',
);

/* Tail-walk a CC jsonl to determine whether the most recent
 * assistant turn parked on a question that the operator has not
 * yet answered. Three signals trip the detector:
 *   1. Trailing '?' on the last sentence of the last assistant turn.
 *   2. Any of PARKED_QUESTION_PHRASES present as a word-bounded
 *      match anywhere in the last assistant turn body.
 * AND for both signals: no user-role record may follow the
 * candidate assistant turn (we walk from the tail; finding a user
 * record before the assistant clears the parked state), AND the
 * assistant turn must be at least ageThresholdMs old.
 *
 * Returns the rendered question fragment so the emit body carries
 * enough detail for the operator to recognise which question is
 * waiting on a reply. */
export function detectParkedQuestionPersistent(
  jsonlText: string,
  now: number,
  ageThresholdMs: number,
): { parked: boolean; question: string | null; age_ms: number | null } {
  const lines = jsonlText.split(/\r?\n/).filter((l) => l.trim());
  /* Bound to the last 50 records per spec - the cold-start tail
   * reader uses the same window. */
  const tail = lines.slice(-50);
  let lastAssistantText = '';
  let lastAssistantMs: number | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    let rec: {
      type?: string;
      timestamp?: string;
      message?: {
        role?: string;
        content?: string | Array<{ type?: string; text?: string }>;
      };
    };
    try {
      rec = JSON.parse(tail[i]!);
    } catch {
      continue;
    }
    if (rec.type === 'user') {
      return { parked: false, question: null, age_ms: null };
    }
    if (rec.type === 'assistant') {
      const c = rec.message?.content;
      if (typeof c === 'string') {
        lastAssistantText = c;
      } else if (Array.isArray(c)) {
        for (const p of c) {
          if (p?.type === 'text' && typeof p.text === 'string') {
            lastAssistantText = p.text;
          }
        }
      }
      if (rec.timestamp) {
        const parsed = Date.parse(rec.timestamp);
        if (Number.isFinite(parsed)) lastAssistantMs = parsed;
      }
      break;
    }
  }
  const trimmed = lastAssistantText.trim();
  if (!trimmed) return { parked: false, question: null, age_ms: null };
  const lastSentence = trimmed.split(/(?<=[.!?])\s+/).pop() ?? trimmed;
  const endsWithQuestionMark = lastSentence.endsWith('?');
  const phraseMatch = PARKED_QUESTION_PHRASE_RE.exec(trimmed);
  if (!endsWithQuestionMark && !phraseMatch) {
    return { parked: false, question: null, age_ms: null };
  }
  const ageMs = lastAssistantMs ? now - lastAssistantMs : ageThresholdMs + 1;
  if (ageMs < ageThresholdMs) {
    return { parked: false, question: null, age_ms: ageMs };
  }
  /* Prefer the trailing question sentence for the rendered hint;
   * fall back to the phrase-anchored fragment when the question
   * mark was missing. */
  const hint = endsWithQuestionMark
    ? lastSentence
    : phraseMatch
      ? trimmed.slice(
          Math.max(0, phraseMatch.index - 30),
          Math.min(trimmed.length, phraseMatch.index + phraseMatch[0].length + 60),
        )
      : trimmed;
  return {
    parked: true,
    question: hint.length > 180 ? hint.slice(0, 179) + '\u2026' : hint,
    age_ms: ageMs,
  };
}

function defaultReadMtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function defaultScanDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function findFreshestArtifact(
  cwd: string,
  io: {
    readMtime?: (p: string) => number | null;
    scanDir?: (dir: string) => string[];
  } = {},
): { path: string; mtime_ms: number } | null {
  if (!cwd) return null;
  const readMtime = io.readMtime ?? defaultReadMtime;
  const scanDir = io.scanDir ?? defaultScanDir;
  const candidates: string[] = [];
  /* Top-level: HANDOVER*, OVERNIGHT*, FIXES.md */
  for (const name of scanDir(cwd)) {
    if (/^(HANDOVER|OVERNIGHT)/i.test(name) || name === 'FIXES.md') {
      candidates.push(path.posix.join(cwd.replace(/\\/g, '/'), name));
    }
  }
  /* docs/spec/*.md + docs/bugs/*.md */
  for (const sub of ['docs/spec', 'docs/bugs']) {
    const dir = path.posix.join(cwd.replace(/\\/g, '/'), sub);
    for (const name of scanDir(dir)) {
      if (name.toLowerCase().endsWith('.md')) {
        candidates.push(path.posix.join(dir, name));
      }
    }
  }
  let best: { path: string; mtime_ms: number } | null = null;
  for (const p of candidates) {
    const m = readMtime(p);
    if (m === null) continue;
    if (best === null || m > best.mtime_ms) best = { path: p, mtime_ms: m };
  }
  return best;
}

function corpusHighWater(db: IndexDb, anchorId: string): number {
  let hi = 0;
  try {
    const bs = db.getBrainstorm(anchorId);
    if (bs?.last_summary_ms && bs.last_summary_ms > hi) hi = bs.last_summary_ms;
    const refs = db.listLexTranscriptRefs(anchorId);
    for (const r of refs) {
      if (r.ref_summary_ms && r.ref_summary_ms > hi) hi = r.ref_summary_ms;
    }
  } catch {
    /* observational */
  }
  return hi;
}

export function runGroomingTick(deps: GroomingTickDeps): GroomingTickResult {
  const now = (deps.now ?? Date.now)();
  const t = deps.thresholds ?? {};
  const T = {
    distillFailurePersistentMs: t.distillFailurePersistentMs ?? 2 * 3_600_000,
    /* parked_question_persistent: 30-min idle threshold per Fix 48
     * codex 11b. Loose-ends-gate uses a shorter 5-min window because
     * it fires on Lex resume (operator just clicked); the grooming
     * tick is a background sweeper and wants a wider window so it
     * does not alert on questions the user is actively typing a
     * reply to. */
    parkedQuestionPersistentMs: t.parkedQuestionPersistentMs ?? 30 * 60_000,
    distillErrorRepeatCount: t.distillErrorRepeatCount ?? 3,
    distillErrorWindowMs: t.distillErrorWindowMs ?? 24 * 3_600_000,
    looseEndsBlockPersistentMs: t.looseEndsBlockPersistentMs ?? 3_600_000,
    groomingGapMs: t.groomingGapMs ?? 30 * 60_000,
    idleNoDistillMs: t.idleNoDistillMs ?? 24 * 3_600_000,
    debounceMs: t.debounceMs ?? GROOMING_DEBOUNCE_MS_DEFAULT,
  };
  const state = deps.state ?? new Map<string, number>();
  const out: GroomingTickResult = {
    evaluated: 0,
    gaps: [],
    emitted: [],
    skipped_debounce: [],
  };

  let anchors: ReturnType<IndexDb['listBrainstorms']> = [];
  try {
    anchors = deps.db.listBrainstorms({ status: 'active', limit: 200 });
  } catch {
    anchors = [];
  }

  for (const a of anchors) {
    out.evaluated += 1;
    const anchorId = a.id;
    let refs: LexTranscriptRefRow[] = [];
    try {
      refs = deps.db.listLexTranscriptRefs(anchorId);
    } catch {
      refs = [];
    }
    /* distill_failure_persistent: ref ended, ref_summary NULL, ended_ms > T_persist ago. */
    for (const r of refs) {
      if (r.ref_summary !== null) continue;
      if (r.ended_ms === null) continue;
      if (now - r.ended_ms < T.distillFailurePersistentMs) continue;
      out.gaps.push({
        class: 'distill_failure_persistent',
        anchor_id: anchorId,
        severity: 'warn',
        detail: `ref ${r.id} ended ${humanAge(now - r.ended_ms)} ago without distillation`,
        evidence_ms: r.ended_ms,
      });
      break;
    }
    /* distill_error_repeat: same (anchor, cc_session_id, error_class) >N in window. */
    try {
      const errRows = deps.db.listRecentDistillationErrors(200, {
        brainstormId: anchorId,
      });
      const counts = new Map<string, number>();
      for (const e of errRows) {
        const ts = Date.parse(e.ts);
        if (!Number.isFinite(ts)) continue;
        if (now - ts > T.distillErrorWindowMs) continue;
        const key = `${e.cc_session_id ?? '?'}:${e.error_class}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const [, n] of counts) {
        if (n >= T.distillErrorRepeatCount) {
          out.gaps.push({
            class: 'distill_error_repeat',
            anchor_id: anchorId,
            severity: 'alert',
            detail: `repeated distillation failures (${n} in 24h)`,
          });
          break;
        }
      }
    } catch {
      /* */
    }
    /* loose_ends_block_persistent: blocked timestamp older than T. */
    const blockedAt = deps.looseEndsBlockedAt?.get(anchorId);
    if (blockedAt && now - blockedAt > T.looseEndsBlockPersistentMs) {
      out.gaps.push({
        class: 'loose_ends_block_persistent',
        anchor_id: anchorId,
        severity: 'alert',
        detail: `worker spawn blocked ${humanAge(now - blockedAt)}`,
        evidence_ms: blockedAt,
      });
    }
    /* grooming_gap: artifact_high_water - corpus_high_water > T. */
    const corpusHi = corpusHighWater(deps.db, anchorId);
    if (a.cwd) {
      const art = findFreshestArtifact(a.cwd, {
        ...(deps.readMtime ? { readMtime: deps.readMtime } : {}),
        ...(deps.scanDir ? { scanDir: deps.scanDir } : {}),
      });
      if (art && art.mtime_ms - corpusHi > T.groomingGapMs) {
        out.gaps.push({
          class: 'grooming_gap',
          anchor_id: anchorId,
          severity: 'info',
          detail: `artifact ${path.basename(art.path)} ${humanAge(art.mtime_ms - corpusHi)} ahead of corpus`,
          evidence_ms: art.mtime_ms,
        });
      }
    }
    /* idle_no_distill: anchor idle/ended, no last_summary, started long ago. */
    if (
      !a.last_summary &&
      a.started_ms &&
      now - a.started_ms > T.idleNoDistillMs
    ) {
      out.gaps.push({
        class: 'idle_no_distill',
        anchor_id: anchorId,
        severity: 'info',
        detail: `anchor active for ${humanAge(now - a.started_ms)} without distillation`,
        evidence_ms: a.started_ms,
      });
    }
    /* parked_question_persistent: tail-walk the latest ref's
     * transcript_path looking for an assistant question that has
     * been sitting unanswered for parkedQuestionPersistentMs. Shares
     * the readTranscriptFile reader with loose-ends-gate so the
     * grooming tick and the resume-time gate hit disk through the
     * same code path. Question = trailing '?' on the last sentence
     * OR word-bounded prompt-for-input phrase anywhere in the body
     * ("let me know", "should I", "want me to", "which one"). */
    const latestRef = refs
      .slice()
      .sort((a, b) => b.ordering - a.ordering)[0];
    if (latestRef?.transcript_path) {
      const reader = deps.readTranscript ?? readTranscriptFile;
      const jsonlText = reader(latestRef.transcript_path);
      if (jsonlText) {
        const parked = detectParkedQuestionPersistent(
          jsonlText,
          now,
          T.parkedQuestionPersistentMs,
        );
        if (parked.parked && parked.question) {
          out.gaps.push({
            class: 'parked_question_persistent',
            anchor_id: anchorId,
            severity: 'alert',
            detail: `unanswered question (${humanAge(parked.age_ms ?? 0)} idle): "${parked.question}"`,
            evidence_ms: parked.age_ms ?? null,
          });
        }
      }
    }
  }

  out.gaps.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);

  const emit = deps.emit;
  for (const g of out.gaps) {
    const key = `${g.anchor_id}:${g.class}`;
    const last = state.get(key) ?? 0;
    if (last && now - last < T.debounceMs) {
      out.skipped_debounce.push(g);
      continue;
    }
    state.set(key, now);
    if (emit) {
      try {
        emit({
          severity: g.severity,
          source: 'grooming-watch',
          notify_class: 'signal',
          title: `Grooming: ${g.class} (${g.anchor_id.slice(0, 8)})`,
          body: g.detail,
          link: `/brainstorms/${encodeURIComponent(g.anchor_id)}`,
          push: g.severity === 'alert' ? 'force' : 'auto',
        });
      } catch {
        /* emit failure is observational */
      }
    }
    out.emitted.push(g);
  }
  return out;
}

function humanAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export interface GroomingHandle {
  stop(): void;
  tickNow(): GroomingTickResult;
}

export function installGroomingScheduler(
  deps: GroomingTickDeps,
  opts: { intervalMs?: number } = {},
): GroomingHandle {
  const envInterval = Number(process.env.DEVNEURAL_GROOMING_TICK_MS);
  const interval =
    opts.intervalMs ??
    (Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : GROOMING_TICK_MS_DEFAULT);
  const state = deps.state ?? new Map<string, number>();
  const sharedDeps: GroomingTickDeps = { ...deps, state };
  let inFlight = false;
  const tick = (): GroomingTickResult => {
    if (inFlight) {
      return { evaluated: 0, gaps: [], emitted: [], skipped_debounce: [] };
    }
    inFlight = true;
    try {
      return runGroomingTick(sharedDeps);
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => {
    tick();
  }, interval);
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as unknown as { unref: () => void }).unref();
  }
  return {
    stop: () => clearInterval(handle),
    tickNow: tick,
  };
}
