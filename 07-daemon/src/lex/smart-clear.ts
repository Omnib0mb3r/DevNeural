/* Smart-clear: automated context-full wind-down (DRIVE-QUEUE 4).
 *
 * The auto version of the manual context-full wind-down, spec section 2b.
 * Upgrades smart-compact's reseed to the investigator engine and adds the
 * trigger + the choreography primitives.
 *
 * Division of labor (spec): the INVESTIGATOR assembles the report + the
 * two artifacts (a safe stopping point, the restart/reseed prompt) and
 * logs/closes; LEX decides + fires (tell the worker to stop, wait for the
 * /clear, inject the VETTED reseed, trail the new jsonl to confirm). This
 * module is the daemon's transport + assembly + gate half: pure, testable
 * functions Lex's loop calls. The daemon never blind-injects investigator
 * output - the vet gate sits between assembly and inject.
 *
 * Behind a runtime flag (smart_clear_mode, default off) so live behavior
 * is unchanged until the operator opts in.
 */
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import type { IndexDb } from '../store/index-db.js';
import {
  assembleInvestigatorContext,
  type AssembledInvestigatorContext,
} from './lex-investigator.js';

/* ── config (settings-adjustable threshold + ceiling + mode) ──────── */

export const SMART_CLEAR_MODE_KEY = 'smart_clear_mode';
export const SMART_CLEAR_THRESHOLD_KEY = 'smart_clear_threshold_pct';
export const SMART_CLEAR_CEILING_KEY = 'smart_clear_ceiling_pct';

/* off: inert. shadow: compute + log, never inject. live: Lex drives the
 * real stop/clear/reseed. Default off so wiring it in changes nothing. */
export type SmartClearMode = 'off' | 'shadow' | 'live';

/* Fire deliberately EARLY (40%) to leave runway to a graceful landing by
 * the ceiling (60%). Past the ceiling Lex forces the commit-first stop. */
export const DEFAULT_THRESHOLD_PCT = 40;
export const DEFAULT_CEILING_PCT = 60;

export function parseSmartClearMode(
  raw: string | null | undefined,
): SmartClearMode | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === '' ) return null;
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'shadow') return 'shadow';
  if (v === 'live' || v === 'on' || v === 'true' || v === '1') return 'live';
  return null;
}

function clampPct(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  if (v < 1) return 1;
  if (v > 99) return 99;
  return Math.round(v);
}

export interface SmartClearConfig {
  mode: SmartClearMode;
  thresholdPct: number;
  ceilingPct: number;
}

export function smartClearConfig(db: IndexDb): SmartClearConfig {
  const mode =
    parseSmartClearMode(db.getRuntimeConfig(SMART_CLEAR_MODE_KEY)) ?? 'off';
  /* getRuntimeConfig returns null when unset; Number(null) is 0 (finite),
   * so guard on the raw value to fall back to the default rather than
   * clamp 0 up to 1. */
  const rawThreshold = db.getRuntimeConfig(SMART_CLEAR_THRESHOLD_KEY);
  const threshold = rawThreshold
    ? clampPct(Number(rawThreshold), DEFAULT_THRESHOLD_PCT)
    : DEFAULT_THRESHOLD_PCT;
  /* The ceiling must sit above the threshold; if a bad config inverts
   * them, push the ceiling to at least threshold + 5. */
  const rawCeiling = db.getRuntimeConfig(SMART_CLEAR_CEILING_KEY);
  let ceiling = rawCeiling
    ? clampPct(Number(rawCeiling), DEFAULT_CEILING_PCT)
    : DEFAULT_CEILING_PCT;
  if (ceiling <= threshold) ceiling = Math.min(99, threshold + 5);
  return { mode, thresholdPct: threshold, ceilingPct: ceiling };
}

/* ── trigger ──────────────────────────────────────────────────────── */

export type SmartClearStage = 'idle' | 'wind-down' | 'force-stop';

export interface SmartClearTriggerInput {
  /** Worker context usage 0-100, or null when unknown (no jsonl yet). */
  ctxPct: number | null;
  thresholdPct: number;
  ceilingPct: number;
}

export interface SmartClearTriggerResult {
  stage: SmartClearStage;
  /** At/over the early threshold: begin the graceful wind-down. */
  windDown: boolean;
  /** At/over the ceiling: the worker did not land in time; Lex forces
   * the commit-first stop now. */
  forceStop: boolean;
  reason: string;
}

/* Pure verdict. The cheap watcher / state endpoint feeds ctxPct; Lex
 * reads the verdict and decides. Debounce (fire once per session) is the
 * caller's concern - this stays a stateless function of the inputs. */
export function evaluateSmartClearTrigger(
  input: SmartClearTriggerInput,
): SmartClearTriggerResult {
  const { ctxPct, thresholdPct, ceilingPct } = input;
  if (ctxPct === null || !Number.isFinite(ctxPct)) {
    return { stage: 'idle', windDown: false, forceStop: false, reason: 'ctx unknown' };
  }
  if (ctxPct >= ceilingPct) {
    return {
      stage: 'force-stop',
      windDown: true,
      forceStop: true,
      reason: `ctx ${ctxPct}% >= ceiling ${ceilingPct}% (force commit-first stop)`,
    };
  }
  if (ctxPct >= thresholdPct) {
    return {
      stage: 'wind-down',
      windDown: true,
      forceStop: false,
      reason: `ctx ${ctxPct}% >= threshold ${thresholdPct}% (wind down to a safe stop)`,
    };
  }
  return {
    stage: 'idle',
    windDown: false,
    forceStop: false,
    reason: `ctx ${ctxPct}% < threshold ${thresholdPct}%`,
  };
}

/* ── investigator: report + two artifacts (stopping point + reseed) ── */

/* Verified repo state the stopping-point + reseed are grounded in. */
export interface RepoSignals {
  headSha: string | null;
  branch: string | null;
  /** Uncommitted WIP present (the stopping point becomes commit-first). */
  dirty: boolean;
  lastCommitSubject: string | null;
}

export type RepoProbe = (cwd: string) => RepoSignals;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export const defaultRepoProbe: RepoProbe = (cwd: string): RepoSignals => {
  if (!cwd || !nodeFs.existsSync(cwd)) {
    return { headSha: null, branch: null, dirty: false, lastCommitSubject: null };
  }
  const headSha = git(cwd, ['rev-parse', '--short', 'HEAD']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(cwd, ['status', '--porcelain']);
  const lastCommitSubject = git(cwd, ['log', '-1', '--format=%s']);
  return {
    headSha: headSha || null,
    branch: branch || null,
    dirty: status !== null && status.length > 0,
    lastCommitSubject: lastCommitSubject || null,
  };
};

/* Artifact (a): the SAFE stopping point. Clean boundary AFTER a commit,
 * NEVER mid-edit. Uncommitted WIP turns the point into "commit first". */
export function draftStoppingPoint(signals: RepoSignals): string {
  if (signals.dirty) {
    return 'Commit the current work first (working tree is dirty), THEN stop. The /clear must never eat uncommitted work or land mid-edit.';
  }
  const head = signals.headSha ? ` at HEAD ${signals.headSha}` : '';
  const subj = signals.lastCommitSubject
    ? ` ("${signals.lastCommitSubject}")`
    : '';
  return `Safe to stop now: clean working tree${head}${subj}. Stop between steps, right after this commit - never mid-edit.`;
}

export interface ThreadHints {
  doing: string | null;
  next: string | null;
  decisions: string[];
}

const HINT_DOING_RE = /(current|working on|in flight|in progress|live recent)/i;
const HINT_NEXT_RE = /\b(next|to ?do|remaining|pipeline|still out|deferred|next up)\b/i;
const HINT_DECISION_RE = /\b(decision|decided|chose|chosen|approach|in force)\b/i;

/* Cheap deterministic scan of the assembled report for the adaptive-
 * sufficiency hints. Heuristic + bounded; the optional Opus refine (or
 * Lex's vet) tightens them into final prose. */
export function extractThreadHints(report: string): ThreadHints {
  const lines = report
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter((l) => l.length > 0);
  let doing: string | null = null;
  let next: string | null = null;
  const decisions: string[] = [];
  for (const line of lines) {
    if (!doing && HINT_DOING_RE.test(line)) doing = line.slice(0, 200);
    if (!next && HINT_NEXT_RE.test(line)) next = line.slice(0, 200);
    if (decisions.length < 3 && HINT_DECISION_RE.test(line)) {
      decisions.push(line.slice(0, 160));
    }
  }
  if (!doing && lines.length > 0) doing = lines[0]!.slice(0, 200);
  return { doing, next, decisions };
}

export interface DraftReseedInput {
  label?: string | null;
  signals: RepoSignals;
  stoppingPoint: string;
  hints: ThreadHints;
}

/* Artifact (b): the restart/reseed prompt. Adaptive sufficiency - enough
 * to resume (what it's doing/next, decisions, verified state like HEAD),
 * NEVER the dumped transcript, NO fixed budget. This is the DRAFT the
 * investigator hands Lex; Lex vets/tightens before injecting. */
export function draftReseed(input: DraftReseedInput): string {
  const { signals, hints } = input;
  const head = signals.headSha
    ? `HEAD ${signals.headSha}${signals.branch ? ` on ${signals.branch}` : ''}`
    : 'HEAD unknown';
  const tree = signals.dirty
    ? 'working tree DIRTY (commit before clearing)'
    : 'working tree clean';
  const parts: string[] = [
    `Resume: ${input.label?.trim() || 'this project'}.`,
    `Verified state: ${head}, ${tree}.`,
  ];
  if (hints.doing) parts.push(`Were doing: ${hints.doing}`);
  if (hints.next) parts.push(`Next: ${hints.next}`);
  if (hints.decisions.length > 0) {
    parts.push(`Decisions in force: ${hints.decisions.join('; ')}`);
  }
  parts.push(`Stopping point was: ${input.stoppingPoint}`);
  parts.push(
    'This is a reseed, not the transcript - resume from here, do not re-read the old session.',
  );
  return parts.join('\n');
}

export interface AssembleSmartClearInput {
  db: IndexDb;
  anchorId: string;
  cwd: string;
  label?: string | null;
  projectScopeId?: string | null;
  /** Test seam: repo state probe. Defaults to a git subprocess. */
  repoProbe?: RepoProbe;
  /** Test seams passed through to assembleInvestigatorContext. */
  readFile?: (p: string) => string | null;
  listDir?: (p: string) => string[];
}

export interface SmartClearReport {
  anchorId: string;
  hasContent: boolean;
  /** ONE cohesive report from the BROAD sweep (investigator engine). */
  report: string;
  /** Artifact (a). */
  stoppingPoint: string;
  /** Artifact (b) - the DRAFT reseed Lex vets before use. */
  reseed: string;
  signals: RepoSignals;
}

/* The investigator ASSEMBLES (spec 2b): one cohesive report from a broad
 * sweep (reusing the cold-start investigator engine - worker jsonl tail +
 * Lex state + project/spec/handover docs) plus the two artifacts. Pure
 * over its injected seams; logs/closes + the decisioning are elsewhere. */
export function assembleSmartClearReport(
  input: AssembleSmartClearInput,
): SmartClearReport {
  const repoProbe = input.repoProbe ?? defaultRepoProbe;
  let assembled: AssembledInvestigatorContext;
  try {
    assembled = assembleInvestigatorContext({
      db: input.db,
      anchorId: input.anchorId,
      cwd: input.cwd,
      label: input.label ?? null,
      projectScopeId: input.projectScopeId ?? null,
      ...(input.readFile ? { readFile: input.readFile } : {}),
      ...(input.listDir ? { listDir: input.listDir } : {}),
    });
  } catch {
    assembled = { block: '', hasContent: false, anchorId: input.anchorId };
  }
  const signals = repoProbe(input.cwd);
  const stoppingPoint = draftStoppingPoint(signals);
  const hints = extractThreadHints(assembled.block);
  const reseed = draftReseed({
    label: input.label ?? null,
    signals,
    stoppingPoint,
    hints,
  });
  return {
    anchorId: input.anchorId,
    hasContent: assembled.hasContent,
    report: assembled.block,
    stoppingPoint,
    reseed,
    signals,
  };
}
