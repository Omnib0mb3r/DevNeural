/**
 * Wave 2 day 4 step 16 (Karpathy steal 3 / A8). LLM self-audit.
 *
 * Picks N random canonical wiki pages and asks the configured LLM
 * (via the existing provider abstraction) "are these accurate,
 * useful, well-scoped?". Parses the per-page JSON verdict and
 * writes one audit_findings row per non-OK verdict with
 * source='self-audit'.
 *
 * Spec calls for spawning a fresh-context Claude Code PTY through
 * the existing PTY-spawn mechanism. The day 4 implementation uses
 * the in-process LLM provider for simplicity and parity with the
 * Pass 1 / Pass 2 ingest path; the PTY-spawn variant lands in
 * Wave 2 day 5 once the prompt-versioning archive ships and the
 * harness can target a specific prompt revision.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Store } from '../store/index.js';
import { wikiPagesDir } from '../paths.js';
import { parsePage } from './schema.js';
import { pickProvider, LlmNotConfiguredError } from '../llm/index.js';
import { createHash } from 'node:crypto';

export interface SelfAuditResult {
  scanned: number;
  llm_calls: number;
  findings_written: number;
  skipped_reason?: 'no_provider' | 'no_canonical_pages' | 'provider_error';
  errors: string[];
}

interface PageVerdict {
  page_id: string;
  ok: boolean;
  severity?: 'low' | 'medium' | 'high';
  reason?: string;
}

const SYSTEM_PROMPT =
  'You audit a small batch of internal wiki pages and emit a JSON ' +
  'array of verdicts. For each page, decide whether the trigger / ' +
  'insight / summary are accurate, useful, and well-scoped. Output ' +
  'STRICT JSON ONLY: an array of {"page_id": string, "ok": boolean, ' +
  '"severity"?: "low"|"medium"|"high", "reason"?: string}. Set ok=false ' +
  'for pages that are inaccurate, contradictory, too narrow, too ' +
  'broad, or duplicates of another page. No prose, no markdown.';

function pickRandomPages(
  k: number,
): Array<{ filePath: string; raw: string }> {
  const dir = wikiPagesDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) return [];
  const out: Array<{ filePath: string; raw: string }> = [];
  const used = new Set<number>();
  while (out.length < k && used.size < files.length) {
    const idx = Math.floor(Math.random() * files.length);
    if (used.has(idx)) continue;
    used.add(idx);
    const file = files[idx]!;
    try {
      const filePath = path.posix.join(dir, file);
      out.push({ filePath, raw: fs.readFileSync(filePath, 'utf-8') });
    } catch {
      /* malformed page; skip */
    }
  }
  return out;
}

function buildBatchPrompt(
  pages: Array<{ filePath: string; raw: string }>,
): string {
  const blocks: string[] = [];
  for (const p of pages) {
    const parsed = parsePage(p.raw);
    blocks.push(
      `### page_id: ${parsed.frontmatter.id}\n` +
        `title: ${parsed.frontmatter.title}\n` +
        `trigger: ${parsed.frontmatter.trigger}\n` +
        `insight: ${parsed.frontmatter.insight}\n` +
        `summary: ${parsed.frontmatter.summary}`,
    );
  }
  return blocks.join('\n\n---\n\n');
}

function parseVerdicts(text: string): PageVerdict[] {
  /* Tolerate fenced JSON or leading prose; pull the first array we
   * can parse. Drop verdicts that lack an id so a malformed line
   * cannot poison the audit_findings write loop. */
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenceMatch?.[1] ?? text).trim();
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];
  try {
    const parsed = JSON.parse(arrayMatch[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PageVerdict[] = [];
    for (const v of parsed) {
      if (!v || typeof v !== 'object') continue;
      const obj = v as Record<string, unknown>;
      if (typeof obj.page_id !== 'string') continue;
      out.push({
        page_id: obj.page_id,
        ok: obj.ok !== false,
        ...(obj.severity === 'low' || obj.severity === 'medium' || obj.severity === 'high'
          ? { severity: obj.severity }
          : {}),
        ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function runSelfAudit(
  store: Store,
  opts: {
    sample?: number;
    log?: (m: string) => void;
  } = {},
): Promise<SelfAuditResult> {
  const log = opts.log ?? (() => undefined);
  const sample = Math.min(50, Math.max(1, opts.sample ?? 10));
  const out: SelfAuditResult = {
    scanned: 0,
    llm_calls: 0,
    findings_written: 0,
    errors: [],
  };
  const provider = pickProvider();
  if (!provider) {
    out.skipped_reason = 'no_provider';
    return out;
  }
  if (!provider.isConfigured()) {
    out.skipped_reason = 'no_provider';
    return out;
  }
  const pages = pickRandomPages(sample);
  if (pages.length === 0) {
    out.skipped_reason = 'no_canonical_pages';
    return out;
  }
  out.scanned = pages.length;
  const prompt = buildBatchPrompt(pages);
  try {
    const res = await provider.call('lint', {
      systemBlocks: [{ text: SYSTEM_PROMPT, cache: true }],
      user: prompt,
      maxTokens: 1200,
      temperature: 0.1,
    });
    out.llm_calls = 1;
    const verdicts = parseVerdicts(res.text);
    for (const v of verdicts) {
      if (v.ok) continue;
      try {
        const detail = v.reason ?? 'self-audit flagged page';
        const id = `selfaudit-${createHash('sha1')
          .update(`${v.page_id}|${detail}`)
          .digest('hex')
          .slice(0, 16)}`;
        store.db.insertAuditFinding({
          id,
          source: 'self-audit',
          severity: v.severity ?? 'medium',
          page_slug: v.page_id,
          finding: 'self-audit flagged page',
          detail,
        });
        out.findings_written += 1;
      } catch (err) {
        out.errors.push(`finding insert ${v.page_id}: ${(err as Error).message}`);
      }
    }
    log(
      `[self-audit] sampled=${out.scanned} verdicts=${verdicts.length} flagged=${out.findings_written}`,
    );
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      out.skipped_reason = 'no_provider';
      return out;
    }
    out.skipped_reason = 'provider_error';
    out.errors.push((err as Error).message);
  }
  return out;
}
