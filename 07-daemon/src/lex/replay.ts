/**
 * Wave 2 day 5 step 21 (LX-2 / B2). A/B replay harness for Lex
 * system-prompt revisions. Loads two archived prompt versions, runs
 * a fixture file (one user turn per JSONL line, format
 * { user: string }) through each via the configured LLM provider,
 * and writes a side-by-side diff at
 * <DATA_ROOT>/lex-replay-output/<timestamp>/diff.md.
 *
 * The "hermetic Lex spawn" the spec describes uses a fresh-context
 * Claude Code PTY; that path lands in Wave 3 once the prompt-
 * versioning archive has accumulated enough revisions to be
 * worth A/B-testing through a real PTY. The day 5 implementation
 * uses the in-process LLM provider (same code path as the
 * self-audit) so the harness ships with the same provider gate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lexReplayRoot, ensureDir } from '../paths.js';
import { readPromptVersion } from './prompt-archive.js';
import { pickProvider } from '../llm/index.js';

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
  skipped_reason?: 'no_provider' | 'version_a_missing' | 'version_b_missing' | 'no_inputs';
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
  const provider = pickProvider();
  if (!provider || !provider.isConfigured()) {
    return {
      output_dir: outDir,
      diff_path: '',
      version_a: opts.versionA,
      version_b: opts.versionB,
      pairs: 0,
      errors: [],
      skipped_reason: 'no_provider',
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
  const errors: string[] = [];
  const pairs: ReplayPair[] = [];
  for (const input of inputs) {
    const aT0 = Date.now();
    let aText = '';
    let aErr: string | undefined;
    try {
      const r = await provider.call('reconcile', {
        systemBlocks: [{ text: promptA, cache: true }],
        user: input.user,
        maxTokens: 600,
        temperature: 0.1,
      });
      aText = r.text;
    } catch (err) {
      aErr = (err as Error).message;
      errors.push(`A "${input.user.slice(0, 30)}": ${aErr}`);
    }
    const aMs = Date.now() - aT0;
    const bT0 = Date.now();
    let bText = '';
    let bErr: string | undefined;
    try {
      const r = await provider.call('reconcile', {
        systemBlocks: [{ text: promptB, cache: true }],
        user: input.user,
        maxTokens: 600,
        temperature: 0.1,
      });
      bText = r.text;
    } catch (err) {
      bErr = (err as Error).message;
      errors.push(`B "${input.user.slice(0, 30)}": ${bErr}`);
    }
    const bMs = Date.now() - bT0;
    pairs.push({
      input: input.user,
      a: { text: aText, ms: aMs, ...(aErr ? { error: aErr } : {}) },
      b: { text: bText, ms: bMs, ...(bErr ? { error: bErr } : {}) },
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
