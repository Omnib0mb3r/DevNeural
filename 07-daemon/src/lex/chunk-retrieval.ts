/**
 * Wave 3 Lane B step 31 (LX-10). Bounded brainstorm-chunk retrieval.
 *
 * Takes a query string and returns the top 2-3 most semantically
 * similar brainstorm_chunks rows using cosine similarity. Uses the
 * same Xenova embedder pipeline as Wave 2 day 3 backfill.
 *
 * Two search paths:
 *   1. Raw-chunks vector store (primary): searches the raw_chunks
 *      VectorStore filtered to kind='brainstorm-summary' so we hit
 *      session-level summaries that cover the full session context.
 *      These were written by the session-end pipeline with brainstorm_id
 *      in metadata, so we can join back to brainstorm_sessions for labels.
 *
 *   2. SQLite BrainstormChunkRow text (secondary): if the vector store
 *      has no brainstorm_id embeddings for a chunk, fall back to the
 *      SQLite text rows with an FTS5 LIKE scan. Less precise but always
 *      available for chunks that pre-date the embedding pipeline.
 *
 * Exposed as:
 *   - chunkSearch(store, query, opts) - programmatic (used by Lex internals)
 *   - Route POST /lex/chunk-search { q, limit? } (registered in routes.ts)
 */
import { embedOne } from '../embedder/index.js';
import type { Store } from '../store/index.js';
import type { BrainstormChunkRow } from '../store/index-db.js';

export interface ChunkSearchHit {
  id: string;
  brainstorm_id: string;
  brainstorm_label: string | null;
  mode: string;
  role: string;
  text_preview: string;
  score: number;
  kind: 'vector' | 'fts-fallback';
}

export interface ChunkSearchResult {
  hits: ChunkSearchHit[];
  query: string;
  embed_ms: number;
  total_scanned: number;
}

export async function chunkSearch(
  store: Store,
  query: string,
  opts: { limit?: number; brainstorm_id?: string } = {},
): Promise<ChunkSearchResult> {
  const limit = Math.max(1, Math.min(10, opts.limit ?? 3));
  const t0 = Date.now();

  let queryVec: Float32Array;
  try {
    queryVec = await embedOne(query);
  } catch {
    /* Embedder not ready; fall back to empty result rather than throwing. */
    return {
      hits: [],
      query,
      embed_ms: Date.now() - t0,
      total_scanned: 0,
    };
  }
  const embedMs = Date.now() - t0;

  /* Primary path: search raw_chunks VectorStore for brainstorm-summary
   * embeddings. These are the most reliable anchors because each summary
   * covers a whole session and is explicitly tagged brainstorm_id. */
  const vecResults = store.rawChunks.search(queryVec, {
    topK: limit * 3, /* oversample; filter to valid brainstorm_id below */
    minScore: 0.15,
    filter: (m) => {
      const hasBrainstorm = Boolean(m.brainstorm_id);
      const isBrainstorm =
        m.kind === 'brainstorm-summary' || m.kind === 'brainstorm';
      const matchesId = opts.brainstorm_id
        ? m.brainstorm_id === opts.brainstorm_id
        : true;
      return hasBrainstorm && isBrainstorm && matchesId;
    },
  });

  const hits: ChunkSearchHit[] = [];
  const seenBrainstorms = new Set<string>();

  for (const r of vecResults) {
    if (hits.length >= limit) break;
    const bid = r.metadata.brainstorm_id!;
    /* Dedupe by brainstorm so the top N hits are from different sessions. */
    if (seenBrainstorms.has(bid)) continue;
    seenBrainstorms.add(bid);
    const row = store.db.getBrainstorm(bid);
    hits.push({
      id: r.id,
      brainstorm_id: bid,
      brainstorm_label:
        row?.user_label ?? row?.derived_label ?? null,
      mode: r.metadata.brainstorm_mode ?? r.metadata.kind ?? 'unknown',
      role: r.metadata.role ?? 'unknown',
      text_preview: r.metadata.text_preview ?? '',
      score: r.score,
      kind: 'vector',
    });
  }

  /* Secondary path: FTS fallback for sessions without brainstorm-summary
   * embeddings. Walk brainstorm_chunks rows that match the brainstorm_id
   * filter (if supplied) and do a naive substring match. */
  if (hits.length < limit) {
    const needed = limit - hits.length;
    const chunkHits = ftsChunkSearch(store, query, opts.brainstorm_id, needed, seenBrainstorms);
    hits.push(...chunkHits);
  }

  return {
    hits,
    query,
    embed_ms: embedMs,
    total_scanned: vecResults.length,
  };
}

/* Fallback: substring match on brainstorm_chunks.text. Not semantic but
 * always available. Caps at `needed` results. */
function ftsChunkSearch(
  store: Store,
  query: string,
  brainstormId: string | undefined,
  needed: number,
  excludeBrainstorms: Set<string>,
): ChunkSearchHit[] {
  const lower = query.toLowerCase();
  const terms = lower.split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const hits: ChunkSearchHit[] = [];
  /* We don't have a global listBrainstormChunks; use listBrainstorms to
   * get candidate session ids, then load chunks per session. */
  const sessions = brainstormId
    ? [store.db.getBrainstorm(brainstormId)].filter(Boolean)
    : store.db.listBrainstorms({ status: 'ended', limit: 50 });

  for (const session of sessions) {
    if (!session) continue;
    if (excludeBrainstorms.has(session.id)) continue;
    if (hits.length >= needed) break;
    const chunks: BrainstormChunkRow[] = store.db.listBrainstormChunks(session.id, 200);
    /* Score by term frequency in the chunk text. */
    for (const chunk of chunks) {
      if (hits.length >= needed) break;
      const textLower = chunk.text.toLowerCase();
      const matches = terms.filter((t) => textLower.includes(t)).length;
      if (matches === 0) continue;
      const score = matches / terms.length;
      excludeBrainstorms.add(session.id);
      hits.push({
        id: chunk.id,
        brainstorm_id: session.id,
        brainstorm_label:
          session.user_label ?? session.derived_label ?? null,
        mode: chunk.mode,
        role: chunk.role,
        text_preview: chunk.text.slice(0, 300),
        score,
        kind: 'fts-fallback',
      });
      break; /* one hit per session for variety */
    }
  }
  return hits;
}
