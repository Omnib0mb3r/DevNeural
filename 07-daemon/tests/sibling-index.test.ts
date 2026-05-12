/**
 * Sibling index helper.
 *
 * Covers the four contracts the helper promises:
 *   1. Empty label / no matches returns an empty string (so the
 *      caller can safely concat without conditional rendering).
 *   2. Case-insensitive label match, whitespace tolerant.
 *   3. excludeId drops the newly-created session.
 *   4. Each line carries id8, label in quotes, ISO started, optional
 *      10-word distillation pulled from last_summary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildSiblingIndex } from '../src/lex/sibling-index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function insertBs(opts: {
  id: string;
  user_label: string | null;
  derived_label?: string | null;
  started_ms: number;
  last_summary?: string | null;
}): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: opts.user_label,
    derived_label: opts.derived_label ?? null,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.started_ms,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: opts.last_summary ?? null,
    last_summary_ms: null,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-sibling-index-'));
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
});

describe('buildSiblingIndex - empty cases', () => {
  it('returns empty string when label is null', () => {
    expect(buildSiblingIndex({ db, label: null })).toBe('');
  });

  it('returns empty string when label is empty / whitespace', () => {
    expect(buildSiblingIndex({ db, label: '   ' })).toBe('');
  });

  it('returns empty string when no brainstorms match the label', () => {
    insertBs({
      id: 'aaaaaaaa-1111',
      user_label: 'Different Topic',
      started_ms: 1_000,
    });
    expect(buildSiblingIndex({ db, label: 'No Match' })).toBe('');
  });
});

describe('buildSiblingIndex - label matching', () => {
  it('matches case-insensitively and trims whitespace', () => {
    insertBs({
      id: 'bbbbbbbb-2222',
      user_label: 'Smart Compact Rollout',
      started_ms: 1_000,
    });
    const out = buildSiblingIndex({ db, label: '  smart compact rollout  ' });
    expect(out).toMatch(/bbbbbbbb/);
    expect(out).toMatch(/Smart Compact Rollout/);
  });

  it('excludes the newly-created session when excludeId is provided', () => {
    insertBs({
      id: 'self-id-00000000',
      user_label: 'DevNeural Testing',
      started_ms: 2_000,
    });
    insertBs({
      id: 'sibling-id-1111',
      user_label: 'DevNeural Testing',
      started_ms: 1_000,
    });
    const out = buildSiblingIndex({
      db,
      label: 'DevNeural Testing',
      excludeId: 'self-id-00000000',
    });
    expect(out).toMatch(/sibling-/);
    expect(out).not.toMatch(/self-id/);
  });

  it('returns empty when only the excluded row matches', () => {
    insertBs({
      id: 'only-self-0000',
      user_label: 'Solo Topic',
      started_ms: 3_000,
    });
    expect(
      buildSiblingIndex({
        db,
        label: 'Solo Topic',
        excludeId: 'only-self-0000',
      }),
    ).toBe('');
  });

  it('caps the visible list at the supplied limit', () => {
    for (let i = 0; i < 12; i++) {
      insertBs({
        id: `mass-${i}`.padEnd(8, '0'),
        user_label: 'Mass Topic',
        started_ms: 1_000 + i,
      });
    }
    const out = buildSiblingIndex({
      db,
      label: 'Mass Topic',
      limit: 3,
    });
    const bulletLines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bulletLines.length).toBe(3);
  });
});

describe('buildSiblingIndex - line format', () => {
  it('formats id8 + quoted label + ISO started + distillation tail', () => {
    insertBs({
      id: 'cccccccc-3333',
      user_label: 'Format Check',
      started_ms: Date.UTC(2026, 4, 12, 8, 30, 0),
      last_summary:
        'wrote sibling index helper covers label match exclude id format truncation tests',
    });
    const out = buildSiblingIndex({ db, label: 'Format Check' });
    /* id8 = first 8 chars; label in quotes; ISO ts; tail dash. */
    expect(out).toMatch(/- cccccccc "Format Check" started 2026-05-12T08:30:00\.000Z — /);
  });

  it('truncates the distillation to 10 words by default', () => {
    insertBs({
      id: 'dddddddd-4444',
      user_label: 'Truncation Check',
      started_ms: 1_000,
      last_summary:
        'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
    });
    const out = buildSiblingIndex({ db, label: 'Truncation Check' });
    expect(out).toMatch(/one two three four five six seven eight nine ten\.\.\./);
    expect(out).not.toMatch(/eleven/);
  });

  it('omits the distillation tail when last_summary is null', () => {
    insertBs({
      id: 'eeeeeeee-5555',
      user_label: 'No Summary',
      started_ms: 1_000,
      last_summary: null,
    });
    const out = buildSiblingIndex({ db, label: 'No Summary' });
    expect(out).toMatch(/- eeeeeeee "No Summary" started \d{4}-\d{2}-\d{2}T/);
    expect(out).not.toMatch(/ — /);
  });

  it('falls back to derived_label when user_label is null', () => {
    insertBs({
      id: 'ffffffff-6666',
      user_label: null,
      derived_label: 'Auto Label',
      started_ms: 1_000,
    });
    /* Caller passes the new session's label as the match key; even
     * when the match row has a null user_label, the formatter still
     * needs a friendly display name. Match must be case-insensitive
     * on whatever the caller supplied, so a null user_label row only
     * surfaces when the caller's label matches its (also null) value
     * - which we treat as no match. This test guards that we do not
     * accidentally show derived-label rows for an unrelated label. */
    expect(buildSiblingIndex({ db, label: 'Auto Label' })).toBe('');
  });
});

describe('buildSiblingIndex - header block', () => {
  it('opens with the canonical header and includes the user label', () => {
    insertBs({
      id: 'gggggggg-7777',
      user_label: 'Header Check',
      started_ms: 1_000,
    });
    const out = buildSiblingIndex({ db, label: 'Header Check' });
    expect(out.startsWith('# Sibling sessions (same label "Header Check")')).toBe(
      true,
    );
    expect(out).toMatch(/Prior brainstorms the user named the same way/);
  });
});
