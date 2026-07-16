/**
 * Brainstorm KPI pins (2026-07-16 operator audit: the home tiles for
 * artifacts-per-brainstorm and wiki lineage coverage were hardcoded
 * to 0 and rendered as "pending" forever).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb, type BrainstormSessionRow } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { computeBrainstormKpis } from '../src/dashboard/brainstorm-kpi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-kpi-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function brainstorm(id: string): void {
  db.insertBrainstorm({
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/tmp/brainstorm',
    user_label: null,
    derived_label: null,
    mode: 'voice',
    status: 'ended',
    started_ms: Date.now() - 3_600_000,
    ended_ms: Date.now(),
    turn_count: 3,
    topic_tags_json: '[]',
    artifacts_json: '[]',
    last_summary: null,
    last_summary_ms: null,
    project_slug: null,
  } as unknown as BrainstormSessionRow);
}

function draft(id: string, brainstormId: string): void {
  db.insertWikiDraft({
    id,
    brainstorm_id: brainstormId,
    page_slug: `slug-${id}`,
    page_title: `title ${id}`,
    body_markdown: 'body',
    confidence: 0.8,
  } as unknown as Parameters<IndexDb['insertWikiDraft']>[0]);
}

describe('computeBrainstormKpis', () => {
  it('computes artifacts-per-brainstorm and lineage coverage from wiki_drafts', () => {
    brainstorm('b1');
    brainstorm('b2');
    brainstorm('b3');
    brainstorm('b4');
    draft('d1', 'b1');
    draft('d2', 'b1');
    draft('d3', 'b2');
    const k = computeBrainstormKpis(db);
    expect(k.total_brainstorms).toBe(4);
    expect(k.artifacts_per_brainstorm_avg).toBeCloseTo(3 / 4, 5);
    expect(k.wiki_lineage_coverage).toBeCloseTo(2 / 4, 5);
  });

  it('returns zeros on an empty database instead of NaN', () => {
    const k = computeBrainstormKpis(db);
    expect(k.total_brainstorms).toBe(0);
    expect(k.artifacts_per_brainstorm_avg).toBe(0);
    expect(k.wiki_lineage_coverage).toBe(0);
    expect(k.project_less_ratio).toBe(0);
  });
});
