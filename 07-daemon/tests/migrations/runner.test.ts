import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { IndexDb } from '../../src/store/index-db.js';
import { runMigrations } from '../../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let wikiDir: string;
let priorWikiRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-mig-'));
  dbFile = path.join(tmpDir, 'index.db');
  wikiDir = path.join(tmpDir, 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });

  const idx = new IndexDb(dbFile);
  idx.close();

  priorWikiRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (priorWikiRoot === undefined) {
    delete process.env.DEVNEURAL_DATA_ROOT;
  } else {
    process.env.DEVNEURAL_DATA_ROOT = priorWikiRoot;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function expectedMigrationFilenames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') || f.endsWith('.ts'))
    .filter((f) => !f.endsWith('.down.sql'))
    .filter((f) => !f.endsWith('.test.ts'))
    .sort();
}

describe('migration runner (Wave 1 day 1)', () => {
  it('applies all 9 migrations to a fresh DB and is idempotent', async () => {
    const r1 = await runMigrations({
      dbPath: dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    const expected = expectedMigrationFilenames();
    expect(r1.applied.sort()).toEqual(expected);
    expect(r1.totalAppliedAfter).toBe(expected.length);

    const r2 = await runMigrations({
      dbPath: dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    expect(r2.applied).toEqual([]);
    expect(r2.skipped.sort()).toEqual(expected);
  });

  it('creates Phase Two tables and columns', async () => {
    await runMigrations({
      dbPath: dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    const db = new Database(dbFile);
    try {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
        )
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);

      for (const t of [
        '_migrations',
        'wiki_meta',
        'brainstorm_chunks',
        'wiki_drafts',
        'outbound_log',
        'curator_log',
        'curator_signal',
        'lex_feedback',
      ]) {
        expect(tableNames).toContain(t);
      }

      const bsCols = db
        .prepare(`PRAGMA table_info(brainstorm_sessions)`)
        .all() as { name: string }[];
      const bsColNames = bsCols.map((c) => c.name);
      for (const c of [
        'project_slug',
        'audio_path',
        'distilled_at',
        'kind',
        'attendees',
        'meeting_topic',
        'consent_acked',
        'consent_acked_at',
        'consent_acked_by',
        'keep_audio',
        'provenance',
      ]) {
        expect(bsColNames).toContain(c);
      }

      const rcCols = db
        .prepare(`PRAGMA table_info(raw_chunks_meta)`)
        .all() as { name: string }[];
      expect(rcCols.map((c) => c.name)).toContain('model_id');
    } finally {
      db.close();
    }
  });

  it('outbound_no_voice_session trigger blocks brainstorm and meeting payloads', async () => {
    await runMigrations({
      dbPath: dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    const db = new Database(dbFile);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO outbound_log (id, destination, purpose, payload_class, payload_bytes)
             VALUES ('o1', 'api.anthropic.com', 'pass2', 'brainstorm-summary', 100)`,
          )
          .run(),
      ).toThrow(/voice-session/);

      expect(() =>
        db
          .prepare(
            `INSERT INTO outbound_log (id, destination, purpose, payload_class, payload_bytes)
             VALUES ('o2', 'api.anthropic.com', 'pass2', 'meeting-summary', 100)`,
          )
          .run(),
      ).toThrow(/voice-session/);

      expect(() =>
        db
          .prepare(
            `INSERT INTO outbound_log (id, destination, purpose, payload_class, payload_bytes, contains_voice_session_source)
             VALUES ('o3', 'api.anthropic.com', 'verify', 'wiki-page-candidate', 100, 1)`,
          )
          .run(),
      ).toThrow(/voice-session/);

      const ok = db
        .prepare(
          `INSERT INTO outbound_log (id, destination, purpose, payload_class, payload_bytes)
           VALUES ('o4', 'api.anthropic.com', 'verify', 'wiki-page-candidate', 100)`,
        )
        .run();
      expect(ok.changes).toBe(1);
    } finally {
      db.close();
    }
  });

  it('frontmatter sweep adds defaults to existing wiki pages without clobbering', async () => {
    fs.writeFileSync(
      path.join(wikiDir, 'no-frontmatter.md'),
      'Just body content, no frontmatter.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(wikiDir, 'partial.md'),
      '---\ntitle: Partial\nfrozen: true\n---\n\nBody.\n',
      'utf8',
    );

    await runMigrations({
      dbPath: dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });

    const noFm = fs.readFileSync(
      path.join(wikiDir, 'no-frontmatter.md'),
      'utf8',
    );
    expect(noFm).toMatch(/^---\n/);
    expect(noFm).toContain('schema_version: 2');
    expect(noFm).toContain('last_verified: null');
    expect(noFm).toContain('frozen: false');
    expect(noFm).toContain('Just body content');

    const partial = fs.readFileSync(path.join(wikiDir, 'partial.md'), 'utf8');
    expect(partial).toContain('title: Partial');
    expect(partial).toContain('frozen: true');
    expect(partial).toContain('schema_version: 2');
    expect(partial).toContain('source_brainstorms: []');
    expect(partial).not.toContain('frozen: false');
  });

  it('curator_log enforces unique prompt_id', async () => {
    await runMigrations({
      dbPath: dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO curator_log (id, prompt_id, decision, threshold)
         VALUES ('c1', 'p1', 'inject', 0.65)`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO curator_log (id, prompt_id, decision, threshold)
             VALUES ('c2', 'p1', 'silence', 0.65)`,
          )
          .run(),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });
});
