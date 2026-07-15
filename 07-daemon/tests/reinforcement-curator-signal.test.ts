/**
 * Curator-loop revival, root cause R2: insertCuratorSignal (store/
 * index-db.ts) had zero production callers, so /stats/curator-health's
 * hit_total and correction_total were always 0 no matter how much the
 * reinforcement loop actually fired.
 *
 * curator.ts's curate() now generates one curatorLogId/promptId per
 * decision and threads it through recordInjection / recordRawInjection
 * into the reinforcement Pending record. evaluateAssistantReply's HIT
 * branches and evaluateCorrection's correction branches use it to write
 * a curator_signal row via the new writeCuratorSignal() helper.
 *
 * The embedder is stubbed (fixed identical vectors) so cosine is
 * trivially >= HIT_COSINE without depending on the real Xenova pipeline
 * — same pattern as tests/backfill-brainstorms.test.ts.
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
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-cursig-'))
    .replace(/\\/g, '/');
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;

  const { IndexDb } = await import('../src/store/index-db.js');
  const bootstrap = new IndexDb(dbFile);
  bootstrap.close();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });

  vi.doMock('../src/embedder/index.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/embedder/index.js')>();
    return {
      ...orig,
      // Identical unit vector every call -> dot product (cosine, since
      // both sides are identical) is always 1.0, comfortably above
      // HIT_COSINE (0.65) regardless of the real text content.
      embedOne: async () => new Float32Array([1, 0, 0]),
    };
  });
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

function plantCanonicalWikiPage(
  paths: typeof import('../src/paths.js'),
  schema: typeof import('../src/wiki/schema.js'),
  id: string,
): void {
  const today = new Date().toISOString().slice(0, 10);
  schema.writePage(paths.wikiPagesDir(), {
    frontmatter: {
      id,
      title: `${id} trigger → ${id} insight`,
      trigger: `${id} trigger`,
      insight: `${id} insight`,
      summary: `${id} summary`,
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
      pattern: `pattern body for ${id}`,
      crossRefs: [],
      crossRefsRaw: [],
      evidence: [],
      openQuestions: [],
      log: [],
    },
  });
}

async function buildStore(dbFilePath: string): Promise<{
  store: import('../src/store/index.js').Store;
  db: import('../src/store/index-db.js').IndexDb;
}> {
  const { IndexDb } = await import('../src/store/index-db.js');
  const db = new IndexDb(dbFilePath);
  const store = {
    db,
    wikiPages: { add: async () => undefined },
  } as unknown as import('../src/store/index.js').Store;
  return { store, db };
}

describe('R2: curator_signal wiring — HIT', () => {
  it('wiki hit writes a curator_signal hit row correlated to the curator_log decision', async () => {
    const paths = await import('../src/paths.js');
    const schema = await import('../src/wiki/schema.js');
    const reinforcement = await import('../src/reinforcement/index.js');
    const { store, db } = await buildStore(dbFile);

    plantCanonicalWikiPage(paths, schema, 'wiki-hit-page');

    db.insertCuratorLog({
      id: 'log-wiki-hit',
      prompt_id: 'prompt-wiki-hit',
      session_id: 'sess-wiki-hit',
      project_slug: 'proj-a',
      decision: 'inject',
      page_slug: 'wiki-hit-page',
      score: 0.8,
      threshold: 0.55,
      confidence: 0.55,
      source_class: 'wiki',
    });

    reinforcement.recordInjection(
      'sess-wiki-hit',
      'wiki-hit-page',
      path.posix.join(paths.wikiPagesDir(), 'wiki-hit-page.md'),
      'wiki-hit-page summary text',
      'log-wiki-hit',
      'prompt-wiki-hit',
    );

    await reinforcement.evaluateAssistantReply(
      store,
      'sess-wiki-hit',
      'a'.repeat(100), // >80 chars so it is not skipped as trivial
      () => undefined,
    );

    const rows = db['db']
      .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
      .all('log-wiki-hit') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.signal).toBe('hit');
    expect(rows[0]?.prompt_id).toBe('prompt-wiki-hit');
    expect(rows[0]?.source).toBe('regex-inferred');
    expect(rows[0]?.weight).toBeCloseTo(1.0, 4);

    const w = db.curatorHealthWindow(7);
    expect(w.hit_total).toBe(1);

    db.close();
  });

  it('raw hit writes a curator_signal hit row correlated to the curator_log decision', async () => {
    const reinforcement = await import('../src/reinforcement/index.js');
    const { store, db } = await buildStore(dbFile);

    db.insertCuratorLog({
      id: 'log-raw-hit',
      prompt_id: 'prompt-raw-hit',
      session_id: 'sess-raw-hit',
      project_slug: 'proj-a',
      decision: 'inject',
      page_slug: null,
      score: 0.7,
      threshold: 0.65,
      confidence: 0.14,
      source_class: 'raw',
    });

    // Short rawText (<40 chars) so scheduleRawHitIngest's internal
    // length guard bails immediately instead of reaching for a real
    // project registry / ingest pipeline in the background.
    reinforcement.recordRawInjection(
      'sess-raw-hit',
      'chunk-1',
      'short raw chunk',
      'proj-a',
      'log-raw-hit',
      'prompt-raw-hit',
    );

    await reinforcement.evaluateAssistantReply(
      store,
      'sess-raw-hit',
      'b'.repeat(100),
      () => undefined,
    );

    const rows = db['db']
      .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
      .all('log-raw-hit') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.signal).toBe('hit');
    expect(rows[0]?.prompt_id).toBe('prompt-raw-hit');

    db.close();
  });
});

describe('R2: curator_signal wiring — correction', () => {
  it('wiki correction writes a curator_signal correction row correlated to the curator_log decision', async () => {
    const paths = await import('../src/paths.js');
    const schema = await import('../src/wiki/schema.js');
    const reinforcement = await import('../src/reinforcement/index.js');
    const { store, db } = await buildStore(dbFile);

    plantCanonicalWikiPage(paths, schema, 'wiki-correction-page');

    db.insertCuratorLog({
      id: 'log-wiki-corr',
      prompt_id: 'prompt-wiki-corr',
      session_id: 'sess-wiki-corr',
      project_slug: 'proj-a',
      decision: 'inject',
      page_slug: 'wiki-correction-page',
      score: 0.8,
      threshold: 0.55,
      confidence: 0.55,
      source_class: 'wiki',
    });

    reinforcement.recordInjection(
      'sess-wiki-corr',
      'wiki-correction-page',
      path.posix.join(paths.wikiPagesDir(), 'wiki-correction-page.md'),
      'wiki-correction-page summary text',
      'log-wiki-corr',
      'prompt-wiki-corr',
    );

    reinforcement.evaluateCorrection(
      store,
      'sess-wiki-corr',
      'No, that is not what I asked for.',
      () => undefined,
    );

    const rows = db['db']
      .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
      .all('log-wiki-corr') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.signal).toBe('correction');
    expect(rows[0]?.prompt_id).toBe('prompt-wiki-corr');
    expect(rows[0]?.weight).toBeCloseTo(1.0, 4);

    const w = db.curatorHealthWindow(7);
    expect(w.correction_total).toBe(1);

    db.close();
  });

  it('raw correction writes a curator_signal correction row correlated to the curator_log decision', async () => {
    const reinforcement = await import('../src/reinforcement/index.js');
    const { store, db } = await buildStore(dbFile);

    db.insertCuratorLog({
      id: 'log-raw-corr',
      prompt_id: 'prompt-raw-corr',
      session_id: 'sess-raw-corr',
      project_slug: 'proj-a',
      decision: 'inject',
      page_slug: null,
      score: 0.7,
      threshold: 0.65,
      confidence: 0.14,
      source_class: 'raw',
    });

    reinforcement.recordRawInjection(
      'sess-raw-corr',
      'chunk-2',
      'short raw chunk',
      'proj-a',
      'log-raw-corr',
      'prompt-raw-corr',
    );

    reinforcement.evaluateCorrection(
      store,
      'sess-raw-corr',
      'Actually, that is wrong.',
      () => undefined,
    );

    const rows = db['db']
      .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
      .all('log-raw-corr') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.signal).toBe('correction');

    db.close();
  });
});
