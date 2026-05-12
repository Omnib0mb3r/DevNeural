/**
 * Smart-compact shadow gate (SMART-COMPACT.md "Safety nets").
 *
 * First N attempts per anchor write the audit row with action='shadow'
 * but do not inject. After N successful shadow rows, the next fire
 * actually injects. Default N = 3, env override
 * DEVNEURAL_SMART_COMPACT_SHADOW_N.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { isShadow } from '../src/lex/smart-compact.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-smart-shadow-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N;
});

describe('isShadow', () => {
  it('returns true for the first N attempts on a fresh anchor', () => {
    expect(isShadow(db, 'anchor-fresh', 3)).toBe(true);
  });

  it('stays shadow while attempt count is below N', () => {
    for (let i = 0; i < 2; i++) {
      db.insertSmartCompactLog({
        id: `log-${i}`,
        anchor_id: 'anchor-A',
        cc_session_id: null,
        caller: 'lex',
        reason: 'window-open',
        action: 'shadow',
        pre_ctx_pct: 60,
      });
    }
    expect(isShadow(db, 'anchor-A', 3)).toBe(true);
  });

  it('flips to live once N rows exist for the anchor', () => {
    for (let i = 0; i < 3; i++) {
      db.insertSmartCompactLog({
        id: `log-${i}`,
        anchor_id: 'anchor-A',
        cc_session_id: null,
        caller: 'lex',
        reason: 'window-open',
        action: 'shadow',
        pre_ctx_pct: 60,
      });
    }
    expect(isShadow(db, 'anchor-A', 3)).toBe(false);
  });

  it('counts only rows for the matching anchor, not global', () => {
    for (let i = 0; i < 5; i++) {
      db.insertSmartCompactLog({
        id: `log-${i}`,
        anchor_id: 'anchor-other',
        cc_session_id: null,
        caller: 'lex',
        reason: 'window-open',
        action: 'shadow',
        pre_ctx_pct: 60,
      });
    }
    expect(isShadow(db, 'anchor-A', 3)).toBe(true);
  });
});
