/**
 * Project-doc index (Unified Knowledge Index, piece 2). Pins the embed +
 * strict-scope query layer: pointer fidelity (store/path/heading/line/
 * snippet), deterministic re-index (no duplicate vectors), and hard
 * cross-project isolation even when both projects share one collection
 * and both match the query.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VectorStore } from '../src/store/vector-store.js';
import type { RawChunkMetadata, Store } from '../src/store/index.js';
import {
  docChunkId,
  indexProjectDocs,
  projectDocSearch,
  reindexDocFile,
  removeDocFile,
  type DocIndexDeps,
} from '../src/lex/project-doc-index.js';
import type { CorpusDeps } from '../src/lex/markdown-corpus.js';

/* Deterministic fake embedder: 8-dim bag-of-keywords, L2-normalized.
 * Texts that share keywords land near each other; a keyword-free text
 * maps to the zero vector (cosine 0, filtered by minScore). No model. */
const VOCAB = [
  'haiku',
  'lifecycle',
  'voice',
  'recall',
  'corpus',
  'stage',
  'index',
  'doc',
];
const DIM = VOCAB.length;

function embed(text: string): Float32Array {
  const lower = text.toLowerCase();
  const v = new Float32Array(DIM);
  for (let i = 0; i < VOCAB.length; i++) {
    const word = VOCAB[i]!;
    let from = 0;
    let count = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at === -1) break;
      count += 1;
      from = at + word.length;
    }
    v[i] = count;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return v; // zero vector; cosine 0 everywhere
  for (let i = 0; i < DIM; i++) v[i] = v[i]! / norm;
  return v;
}

const fakeDeps: Partial<DocIndexDeps> = {
  embedOne: async (t: string) => embed(t),
  embedMany: async (ts: string[]) => ts.map(embed),
};

/* Minimal fake fs for collectMarkdownCorpus, mirroring the corpus test:
 * dirs inferred from path prefixes. */
function fakeFs(tree: Record<string, string>): Partial<CorpusDeps> {
  const dirs = new Set<string>();
  for (const p of Object.keys(tree)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    isDir: (p) => dirs.has(p),
    listDir: (p) => {
      const names = new Set<string>();
      for (const full of [...Object.keys(tree), ...dirs]) {
        if (full === p) continue;
        if (full.startsWith(p + '/')) {
          names.add(full.slice(p.length + 1).split('/')[0]!);
        }
      }
      return [...names];
    },
    readFile: (p) => tree[p] ?? null,
  };
}

let tmpDir: string;
let vs: VectorStore<RawChunkMetadata>;
let store: Store;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-projdoc-'));
  vs = await VectorStore.open<RawChunkMetadata>(tmpDir, 'raw_chunks', DIM);
  store = { rawChunks: vs } as unknown as Store;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('docChunkId', () => {
  it('is deterministic and namespaced by project + path + line', () => {
    expect(docChunkId('P', '/a/b.md', 4)).toBe('project-doc:P:/a/b.md#4');
    expect(docChunkId('P', '/a/b.md', 4)).toBe(docChunkId('P', '/a/b.md', 4));
    expect(docChunkId('P', '/a/b.md', 4)).not.toBe(
      docChunkId('Q', '/a/b.md', 4),
    );
  });
});

describe('indexProjectDocs', () => {
  it('embeds every corpus chunk and reports file + chunk counts', async () => {
    const deps: Partial<DocIndexDeps> = {
      ...fakeDeps,
      corpus: fakeFs({
        '/proj/docs/a.md': '# Haiku\nhaiku canned responses\n## Voice\nvoice lane',
        '/proj/memory/m.md': '# Recall\nrecall corpus index',
      }),
    };
    const res = await indexProjectDocs(
      store,
      {
        project_id: 'proj',
        stores: [
          { store: 'docs', dir: '/proj/docs' },
          { store: 'memory', dir: '/proj/memory' },
        ],
      },
      deps,
    );
    expect(res.project_id).toBe('proj');
    expect(res.files).toBe(2);
    expect(res.indexed).toBe(3); // Haiku, Voice, Recall sections
    expect(vs.size()).toBe(3);
  });

  it('is idempotent: re-indexing an unchanged corpus adds no duplicates', async () => {
    const deps: Partial<DocIndexDeps> = {
      ...fakeDeps,
      corpus: fakeFs({ '/proj/docs/a.md': '# Haiku\nhaiku body\n## Voice\nvoice body' }),
    };
    const params = {
      project_id: 'proj',
      stores: [{ store: 'docs', dir: '/proj/docs' }],
    };
    await indexProjectDocs(store, params, deps);
    expect(vs.size()).toBe(2);
    await indexProjectDocs(store, params, deps);
    expect(vs.size()).toBe(2); // deterministic ids → in-place update
  });

  it('returns indexed=0 on an empty corpus without embedding', async () => {
    let called = false;
    const deps: Partial<DocIndexDeps> = {
      embedMany: async (ts) => {
        called = true;
        return ts.map(embed);
      },
      corpus: fakeFs({ '/proj/docs/empty.md': '\n\n   \n' }),
    };
    const res = await indexProjectDocs(
      store,
      { project_id: 'proj', stores: [{ store: 'docs', dir: '/proj/docs' }] },
      deps,
    );
    expect(res.indexed).toBe(0);
    expect(called).toBe(false);
    expect(vs.size()).toBe(0);
  });
});

describe('projectDocSearch', () => {
  it('returns precise file pointers {store,path,heading,line,snippet,score}', async () => {
    const deps: Partial<DocIndexDeps> = {
      ...fakeDeps,
      corpus: fakeFs({
        '/proj/docs/a.md': '# Intro\nintro line\n## Haiku\nhaiku canned responses here',
      }),
    };
    await indexProjectDocs(
      store,
      { project_id: 'proj', stores: [{ store: 'docs', dir: '/proj/docs' }] },
      deps,
    );
    const res = await projectDocSearch(
      store,
      'haiku',
      { project_id: 'proj' },
      fakeDeps,
    );
    expect(res.hits.length).toBeGreaterThan(0);
    const top = res.hits[0]!;
    expect(top.store).toBe('docs');
    expect(top.path).toBe('/proj/docs/a.md');
    expect(top.heading).toBe('Haiku');
    expect(top.line).toBe(3); // 1-based heading line
    expect(top.snippet).toContain('haiku canned responses');
    expect(top.score).toBeGreaterThan(0.15);
  });

  it('NEVER returns another project chunks, even when both match', async () => {
    const corpus = fakeFs({
      '/A/docs/a.md': '# A\nhaiku in project A',
      '/B/docs/b.md': '# B\nhaiku in project B',
    });
    await indexProjectDocs(
      store,
      { project_id: 'A', stores: [{ store: 'docs', dir: '/A/docs' }] },
      { ...fakeDeps, corpus },
    );
    await indexProjectDocs(
      store,
      { project_id: 'B', stores: [{ store: 'docs', dir: '/B/docs' }] },
      { ...fakeDeps, corpus },
    );
    expect(vs.size()).toBe(2); // both indexed into the shared collection

    const res = await projectDocSearch(
      store,
      'haiku',
      { project_id: 'A' },
      fakeDeps,
    );
    expect(res.hits.length).toBe(1);
    expect(res.hits.every((h) => h.path.startsWith('/A/'))).toBe(true);
    expect(res.hits.some((h) => h.path.startsWith('/B/'))).toBe(false);
  });

  it('returns no hits for an empty project_id (no unscoped fallback)', async () => {
    const res = await projectDocSearch(
      store,
      'haiku',
      { project_id: '' },
      fakeDeps,
    );
    expect(res.hits).toEqual([]);
    expect(res.total_scanned).toBe(0);
  });

  it('returns empty hits when the embedder is not ready', async () => {
    const res = await projectDocSearch(
      store,
      'haiku',
      { project_id: 'proj' },
      {
        embedOne: async () => {
          throw new Error('model not loaded');
        },
      },
    );
    expect(res.hits).toEqual([]);
  });
});

describe('incremental re-index (DRIVE-QUEUE 2 watcher core)', () => {
  it('a changed file re-indexes: stale chunks gone, fresh chunks present', async () => {
    const p = '/proj/docs/a.md';
    /* v1: two sections (lines 1 and 3). */
    let body = '# Haiku\nhaiku one\n## Voice\nvoice two';
    const deps = {
      ...fakeDeps,
      readFile: (q: string) => (q === p ? body : null),
    };
    await reindexDocFile(store, { project_id: 'proj', store: 'docs', path: p }, deps);
    expect(vs.size()).toBe(2);
    expect(vs.has(docChunkId('proj', p, 1))).toBe(true);
    expect(vs.has(docChunkId('proj', p, 3))).toBe(true);

    /* v2: file shrank to a single section. The old line-3 chunk must be
     * dropped, not left dangling. */
    body = '# Haiku\nhaiku rewritten and longer now';
    const r = await reindexDocFile(
      store,
      { project_id: 'proj', store: 'docs', path: p },
      deps,
    );
    expect(r.removed).toBe(2);
    expect(r.added).toBe(1);
    expect(vs.size()).toBe(1);
    expect(vs.has(docChunkId('proj', p, 1))).toBe(true);
    expect(vs.has(docChunkId('proj', p, 3))).toBe(false); // stale chunk gone
  });

  it("a deleted file's chunks are removed", async () => {
    const p = '/proj/docs/gone.md';
    let body: string | null = '# Recall\nrecall corpus to be deleted';
    const deps = {
      ...fakeDeps,
      readFile: (q: string) => (q === p ? body : null),
    };
    await reindexDocFile(store, { project_id: 'proj', store: 'docs', path: p }, deps);
    expect(vs.size()).toBe(1);

    body = null; // file deleted
    const r = await reindexDocFile(
      store,
      { project_id: 'proj', store: 'docs', path: p },
      deps,
    );
    expect(r.removed).toBe(1);
    expect(r.added).toBe(0);
    expect(vs.size()).toBe(0);
    const hits = await projectDocSearch(store, 'recall', { project_id: 'proj' }, fakeDeps);
    expect(hits.hits).toEqual([]);
  });

  it('removeDocFile is strictly project + path scoped', async () => {
    const shared = fakeFs({
      '/A/docs/x.md': '# A\nhaiku in A',
      '/B/docs/y.md': '# B\nhaiku in B',
    });
    await indexProjectDocs(
      store,
      { project_id: 'A', stores: [{ store: 'docs', dir: '/A/docs' }] },
      { ...fakeDeps, corpus: shared },
    );
    await indexProjectDocs(
      store,
      { project_id: 'B', stores: [{ store: 'docs', dir: '/B/docs' }] },
      { ...fakeDeps, corpus: shared },
    );
    expect(vs.size()).toBe(2);
    /* Removing A's file leaves B untouched. */
    const removed = removeDocFile(store, 'A', '/A/docs/x.md');
    expect(removed).toBe(1);
    expect(vs.size()).toBe(1);
    const aHits = await projectDocSearch(store, 'haiku', { project_id: 'A' }, fakeDeps);
    expect(aHits.hits).toEqual([]);
    const bHits = await projectDocSearch(store, 'haiku', { project_id: 'B' }, fakeDeps);
    expect(bHits.hits.length).toBe(1);
    expect(bHits.hits[0]!.path).toBe('/B/docs/y.md');
  });

  it('re-indexing a path for project A never removes project B chunks at the same path', async () => {
    const p = '/shared/docs/same.md';
    const body = '# Title\nhaiku shared path';
    const deps = { ...fakeDeps, readFile: (q: string) => (q === p ? body : null) };
    await reindexDocFile(store, { project_id: 'A', store: 'docs', path: p }, deps);
    await reindexDocFile(store, { project_id: 'B', store: 'docs', path: p }, deps);
    expect(vs.size()).toBe(2); // one per project, same path
    /* Re-index A's copy: B's copy at the same path must survive. */
    const r = await reindexDocFile(store, { project_id: 'A', store: 'docs', path: p }, deps);
    expect(r.removed).toBe(1); // only A's
    expect(vs.size()).toBe(2);
    expect(vs.has(docChunkId('A', p, 1))).toBe(true);
    expect(vs.has(docChunkId('B', p, 1))).toBe(true);
  });
});
