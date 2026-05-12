/**
 * Smart compact (SMART-COMPACT.md).
 *
 * Lex orchestrates, daemon executes. This module exposes pure helpers
 * the Lex tool surface calls over HTTP:
 *
 *   evaluateTrigger    decides fire / wrap / wait from a state snapshot
 *   assembleSummary    builds the resume prompt from durable sources
 *   isShadow           gates the first N attempts per anchor to audit-only
 *   ctxPctFromJsonl    convenience wrapper around deriveContextFromTail
 *
 * No daemon-side scheduler thread per spec. The Lex tool polls / asks
 * for evaluate, decides whether to fire, then calls fire which records
 * the audit row and injects via the existing cross-session inject path.
 */
import * as fs from 'node:fs';
import type { IndexDb } from '../store/index-db.js';

export type Phase =
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'idle'
  | 'unknown';

export type EvalAction = 'fire' | 'wrap' | 'wait';
export type EvalReason =
  | 'window-open'
  | 'forced-no-stop'
  | 'hard-ceiling'
  | 'below-window'
  | 'no-stop';

export interface EvalInput {
  ctxPct: number;
  threshold: number;
  bandHalf: number;
  hardCeiling: number;
  stopWindowMs: number;
  now: number;
  lastCommitMs: number | null;
  lastToolMs: number | null;
  phase: Phase;
}

export interface EvalResult {
  action: EvalAction;
  reason: EvalReason;
}

const STOP_PHASES: ReadonlySet<Phase> = new Set(['idle', 'permission']);

export function evaluateTrigger(input: EvalInput): EvalResult {
  const {
    ctxPct,
    threshold,
    bandHalf,
    hardCeiling,
    stopWindowMs,
    now,
    lastCommitMs,
    lastToolMs,
    phase,
  } = input;

  if (ctxPct >= hardCeiling) {
    return { action: 'fire', reason: 'hard-ceiling' };
  }

  const lo = threshold - bandHalf;
  const hi = threshold + bandHalf;

  if (ctxPct < lo) {
    return { action: 'wait', reason: 'below-window' };
  }

  /* Stop point: any of: recent commit, idle tool, phase ∈ {idle,
   * permission}. permission = "awaiting-prompt" in spec vocab. */
  const recentCommit =
    lastCommitMs !== null && now - lastCommitMs <= stopWindowMs;
  const idleTool = lastToolMs === null || now - lastToolMs > stopWindowMs;
  const stopPhase = STOP_PHASES.has(phase);
  const hasStop = recentCommit || idleTool || stopPhase;

  if (ctxPct <= hi) {
    if (hasStop) return { action: 'fire', reason: 'window-open' };
    return { action: 'wait', reason: 'no-stop' };
  }

  /* ctxPct in (hi, hardCeiling). Window closed without a stop; inject
   * the wrap-and-commit prompt and wait for the worker to settle. */
  return { action: 'wrap', reason: 'forced-no-stop' };
}

export interface SummaryInput {
  projectSlug: string;
  title: string | null;
  cwd: string;
  activeWork: string;
  recentCommits: string[];
  diffStat: string;
  jsonlPath: string;
  lastActionSummary: string;
  openAuditFindings: number;
}

export function assembleSummary(input: SummaryInput): string {
  const name = input.title?.trim() || input.projectSlug;
  const commitsBlock = input.recentCommits.length
    ? input.recentCommits.map((c) => `  ${c}`).join('\n')
    : '  (none)';
  const diff = input.diffStat.trim() || 'clean';
  const auditLine =
    input.openAuditFindings > 0
      ? `\nOpen audit findings for this project: ${input.openAuditFindings}.`
      : '';
  return [
    `You were working on ${name}. Context refreshed for capacity.`,
    '',
    `Active work: ${input.activeWork}`,
    `Recent commits:`,
    commitsBlock,
    `Uncommitted: ${diff}`,
    `Last action: ${input.lastActionSummary || '(none)'}${auditLine}`,
    '',
    `Resume from where you left off. Full transcript is at ${input.jsonlPath || '(unknown)'} if you need to look anything up.`,
  ].join('\n');
}

export const WRAP_AND_COMMIT_PROMPT =
  'Wrap your current work: commit what is stable with a meaningful message, defer the rest with a TODO comment if needed. Reply "ready" when done. Reason: context refresh in progress.';

const DEFAULT_SHADOW_N = 3;

export function shadowThreshold(): number {
  const raw = process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return DEFAULT_SHADOW_N;
}

export function isShadow(
  db: IndexDb,
  anchorId: string,
  n: number = shadowThreshold(),
): boolean {
  const count = db.countSmartCompactsForAnchor(anchorId);
  return count < n;
}

/* Convenience: derive ctx_pct (0-100) from a Claude Code jsonl tail.
 * Returns null when the file is missing or the tail has no usage
 * record yet (e.g. a freshly-spawned session). */
export interface CtxSnapshot {
  ctxPct: number;
  tokens: number;
  max: number;
}

export function ctxPctFromJsonl(
  file: string,
  deriver: (file: string) => { tokens: number; max: number } | null,
): CtxSnapshot | null {
  if (!file) return null;
  if (!fs.existsSync(file)) return null;
  const ctx = deriver(file);
  if (!ctx || ctx.max <= 0) return null;
  return {
    tokens: ctx.tokens,
    max: ctx.max,
    ctxPct: Math.round((ctx.tokens / ctx.max) * 1000) / 10,
  };
}

export interface Defaults {
  threshold: number;
  bandHalf: number;
  hardCeiling: number;
  stopWindowMs: number;
}

export function defaults(): Defaults {
  const env = process.env;
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    threshold: num('DEVNEURAL_SMART_COMPACT_THRESHOLD_PCT', 60),
    bandHalf: 5,
    hardCeiling: 90,
    stopWindowMs: 30_000,
  };
}
