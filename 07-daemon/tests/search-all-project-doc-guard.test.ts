/**
 * Regression guard (Unified Knowledge Index, piece 2). project-doc
 * chunks share the raw_chunks collection but must NEVER surface through
 * searchAll (which powers /lex/recall + the dashboard search bar). This
 * pins the exclusion: a project-doc chunk with an identical vector to a
 * real transcript chunk is dropped, the transcript chunk is kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VectorStore } from '../src/store/vector-store.js';
import type { RawChunkMetadata, Store } from '../src/store/index.js';

let tmpDir: string;
let vs: VectorStore<RawChunkMetadata>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-saguard-'));
  vs = await VectorStore.open<RawChunkMetadata>(tmpDir, 'raw_chunks', 3);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function meta(kind: string, extra: Partial<RawChunkMetadata> = {}): RawChunkMetadata {
  return {
    project_id: 'proj',
    session_id: 'sess',
    timestamp_ms: 1,
    kind,
    role: 'doc',
    byte_length: 10,
    text_preview: `${kind} preview`,
    ...extra,
  };
}

describe('searchAll project-doc exclusion', () => {
  it('drops project-doc chunks while keeping identical-vector transcript chunks', async () => {
    vi.doMock('../src/embedder/index.js', async (importOriginal) => {
      const orig =
        await importOriginal<typeof import('../src/embedder/index.js')>();
      return { ...orig, embedOne: async () => new Float32Array([1, 0, 0]) };
    });
    const { searchAll } = await import('../src/dashboard/search-all.js');

    /* Two chunks with the SAME vector as the query: only the kind
     * differs. Without the guard both would tie at cosine 1.0. */
    await vs.add({
      id: 'raw-1',
      vector: new Float32Array([1, 0, 0]),
      metadata: meta('transcript'),
    });
    await vs.add({
      id: 'doc-1',
      vector: new Float32Array([1, 0, 0]),
      metadata: meta('project-doc', {
        doc_store: 'docs',
        doc_path: '/proj/docs/a.md',
        doc_heading: 'Haiku',
        doc_line: 3,
      }),
    });

    const store = {
      rawChunks: vs,
      db: { listBrainstorms: () => [] },
    } as unknown as Store;

    const page = await searchAll(store, {
      query: 'anything',
      collections: ['raw_chunk'],
      limit: 10,
    });
    const ids = page.results.map((r) => r.id);
    expect(ids).toContain('raw-1');
    expect(ids).not.toContain('doc-1');
  });
});
