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

/* ── worker-anchored activity (2026-07-16) ──────────────────────────
 *
 * Smart-clear plans against a WORKER anchor (a project_session id).
 * Worker anchors have NO brainstorm row, so the brainstorm-anchored
 * investigator fails closed and the sweep used to come back empty:
 * the 05:11:01Z live draft carried only git signals and vetReseed
 * rightly rejected it for "no next step". The worker's live jsonl
 * tail is the active-work source - the latest substantial user
 * directive carries the current task, the queued next items, and the
 * standing constraints verbatim; the latest assistant text shows
 * where the worker actually is. Extraction is deterministic and
 * bounded; when the tail yields nothing the draft degrades exactly
 * as before and the (unchanged) vet gate keeps rejecting it. */

export interface WorkerActivity {
  /** Latest substantial user directive (reminder-stripped, bounded). */
  directive: string | null;
  /** Latest assistant text (bounded). */
  reply: string | null;
  /** Directive lines that read as queued / next work. */
  nextItems: string[];
  /** Directive lines that read as standing constraints. */
  constraints: string[];
}

/* A user turn must clear this to count as a directive; filters out
 * "ok" / short steering fragments and tool_result-only records whose
 * text extraction is empty. */
const WORKER_DIRECTIVE_MIN_CHARS = 80;
/** Tail window scanned for activity; directives live near the end. */
export const WORKER_TAIL_BYTES = 256 * 1024;
const WORKER_DIRECTIVE_SLICE = 1200;
const WORKER_REPLY_SLICE = 240;
const WORKER_ITEM_SLICE = 160;
const WORKER_ITEM_CAP = 5;

const WORKER_NEXT_LINE_RE =
  /\b(next|queue|queued|todo|to-do|remaining|then|after (this|that|the))\b/i;
const WORKER_CONSTRAINT_LINE_RE =
  /\b(constraints?|do not|don't|never|must|additive)\b/i;

function stripHarnessNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

function assistantTextOf(msg: unknown): string {
  const m = msg as { content?: unknown } | undefined;
  if (!m || !Array.isArray(m.content)) return '';
  return m.content
    .map((c) => {
      const block = c as { type?: string; text?: string };
      return block?.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '';
    })
    .join(' ')
    .trim();
}

/* Pure over the jsonl tail text. Never throws; unparseable lines are
 * skipped the same way confirmResumeOnTask skips them. */
export function extractWorkerActivity(jsonlTail: string): WorkerActivity {
  let directive: string | null = null;
  let reply: string | null = null;
  for (const line of (jsonlTail ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let rec: { type?: string; message?: unknown };
    try {
      rec = JSON.parse(t) as { type?: string; message?: unknown };
    } catch {
      continue;
    }
    if (rec.type === 'user') {
      const text = stripHarnessNoise(userTextOf(rec.message));
      if (text.length >= WORKER_DIRECTIVE_MIN_CHARS) {
        directive = text.slice(0, WORKER_DIRECTIVE_SLICE);
      }
    } else if (rec.type === 'assistant') {
      const text = assistantTextOf(rec.message);
      if (text) reply = text.slice(0, WORKER_REPLY_SLICE);
    }
  }
  const nextItems: string[] = [];
  const constraints: string[] = [];
  if (directive) {
    for (const raw of directive.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (
        nextItems.length < WORKER_ITEM_CAP &&
        WORKER_NEXT_LINE_RE.test(line)
      ) {
        nextItems.push(line.slice(0, WORKER_ITEM_SLICE));
      }
      if (
        constraints.length < WORKER_ITEM_CAP &&
        WORKER_CONSTRAINT_LINE_RE.test(line)
      ) {
        constraints.push(line.slice(0, WORKER_ITEM_SLICE));
      }
    }
  }
  return { directive, reply, nextItems, constraints };
}

/* Report section rendered from the activity. Empty when the tail
 * yielded nothing - the assembler must never fabricate content the
 * vet gate would then bless. */
export function buildWorkerActivityBlock(activity: WorkerActivity): string {
  if (!activity.directive && !activity.reply) return '';
  const lines: string[] = ['# Worker active context (live session tail)'];
  if (activity.directive) {
    const firstLine =
      activity.directive
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? '';
    lines.push(`Current task: ${firstLine.slice(0, 200)}`);
  }
  if (activity.nextItems.length > 0) {
    lines.push(`Queued next: ${activity.nextItems.join('; ').slice(0, 300)}`);
  }
  if (activity.constraints.length > 0) {
    lines.push(
      `Constraints in force: ${activity.constraints.join('; ').slice(0, 300)}`,
    );
  }
  if (activity.reply) {
    lines.push(`Recent worker reply: ${activity.reply}`);
  }
  if (activity.directive) {
    lines.push('', 'Latest directive (verbatim, bounded):', activity.directive);
  }
  return lines.join('\n');
}

/* Structured hints straight from the activity - no heuristic line
 * scan needed for the live-tail source. Null fields defer to the
 * report-scan heuristics in assembleSmartClearReport. */
export function workerHints(activity: WorkerActivity): ThreadHints {
  const doingLine = activity.directive
    ? (activity.directive
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? null)
    : null;
  return {
    doing: doingLine ? doingLine.slice(0, 200) : null,
    next:
      activity.nextItems.length > 0
        ? activity.nextItems.join('; ').slice(0, 200)
        : null,
    decisions: activity.constraints.slice(0, 3).map((c) => c.slice(0, 160)),
  };
}

/* Tail-read the worker jsonl (multi-MB files; only the end matters).
 * A readFile seam (tests) reads whole-body then slices; prod does a
 * bounded fd read. Never throws. */
function readWorkerTail(
  p: string,
  readFile?: (p: string) => string | null,
): string | null {
  if (readFile) {
    const body = readFile(p);
    return body ? body.slice(-WORKER_TAIL_BYTES) : null;
  }
  try {
    const stat = nodeFs.statSync(p);
    const len = Math.min(stat.size, WORKER_TAIL_BYTES);
    if (len <= 0) return null;
    const fd = nodeFs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      nodeFs.readSync(fd, buf, 0, len, stat.size - len);
      return buf.toString('utf8');
    } finally {
      nodeFs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export interface AssembleSmartClearInput {
  db: IndexDb;
  anchorId: string;
  cwd: string;
  label?: string | null;
  projectScopeId?: string | null;
  /** The worker's live session jsonl (resolved by the route via
   * jsonlForAnchor). Optional: absent behaves exactly as before. */
  workerJsonlPath?: string | null;
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
  /* Worker-anchored activity: the live jsonl tail is the primary
   * active-work source for smart-clear (worker anchors have no
   * brainstorm row, so the investigator above legitimately comes back
   * empty for them). The tail block LEADS the report - the freshest
   * signal of what to resume on. */
  let activity: WorkerActivity | null = null;
  if (input.workerJsonlPath) {
    const tail = readWorkerTail(input.workerJsonlPath, input.readFile);
    if (tail) activity = extractWorkerActivity(tail);
  }
  const workerBlock = activity ? buildWorkerActivityBlock(activity) : '';
  const report = [workerBlock, assembled.block]
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
  const signals = repoProbe(input.cwd);
  const stoppingPoint = draftStoppingPoint(signals);
  /* Hints: structured worker-tail extraction first (deterministic),
   * report-scan heuristics fill whatever the tail did not provide. */
  const heuristic = extractThreadHints(report);
  const worker = activity
    ? workerHints(activity)
    : { doing: null, next: null, decisions: [] };
  const hints: ThreadHints = {
    doing: worker.doing ?? heuristic.doing,
    next: worker.next ?? heuristic.next,
    decisions:
      worker.decisions.length > 0 ? worker.decisions : heuristic.decisions,
  };
  const reseed = draftReseed({
    label: input.label ?? null,
    signals,
    stoppingPoint,
    hints,
  });
  return {
    anchorId: input.anchorId,
    hasContent: assembled.hasContent || workerBlock.trim().length > 0,
    report,
    stoppingPoint,
    reseed,
    signals,
  };
}

/* ── vet gate (Lex vets the reseed before use) ──────────────────────── */

export interface VetResult {
  ok: boolean;
  issues: string[];
}

/* The GATE between investigator output and inject: the daemon never
 * blind-injects the draft. Objective checks the reseed must pass before
 * /clear-and-paste ships it. Enforces adaptive sufficiency's guardrails -
 * the LOWER bound (carries verified state + a next step) and the UPPER
 * bound (not a dumped transcript). The lower bound is what to resume on;
 * the upper bound is the "this is a reseed, not the old session" rule. */
const TRANSCRIPT_MARKER_RE =
  /"type"\s*:\s*"(assistant|user|tool_use|tool_result)"|"uuid"\s*:|"role"\s*:\s*"(user|assistant)"/;
const VERIFIED_STATE_RE = /HEAD\s+[0-9a-f]{6,}|working tree|verified state/i;

export function vetReseed(
  reseed: string,
  opts: { maxChars?: number; maxLines?: number } = {},
): VetResult {
  const issues: string[] = [];
  const text = (reseed ?? '').trim();
  const maxChars = opts.maxChars ?? 2400;
  const maxLines = opts.maxLines ?? 40;
  if (!text) {
    return { ok: false, issues: ['empty reseed'] };
  }
  if (text.length > maxChars) {
    issues.push(
      `too long (${text.length} > ${maxChars} chars): looks like a dumped transcript, not a reseed`,
    );
  }
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > maxLines) {
    issues.push(`too many lines (${lineCount} > ${maxLines}): not a reseed`);
  }
  if (!VERIFIED_STATE_RE.test(text)) {
    issues.push('no verified state (a HEAD sha / working-tree status)');
  }
  if (!/\bnext\b/i.test(text)) {
    issues.push('no next step (what to resume on)');
  }
  if (TRANSCRIPT_MARKER_RE.test(text)) {
    issues.push('contains raw transcript / jsonl markers');
  }
  return { ok: issues.length === 0, issues };
}

/* ── trail-confirm (Lex confirms the worker resumed on task) ────────── */

export interface ConfirmResumeInput {
  /** The worker's NEW session jsonl (found by mtime after the /clear). */
  newJsonl: string;
  /** The reseed that was injected; we confirm it landed + got a reply. */
  reseed: string;
  readFile?: (p: string) => string | null;
}

export interface ConfirmResumeResult {
  onTask: boolean;
  reason: string;
  sawReseedEcho: boolean;
  sawAssistant: boolean;
}

function reseedMarker(reseed: string): string {
  const head = /HEAD\s+([0-9a-f]{6,})/i.exec(reseed);
  if (head) return head[1]!.toLowerCase();
  const firstLine = reseed.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return firstLine.trim().slice(0, 40).toLowerCase();
}

function userTextOf(msg: unknown): string {
  const m = msg as { content?: unknown } | undefined;
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => {
        const block = c as { type?: string; text?: string };
        return block?.type === 'text' && typeof block.text === 'string'
          ? block.text
          : '';
      })
      .join(' ');
  }
  return '';
}

/* Trail the worker's new jsonl: confirm the injected reseed actually
 * landed as a user turn AND the worker replied (it resumed on task), not
 * that the /clear left it idle or the inject got swallowed. Pure over an
 * injected file reader. */
export function confirmResumeOnTask(
  input: ConfirmResumeInput,
): ConfirmResumeResult {
  const readFile = input.readFile ?? defaultReadFileSc;
  const body = readFile(input.newJsonl);
  if (!body) {
    return {
      onTask: false,
      reason: 'new jsonl unreadable / empty',
      sawReseedEcho: false,
      sawAssistant: false,
    };
  }
  const marker = reseedMarker(input.reseed);
  let sawReseedEcho = false;
  let sawAssistant = false;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let rec: { type?: string; message?: unknown };
    try {
      rec = JSON.parse(t) as { type?: string; message?: unknown };
    } catch {
      continue;
    }
    if (rec.type === 'assistant') sawAssistant = true;
    if (rec.type === 'user') {
      const text = userTextOf(rec.message).toLowerCase();
      if (marker && text.includes(marker)) sawReseedEcho = true;
    }
  }
  const onTask = sawReseedEcho && sawAssistant;
  const reason = onTask
    ? 'reseed landed and the worker replied'
    : !sawReseedEcho
      ? 'reseed not found in the new session (inject may have been swallowed)'
      : 'reseed landed but no worker reply yet';
  return { onTask, reason, sawReseedEcho, sawAssistant };
}

function defaultReadFileSc(p: string): string | null {
  try {
    return nodeFs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
