/**
 * Wave 2 day 3 step 13 (BF-13 + BF-14). One-shot backfill that walks
 * every brainstorm_sessions row predating Wave 1 day 1 (or any row
 * with zero brainstorm_chunks rows), ingests the legacy transcript
 * into brainstorm_chunks, classifies kind via mode (BF-14), and
 * computes lineage between each brainstorm-summary and every wiki
 * page.
 *
 * Lineage bands (spec section 11 day 3 step 13):
 *   - high       (cosine >= 0.85): auto-link via source_brainstorms.
 *                derived_from_brainstorm only set true when cosine
 *                >= 0.90 OR body overlap >= 30% (heuristic).
 *   - borderline (0.65 .. 0.85): row written to backfill_review_queue
 *                with status='pending' so /brainstorms/backfill-review
 *                can resolve manually.
 *   - low        (< 0.65): logged to crossproject_fallback_log for
 *                audit; never linked.
 *
 * Meeting-kind sessions skip lineage entirely; no auto-link to wiki
 * pages from meetings, per BF-15 (the user must explicitly call
 * POST /meetings/:id/promote-to-wiki to derive a wiki page from a
 * meeting). Backfill stops at brainstorm_chunks ingest for meetings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Store } from '../store/index.js';
import type { BrainstormSessionRow, BrainstormChunkRow } from '../store/index-db.js';
import { transcriptsFile, wikiPagesDir, wikiPendingDir } from '../paths.js';
import { embedOne, getModelId } from '../embedder/index.js';
import { readPage } from './schema.js';
import { rewritePageFrontmatter, loadPage } from '../reinforcement/index.js';
import { randomUUID } from 'node:crypto';

const BAND_HIGH = 0.85;
const BAND_BORDERLINE = 0.65;
const PRIMARY_COSINE = 0.9;
const PRIMARY_BODY_OVERLAP = 0.3;

export interface BackfillBrainstormsResult {
  scanned: number;
  ingested: number;
  chunks_written: number;
  high_links: number;
  borderline_queued: number;
  low_logged: number;
  meetings_skipped_for_lineage: number;
  errors: string[];
}

interface LegacyTurn {
  role: 'user' | 'assistant' | 'lex' | 'tool';
  text: string;
  timestamp_ms: number;
}

function loadTranscriptTurns(
  projectId: string,
  sessionId: string,
): LegacyTurn[] {
  const file = transcriptsFile(projectId);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const turns: LegacyTurn[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as {
        role?: string;
        text?: string;
        session?: string;
        timestamp?: string;
        kind?: string;
      };
      if (rec.session !== sessionId) continue;
      if (rec.role !== 'user' && rec.role !== 'assistant') continue;
      if (rec.kind && rec.kind !== 'text' && rec.kind !== '') continue;
      const text = (rec.text ?? '').trim();
      if (!text) continue;
      const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
      turns.push({
        role: rec.role as 'user' | 'assistant',
        text,
        timestamp_ms: Number.isFinite(tsMs) ? tsMs : Date.now(),
      });
    } catch {
      continue;
    }
  }
  return turns;
}

function classifyKind(mode: string): 'brainstorm' | 'meeting' {
  /* BF-14: mode='conversation' or 'push-to-talk' -> brainstorm;
   * mode='notes' -> meeting (per the user's clarification 2026-05-10).
   * Anything else falls back to brainstorm so legacy nulls don't
   * silently become meetings (the privacy class is stricter on
   * meetings). */
  if (mode === 'notes') return 'meeting';
  return 'brainstorm';
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

function bodyOverlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.max(1, Math.min(ta.size, tb.size));
}

function cosine(a: Float32Array, b: Float32Array): number {
  /* Both vectors are pre-normalized by the embedder, so dot product
   * is the cosine similarity directly. Length mismatch is unrecover
   * able and indicates a model swap mid-run. */
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return s;
}

function bandFor(c: number): 'high' | 'borderline' | 'low' {
  if (c >= BAND_HIGH) return 'high';
  if (c >= BAND_BORDERLINE) return 'borderline';
  return 'low';
}

interface PageHandle {
  id: string;
  body: string;
  vec: Float32Array;
}

async function loadAllWikiPages(log: (m: string) => void): Promise<PageHandle[]> {
  const dirs = [wikiPagesDir(), wikiPendingDir()];
  const pages: PageHandle[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of entries) {
      try {
        const page = readPage(path.posix.join(dir, file));
        const body =
          `${page.frontmatter.title}\n\n${page.frontmatter.summary}\n\n${page.sections.pattern.slice(0, 2000)}`;
        const vec = await embedOne(body);
        pages.push({ id: page.frontmatter.id, body, vec });
      } catch (err) {
        log(`[backfill-brainstorms] page parse failed ${file}: ${(err as Error).message}`);
      }
    }
  }
  return pages;
}

function buildSummary(turns: LegacyTurn[]): string {
  /* The legacy session may have no last_summary; synthesize one from
   * the first 10 user turns + last 10 assistant turns so cosine has
   * meaningful signal. Cap at 4k chars to match the embed input
   * budget the live pipeline uses. */
  const userTurns = turns.filter((t) => t.role === 'user').slice(0, 10);
  const lexTurns = turns.filter((t) => t.role === 'assistant').slice(-10);
  const head = userTurns.map((t) => `USER: ${t.text}`).join('\n');
  const tail = lexTurns.map((t) => `LEX: ${t.text}`).join('\n');
  return `${head}\n\n${tail}`.slice(0, 4000);
}

function lineageHigh(
  store: Store,
  brainstormId: string,
  pageId: string,
  cos: number,
  summary: string,
  pageBody: string,
): boolean {
  /* Apply the heuristic for derived_from_brainstorm: cosine >= 0.90 OR
   * body overlap >= 30%. The page may not exist on disk if it was
   * archived between vector load and write; tolerate the miss. */
  const page = loadPage(pageId);
  if (!page) return false;
  const existing = page.frontmatter.source_brainstorms ?? [];
  if (!existing.includes(brainstormId)) {
    const overlap = bodyOverlap(summary, pageBody);
    const isPrimary = cos >= PRIMARY_COSINE || overlap >= PRIMARY_BODY_OVERLAP;
    rewritePageFrontmatter(page, {
      ...page.frontmatter,
      source_brainstorms: [...existing, brainstormId],
      derived_from_brainstorm:
        page.frontmatter.derived_from_brainstorm === true || isPrimary,
    });
    void store;
    return true;
  }
  return false;
}

export async function runBackfillBrainstorms(
  store: Store,
  log: (msg: string) => void = () => undefined,
): Promise<BackfillBrainstormsResult> {
  const out: BackfillBrainstormsResult = {
    scanned: 0,
    ingested: 0,
    chunks_written: 0,
    high_links: 0,
    borderline_queued: 0,
    low_logged: 0,
    meetings_skipped_for_lineage: 0,
    errors: [],
  };
  const pages = await loadAllWikiPages(log);
  log(`[backfill-brainstorms] loaded ${pages.length} wiki page(s) for lineage`);
  const sessions: BrainstormSessionRow[] = store.db.listBrainstorms({ limit: 5000 });
  for (const bs of sessions) {
    out.scanned += 1;
    const existing = store.db.countBrainstormChunks(bs.id);
    if (existing > 0) continue;
    if (!bs.claude_session_id) continue;
    const projectId = store.db.projectIdBySession(bs.claude_session_id);
    if (!projectId) continue;
    const turns = loadTranscriptTurns(projectId, bs.claude_session_id);
    if (turns.length === 0) continue;
    const kind = classifyKind(bs.mode);
    const inferredMode: BrainstormChunkRow['mode'] =
      bs.mode === 'conversation' || bs.mode === 'push-to-talk' || bs.mode === 'notes'
        ? bs.mode
        : 'conversation';
    const modelId = getModelId();
    let chunkN = 0;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!;
      try {
        store.db.insertBrainstormChunk({
          id: `bc-${bs.id}-${i}`,
          brainstorm_id: bs.id,
          turn_index: i,
          role: t.role === 'assistant' ? 'lex' : 'user',
          mode: inferredMode,
          text: t.text,
          model_id: modelId,
        });
        chunkN++;
      } catch (err) {
        out.errors.push(`chunk insert ${bs.id}#${i}: ${(err as Error).message}`);
      }
    }
    out.chunks_written += chunkN;
    out.ingested += 1;
    /* Patch kind on the row so future reads do not re-run classification.
     * Direct UPDATE via the Phase Two setter; the legacy
     * updateBrainstorm round-trips through INSERT OR REPLACE which
     * resets Phase Two columns to defaults. */
    store.db.setBrainstormPhaseTwo(bs.id, { kind });
    if (kind === 'meeting') {
      out.meetings_skipped_for_lineage += 1;
      continue;
    }
    const summary = bs.last_summary?.trim() || buildSummary(turns);
    if (!summary) continue;
    let summaryVec: Float32Array;
    try {
      summaryVec = await embedOne(summary);
    } catch (err) {
      out.errors.push(`embed summary ${bs.id}: ${(err as Error).message}`);
      continue;
    }
    for (const p of pages) {
      const c = cosine(summaryVec, p.vec);
      const band = bandFor(c);
      if (band === 'high') {
        try {
          if (lineageHigh(store, bs.id, p.id, c, summary, p.body)) {
            out.high_links += 1;
          }
        } catch (err) {
          out.errors.push(`lineage write ${bs.id}->${p.id}: ${(err as Error).message}`);
        }
      } else if (band === 'borderline') {
        try {
          store.db.insertBackfillReview({
            id: `br-${bs.id}-${p.id}`,
            brainstorm_id: bs.id,
            candidate_page_slug: p.id,
            cosine: c,
            band,
          });
          out.borderline_queued += 1;
        } catch (err) {
          /* Duplicate insert is fine on re-run; log other errors. */
          if (!/UNIQUE/.test((err as Error).message)) {
            out.errors.push(`review insert ${bs.id}->${p.id}: ${(err as Error).message}`);
          }
        }
      } else {
        try {
          store.db.insertCrossprojectFallback({
            id: randomUUID(),
            candidate_slug: p.id,
            reason: `backfill low-band cosine=${c.toFixed(3)} brainstorm=${bs.id}`,
            participating_projects: JSON.stringify([projectId]),
          });
          out.low_logged += 1;
        } catch (err) {
          out.errors.push(`fallback log ${bs.id}->${p.id}: ${(err as Error).message}`);
        }
      }
    }
  }
  log(
    `[backfill-brainstorms] done scanned=${out.scanned} ingested=${out.ingested} chunks=${out.chunks_written} high=${out.high_links} borderline=${out.borderline_queued} low=${out.low_logged}`,
  );
  return out;
}
