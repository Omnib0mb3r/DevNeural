/**
 * Unified search across all corpora.
 *
 * Hits wiki_pages, raw_chunks, and (optionally) reference_chunks in
 * parallel, classifies every hit into a 5-tier source taxonomy, and
 * applies a class-priority multiplier on top of the raw cosine score
 * so canonical wiki pages outrank pending drafts which outrank
 * brainstorm transcripts which outrank generic raw chunks which
 * outrank reference material. The multiplier is what Slice B gets
 * Lex out of "chunk soup" without a new vector collection: ranking
 * is metadata-driven and reversible.
 *
 * Brainstorm detection is JOIN-at-query-time — we fetch the small
 * brainstorm_sessions table once per request and map raw_chunk
 * metadata.session_id → brainstorm row, attaching label/mode/started
 * to the hit. No raw_chunks_meta migration needed.
 *
 * Optional `group_by_session` mode buckets brainstorm chunks under
 * their session object so callers (notably /lex/recall) get one
 * "session: { id, label, mode, ... }, chunks: [...]" envelope per
 * brainstorm instead of N orphan transcript rows.
 */
import { embedOne } from '../embedder/index.js';
import type { Store } from '../store/index.js';
import type { ReferenceStore } from '../reference/store.js';
import type { BrainstormSessionRow } from '../store/index-db.js';

export type SourceClass =
  | 'wiki-canonical'
  | 'wiki-pending'
  | 'brainstorm'
  | 'raw'
  | 'reference';

/* Source-class scoring multiplier (codex-pinned). Applied on top of
 * the cosine similarity so the same query surfaces canonical wisdom
 * first, pending drafts next, then live brainstorm context, then
 * generic logs, then reference material. Ranking is reversible —
 * delete the multiplier and you're back to raw cosine. */
const SOURCE_CLASS_MULTIPLIER: Record<SourceClass, number> = {
  'wiki-canonical': 1.0,
  'wiki-pending': 0.85,
  brainstorm: 0.7,
  raw: 0.6,
  reference: 0.5,
};

export interface BrainstormSummary {
  id: string;
  claude_session_id: string | null;
  user_label: string | null;
  derived_label: string | null;
  mode: string;
  status: string;
  started_ms: number;
}

export interface UnifiedSearchHit {
  /** Legacy enum kept for backwards compat with the dashboard search bar.
   * New consumers should branch on source_class. */
  source: 'wiki_page' | 'raw_chunk' | 'reference_chunk';
  source_class: SourceClass;
  id: string;
  /** Final ranking score = raw_score * SOURCE_CLASS_MULTIPLIER[source_class]. */
  score: number;
  /** Pre-multiplier cosine similarity. Lets callers see the original
   * vector match strength when they want to debug ranking. */
  raw_score: number;
  metadata: Record<string, unknown>;
  /** Present on raw_chunk hits whose session_id matches a row in
   * brainstorm_sessions. Lex's system prompt (Slice D) will require
   * citations to use this when present. */
  brainstorm_session?: BrainstormSummary;
}

export interface SessionGroup {
  session: BrainstormSummary;
  chunks: UnifiedSearchHit[];
  /** Best chunk score in the group, used to position the group
   * relative to ungrouped hits in the merged display. */
  top_score: number;
}

export interface UnifiedSearchOptions {
  query: string;
  project_id?: string;
  collections?: Array<'wiki_page' | 'raw_chunk' | 'reference_chunk'>;
  /** @deprecated Use limit + offset. Kept for backwards compatibility. */
  top_k?: number;
  /** Page size for the merged result list. Default 10, capped at 100. */
  limit?: number;
  /** Zero-based page offset across the merged result list. Default 0. */
  offset?: number;
  /** When true, brainstorm-class chunks are also bundled under their
   * session in the `groups` array. The flat `results` list is still
   * returned for backwards compat. */
  group_by_session?: boolean;
}

/* Per-collection candidate pool. We pull this many hits from each
 * vector store before merging and sorting, so pagination can walk
 * through more than the top-N most-similar hits. Capped to keep
 * memory bounded; 500 hits across 3 collections = 1500 hit objects
 * temporary, well within budget. */
const CANDIDATE_POOL_PER_COLLECTION = 500;

export interface UnifiedSearchPage {
  results: UnifiedSearchHit[];
  total: number;
  offset: number;
  limit: number;
  /** Populated only when options.group_by_session is true. Brainstorm
   * chunks within `results` are also bucketed under their session
   * here, sorted by best chunk score. Non-brainstorm hits are not
   * grouped. */
  groups?: SessionGroup[];
}

function summariseBrainstorm(row: BrainstormSessionRow): BrainstormSummary {
  return {
    id: row.id,
    claude_session_id: row.claude_session_id,
    user_label: row.user_label,
    derived_label: row.derived_label,
    mode: row.mode,
    status: row.status,
    started_ms: row.started_ms,
  };
}

/* Build a session_id → brainstorm summary map for the current query.
 * Pulls all brainstorm rows that have been bound to a claude session
 * (claude_session_id non-null) so raw_chunk hits can be tagged. The
 * lookup runs once per /search/all call, not per hit. */
function buildBrainstormIndex(store: Store): Map<string, BrainstormSummary> {
  const map = new Map<string, BrainstormSummary>();
  let rows: BrainstormSessionRow[] = [];
  try {
    rows = store.db.listBrainstorms({ limit: 1000 });
  } catch {
    return map;
  }
  for (const row of rows) {
    if (row.claude_session_id) {
      map.set(row.claude_session_id, summariseBrainstorm(row));
    }
  }
  return map;
}

function classifyWiki(metadata: Record<string, unknown>): SourceClass {
  const status = metadata.status;
  if (status === 'canonical') return 'wiki-canonical';
  /* Pending and archived both fall into pending priority. Archived
   * is rare and downranking it further would just hide useful
   * historical context behind generic raw chunks. */
  return 'wiki-pending';
}

export async function searchAll(
  store: Store,
  options: UnifiedSearchOptions,
  referenceStore?: ReferenceStore,
): Promise<UnifiedSearchPage> {
  const collections = options.collections ?? ['wiki_page', 'raw_chunk'];
  // limit takes precedence; fall back to legacy top_k; default 10.
  const limit = Math.min(Math.max(options.limit ?? options.top_k ?? 10, 1), 100);
  const offset = Math.max(0, options.offset ?? 0);
  const candidatePerCollection = CANDIDATE_POOL_PER_COLLECTION;
  const vec = await embedOne(options.query.slice(0, 4000));

  const brainstormIndex = buildBrainstormIndex(store);
  const all: UnifiedSearchHit[] = [];

  if (collections.includes('wiki_page') && store.wikiPages.size() > 0) {
    const hits = (
      store.wikiPages as unknown as {
        search: (
          q: Float32Array,
          o: { topK: number; filter?: (m: unknown) => boolean },
        ) => Array<{ id: string; score: number; metadata: unknown }>;
      }
    ).search(vec, {
      topK: candidatePerCollection,
      filter: (m) => {
        const meta = m as Record<string, unknown>;
        // wiki pages may have project_ids in projects array; soft filter only if provided
        if (options.project_id) {
          const projects = meta.projects as string[] | undefined;
          if (projects && projects.length > 0) {
            return projects.includes(options.project_id);
          }
        }
        return true;
      },
    });
    for (const h of hits) {
      const metadata = h.metadata as Record<string, unknown>;
      const source_class = classifyWiki(metadata);
      all.push({
        source: 'wiki_page',
        source_class,
        id: h.id,
        raw_score: h.score,
        score: h.score * SOURCE_CLASS_MULTIPLIER[source_class],
        metadata,
      });
    }
  }

  if (collections.includes('raw_chunk') && store.rawChunks.size() > 0) {
    const hits = (
      store.rawChunks as unknown as {
        search: (
          q: Float32Array,
          o: { topK: number; filter?: (m: unknown) => boolean },
        ) => Array<{ id: string; score: number; metadata: unknown }>;
      }
    ).search(vec, {
      topK: candidatePerCollection,
      filter: (m) => {
        const meta = m as Record<string, unknown>;
        if (options.project_id && meta.project_id !== options.project_id) {
          return false;
        }
        return true;
      },
    });
    for (const h of hits) {
      const metadata = h.metadata as Record<string, unknown>;
      const sessionId = metadata.session_id as string | undefined;
      const brainstorm = sessionId ? brainstormIndex.get(sessionId) : undefined;
      const source_class: SourceClass = brainstorm ? 'brainstorm' : 'raw';
      const hit: UnifiedSearchHit = {
        source: 'raw_chunk',
        source_class,
        id: h.id,
        raw_score: h.score,
        score: h.score * SOURCE_CLASS_MULTIPLIER[source_class],
        metadata,
      };
      if (brainstorm) hit.brainstorm_session = brainstorm;
      all.push(hit);
    }
  }

  if (
    collections.includes('reference_chunk') &&
    referenceStore &&
    referenceStore.chunks.size() > 0
  ) {
    const hits = (
      referenceStore.chunks as unknown as {
        search: (
          q: Float32Array,
          o: { topK: number; filter?: (m: unknown) => boolean },
        ) => Array<{ id: string; score: number; metadata: unknown }>;
      }
    ).search(vec, {
      topK: candidatePerCollection,
      filter: (m) => {
        const meta = m as Record<string, unknown>;
        if (options.project_id && meta.project_id !== options.project_id) {
          return false;
        }
        return true;
      },
    });
    for (const h of hits) {
      const metadata = h.metadata as Record<string, unknown>;
      all.push({
        source: 'reference_chunk',
        source_class: 'reference',
        id: h.id,
        raw_score: h.score,
        score: h.score * SOURCE_CLASS_MULTIPLIER.reference,
        metadata,
      });
    }
  }

  all.sort((a, b) => b.score - a.score);
  const total = all.length;
  const results = all.slice(offset, offset + limit);

  const page: UnifiedSearchPage = {
    results,
    total,
    offset,
    limit,
  };

  if (options.group_by_session) {
    const groupMap = new Map<string, SessionGroup>();
    for (const hit of results) {
      if (hit.source_class !== 'brainstorm' || !hit.brainstorm_session) continue;
      const key = hit.brainstorm_session.id;
      const existing = groupMap.get(key);
      if (existing) {
        existing.chunks.push(hit);
        if (hit.score > existing.top_score) existing.top_score = hit.score;
      } else {
        groupMap.set(key, {
          session: hit.brainstorm_session,
          chunks: [hit],
          top_score: hit.score,
        });
      }
    }
    page.groups = [...groupMap.values()].sort(
      (a, b) => b.top_score - a.top_score,
    );
  }

  return page;
}
