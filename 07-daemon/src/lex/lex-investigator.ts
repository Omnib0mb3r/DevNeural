/* Headless Opus investigator (2026-06-19).
 *
 * Runs BEFORE a Lex PTY spawns and assembles the primed context block
 * the cold-start hook serves. Two layers:
 *
 *   1. assembleInvestigatorContext - a deterministic, fail-CLOSED daemon
 *      assembler. Anchor-scoped only (no label fallback), so an LPCC
 *      session can never inherit DevNeural context. Reads the live
 *      transcript tail + scope-safe sibling index + the project/spec
 *      docs in the cwd. This layer ALWAYS works and is fully unit-tested.
 *
 *   2. runInvestigator - an optional headless Opus refinement. Spawns a
 *      `claude -p` pass over the assembled material to produce a tight
 *      briefing. Fail-SAFE: on any error / timeout / missing binary it
 *      returns the assembled block unrefined, so the investigator can
 *      never regress cold-start below the deterministic baseline.
 *
 * BF-4 note: the headless pass is a `claude` subprocess on the user's
 * own auth - the same interactive channel Lex uses - NOT a daemon
 * provider.call(), so it is outside the outbound-guard that blocks
 * brainstorm content from automated off-host calls.
 */
import * as nodeFs from 'node:fs';
import type { IndexDb } from '../store/index-db.js';
import { buildSiblingIndex } from './sibling-index.js';
import { readTranscriptFromJsonlRefs } from './jsonl-transcript-reader.js';
import { spawnHeadlessOpus } from './headless-opus.js';
import {
  writeColdStartReport,
  readLatestColdStartReport,
} from './cold-start-report.js';

interface BrainstormLike {
  id: string;
  user_label: string | null;
  derived_label?: string | null;
}

export interface AssembleInvestigatorInput {
  db: IndexDb;
  /** Stable anchor (= brainstorm id) for this Lex session. */
  anchorId: string;
  /** Brainstorm cwd; project/spec docs are read from here. */
  cwd: string;
  label?: string | null;
  projectScopeId?: string | null;
  /** Byte cap on the live transcript tail. Default 8000. */
  recentTranscriptBytes?: number;
  /** Byte cap on the project/spec doc digest. Default 6000. */
  projectDocsBytes?: number;
  /** Test seam: file reader. Defaults to fs.readFileSync. */
  readFile?: (p: string) => string | null;
  /** Test seam: directory lister. Defaults to fs.readdirSync. */
  listDir?: (p: string) => string[];
  now?: () => number;
}

export interface AssembledInvestigatorContext {
  block: string;
  /** True when the assembler found any real context (siblings, live
   * turns, or project docs). False = a confidently-empty cold-cold
   * start; the caller should prime with nothing rather than guess. */
  hasContent: boolean;
  anchorId: string;
}

/* Planning / spec docs the investigator reads from the cwd, in priority
 * order. Bounded + best-effort: a missing file is simply skipped. The
 * point is to give the incoming Lex the project's current plan + open
 * threads without it having to Read around blindly on its first turn. */
const PROJECT_DOC_PRIORITY = [
  /^PROJECT\.md$/i,
  /^HANDOVER.*\.md$/i,
  /^DESIGN.*\.md$/i,
  /^NEXT-WORK\.md$/i,
  /^PLAN.*\.md$/i,
  /^SPEC.*\.md$/i,
  /^TODO\.md$/i,
];

function defaultReadFile(p: string): string | null {
  try {
    return nodeFs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function defaultListDir(p: string): string[] {
  try {
    return nodeFs.readdirSync(p);
  } catch {
    return [];
  }
}

/* Read the highest-priority project/spec docs from the cwd up to a byte
 * budget. Deterministic order so the digest is stable across runs. */
function readProjectDocs(
  cwd: string,
  budget: number,
  readFile: (p: string) => string | null,
  listDir: (p: string) => string[],
): string {
  const entries = listDir(cwd);
  if (entries.length === 0) return '';
  const picked: string[] = [];
  for (const pattern of PROJECT_DOC_PRIORITY) {
    for (const name of entries) {
      if (pattern.test(name) && !picked.includes(name)) picked.push(name);
    }
  }
  if (picked.length === 0) return '';
  const sep = cwd.includes('\\') ? '\\' : '/';
  const out: string[] = [];
  let used = 0;
  for (const name of picked) {
    if (used >= budget) break;
    const body = readFile(`${cwd}${sep}${name}`);
    if (!body) continue;
    const remaining = budget - used;
    const slice = body.length > remaining ? body.slice(0, remaining) : body;
    out.push(`## ${name}\n${slice.trim()}`);
    used += slice.length;
  }
  return out.join('\n\n');
}

export function assembleInvestigatorContext(
  input: AssembleInvestigatorInput,
): AssembledInvestigatorContext {
  const readFile = input.readFile ?? defaultReadFile;
  const listDir = input.listDir ?? defaultListDir;

  /* Fail closed: no resolvable brainstorm row -> no context. */
  let bs: BrainstormLike | null = null;
  try {
    bs = (input.db.getBrainstorm(input.anchorId) as unknown as
      | BrainstormLike
      | undefined) ?? null;
  } catch {
    bs = null;
  }
  if (!bs) {
    return { block: '', hasContent: false, anchorId: input.anchorId };
  }

  const label =
    input.label ?? bs.user_label ?? bs.derived_label ?? null;

  /* Scope-safe siblings. strictScope forbids the label fallback, so an
   * anchor with no prior refs surfaces nothing instead of crossing
   * projects. */
  let siblingBlock = '';
  try {
    siblingBlock = buildSiblingIndex({
      db: input.db,
      label,
      anchorId: input.anchorId,
      excludeId: input.anchorId,
      projectScopeId: input.projectScopeId ?? null,
      strictScope: true,
      limit: 5,
      distillationWords: 20,
    });
  } catch {
    siblingBlock = '';
  }

  /* Live transcript tail for THIS anchor (anchor-scoped reader). */
  let liveTail = '';
  try {
    liveTail = readTranscriptFromJsonlRefs(input.db, input.anchorId, {
      maxBytes: input.recentTranscriptBytes ?? 8000,
      readFile: (p) => readFile(p),
    });
  } catch {
    liveTail = '';
  }

  const projectDocs = readProjectDocs(
    input.cwd,
    input.projectDocsBytes ?? 6000,
    readFile,
    listDir,
  );

  const hasContent = Boolean(
    siblingBlock.trim() || liveTail.trim() || projectDocs.trim(),
  );
  if (!hasContent) {
    return { block: '', hasContent: false, anchorId: input.anchorId };
  }

  const labelLine = label ? ` "${label}"` : '';
  const sections: string[] = [
    `# Lex cold-start context (anchor ${input.anchorId.slice(0, 8)}${labelLine})`,
    'Assembled before boot from this project anchor only. Scope-isolated: nothing here comes from another project.',
  ];
  if (projectDocs.trim()) {
    sections.push(`# Project + specs\n${projectDocs}`);
  }
  if (siblingBlock.trim()) {
    sections.push(siblingBlock);
  }
  if (liveTail.trim()) {
    sections.push(`# Live recent thread (verbatim tail)\n${liveTail}`);
  }
  return {
    block: sections.join('\n\n'),
    hasContent: true,
    anchorId: input.anchorId,
  };
}

export interface RunInvestigatorInput {
  assembled: AssembledInvestigatorContext;
  cwd: string;
  /** Test seam / prod injection: run a headless Opus pass over the
   * prompt and return its text, or null on any failure. When omitted,
   * runInvestigator returns the assembled block unrefined. */
  spawnHeadless?: (
    prompt: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<string | null>;
  timeoutMs?: number;
}

export function buildInvestigatorPrompt(block: string): string {
  return [
    'You are a headless investigator priming an incoming Lex brainstorm',
    'session. Below is the scope-isolated context for ONE project anchor.',
    'Produce a tight briefing the incoming Lex will read on its first',
    'turn so it holds the thread immediately. Cover, in plain prose:',
    'what this project is, what is currently being worked on, the open',
    'questions, and what is still in the pipeline. Do NOT invent anything',
    'not supported by the context. Do NOT reference any other project.',
    'Output only the briefing.',
    '',
    '--- CONTEXT ---',
    block,
  ].join('\n');
}

/* Fail-safe: returns the Opus-refined briefing when the headless pass
 * succeeds, otherwise the deterministic assembled block. Never throws,
 * never returns empty when the assembler had content. */
export async function runInvestigator(
  input: RunInvestigatorInput,
): Promise<string> {
  const base = input.assembled.block;
  if (!input.assembled.hasContent) return base;
  if (!input.spawnHeadless) return base;
  try {
    const prompt = buildInvestigatorPrompt(base);
    const refined = await input.spawnHeadless(
      prompt,
      input.cwd,
      input.timeoutMs ?? 60000,
    );
    if (refined && refined.trim()) {
      const labelLine = `# Lex cold-start briefing (Opus investigator)`;
      return `${labelLine}\n\n${refined.trim()}\n\n${base}`;
    }
    return base;
  } catch {
    return base;
  }
}

/* Prod headless Opus pass. Now the shared spawnHeadlessOpus primitive
 * (headless-opus.ts) so cold-start and distillation run on ONE engine.
 * Re-exported under the original name to keep existing callers stable. */
export const defaultSpawnHeadless = spawnHeadlessOpus;

/* Pre-spawn cache. Keyed by anchorId (= brainstorm id), which the
 * cold-start route resolves the incoming session to. One-shot read via
 * takeInvestigatorBlock so a stale block is never served twice. */
interface CacheEntry {
  block: string;
  ts: number;
}
const investigatorCache = new Map<string, CacheEntry>();

export function cacheInvestigatorBlock(
  anchorId: string,
  block: string,
  now: number,
): void {
  if (!anchorId || !block.trim()) return;
  investigatorCache.set(anchorId, { block, ts: now });
}

/* Returns a fresh cached block (within maxAgeMs) and DELETES it so the
 * next cold start recomputes rather than replaying a stale prime. */
export function takeInvestigatorBlock(
  anchorId: string,
  maxAgeMs: number,
  now: number,
): string | null {
  const hit = investigatorCache.get(anchorId);
  if (!hit) return null;
  investigatorCache.delete(anchorId);
  if (now - hit.ts > maxAgeMs) return null;
  return hit.block;
}

export function _resetInvestigatorCache(): void {
  investigatorCache.clear();
}

export interface PrewarmInvestigatorInput {
  db: IndexDb;
  anchorId: string;
  cwd: string;
  label?: string | null;
  projectScopeId?: string | null;
  /** When false, skip the headless Opus pass and cache the
   * deterministic assembled block only. Default true. */
  enableHeadless?: boolean;
  /** Injected for tests; prod uses defaultSpawnHeadless. */
  spawnHeadless?: (
    prompt: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<string | null>;
  timeoutMs?: number;
  now?: () => number;
  readFile?: (p: string) => string | null;
  listDir?: (p: string) => string[];
}

export interface PrewarmInvestigatorResult {
  hasContent: boolean;
  refined: boolean;
  blockLength: number;
}

/* One-call orchestrator the spawn path runs BEFORE the Lex PTY starts:
 * assemble (fail-closed) -> optionally refine via headless Opus
 * (fail-safe) -> cache for the cold-start hook to serve. Never throws;
 * a confidently-empty anchor caches nothing and the cold-start route
 * falls through to its existing path (no regression). */
export async function prewarmInvestigator(
  input: PrewarmInvestigatorInput,
): Promise<PrewarmInvestigatorResult> {
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
    return { hasContent: false, refined: false, blockLength: 0 };
  }
  if (!assembled.hasContent) {
    return { hasContent: false, refined: false, blockLength: 0 };
  }
  const spawnHeadless =
    input.enableHeadless === false
      ? undefined
      : (input.spawnHeadless ?? defaultSpawnHeadless);
  const block = await runInvestigator({
    assembled,
    cwd: input.cwd,
    ...(spawnHeadless ? { spawnHeadless } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  const now = input.now ? input.now() : Date.now();
  cacheInvestigatorBlock(input.anchorId, block, now);
  /* Sliver 3: persist the block as a timestamped cold-start report so
   * the seed survives a daemon restart (the in-memory cache does not).
   * Best-effort; the in-memory fast path is unaffected if this fails. */
  writeColdStartReport(input.anchorId, block, now);
  return {
    hasContent: true,
    refined: block !== assembled.block,
    blockLength: block.length,
  };
}

export interface GateColdStartInput {
  db: IndexDb;
  anchorId: string;
  cwd: string;
  label?: string | null;
  projectScopeId?: string | null;
  now?: () => number;
  readFile?: (p: string) => string | null;
  listDir?: (p: string) => string[];
}

export interface GateColdStartResult {
  /** True when a block was assembled, cached, and a report persisted. */
  seeded: boolean;
  hasContent: boolean;
  /** Path of the report written this gate, or null. */
  reportPath: string | null;
  /** A prior report existed and was treated as a PRIOR (newest-wins). */
  hadPriorReport: boolean;
  blockLength: number;
}

/* Cold-start boot gate (2026-06-20). The SYNCHRONOUS, deterministic step
 * the spawn path runs to completion before Claude reaches its SessionStart
 * hook (the seed consumption point):
 *
 *   1. assemble the scope-isolated block from live refs + distillations +
 *      project docs (fail-closed; empty anchor seeds nothing).
 *   2. validate any existing distillation: a prior cold-start report is a
 *      PRIOR, not gospel. The fresh assemble reads CURRENT ref summaries
 *      so it supersedes a stale prior; newest report wins on read. We note
 *      whether a prior existed for the audit log.
 *   3. cache + persist the block as a timestamped report so the
 *      SessionStart cold-start route serves it as Lex's seed, durably.
 *
 * Cannot hang: no async wait, no subprocess. The deterministic block is
 * the guaranteed floor / fallback. The headless Opus refinement (slow) is
 * NOT part of this gate; the spawn path fires it as a bounded async
 * upgrade afterward. Never throws. */
export function gateColdStart(input: GateColdStartInput): GateColdStartResult {
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
    return {
      seeded: false,
      hasContent: false,
      reportPath: null,
      hadPriorReport: false,
      blockLength: 0,
    };
  }
  let hadPriorReport = false;
  try {
    hadPriorReport = readLatestColdStartReport(input.anchorId) !== null;
  } catch {
    hadPriorReport = false;
  }
  if (!assembled.hasContent) {
    return {
      seeded: false,
      hasContent: false,
      reportPath: null,
      hadPriorReport,
      blockLength: 0,
    };
  }
  const now = input.now ? input.now() : Date.now();
  cacheInvestigatorBlock(input.anchorId, assembled.block, now);
  const reportPath = writeColdStartReport(input.anchorId, assembled.block, now);
  return {
    seeded: true,
    hasContent: true,
    reportPath,
    hadPriorReport,
    blockLength: assembled.block.length,
  };
}
