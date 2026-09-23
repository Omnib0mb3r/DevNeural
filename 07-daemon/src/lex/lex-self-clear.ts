/**
 * Lex self-clear (AUTO-CLEAR T4, Phase C, 2026-09-22).
 *
 * Layer 2 clears her own context the way she clears the worker's, with
 * one difference the operator named: nobody above her reviews the
 * handover, so the daemon has to make sure it is good. Three checks,
 * every one written into the handover file so the operator can see
 * them:
 *
 *   1. structural vet (vetHandoverFrame, shared with the worker flow);
 *   2. a fact check against live state, deterministic and cheap: a
 *      commit sha she quotes must be the worker's real HEAD, the plan
 *      file she names must exist, a pending handover or dispatch must
 *      be mentioned;
 *   3. an outside approver: the judge session (a headless `claude` on
 *      the operator's subscription, never the Anthropic API) reads her
 *      draft plus the live facts and answers OK or NO with one line.
 *
 * The stagger rule: never while a worker clear is in flight for the
 * supervised anchor. This module is pure; the route wires it.
 */
import type { HandoverFrame } from './handover-frame.js';

export const SELF_CLEAR_DEFAULT_PCT = 70;
export const SELF_CLEAR_PCT_KEY = 'lex_self_clear_pct';
/** A pending reseed older than this is not served (a stale clear). */
export const PENDING_RESEED_TTL_MS = 30 * 60_000;
/** A worker clear that never reported its end stops blocking after this. */
export const WORKER_CLEAR_IN_FLIGHT_TTL_MS = 5 * 60_000;

export interface SelfClearFacts {
  /** The supervised worker's HEAD sha (full or short), null when none. */
  workerHead: string | null;
  workerBranch: string | null;
  workerSessionId: string | null;
  /** True when the named plan reference resolves to a file. */
  planExists: (ref: string) => boolean;
  /** A handover awaiting the operator's approval on this brainstorm. */
  pendingHandoverId: string | null;
  /** A worker dispatch parked by the confirm gate. */
  pendingDispatch: string | null;
}

const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

function frameText(f: HandoverFrame): string {
  const w = f.worker;
  return [
    w.verifiedState,
    w.whatIWasDoing,
    w.decisionsInForce,
    w.stoppingPoint,
    f.lex?.nextSteps ?? '',
    f.lex?.planReference ?? '',
  ].join('\n');
}

/* Deterministic check of what she wrote against what the daemon can
 * see right now. Issues are one line each, in her terms. */
export function factCheckSelfClear(
  f: HandoverFrame,
  facts: SelfClearFacts,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const text = frameText(f);
  const shas = [...new Set((text.match(SHA_RE) ?? []).map((s) => s.toLowerCase()))].filter(
    (s) => /[a-f]/.test(s) || s.length >= 12,
  );
  if (facts.workerHead) {
    const head = facts.workerHead.toLowerCase();
    for (const s of shas) {
      const matches = head.startsWith(s) || s.startsWith(head);
      if (!matches) issues.push(`commit ${s} is not the worker's HEAD (${head.slice(0, 8)})`);
    }
  }
  const ref = f.lex?.planReference?.trim() ?? '';
  if (ref) {
    const candidates = ref
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => /\.(md|txt)\b/i.test(s));
    for (const c of candidates) {
      const file = c.replace(/\s.*$/, '');
      if (!facts.planExists(file)) issues.push(`plan reference "${file}" does not resolve to a file`);
    }
  } else {
    issues.push('no plan reference named');
  }
  const lower = text.toLowerCase();
  if (facts.pendingHandoverId && !/handover/.test(lower)) {
    issues.push(`a handover (${facts.pendingHandoverId}) is waiting for the operator and the draft does not mention it`);
  }
  if (facts.pendingDispatch && !/dispatch|parked|confirm/.test(lower)) {
    issues.push('a worker dispatch is parked for confirmation and the draft does not mention it');
  }
  if (facts.workerSessionId && !/worker/.test(lower)) {
    issues.push('a worker is bound and the draft never mentions the worker');
  }
  return { ok: issues.length === 0, issues };
}

export const JUDGE_SYSTEM =
  'You vet a handover that a supervising session (Lex) wrote for her own fresh self before clearing her context. ' +
  'Compare it with the live facts. It is good when a stranger could resume her job from it: what the worker is doing, ' +
  'where it stands, what was decided, and the next steps, with nothing that contradicts the facts. ' +
  'Reply with exactly one line: "OK" or "NO: <what is missing or wrong, one sentence>". No preamble.';

export function buildJudgePrompt(
  f: HandoverFrame,
  facts: SelfClearFacts,
  factIssues: string[],
): string {
  const lines: string[] = [];
  lines.push('Live facts:');
  lines.push(`- worker: ${facts.workerSessionId ? `session ${facts.workerSessionId.slice(0, 8)}` : 'none bound'}`);
  lines.push(`- worker HEAD: ${facts.workerHead ?? 'unknown'}${facts.workerBranch ? ` on ${facts.workerBranch}` : ''}`);
  lines.push(`- pending handover: ${facts.pendingHandoverId ?? 'none'}`);
  lines.push(`- pending dispatch: ${facts.pendingDispatch ?? 'none'}`);
  if (factIssues.length) {
    lines.push('- automatic checks flagged:');
    for (const i of factIssues) lines.push(`  - ${i}`);
  }
  lines.push('');
  lines.push('Her handover:');
  lines.push(`Verified state: ${f.worker.verifiedState}`);
  lines.push(`What I was doing: ${f.worker.whatIWasDoing}`);
  lines.push(`Decisions in force: ${f.worker.decisionsInForce}`);
  lines.push(`Stopping point: ${f.worker.stoppingPoint}`);
  lines.push(`Next steps: ${f.lex?.nextSteps ?? ''}`);
  lines.push(`Plan reference: ${f.lex?.planReference ?? ''}`);
  return lines.join('\n');
}

export interface JudgeVerdict {
  ok: boolean;
  note: string;
}

/* "OK" / "NO: ..." with tolerance for a chatty judge. null = unparseable. */
export function parseJudgeVerdict(text: string | null): JudgeVerdict | null {
  if (text === null) return null;
  const t = text.trim();
  if (!t) return null;
  const first = t.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
  if (/^ok\b/i.test(first)) return { ok: true, note: first.replace(/^ok[.:!\s-]*/i, '').trim() };
  const no = first.match(/^no\b[.:!\s-]*(.*)$/i);
  if (no) return { ok: false, note: (no[1] ?? '').trim() || 'the judge said no' };
  if (/\bok\b/i.test(t) && !/\bno\b/i.test(t)) return { ok: true, note: first };
  return null;
}

export interface PendingLexReseed {
  brainstormId: string;
  handoverId: string;
  reseed: string;
  createdAtMs: number;
  servedAtMs: number | null;
}

/* Stagger + serve-once bookkeeping. Clocked by injection. */
export class SelfClearGate {
  private readonly workerClears = new Map<string, number>();
  private readonly pending = new Map<string, PendingLexReseed>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  workerClearStart(anchorId: string): void {
    this.workerClears.set(anchorId, this.now());
  }

  workerClearEnd(anchorId: string): void {
    this.workerClears.delete(anchorId);
  }

  workerClearInFlight(anchorId: string): boolean {
    const t = this.workerClears.get(anchorId);
    if (t === undefined) return false;
    if (this.now() - t > WORKER_CLEAR_IN_FLIGHT_TTL_MS) {
      this.workerClears.delete(anchorId);
      return false;
    }
    return true;
  }

  /** A Lex clear is pending its reseed for this brainstorm. */
  lexClearPending(brainstormId: string): boolean {
    const p = this.pending.get(brainstormId);
    return Boolean(p && p.servedAtMs === null && this.now() - p.createdAtMs <= PENDING_RESEED_TTL_MS);
  }

  setPendingReseed(p: Omit<PendingLexReseed, 'createdAtMs' | 'servedAtMs'>): PendingLexReseed {
    const entry: PendingLexReseed = { ...p, createdAtMs: this.now(), servedAtMs: null };
    this.pending.set(p.brainstormId, entry);
    return entry;
  }

  /** The newest unserved, unexpired reseed (every brainstorm shares one
   * cwd, so the fresh session cannot name its brainstorm; the stagger
   * rule keeps at most one Lex clear pending at a time). Marked served. */
  takePendingReseed(): PendingLexReseed | null {
    const t = this.now();
    let best: PendingLexReseed | null = null;
    for (const p of this.pending.values()) {
      if (p.servedAtMs !== null) continue;
      if (t - p.createdAtMs > PENDING_RESEED_TTL_MS) continue;
      if (!best || p.createdAtMs > best.createdAtMs) best = p;
    }
    if (best) best.servedAtMs = t;
    return best;
  }

  peekPending(brainstormId: string): PendingLexReseed | null {
    return this.pending.get(brainstormId) ?? null;
  }
}

/* The wrap prompt the daemon injects into Lex when her own context passes
 * the setpoint (auto-clear mode live). She understands the current state
 * first (her hard rule), then posts her handover. */
export function selfClearDuePrompt(ctxPct: number, setpoint: number): string {
  return (
    `[self-clear-due] Your context is at ${Math.round(ctxPct)}% (setpoint ${setpoint}%). ` +
    'Finish the sentence you are on, then: look at the current state (worker, repo, pending items), ' +
    'write your handover for your fresh self, and POST /lex/self-clear with it. ' +
    'Never type /clear yourself; the daemon clears you once the handover passes the vet, the fact check and the judge.'
  );
}
