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
import * as nodeFs from 'node:fs';
import { embedOne, embedMany } from '../embedder/index.js';
import { PROJECT_DOC_KIND } from '../store/index.js';
import type { Store } from '../store/index.js';
import {
  chunkMarkdown,
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

/* Embed a set of corpus chunks and write them to raw_chunks under
 * PROJECT_DOC_KIND with deterministic ids (add upserts by id). Shared by
 * the full indexer and the incremental per-file re-indexer. Returns the
 * count written + the distinct file set touched. */
async function embedAndAddChunks(
  store: Store,
  projectId: string,
  chunks: CorpusChunk[],
  embedManyFn: (texts: string[]) => Promise<Float32Array[]>,
): Promise<{ indexed: number; files: Set<string> }> {
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
        id: docChunkId(projectId, chunk.path, chunk.line),
        vector: vec,
        metadata: {
          project_id: projectId,
          session_id: `${PROJECT_DOC_KIND}:${projectId}`,
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
  return { indexed, files };
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

  const { indexed, files } = await embedAndAddChunks(
    store,
    params.project_id,
    chunks,
    embedManyFn,
  );

  return {
    project_id: params.project_id,
    indexed,
    files: files.size,
    embed_ms: Date.now() - t0,
  };
}

/* Drop every indexed chunk for one file path, project-scoped. Returns the
 * count removed. Strict scope: only this project's chunks for this exact
 * path are touched. */
export function removeDocFile(
  store: Store,
  projectId: string,
  path: string,
): number {
  return store.rawChunks.deleteWhere(
    (m) =>
      m.kind === PROJECT_DOC_KIND &&
      m.project_id === projectId &&
      m.doc_path === path,
  );
}

export interface ReindexDocFileResult {
  project_id: string;
  path: string;
  /** Stale chunks dropped (old line-keyed ids that may no longer exist). */
  removed: number;
  /** Fresh chunks embedded + added. 0 when the file was deleted/empty. */
  added: number;
}

/* Incrementally re-index ONE markdown file: delete its old chunks, then
 * (if it still exists with content) re-chunk + embed + add fresh. A
 * deleted or emptied file just removes. Deleting first then re-adding by
 * line-keyed id is what clears stale chunks for lines that disappeared
 * when the file shrank. Strict project scope is preserved by stamping
 * params.project_id on every fresh chunk. */
export async function reindexDocFile(
  store: Store,
  params: { project_id: string; store: string; path: string },
  deps?: Partial<DocIndexDeps> & { readFile?: (p: string) => string | null },
): Promise<ReindexDocFileResult> {
  const embedManyFn = deps?.embedMany ?? embedMany;
  const readFile =
    deps?.readFile ?? deps?.corpus?.readFile ?? defaultReadFile;

  const removed = removeDocFile(store, params.project_id, params.path);

  const body = readFile(params.path);
  if (!body || !body.trim()) {
    return { project_id: params.project_id, path: params.path, removed, added: 0 };
  }
  const chunks = chunkMarkdown(params.store, params.path, body);
  const { indexed } = await embedAndAddChunks(
    store,
    params.project_id,
    chunks,
    embedManyFn,
  );
  return {
    project_id: params.project_id,
    path: params.path,
    removed,
    added: indexed,
  };
}

function defaultReadFile(p: string): string | null {
  try {
    return nodeFs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export interface DocChunkPointer {
  heading: string;
  line: number;
  snippet: string;
}

export interface DocFile {
  store: string;
  path: string;
  /** Basename for a compact node label. */
  name: string;
  chunks: DocChunkPointer[];
}

/* Browse the whole project-doc index for ONE project, grouped by file.
 * Powers the orb's visual browse front (part 2B): nodes = files grouped
 * by store, clicking a file shows its chunk pointers. Strict project
 * scope by construction - an empty project_id returns nothing and another
 * project's chunks are never included, matching projectDocSearch. Pure
 * read over the in-memory vector store; no embedding. */
export function listProjectDocs(store: Store, projectId: string): DocFile[] {
  if (!projectId) return [];
  const byPath = new Map<string, DocFile>();
  for (const { metadata: m } of store.rawChunks.all()) {
    if (m.kind !== PROJECT_DOC_KIND || m.project_id !== projectId) continue;
    const path = m.doc_path ?? '';
    if (!path) continue;
    let file = byPath.get(path);
    if (!file) {
      file = {
        store: m.doc_store ?? '',
        path,
        name: path.split(/[\\/]/).pop() ?? path,
        chunks: [],
      };
      byPath.set(path, file);
    }
    file.chunks.push({
      heading: m.doc_heading ?? '',
      line: m.doc_line ?? 1,
      snippet: m.text_preview ?? '',
    });
  }
  const files = [...byPath.values()];
  for (const f of files) f.chunks.sort((a, b) => a.line - b.line);
  files.sort(
    (a, b) => a.store.localeCompare(b.store) || a.name.localeCompare(b.name),
  );
  return files;
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
