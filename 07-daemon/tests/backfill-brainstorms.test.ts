/**
 * Wave 2 day 3 step 13 (BF-13). End-to-end backfill assertions:
 *   - kind classification by mode (BF-14)
 *   - brainstorm_chunks ingest from a transcripts.jsonl file
 *   - lineage band computation (high / borderline / low)
 *   - high-band auto-link writes source_brainstorms onto disk
 *   - meeting kind skips lineage entirely
 *
 * The cosine values are forced via a tiny embedder stub so the test
 * does not need the real Xenova transformer pipeline.
 *
 * Module loading order: paths.ts snapshots DATA_ROOT at first import,
 * so EVERY test resetModules() and dynamic-imports the modules that
 * read DATA_ROOT after setting DEVNEURAL_DATA_ROOT. The test file
 * itself only uses node:fs / node:path at the top level.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let priorRoot: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-bf3-'))
    .replace(/\\/g, '/');
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'projects'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  /* Bootstrap base schema via IndexDb constructor, then close + run
   * migrations to add the Phase Two tables. Dynamic import so the
   * per-test DEVNEURAL_DATA_ROOT propagates to anything cached at
   * paths.ts module load. */
  const { IndexDb } = await import('../src/store/index-db.js');
  const bootstrap = new IndexDb(dbFile);
  bootstrap.close();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

function plantTranscript(
  paths: typeof import('../src/paths.js'),
  projectId: string,
  sessionId: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
): void {
  paths.ensureDir(paths.projectDir(projectId));
  const lines = turns.map((t, i) =>
    JSON.stringify({
      role: t.role,
      text: t.text,
      session: sessionId,
      timestamp: new Date(Date.now() - (turns.length - i) * 1000).toISOString(),
      kind: 'text',
    }),
  );
  fs.appendFileSync(paths.transcriptsFile(projectId), lines.join('\n') + '\n');
}

function plantWikiPage(
  paths: typeof import('../src/paths.js'),
  schema: typeof import('../src/wiki/schema.js'),
  id: string,
  title: string,
): void {
  const today = new Date().toISOString().slice(0, 10);
  schema.writePage(paths.wikiPagesDir(), {
    frontmatter: {
      id,
      title: `${title} → existing`,
      trigger: 'pre-existing trigger',
      insight: 'pre-existing insight',
      summary: title,
      status: 'canonical',
      weight: 0.5,
      hits: 0,
      corrections: 0,
      created: today,
      last_touched: today,
      projects: [],
      human_edited: true,
    },
    sections: {
      pattern: `pattern body for ${title}`,
      crossRefs: [],
      crossRefsRaw: [],
      evidence: [],
      openQuestions: [],
      log: [],
    },
  });
}

describe('runBackfillBrainstorms', () => {
  it('ingests chunks, classifies kind by mode, and writes high-band lineage', async () => {
    const HIGH = new Float32Array([1, 0, 0]);
    const BORD = new Float32Array([0.7071, 0.7071, 0]);
    const LOW = new Float32Array([0, 0, 1]);
    vi.doMock('../src/embedder/index.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/embedder/index.js')>();
      return {
        ...orig,
        embedOne: async (text: string) => {
          if (text.includes('alpha')) return HIGH;
          if (text.includes('beta')) return BORD;
          return LOW;
        },
        getModelId: () => 'stub-model',
      };
    });
    const paths = await import('../src/paths.js');
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    db['db'].prepare(
      `INSERT INTO raw_chunks_meta (id, project_id, session_id, timestamp_ms, kind, role, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('seed-1', 'p1', 'cc-bs1', Date.now(), 'text', 'user', 10);
    db['db'].prepare(
      `INSERT INTO raw_chunks_meta (id, project_id, session_id, timestamp_ms, kind, role, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('seed-2', 'p1', 'cc-mt1', Date.now(), 'text', 'user', 10);

    plantTranscript(paths, 'p1', 'cc-bs1', [
      { role: 'user', text: 'alpha alpha alpha discussion' },
      { role: 'assistant', text: 'alpha summary content' },
    ]);
    plantTranscript(paths, 'p1', 'cc-mt1', [
      { role: 'user', text: 'meeting agenda topic A' },
      { role: 'assistant', text: 'meeting summary' },
    ]);
    db.insertBrainstorm({
      id: 'bs1', claude_session_id: 'cc-bs1', pty_id: null, cwd: tmpDir,
      user_label: 'alpha session', derived_label: null, mode: 'conversation',
      status: 'ended', started_ms: Date.now() - 5000, ended_ms: Date.now(),
      turn_count: 2, topic_tags_json: '[]', artifacts_json: '{}',
      last_summary: 'alpha summary text', last_summary_ms: Date.now(),
    });
    db.insertBrainstorm({
      id: 'mt1', claude_session_id: 'cc-mt1', pty_id: null, cwd: tmpDir,
      user_label: 'Q2 review', derived_label: null, mode: 'notes',
      status: 'ended', started_ms: Date.now() - 5000, ended_ms: Date.now(),
      turn_count: 2, topic_tags_json: '[]', artifacts_json: '{}',
      last_summary: 'meeting notes', last_summary_ms: Date.now(),
    });
    plantWikiPage(paths, schema, 'alpha-page', 'alpha primary topic');
    plantWikiPage(paths, schema, 'beta-page', 'beta neighbouring topic');
    plantWikiPage(paths, schema, 'gamma-page', 'gamma unrelated topic');

    const { runBackfillBrainstorms } = await import('../src/wiki/backfill-brainstorms.js');
    const store = { db } as unknown as import('../src/store/index.js').Store;
    const r = await runBackfillBrainstorms(store, () => undefined);

    expect(r.ingested).toBe(2);
    expect(r.chunks_written).toBe(4);
    expect(r.high_links).toBeGreaterThanOrEqual(1);
    expect(r.borderline_queued).toBeGreaterThanOrEqual(1);
    expect(r.low_logged).toBeGreaterThanOrEqual(1);
    expect(r.meetings_skipped_for_lineage).toBe(1);

    expect(db.getBrainstorm('bs1')?.kind).toBe('brainstorm');
    expect(db.getBrainstorm('mt1')?.kind).toBe('meeting');
    expect(db.countBrainstormChunks('bs1')).toBe(2);
    expect(db.countBrainstormChunks('mt1')).toBe(2);

    const queue = db.listBackfillReview({ status: 'pending' });
    expect(queue.find((q) => q.candidate_page_slug === 'beta-page')).toBeTruthy();
    db.close();
  });

  it('re-run is idempotent: chunks not duplicated, high-link not double-applied', async () => {
    vi.doMock('../src/embedder/index.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/embedder/index.js')>();
      return {
        ...orig,
        embedOne: async () => new Float32Array([1, 0, 0]),
        getModelId: () => 'stub-model',
      };
    });
    const paths = await import('../src/paths.js');
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    db['db'].prepare(
      `INSERT INTO raw_chunks_meta (id, project_id, session_id, timestamp_ms, kind, role, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('seed-3', 'p1', 'cc-rerun', Date.now(), 'text', 'user', 10);
    plantTranscript(paths, 'p1', 'cc-rerun', [
      { role: 'user', text: 'reproducible content' },
      { role: 'assistant', text: 'reply content' },
    ]);
    db.insertBrainstorm({
      id: 'rerun1', claude_session_id: 'cc-rerun', pty_id: null, cwd: tmpDir,
      user_label: 'r', derived_label: null, mode: 'conversation',
      status: 'ended', started_ms: Date.now() - 5000, ended_ms: Date.now(),
      turn_count: 2, topic_tags_json: '[]', artifacts_json: '{}',
      last_summary: 'reproducible', last_summary_ms: Date.now(),
    });
    plantWikiPage(paths, schema, 'rerun-page', 'reproducible page');
    const { runBackfillBrainstorms } = await import('../src/wiki/backfill-brainstorms.js');
    const store = { db } as unknown as import('../src/store/index.js').Store;
    const a = await runBackfillBrainstorms(store, () => undefined);
    expect(a.chunks_written).toBe(2);
    const b = await runBackfillBrainstorms(store, () => undefined);
    expect(b.chunks_written).toBe(0);
    expect(b.ingested).toBe(0);
    expect(db.countBrainstormChunks('rerun1')).toBe(2);
    db.close();
  });
});
