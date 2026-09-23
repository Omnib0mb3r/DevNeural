/**
 * Lex context pack (operator, 2026-09-22 evening): "Lex's layer 2 cold
 * start and handover docs should be very rich in context even if it
 * fills her context. She needs that additional context to accurately
 * evaluate the workers on layer 3 and lower."
 *
 * One builder, pure over injected readers, used by the cold-start
 * preload, the self-clear reseed and GET /lex/context-pack. Scope rule
 * (fail closed): only the brainstorm's own directory and its ONE
 * supervised worker are read. Nothing from any other project.
 *
 * Sections, in priority order (later ones are dropped first when the
 * cap bites):
 *   1. the worker (slug, cwd, session, branch, HEAD, dirty, commits)
 *   2. the newest worker handovers, in full (what the worker said and
 *      what Lex changed)
 *   3. Lex's own last handover, in full
 *   4. plan task state (the checkbox lines of the referenced plan)
 *   5. the worker's recent turn summaries from its transcript
 *   6. open bugs (BUGS.md index rows that are OPEN or SMOKE-TESTING)
 *   7. the voice digest
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultRepoProbe, type RepoProbe } from './smart-clear.js';
import { listHandovers, readHandover, type HandoverFsDeps } from './handover-writer.js';
import { parseHandoverFrame } from './handover-frame.js';
import { transcriptPathFor } from './spawn-lex-session.js';
import { readFileTail } from '../dashboard/voice-layers-wire.js';
import type { LexDigest } from '../voice/voice-digest.js';

export interface ContextPackWorker {
  anchorId: string;
  slug: string;
  cwd: string | null;
  sessionId: string | null;
}

export interface ContextPackDeps {
  brainstormId: string;
  worker: ContextPackWorker | null;
  probe?: RepoProbe;
  recentCommits?: (cwd: string, n: number) => string[];
  handoverFs?: HandoverFsDeps;
  readFile?: (p: string) => string | null;
  readTail?: (p: string, bytes: number) => string;
  transcriptPath?: (cwd: string, sessionId: string) => string;
  digest?: LexDigest | null;
  /** Extra roots to resolve a relative plan reference against. */
  planRoots?: string[];
  maxChars?: number;
}

export const CONTEXT_PACK_MAX_CHARS = 40_000;
const HANDOVERS_TO_INCLUDE = 2;
const SUMMARIES_TO_INCLUDE = 5;
const SUMMARY_HEAD_CHARS = 600;
const SUMMARY_MIN_CHARS = 80;
const TAIL_BYTES = 512 * 1024;

export function defaultRecentCommits(cwd: string, n: number): string[] {
  try {
    const out = execFileSync('git', ['log', '--oneline', `-n${n}`], {
      cwd,
      encoding: 'utf-8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/* Assistant end-of-turn texts (not tool_use acks) from a jsonl tail,
 * newest last, each cut to a head. Same rule as the turn_summary event. */
export function extractTurnSummaries(
  tail: string,
  n = SUMMARIES_TO_INCLUDE,
  headChars = SUMMARY_HEAD_CHARS,
): string[] {
  const out: string[] = [];
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    let rec: {
      type?: string;
      role?: string;
      message?: { role?: string; stop_reason?: string; content?: unknown };
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const role = rec.role ?? rec.message?.role;
    if (role !== 'assistant') continue;
    if (rec.message?.stop_reason === 'tool_use') continue;
    const c = rec.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      text = (c as Array<{ type?: string; text?: string }>)
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length < SUMMARY_MIN_CHARS) continue;
    out.push(text.slice(0, headChars));
  }
  return out.slice(-n);
}

/* BUGS.md index rows that are still live. The index block is the
 * "start here" pointer by the operator's own rule. */
export function openBugRows(bugsMd: string, max = 30): string[] {
  const start = bugsMd.indexOf('<!-- INDEX START -->');
  const end = bugsMd.indexOf('<!-- INDEX END -->');
  const block = start >= 0 && end > start ? bugsMd.slice(start, end) : bugsMd;
  return block
    .split(/\r?\n/)
    .filter((l) => /\bBUG-\d+\b/.test(l) && /\b(OPEN|SMOKE-TESTING)\b/.test(l))
    .map((l) => l.trim())
    .slice(0, max);
}

/* Headings and checkbox lines of a plan file: the task state at a glance. */
export function planTaskState(planMd: string, maxLines = 80): string[] {
  return planMd
    .split(/\r?\n/)
    .filter((l) => /^\s*- \[( |x|X)\]/.test(l) || /^#{1,3} /.test(l))
    .map((l) => l.replace(/\s+$/, ''))
    .slice(0, maxLines);
}

export function resolvePlanRef(
  ref: string,
  roots: string[],
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string | null {
  const file = ref
    .split(/[,;]/)[0]!
    .trim()
    .replace(/\s.*$/, '')
    .replace(/\\/g, '/');
  if (!file) return null;
  if (path.isAbsolute(file)) return exists(file) ? file : null;
  for (const root of roots) {
    const p = path.join(root, file).replace(/\\/g, '/');
    if (exists(p)) return p;
  }
  return null;
}

export interface ContextPack {
  text: string;
  sections: string[];
  truncated: boolean;
}

export function buildLexContextPack(deps: ContextPackDeps): ContextPack {
  const probe = deps.probe ?? defaultRepoProbe;
  const recentCommits = deps.recentCommits ?? defaultRecentCommits;
  const readFile = deps.readFile ?? defaultReadFile;
  const readTail = deps.readTail ?? readFileTail;
  const pathFor =
    deps.transcriptPath ??
    ((cwd: string, sessionId: string) =>
      transcriptPathFor({ cwd, ccSessionId: sessionId, homeDir: os.homedir() }));
  const maxChars = deps.maxChars ?? CONTEXT_PACK_MAX_CHARS;
  const fsDeps = deps.handoverFs ?? {};
  const parts: Array<{ name: string; text: string }> = [];

  /* 1. the worker */
  const w = deps.worker;
  if (w) {
    const lines = [`## Your worker: ${w.slug}`];
    lines.push(`- anchor ${w.anchorId}`);
    lines.push(`- session ${w.sessionId ?? 'none open'}`);
    if (w.cwd) {
      lines.push(`- cwd ${w.cwd}`);
      const sig = probe(w.cwd);
      if (sig.branch || sig.headSha) {
        lines.push(
          `- git: ${sig.branch ? `branch ${sig.branch}` : ''}${sig.headSha ? ` HEAD ${sig.headSha}` : ''}${sig.dirty ? ', working tree DIRTY' : ', tree clean'}`,
        );
      }
      const commits = recentCommits(w.cwd, 8);
      if (commits.length) {
        lines.push('- recent commits:');
        for (const c of commits) lines.push(`  - ${c}`);
      }
    }
    parts.push({ name: 'worker', text: lines.join('\n') });
  } else {
    parts.push({ name: 'worker', text: '## Your worker\nNo worker is bound to this brainstorm.' });
  }

  /* 2 + 3. handovers, in full */
  let planRef: string | null = null;
  const entries = listHandovers(deps.brainstormId, fsDeps).filter((e) => !e.legacy);
  const workerOnes = entries.filter((e) => e.kind !== 'lex-self-clear').slice(0, HANDOVERS_TO_INCLUDE);
  const lexOne = entries.find((e) => e.kind === 'lex-self-clear') ?? null;
  const render = (title: string, files: typeof entries): string | null => {
    const chunks: string[] = [];
    for (const e of files) {
      const content = readHandover(deps.brainstormId, e.file, fsDeps);
      if (!content) continue;
      const frame = parseHandoverFrame(content);
      if (frame?.lex?.planReference && !planRef) planRef = frame.lex.planReference;
      chunks.push(`### ${e.file}\n${content.trim()}`);
    }
    return chunks.length ? `## ${title}\n${chunks.join('\n\n')}` : null;
  };
  const wh = render('Latest worker handovers (worker draft, then the review)', workerOnes);
  if (wh) parts.push({ name: 'worker-handovers', text: wh });
  const lh = lexOne ? render('Your own last handover', [lexOne]) : null;
  if (lh) parts.push({ name: 'lex-handover', text: lh });

  /* 4. plan task state */
  if (planRef) {
    const roots = [...(w?.cwd ? [w.cwd] : []), ...(deps.planRoots ?? [])];
    const resolved = resolvePlanRef(planRef, roots, (p) => readFile(p) !== null);
    const md = resolved ? readFile(resolved) : null;
    if (resolved && md) {
      const state = planTaskState(md);
      if (state.length) {
        parts.push({ name: 'plan', text: `## Plan task state (${resolved})\n${state.join('\n')}` });
      }
    }
  }

  /* 5. the worker's recent summaries */
  if (w?.cwd && w.sessionId) {
    let tail = '';
    try {
      tail = readTail(pathFor(w.cwd, w.sessionId), TAIL_BYTES);
    } catch {
      tail = '';
    }
    const sums = extractTurnSummaries(tail);
    if (sums.length) {
      parts.push({
        name: 'summaries',
        text: `## What the worker reported lately (oldest first)\n${sums.map((s) => `- ${s}`).join('\n')}`,
      });
    }
  }

  /* 6. open bugs */
  if (w?.cwd) {
    const bugs = readFile(path.join(w.cwd, 'BUGS.md'));
    if (bugs) {
      const rows = openBugRows(bugs);
      if (rows.length) parts.push({ name: 'bugs', text: `## Open bugs (${w.slug})\n${rows.join('\n')}` });
    }
  }

  /* 7. the voice digest */
  if (deps.digest) {
    const d = deps.digest;
    parts.push({
      name: 'digest',
      text: [
        '## Where the conversation with Michael stood',
        `- current task: ${d.currentTask}`,
        `- last decision: ${d.lastDecision}`,
        `- open question: ${d.openQuestion}`,
        `- next steps: ${d.nextSteps}`,
      ].join('\n'),
    });
  }

  const out: string[] = [];
  const sections: string[] = [];
  let used = 0;
  let truncated = false;
  for (const p of parts) {
    const cost = p.text.length + 2;
    if (used + cost > maxChars) {
      truncated = true;
      break;
    }
    out.push(p.text);
    sections.push(p.name);
    used += cost;
  }
  if (truncated) out.push('(context pack truncated at the size cap)');
  return { text: out.join('\n\n'), sections, truncated };
}
