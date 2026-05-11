/**
 * Wave 3 Lane B step 37 (LX-14). Memory janitor.
 *
 * Walks brainstorm_chunks, identifies merge candidates (high cosine
 * between chunk pairs from different sessions on the same topic) and
 * contradiction flags (same topic, divergent content). Writes findings
 * to audit_findings with source='janitor'.
 *
 * Runs on:
 *   - Manual POST /admin/janitor/run
 *   - Daemon weekly timer (DEVNEURAL_JANITOR_INTERVAL_MS, default 7 days)
 *
 * BF-4 compliance: the janitor uses the local embedder for similarity
 * only. It does not send brainstorm content to Anthropic (even when
 * Anthropic is the configured LLM provider). The merge/contradiction
 * analysis is pure cosine similarity with threshold heuristics; no LLM
 * call is made.
 *
 * Output: audit_findings rows with source='janitor'. The dashboard
 * JanitorApprovalsPanel reads these and lets the user approve merges
 * or dismiss false positives.
 */
import { randomUUID } from 'node:crypto';
import { embedOne } from '../embedder/index.js';
import type { Store } from '../store/index.js';
import type { BrainstormChunkRow, AuditFindingRow } from '../store/index-db.js';

/* Cosine thresholds. Both are intentionally conservative to keep
 * false-positive rates low - a merge or contradiction flag that is
 * wrong wastes the user's review time. */
const MERGE_THRESHOLD = 0.88;    /* very similar chunks: merge candidate */
const CONTRADICTION_THRESHOLD = 0.75;  /* topic overlap but divergent */

const MAX_BRAINSTORMS_PER_RUN = 20;   /* avoid long-running scans */
const MAX_CHUNKS_PER_BRAINSTORM = 50;

export interface JanitorResult {
  brainstorms_scanned: number;
  chunks_compared: number;
  merge_candidates_found: number;
  contradiction_flags_found: number;
  findings_written: number;
  skipped_reason?: string;
}

/* Dot product of two normalized vectors = cosine similarity. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

export async function runMemoryJanitor(
  store: Store,
  log: (msg: string) => void = () => undefined,
): Promise<JanitorResult> {
  const result: JanitorResult = {
    brainstorms_scanned: 0,
    chunks_compared: 0,
    merge_candidates_found: 0,
    contradiction_flags_found: 0,
    findings_written: 0,
  };

  /* Load a sample of ended brainstorms (most recent first). Limit to
   * keep the run bounded; weekly cadence means we re-scan over time. */
  const sessions = store.db.listBrainstorms({ status: 'ended', limit: MAX_BRAINSTORMS_PER_RUN });
  if (sessions.length === 0) {
    result.skipped_reason = 'no_ended_brainstorms';
    return result;
  }

  /* Build a flat array of (chunk, embedding) pairs for comparison.
   * We embed representative chunks (user turns only, > 50 chars) to
   * keep the embedding count bounded. */
  interface EmbeddedChunk {
    chunk: BrainstormChunkRow;
    vec: Float32Array;
    sessionLabel: string;
  }
  const embedded: EmbeddedChunk[] = [];

  for (const session of sessions) {
    result.brainstorms_scanned++;
    const label = session.user_label ?? session.derived_label ?? session.id.slice(0, 8);
    const chunks: BrainstormChunkRow[] = store.db.listBrainstormChunks(
      session.id,
      MAX_CHUNKS_PER_BRAINSTORM,
    );
    /* Only user turns with meaningful length to reduce noise. */
    const candidates = chunks.filter(
      (c) => c.role === 'user' && c.text.trim().length > 50,
    );
    /* Sample up to 5 representative chunks per session. */
    const sample = candidates.slice(0, 5);
    for (const chunk of sample) {
      try {
        const vec = await embedOne(chunk.text.slice(0, 512));
        embedded.push({ chunk, vec, sessionLabel: label });
      } catch {
        /* embedder not ready; skip this chunk */
      }
    }
  }

  if (embedded.length < 2) {
    result.skipped_reason = 'insufficient_embedded_chunks';
    return result;
  }

  log(`[janitor] comparing ${embedded.length} embedded chunks from ${result.brainstorms_scanned} sessions`);

  /* Pairwise comparison: O(n^2) but n is bounded by MAX_BRAINSTORMS *
   * 5 chunks = 100 max, so 100*99/2 = ~5000 comparisons. Acceptable. */
  const writtenIds = new Set<string>();

  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      const a = embedded[i]!;
      const b = embedded[j]!;
      /* Skip same-session pairs; merging within one session is out of scope. */
      if (a.chunk.brainstorm_id === b.chunk.brainstorm_id) continue;
      result.chunks_compared++;
      const sim = cosine(a.vec, b.vec);

      if (sim >= MERGE_THRESHOLD) {
        result.merge_candidates_found++;
        /* Dedup by (id_a, id_b) pair to avoid writing the same finding twice. */
        const pairKey = [a.chunk.id, b.chunk.id].sort().join('|');
        if (!writtenIds.has(`merge:${pairKey}`)) {
          writtenIds.add(`merge:${pairKey}`);
          const finding: Omit<AuditFindingRow, 'created_at' | 'resolved_at'> = {
            id: `janitor-merge-${randomUUID()}`,
            source: 'janitor',
            severity: 'low',
            page_slug: null,
            brainstorm_id: a.chunk.brainstorm_id,
            finding: `Merge candidate: chunk from "${a.sessionLabel}" is highly similar to chunk from "${b.sessionLabel}" (cosine ${sim.toFixed(3)})`,
            detail: JSON.stringify({
              chunk_a: { id: a.chunk.id, brainstorm_id: a.chunk.brainstorm_id, preview: a.chunk.text.slice(0, 100) },
              chunk_b: { id: b.chunk.id, brainstorm_id: b.chunk.brainstorm_id, preview: b.chunk.text.slice(0, 100) },
              cosine: sim,
            }),
            status: 'open',
          };
          try {
            store.db.insertAuditFinding(finding);
            result.findings_written++;
            log(`[janitor] merge candidate: ${a.chunk.id} + ${b.chunk.id} (cos=${sim.toFixed(3)})`);
          } catch (err) {
            log(`[janitor] insert merge finding failed: ${(err as Error).message}`);
          }
        }
      } else if (sim >= CONTRADICTION_THRESHOLD) {
        /* Borderline similarity: check if the texts diverge in sentiment.
         * Simple heuristic: look for opposing keywords. If both texts
         * contain "yes"/"no", "works"/"broken", "fixed"/"bug" in close
         * proximity, flag as potential contradiction. */
        if (looksLikeContradiction(a.chunk.text, b.chunk.text)) {
          result.contradiction_flags_found++;
          const pairKey = [a.chunk.id, b.chunk.id].sort().join('|');
          if (!writtenIds.has(`contra:${pairKey}`)) {
            writtenIds.add(`contra:${pairKey}`);
            const finding: Omit<AuditFindingRow, 'created_at' | 'resolved_at'> = {
              id: `janitor-contra-${randomUUID()}`,
              source: 'janitor',
              severity: 'medium',
              page_slug: null,
              brainstorm_id: a.chunk.brainstorm_id,
              finding: `Possible contradiction: chunks from "${a.sessionLabel}" and "${b.sessionLabel}" are on similar topics but appear to diverge (cosine ${sim.toFixed(3)})`,
              detail: JSON.stringify({
                chunk_a: { id: a.chunk.id, brainstorm_id: a.chunk.brainstorm_id, preview: a.chunk.text.slice(0, 100) },
                chunk_b: { id: b.chunk.id, brainstorm_id: b.chunk.brainstorm_id, preview: b.chunk.text.slice(0, 100) },
                cosine: sim,
              }),
              status: 'open',
            };
            try {
              store.db.insertAuditFinding(finding);
              result.findings_written++;
              log(`[janitor] contradiction: ${a.chunk.id} + ${b.chunk.id} (cos=${sim.toFixed(3)})`);
            } catch (err) {
              log(`[janitor] insert contradiction finding failed: ${(err as Error).message}`);
            }
          }
        }
      }
    }
  }

  log(
    `[janitor] done: scanned=${result.brainstorms_scanned} compared=${result.chunks_compared} ` +
    `merges=${result.merge_candidates_found} contradictions=${result.contradiction_flags_found} ` +
    `written=${result.findings_written}`,
  );
  return result;
}

/* Simple keyword-based contradiction heuristic. Not LLM-based; fast
 * and cheap. Checks for opposing term pairs within the two texts. */
const OPPOSING_PAIRS = [
  ['yes', 'no'],
  ['works', 'broken'],
  ['works', 'fails'],
  ['fixed', 'bug'],
  ['fixed', 'broken'],
  ['correct', 'wrong'],
  ['correct', 'incorrect'],
  ['pass', 'fail'],
  ['succeed', 'fail'],
  ['approve', 'reject'],
  ['approved', 'rejected'],
  ['enabled', 'disabled'],
  ['true', 'false'],
  ['valid', 'invalid'],
];

function looksLikeContradiction(textA: string, textB: string): boolean {
  const a = textA.toLowerCase();
  const b = textB.toLowerCase();
  for (const [pos, neg] of OPPOSING_PAIRS) {
    if (!pos || !neg) continue;
    /* Pattern: text A has pos and text B has neg (or vice versa). */
    if (
      (a.includes(pos) && b.includes(neg)) ||
      (a.includes(neg) && b.includes(pos))
    ) {
      return true;
    }
  }
  return false;
}
