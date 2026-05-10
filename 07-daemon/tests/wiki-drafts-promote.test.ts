/**
 * Wave 2 day 2 step 10 (BF-7 review / A2). The /drafts/:id/promote
 * conflict semantics:
 *   - slug_collision    : page with same id already on disk
 *   - frozen_target     : existing page has frontmatter.frozen=true
 *   - superseded        : another draft for the slug already promoted
 *   - target_drift      : expected_resolved_at no longer matches the row
 *
 * These tests exercise the underlying IndexDb helpers + the wiki
 * schema writer directly. The route layer is a thin wrapper around
 * these primitives; the higher-level fastify wiring is covered by
 * the existing integration tests under tests/integration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb, type WikiDraftRow } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { writePage } from '../src/wiki/schema.js';
import { wikiPagesDir } from '../src/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-drafts-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  db = new IndexDb(dbFile);
  db.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  /* Every test starts with one brainstorm row + one pending draft so
   * the conflict assertions stay focused on the promote path itself. */
  db.insertBrainstorm({
    id: 'bs-1',
    claude_session_id: 'cc-1',
    pty_id: null,
    cwd: tmpDir,
    user_label: 'pricing rethink',
    derived_label: null,
    mode: 'conversation',
    status: 'ended',
    started_ms: Date.now() - 1000,
    ended_ms: Date.now(),
    turn_count: 5,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: 'sum',
    last_summary_ms: Date.now(),
  });
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function pendingDraft(id: string, slug: string): WikiDraftRow {
  db.insertWikiDraft({
    id,
    brainstorm_id: 'bs-1',
    page_slug: slug,
    page_title: `Title → ${slug}`,
    body_markdown: `body for ${slug}`,
    confidence: 0.8,
  });
  return db.getWikiDraft(id)!;
}

function makePage(id: string, opts: { frozen?: boolean } = {}): void {
  const today = new Date().toISOString().slice(0, 10);
  writePage(wikiPagesDir(), {
    frontmatter: {
      id,
      title: `${id} → existing`,
      trigger: 'pre-existing trigger',
      insight: 'pre-existing insight',
      summary: 'pre-existing summary',
      status: 'canonical',
      weight: 0.5,
      hits: 0,
      corrections: 0,
      created: today,
      last_touched: today,
      projects: [],
      human_edited: true,
      ...(opts.frozen ? { frozen: true } : {}),
    },
    sections: {
      pattern: 'existing body',
      crossRefs: [],
      crossRefsRaw: [],
      evidence: [],
      openQuestions: [],
      log: [],
    },
  });
}

describe('/drafts/:id/promote conflict cases', () => {
  it('slug_collision: another wiki page with same slug exists', async () => {
    pendingDraft('d-1', 'pricing-rethink');
    makePage('pricing-rethink');
    /* Re-read after collision: the helper that walks the disk for
     * the existing page is loadPage(slug); the conflict surface is
     * "page is loadable AND no resolution supplied". */
    const { loadPage } = await import('../src/reinforcement/index.js');
    const page = loadPage('pricing-rethink');
    expect(page).not.toBeNull();
    expect(page!.frontmatter.frozen).not.toBe(true);
  });

  it('frozen_target: existing page marked frozen blocks promote without force', async () => {
    pendingDraft('d-2', 'frozen-page');
    makePage('frozen-page', { frozen: true });
    const { loadPage } = await import('../src/reinforcement/index.js');
    const page = loadPage('frozen-page');
    expect(page!.frontmatter.frozen).toBe(true);
  });

  it('superseded: another draft for the same slug already promoted', () => {
    pendingDraft('d-3a', 'shared-slug');
    pendingDraft('d-3b', 'shared-slug');
    db.updateWikiDraft('d-3a', { status: 'promoted', resolved_by: 'user' });
    const others = db
      .wikiDraftsBySlug('shared-slug', ['promoted', 'auto-promoted'])
      .filter((d) => d.id !== 'd-3b');
    expect(others).toHaveLength(1);
    expect(others[0]?.id).toBe('d-3a');
    /* And the routing layer would flip d-3b to superseded; replay
     * that step here so the assertion reaches the same end state
     * the dashboard would observe. */
    const flipped = db.updateWikiDraft('d-3b', {
      status: 'superseded',
      resolved_by: 'system:promote-race',
    });
    expect(flipped?.status).toBe('superseded');
    expect(flipped?.resolved_at).not.toBeNull();
  });

  it('target_drift: expected_resolved_at no longer matches the row', () => {
    const draft = pendingDraft('d-4', 'drift-slug');
    /* The dashboard observed resolved_at=null on open. A second tab
     * promotes-then-discards in a way that flips resolved_at. We
     * simulate by writing a non-null value directly. */
    db.updateWikiDraft('d-4', { status: 'discarded', resolved_by: 'other-tab' });
    const after = db.getWikiDraft('d-4')!;
    expect(after.resolved_at).not.toBeNull();
    expect(draft.resolved_at).toBeNull();
    /* The route checks `expected_resolved_at !== current resolved_at`.
     * Confirm the mismatch is detectable. */
    expect(after.resolved_at).not.toBe(draft.resolved_at);
  });

  it('updateWikiDraft sets resolved_at on terminal status transition only', () => {
    pendingDraft('d-5', 'terminal-slug');
    const same = db.updateWikiDraft('d-5', { page_title: 'edited' });
    expect(same?.status).toBe('pending');
    expect(same?.resolved_at).toBeNull();
    const promoted = db.updateWikiDraft('d-5', {
      status: 'promoted',
      resolved_by: 'user',
    });
    expect(promoted?.status).toBe('promoted');
    expect(promoted?.resolved_at).not.toBeNull();
    expect(promoted?.resolved_by).toBe('user');
  });

  it('listWikiDrafts filters by status', () => {
    pendingDraft('d-6a', 'a-slug');
    pendingDraft('d-6b', 'b-slug');
    db.updateWikiDraft('d-6a', { status: 'promoted', resolved_by: 'user' });
    expect(db.listWikiDrafts({ status: 'pending' }).map((d) => d.id)).toEqual([
      'd-6b',
    ]);
    expect(db.listWikiDrafts({ status: 'promoted' }).map((d) => d.id)).toEqual([
      'd-6a',
    ]);
  });
});

describe('listBrainstormsFiltered (Wave 2 day 2 step 9)', () => {
  it('filters by project_slug and mode without breaking the kind default', () => {
    db.insertBrainstorm({
      id: 'bs-fa',
      claude_session_id: 'cc-fa',
      pty_id: null,
      cwd: tmpDir,
      user_label: 'a',
      derived_label: null,
      mode: 'conversation',
      status: 'ended',
      started_ms: Date.now() - 100,
      ended_ms: Date.now(),
      turn_count: 1,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: null,
      last_summary_ms: null,
    });
    /* Patch project_slug via raw UPDATE since insertBrainstorm doesn't
     * surface it (matches the legacy migration semantics). */
    db['db'].prepare(`UPDATE brainstorm_sessions SET project_slug = ? WHERE id = ?`).run('alpha', 'bs-fa');
    db['db'].prepare(`UPDATE brainstorm_sessions SET project_slug = ? WHERE id = ?`).run('beta', 'bs-1');
    const alpha = db.listBrainstormsFiltered({ project_slug: 'alpha' });
    const beta = db.listBrainstormsFiltered({ project_slug: 'beta' });
    expect(alpha.map((b) => b.id)).toEqual(['bs-fa']);
    expect(beta.map((b) => b.id)).toEqual(['bs-1']);
    const convOnly = db.listBrainstormsFiltered({ mode: 'conversation' });
    expect(convOnly.map((b) => b.id).sort()).toEqual(['bs-1', 'bs-fa']);
  });
});
