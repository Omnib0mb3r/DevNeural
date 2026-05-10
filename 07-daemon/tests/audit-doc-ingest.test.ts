/**
 * Wave 2 day 3 step 14 (A6). Audit doc auto-ingest creates synthetic
 * brainstorm_sessions rows with the kind override (brainstorm, not
 * meeting) and provenance='audit-document'. Re-runs are idempotent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;
let repoRoot: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-audit-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  db = new IndexDb(dbFile);
  db.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  /* Pretend the repo root has the two audit-doc shapes we ingest. */
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-audit-repo-'));
  fs.writeFileSync(
    path.join(repoRoot, 'voice-review.md'),
    '# voice review\n\nfirst observation here\n\n## section\n\nsecond block of text',
  );
  fs.mkdirSync(path.join(repoRoot, 'docs', 'audit'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'docs', 'audit', 'q1.md'),
    'q1 audit body\n\nmore content',
  );
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runAuditDocIngest', () => {
  it('writes synthetic brainstorm_sessions row with the BF-14 kind override', async () => {
    vi.doMock('../src/embedder/index.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/embedder/index.js')>();
      return {
        ...orig,
        embedOne: async () => new Float32Array([1, 0, 0]),
        getModelId: () => 'stub-model',
      };
    });
    const { runAuditDocIngest } = await import('../src/wiki/audit-doc-ingest.js');
    const store = { db } as unknown as import('../src/store/index.js').Store;
    const r = await runAuditDocIngest(store, repoRoot.replace(/\\/g, '/'), () => undefined);
    expect(r.files_scanned).toBe(2);
    expect(r.files_ingested).toBe(2);
    expect(r.chunks_written).toBeGreaterThan(0);
    /* Both rows are kind='brainstorm' even though mode='notes' (the
     * BF-14 audit-doc override). */
    const rows = db.listBrainstorms({ limit: 50 });
    const audit = rows.filter((r) => (r.provenance ?? '') === 'audit-document');
    expect(audit.length).toBe(2);
    for (const row of audit) {
      expect(row.kind).toBe('brainstorm');
      expect(row.mode).toBe('notes');
      expect(row.consent_acked).toBe(0);
      expect(row.project_slug).toBeNull();
      expect(row.audio_path).toBeNull();
    }
  });

  it('re-running does not duplicate rows or chunks', async () => {
    vi.doMock('../src/embedder/index.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/embedder/index.js')>();
      return {
        ...orig,
        embedOne: async () => new Float32Array([1, 0, 0]),
        getModelId: () => 'stub-model',
      };
    });
    const { runAuditDocIngest } = await import('../src/wiki/audit-doc-ingest.js');
    const store = { db } as unknown as import('../src/store/index.js').Store;
    await runAuditDocIngest(store, repoRoot.replace(/\\/g, '/'), () => undefined);
    const after1 = db.listBrainstorms({ limit: 50 }).length;
    const chunks1 = db['db']
      .prepare(`SELECT COUNT(*) AS n FROM brainstorm_chunks`).get() as { n: number };
    await runAuditDocIngest(store, repoRoot.replace(/\\/g, '/'), () => undefined);
    const after2 = db.listBrainstorms({ limit: 50 }).length;
    const chunks2 = db['db']
      .prepare(`SELECT COUNT(*) AS n FROM brainstorm_chunks`).get() as { n: number };
    expect(after2).toBe(after1);
    expect(chunks2.n).toBe(chunks1.n);
  });
});
