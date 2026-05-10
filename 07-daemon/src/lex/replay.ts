/**
 * Wave 2 day 5 step 21 (LX-2 / B2) + carry-over #4. A/B replay harness
 * for Lex system-prompt revisions. Loads two archived prompt versions,
 * runs a fixture file (one user turn per JSONL line, format
 * { user: string }) through each via a hermetic Claude Code PTY spawn,
 * and writes a side-by-side diff at
 * <DATA_ROOT>/lex-replay-output/<timestamp>/diff.md.
 *
 * The execution path is now spec-compliant: each prompt version gets
 * its own throwaway PTY at a non-brainstorm tmp cwd, the entire fixture
 * is replayed through that PTY, then the PTY + cwd tear down. The
 * earlier day-5 ship used the in-process LLM provider as a shortcut;
 * the diff format + output dir are unchanged so existing consumers
 * (admin route, LexReplayViewer) need no updates.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lexReplayRoot, ensureDir } from '../paths.js';
import { readPromptVersion } from './prompt-archive.js';
import { runHermeticVersion } from './replay-pty.js';

export interface ReplayInput {
  user: string;
}

export interface ReplayPair {
  input: string;
  a: { text: string; ms: number; error?: string };
  b: { text: string; ms: number; error?: string };
}

export interface ReplayResult {
  output_dir: string;
  diff_path: string;
  version_a: string;
  version_b: string;
  pairs: number;
  errors: string[];
  skipped_reason?:
    | 'version_a_missing'
    | 'version_b_missing'
    | 'no_inputs';
}

function readFixture(filePath: string): ReplayInput[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const out: ReplayInput[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { user?: string };
      if (typeof parsed.user === 'string') out.push({ user: parsed.user });
    } catch {
      /* tolerate plain-text fixture lines */
      out.push({ user: trimmed });
    }
  }
  return out;
}

function writeDiff(
  outDir: string,
  versionA: string,
  versionB: string,
  pairs: ReplayPair[],
): string {
  ensureDir(outDir);
  const diffPath = path.posix.join(outDir, 'diff.md');
  const lines: string[] = [
    `# Lex prompt A/B replay`,
    ``,
    `- run: ${new Date().toISOString()}`,
    `- version_a: \`${versionA}\``,
    `- version_b: \`${versionB}\``,
    `- pairs: ${pairs.length}`,
    ``,
  ];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    lines.push(`## Turn ${i + 1}`);
    lines.push('');
    lines.push('### user');
    lines.push('```');
    lines.push(p.input);
    lines.push('```');
    lines.push('');
    lines.push(`### A (${versionA}) — ${p.a.ms}ms`);
    lines.push(p.a.error ? `_error: ${p.a.error}_` : p.a.text);
    lines.push('');
    lines.push(`### B (${versionB}) — ${p.b.ms}ms`);
    lines.push(p.b.error ? `_error: ${p.b.error}_` : p.b.text);
    lines.push('');
  }
  fs.writeFileSync(diffPath, lines.join('\n'), 'utf-8');
  return diffPath;
}

export async function runLexReplay(opts: {
  inputPath: string;
  versionA: string;
  versionB: string;
  log?: (m: string) => void;
}): Promise<ReplayResult> {
  const log = opts.log ?? (() => undefined);
  const ts = new Date().toISOString().replace(/[:]/g, '-');
  const outDir = path.posix.join(lexReplayRoot(), ts);
  const promptA = readPromptVersion(opts.versionA);
  const promptB = readPromptVersion(opts.versionB);
  if (promptA === null) {
    return {
      output_dir: outDir,
      diff_path: '',
      version_a: opts.versionA,
      version_b: opts.versionB,
      pairs: 0,
      errors: [],
      skipped_reason: 'version_a_missing',
    };
  }
  if (promptB === null) {
    return {
      output_dir: outDir,
      diff_path: '',
      version_a: opts.versionA,
      version_b: opts.versionB,
      pairs: 0,
      errors: [],
      skipped_reason: 'version_b_missing',
    };
  }
  const inputs = readFixture(opts.inputPath);
  if (inputs.length === 0) {
    return {
      output_dir: outDir,
      diff_path: '',
      version_a: opts.versionA,
      version_b: opts.versionB,
      pairs: 0,
      errors: [],
      skipped_reason: 'no_inputs',
    };
  }
  /* Run each version against the SAME fixture in order so the diff
   * isolates the prompt as the only varying input. Run A then B; we
   * could parallelise, but two simultaneous Claude Code spawns at the
   * same cwd-slug pattern have produced cross-talk in past testing,
   * and replay is rarely latency-sensitive. */
  const userTurns = inputs.map((i) => i.user);
  log(`[lex-replay] version A: spawning hermetic PTY (${opts.versionA})`);
  const aResults = await runHermeticVersion(promptA, userTurns, { log });
  log(`[lex-replay] version B: spawning hermetic PTY (${opts.versionB})`);
  const bResults = await runHermeticVersion(promptB, userTurns, { log });

  const errors: string[] = [];
  const pairs: ReplayPair[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const userText = inputs[i]!.user;
    const a = aResults[i] ?? { text: '', ms: 0, error: 'missing-A' };
    const b = bResults[i] ?? { text: '', ms: 0, error: 'missing-B' };
    if (a.error) errors.push(`A "${userText.slice(0, 30)}": ${a.error}`);
    if (b.error) errors.push(`B "${userText.slice(0, 30)}": ${b.error}`);
    pairs.push({
      input: userText,
      a: { text: a.text, ms: a.ms, ...(a.error ? { error: a.error } : {}) },
      b: { text: b.text, ms: b.ms, ...(b.error ? { error: b.error } : {}) },
    });
  }
  const diffPath = writeDiff(outDir, opts.versionA, opts.versionB, pairs);
  log(`[lex-replay] wrote ${diffPath} pairs=${pairs.length}`);
  return {
    output_dir: outDir,
    diff_path: diffPath,
    version_a: opts.versionA,
    version_b: opts.versionB,
    pairs: pairs.length,
    errors,
  };
}
