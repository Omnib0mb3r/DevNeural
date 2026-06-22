/**
 * Project-doc index (Unified Knowledge Index, piece 2).
 *
 * Embeds the markdown corpus (from markdown-corpus.ts) into the shared
 * raw_chunks vector store under PROJECT_DOC_KIND and exposes a strictly
 * project-scoped query that returns precise file pointers instead of a
 * grep. This is the "where is X" retrieval layer the corpus chunker was
 * built to feed.
 *
 * STRICT project scope by construction:
 *   - indexProjectDocs stamps every chunk with the caller's project_id
 *     and walks only that project's store dirs.
 *   - projectDocSearch filters on kind === PROJECT_DOC_KIND AND
 *     project_id === the requested project. A query for project P can
 *     never return another project's chunks, even though all projects
 *     share one physical collection.
 *
 * Additive + isolated: project-doc chunks share raw_chunks but never get
 * a raw_chunks_meta (SQL) row, so the cull job and the brainstorm
 * session-id join in search-all never see them. Every pre-existing
 * raw_chunks reader opts out via the PROJECT_DOC_KIND guard.
 *
 * Pure-ish + testable: the embedder flows through an injectable seam so
 * the indexer + query can be unit-tested against a fake embedder and an
 * in-memory VectorStore, with no Xenova model load.
 */
import { embedOne, embedMany } from '../embedder/index.js';
import { PROJECT_DOC_KIND } from '../store/index.js';
import type { Store } from '../store/index.js';
import {
  collectMarkdownCorpus,
  type CorpusChunk,
  type CorpusDeps,
  type MarkdownStoreSpec,
} from './markdown-corpus.js';

/* Embed text length cap, mirroring session-end-pipeline. The MiniLM
 * model truncates internally; slicing keeps batches honest. */
const EMBED_TEXT_CAP = 4000;
/* Embed in bounded batches so a large corpus does not build one giant
 * pipeline call. */
const EMBED_BATCH = 32;

export interface DocIndexDeps {
  embedMany: (texts: string[]) => Promise<Float32Array[]>;
  embedOne: (text: string) => Promise<Float32Array>;
  corpus?: Partial<CorpusDeps>;
}

export interface IndexProjectDocsParams {
  project_id: string;
  stores: MarkdownStoreSpec[];
}

export interface IndexProjectDocsResult {
  project_id: string;
  /** Chunks embedded + written this run. */
  indexed: number;
  /** Distinct source files contributing chunks. */
  files: number;
  embed_ms: number;
}

/** Deterministic id: re-indexing the same file+line updates the vector
 * in place (VectorStore.add upserts by id) so a re-run never duplicates
 * a chunk. Keyed on project + absolute path + 1-based start line. */
export function docChunkId(
  projectId: string,
  path: string,
  line: number,
): string {
  return `${PROJECT_DOC_KIND}:${projectId}:${path}#${line}`;
}

export interface DocPointerHit {
  id: string;
  store: string;
  path: string;
  heading: string;
  line: number;
  snippet: string;
  score: number;
}

export interface DocPointerSearchResult {
  hits: DocPointerHit[];
  query: string;
  project_id: string;
  embed_ms: number;
  total_scanned: number;
}

/* Embed corpus chunks for ONE project and write them to raw_chunks under
 * PROJECT_DOC_KIND. Returns the count written. Idempotent: deterministic
 * ids mean a second run over an unchanged corpus rewrites in place. */
export async function indexProjectDocs(
  store: Store,
  params: IndexProjectDocsParams,
  deps?: Partial<DocIndexDeps>,
): Promise<IndexProjectDocsResult> {
  const embedManyFn = deps?.embedMany ?? embedMany;
  const t0 = Date.now();

  const chunks: CorpusChunk[] = collectMarkdownCorpus(
    params.stores,
    deps?.corpus,
  );
  if (chunks.length === 0) {
    return {
      project_id: params.project_id,
      indexed: 0,
      files: 0,
      embed_ms: Date.now() - t0,
    };
  }

  const files = new Set<string>();
  let indexed = 0;

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vecs = await embedManyFn(
      batch.map((c) => c.text.slice(0, EMBED_TEXT_CAP)),
    );
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j]!;
      const vec = vecs[j];
      if (!vec) continue;
      files.add(chunk.path);
      await store.rawChunks.add({
        id: docChunkId(params.project_id, chunk.path, chunk.line),
        vector: vec,
        metadata: {
          project_id: params.project_id,
          session_id: `${PROJECT_DOC_KIND}:${params.project_id}`,
          timestamp_ms: Date.now(),
          kind: PROJECT_DOC_KIND,
          role: 'doc',
          byte_length: chunk.text.length,
          text_preview: chunk.snippet,
          doc_store: chunk.store,
          doc_path: chunk.path,
          doc_heading: chunk.heading,
          doc_line: chunk.line,
        },
      });
      indexed += 1;
    }
  }

  return {
    project_id: params.project_id,
    indexed,
    files: files.size,
    embed_ms: Date.now() - t0,
  };
}

/* Strictly project-scoped semantic search over project-doc chunks.
 * Returns precise file pointers. A missing/empty project_id returns no
 * hits (never falls back to an unscoped scan) so cross-project leakage
 * is impossible by construction. */
export async function projectDocSearch(
  store: Store,
  query: string,
  opts: { project_id: string; limit?: number },
  deps?: Partial<DocIndexDeps>,
): Promise<DocPointerSearchResult> {
  const embedOneFn = deps?.embedOne ?? embedOne;
  const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
  const t0 = Date.now();
  const projectId = opts.project_id;

  if (!projectId) {
    return {
      hits: [],
      query,
      project_id: projectId,
      embed_ms: 0,
      total_scanned: 0,
    };
  }

  let queryVec: Float32Array;
  try {
    queryVec = await embedOneFn(query);
  } catch {
    /* Embedder not ready; empty result rather than throwing, matching
     * chunkSearch. */
    return {
      hits: [],
      query,
      project_id: projectId,
      embed_ms: Date.now() - t0,
      total_scanned: 0,
    };
  }
  const embedMs = Date.now() - t0;

  const results = store.rawChunks.search(queryVec, {
    topK: limit,
    minScore: 0.15,
    filter: (m) =>
      m.kind === PROJECT_DOC_KIND && m.project_id === projectId,
  });

  const hits: DocPointerHit[] = results.map((r) => ({
    id: r.id,
    store: r.metadata.doc_store ?? '',
    path: r.metadata.doc_path ?? '',
    heading: r.metadata.doc_heading ?? '',
    line: r.metadata.doc_line ?? 1,
    snippet: r.metadata.text_preview ?? '',
    score: r.score,
  }));

  return {
    hits,
    query,
    project_id: projectId,
    embed_ms: embedMs,
    total_scanned: results.length,
  };
}
