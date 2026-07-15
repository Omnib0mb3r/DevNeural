/**
 * Wiki index/disk reconciler tests (src/wiki/reconcile-index.ts).
 *
 * Module loading order discipline (see backfill-brainstorms.test.ts's
 * header comment): paths.ts snapshots DATA_ROOT as a top-level const
 * at first import, so a STATIC import of anything that transitively
 * pulls in paths.js (IndexDb, schema.js) would freeze DATA_ROOT before
 * beforeEach ever sets DEVNEURAL_DATA_ROOT. That exact mistake -- a
 * static `import { wikiPagesDir } from '../src/paths.js'` ahead of any
 * env override -- is what leaked alpha-page/beta-page/gamma-page/
 * frozen-page/rerun-page into the live data root in the first place
 * (tests/wiki-drafts-promote.test.ts). This file only ever uses type-
 * only imports statically (zero runtime footprint) and dynamic-
 * imports every runtime module inside each test, after resetModules()
 * + the env override in beforeEach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PageFrontmatter, PageSections } from '../src/wiki/schema.js';

let tmpDir: string;
let dbFile: string;
let dirs: { pages: string; pending: string; archive: string };
let priorRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-wiki-reconcile-'))
    .replace(/\\/g, '/');
  dbFile = path.posix.join(tmpDir, 'index.db');
  dirs = {
    pages: path.posix.join(tmpDir, 'wiki', 'pages'),
    pending: path.posix.join(tmpDir, 'wiki', 'pending'),
    archive: path.posix.join(tmpDir, 'wiki', 'archive'),
  };
  fs.mkdirSync(dirs.pages, { recursive: true });
  fs.mkdirSync(dirs.pending, { recursive: true });
  fs.mkdirSync(dirs.archive, { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fm(overrides: Partial<PageFrontmatter> = {}): PageFrontmatter {
  return {
    id: 'sample-page',
    title: 'sample trigger → sample insight',
    trigger: 'sample trigger text describing a real situation',
    insight: 'sample insight text describing the takeaway',
    summary: 'sample summary describing the recurring pattern',
    status: 'pending',
    weight: 0.3,
    hits: 0,
    corrections: 0,
    created: today(),
    last_touched: today(),
    projects: ['proj-1'],
    human_edited: false,
    ...overrides,
  };
}

function sections(overrides: Partial<PageSections> = {}): PageSections {
  return {
    pattern: 'sample pattern body describing the recurring behavior',
    crossRefs: [],
    crossRefsRaw: [],
    evidence: ['session abc123: observed once'],
    openQuestions: [],
    log: ['log line'],
    ...overrides,
  };
}

describe('wiki reconcile-index', () => {
  it('insert-missing-row: file on disk with no meta row is inserted on --apply', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({ id: 'new-page-no-row', status: 'canonical', weight: 0.55 }),
      sections: sections(),
    });

    const db = new IndexDb(dbFile);
    try {
      expect(db.pageById('new-page-no-row')).toBeUndefined();

      const disk = rec.scanWikiDisk(dirs);
      const plan = rec.planReconcile(disk, rec.readAllMetaRows(db));
      expect(plan.actions.map((a) => a.kind)).toContain('insert-missing-row');

      const applied = rec.applyReconcile(plan, disk, {
        db,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
      });
      expect(applied.inserted).toBe(1);

      const row = db.pageById('new-page-no-row');
      expect(row).toBeDefined();
      expect(row!.status).toBe('canonical');
      expect(row!.weight).toBeCloseTo(0.55);
    } finally {
      db.close();
    }
  });

  it('insert-missing-row is NOT applied on a dry run', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({ id: 'dry-run-page' }),
      sections: sections(),
    });

    const db = new IndexDb(dbFile);
    try {
      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: false,
      });
      expect(result.plan.actions.some((a) => a.kind === 'insert-missing-row')).toBe(true);
      expect(result.applied).toBeUndefined();
      expect(db.pageById('dry-run-page')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('delete-orphan-row: meta row with no disk file anywhere is deleted on --apply', async () => {
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    const db = new IndexDb(dbFile);
    try {
      db.upsertWikiPage(
        {
          id: 'orphan-row',
          title: 'orphan → row',
          trigger: 'orphan trigger',
          insight: 'orphan insight',
          status: 'pending',
          weight: 0.3,
          hits: 0,
          corrections: 0,
          created_ms: Date.now(),
          last_touched_ms: Date.now(),
          projects_json: '[]',
          human_edited: 0,
        },
        'orphan pattern body',
      );
      expect(db.pageById('orphan-row')).toBeDefined();

      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      expect(result.plan.actions.some((a) => a.kind === 'delete-orphan-row')).toBe(true);
      expect(result.applied!.deletedOrphanRows).toBe(1);
      expect(db.pageById('orphan-row')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('delete-orphan-row is NOT applied on a dry run', async () => {
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    const db = new IndexDb(dbFile);
    try {
      db.upsertWikiPage(
        {
          id: 'orphan-row-dry',
          title: 'orphan → row dry',
          trigger: 'orphan trigger',
          insight: 'orphan insight',
          status: 'pending',
          weight: 0.3,
          hits: 0,
          corrections: 0,
          created_ms: Date.now(),
          last_touched_ms: Date.now(),
          projects_json: '[]',
          human_edited: 0,
        },
        'orphan pattern body',
      );

      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: false,
      });
      expect(result.plan.actions.some((a) => a.kind === 'delete-orphan-row')).toBe(true);
      expect(db.pageById('orphan-row-dry')).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('sync-meta: disk frontmatter status/weight wins over a stale SQL row on --apply', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({ id: 'drifted-page', status: 'canonical', weight: 0.42 }),
      sections: sections(),
    });

    const db = new IndexDb(dbFile);
    try {
      db.upsertWikiPage(
        {
          id: 'drifted-page',
          title: 'stale title',
          trigger: 'stale trigger',
          insight: 'stale insight',
          status: 'pending',
          weight: 0.1,
          hits: 0,
          corrections: 0,
          created_ms: Date.now() - 1000,
          last_touched_ms: Date.now() - 1000,
          projects_json: '[]',
          human_edited: 0,
        },
        'stale pattern',
      );

      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      expect(result.plan.actions.some((a) => a.kind === 'sync-meta')).toBe(true);
      expect(result.applied!.synced).toBe(1);

      const row = db.pageById('drifted-page');
      expect(row!.status).toBe('canonical');
      expect(row!.weight).toBeCloseTo(0.42);
      expect(row!.title).toBe('sample trigger → sample insight');
    } finally {
      db.close();
    }
  });

  it('sync-meta is NOT applied on a dry run', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({ id: 'drifted-page-dry', status: 'canonical' }),
      sections: sections(),
    });

    const db = new IndexDb(dbFile);
    try {
      db.upsertWikiPage(
        {
          id: 'drifted-page-dry',
          title: 'stale title',
          trigger: 'stale trigger',
          insight: 'stale insight',
          status: 'pending',
          weight: 0.1,
          hits: 0,
          corrections: 0,
          created_ms: Date.now(),
          last_touched_ms: Date.now(),
          projects_json: '[]',
          human_edited: 0,
        },
        'stale pattern',
      );

      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: false,
      });
      expect(result.plan.actions.some((a) => a.kind === 'sync-meta')).toBe(true);
      const row = db.pageById('drifted-page-dry');
      expect(row!.status).toBe('pending');
      expect(row!.title).toBe('stale title');
    } finally {
      db.close();
    }
  });

  it('already in sync: no actions when disk and SQL agree', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({ id: 'in-sync-page', status: 'canonical', weight: 0.6 }),
      sections: sections(),
    });

    const db = new IndexDb(dbFile);
    try {
      // Seed with a real insert-missing-row apply first...
      rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      // ...then re-scan from scratch: should be fully idempotent.
      const disk = rec.scanWikiDisk(dirs);
      const plan = rec.planReconcile(disk, rec.readAllMetaRows(db));
      expect(plan.actions).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('re-running --apply on a mixed scenario is idempotent (zero actions the second time)', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({ id: 'mixed-insert', status: 'canonical' }),
      sections: sections(),
    });
    schema.writePage(dirs.pending, {
      frontmatter: fm({ id: 'mixed-sync', status: 'pending' }),
      sections: sections(),
    });

    const db = new IndexDb(dbFile);
    try {
      db.upsertWikiPage(
        {
          id: 'mixed-sync',
          title: 'stale',
          trigger: 'stale',
          insight: 'stale',
          status: 'canonical',
          weight: 0.9,
          hits: 5,
          corrections: 1,
          created_ms: Date.now(),
          last_touched_ms: Date.now(),
          projects_json: '[]',
          human_edited: 1,
        },
        'stale',
      );
      db.upsertWikiPage(
        {
          id: 'mixed-orphan',
          title: 'orphan → row',
          trigger: 'orphan',
          insight: 'orphan',
          status: 'pending',
          weight: 0.2,
          hits: 0,
          corrections: 0,
          created_ms: Date.now(),
          last_touched_ms: Date.now(),
          projects_json: '[]',
          human_edited: 0,
        },
        'orphan',
      );

      const first = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      expect(first.plan.actions.length).toBeGreaterThan(0);

      const second = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      expect(second.plan.actions).toHaveLength(0);
      expect(second.applied).toEqual({
        inserted: 0,
        synced: 0,
        deletedOrphanRows: 0,
        quarantined: 0,
        errors: [],
      });
    } finally {
      db.close();
    }
  });

  it('quarantine-fixture: slug + content match moves the file and removes the row on --apply', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    // Mirrors tests/backfill-brainstorms.test.ts's plantWikiPage() exactly.
    schema.writePage(dirs.pages, {
      frontmatter: fm({
        id: 'alpha-page',
        title: 'alpha primary topic → existing',
        trigger: 'pre-existing trigger',
        insight: 'pre-existing insight',
      }),
      sections: sections({ pattern: 'pattern body for alpha primary topic' }),
    });

    const db = new IndexDb(dbFile);
    try {
      // Also simulate the case where indexPage() DID run before the
      // leak was noticed, so a meta row exists too.
      db.upsertWikiPage(
        {
          id: 'alpha-page',
          title: 'alpha primary topic → existing',
          trigger: 'pre-existing trigger',
          insight: 'pre-existing insight',
          status: 'canonical',
          weight: 0.5,
          hits: 0,
          corrections: 0,
          created_ms: Date.now(),
          last_touched_ms: Date.now(),
          projects_json: '[]',
          human_edited: 0,
        },
        'pattern body for alpha primary topic',
      );

      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      expect(result.plan.actions.some((a) => a.kind === 'quarantine-fixture')).toBe(true);
      expect(result.applied!.quarantined).toBe(1);

      expect(fs.existsSync(path.posix.join(dirs.pages, 'alpha-page.md'))).toBe(false);
      expect(
        fs.existsSync(path.posix.join(tmpDir, 'wiki', 'quarantine', 'alpha-page.md')),
      ).toBe(true);
      expect(db.pageById('alpha-page')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('quarantine is NOT applied on a dry run', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({
        id: 'frozen-page',
        title: 'frozen-page → existing',
        trigger: 'pre-existing trigger',
        insight: 'pre-existing insight',
      }),
      sections: sections({ pattern: 'existing body' }),
    });

    const db = new IndexDb(dbFile);
    try {
      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: false,
      });
      expect(result.plan.actions.some((a) => a.kind === 'quarantine-fixture')).toBe(true);
      expect(fs.existsSync(path.posix.join(dirs.pages, 'frozen-page.md'))).toBe(true);
      expect(fs.existsSync(path.posix.join(tmpDir, 'wiki', 'quarantine'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('ambiguous-slug: known fixture slug with real content is only reported, never touched', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({
        id: 'beta-page',
        title: 'beta rollout timing → stage before prod, not after',
        trigger: 'rolling out a beta feature to production traffic',
        insight: 'stage the rollout behind a flag before prod, not after',
        status: 'canonical',
      }),
      sections: sections({ pattern: 'real observed pattern about staged beta rollout' }),
    });

    const db = new IndexDb(dbFile);
    try {
      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      expect(result.plan.actions).toHaveLength(1);
      expect(result.plan.actions[0]!.kind).toBe('report-fixture-ambiguous');
      expect(result.applied).toEqual({
        inserted: 0,
        synced: 0,
        deletedOrphanRows: 0,
        quarantined: 0,
        errors: [],
      });
      expect(fs.existsSync(path.posix.join(dirs.pages, 'beta-page.md'))).toBe(true);
      expect(db.pageById('beta-page')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('ambiguous-content: fixture content under an unknown slug is only reported, never touched', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({
        id: 'delta-page',
        title: 'delta-page → existing',
        trigger: 'pre-existing trigger',
        insight: 'pre-existing insight',
      }),
      sections: sections({ pattern: 'existing body' }),
    });

    const db = new IndexDb(dbFile);
    try {
      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      expect(result.plan.actions).toHaveLength(1);
      expect(result.plan.actions[0]!.kind).toBe('report-fixture-ambiguous');
      expect(fs.existsSync(path.posix.join(dirs.pages, 'delta-page.md'))).toBe(true);
      expect(db.pageById('delta-page')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('duplicate id across locations is only reported; neither copy is touched', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({ id: 'dup-page', status: 'canonical' }),
      sections: sections(),
    });
    schema.writePage(dirs.pending, {
      frontmatter: fm({ id: 'dup-page', status: 'pending' }),
      sections: sections(),
    });

    const db = new IndexDb(dbFile);
    try {
      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      const dupActions = result.plan.actions.filter((a) => a.id === 'dup-page');
      expect(dupActions).toHaveLength(1);
      expect(dupActions[0]!.kind).toBe('report-duplicate-id');
      expect(fs.existsSync(path.posix.join(dirs.pages, 'dup-page.md'))).toBe(true);
      expect(fs.existsSync(path.posix.join(dirs.pending, 'dup-page.md'))).toBe(true);
      expect(db.pageById('dup-page')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('unparseable file is reported without crashing the scan', async () => {
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    fs.writeFileSync(
      path.posix.join(dirs.pages, 'broken.md'),
      'not a valid page, no frontmatter delimiters here',
      'utf-8',
    );

    const db = new IndexDb(dbFile);
    try {
      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: true,
      });
      expect(result.disk.unparseable).toHaveLength(1);
      expect(result.plan.actions.some((a) => a.kind === 'report-unparseable')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('dry run mutates nothing across a mixed scenario (disk + db unchanged)', async () => {
    const schema = await import('../src/wiki/schema.js');
    const { IndexDb } = await import('../src/store/index-db.js');
    const rec = await import('../src/wiki/reconcile-index.js');

    schema.writePage(dirs.pages, {
      frontmatter: fm({ id: 'dr-insert', status: 'canonical' }),
      sections: sections(),
    });
    schema.writePage(dirs.pending, {
      frontmatter: fm({ id: 'dr-sync', status: 'pending' }),
      sections: sections(),
    });
    schema.writePage(dirs.pages, {
      frontmatter: fm({
        id: 'gamma-page',
        title: 'gamma unrelated topic → existing',
        trigger: 'pre-existing trigger',
        insight: 'pre-existing insight',
      }),
      sections: sections({ pattern: 'pattern body for gamma unrelated topic' }),
    });

    const db = new IndexDb(dbFile);
    try {
      db.upsertWikiPage(
        {
          id: 'dr-sync',
          title: 'stale',
          trigger: 'stale',
          insight: 'stale',
          status: 'canonical',
          weight: 0.9,
          hits: 0,
          corrections: 0,
          created_ms: Date.now(),
          last_touched_ms: Date.now(),
          projects_json: '[]',
          human_edited: 0,
        },
        'stale',
      );
      db.upsertWikiPage(
        {
          id: 'dr-orphan',
          title: 'orphan → row',
          trigger: 'orphan',
          insight: 'orphan',
          status: 'pending',
          weight: 0.2,
          hits: 0,
          corrections: 0,
          created_ms: Date.now(),
          last_touched_ms: Date.now(),
          projects_json: '[]',
          human_edited: 0,
        },
        'orphan',
      );

      const rowCountBefore = db.allWikiPages().length;
      const pagesBefore = fs.readdirSync(dirs.pages).sort();
      const pendingBefore = fs.readdirSync(dirs.pending).sort();

      const result = rec.runReconcile({
        db,
        dirs,
        quarantineDir: path.posix.join(tmpDir, 'wiki', 'quarantine'),
        apply: false,
      });

      // There is real work to report...
      const kinds = new Set(result.plan.actions.map((a) => a.kind));
      expect(kinds.has('insert-missing-row')).toBe(true);
      expect(kinds.has('sync-meta')).toBe(true);
      expect(kinds.has('delete-orphan-row')).toBe(true);
      expect(kinds.has('quarantine-fixture')).toBe(true);

      // ...but nothing actually moved.
      expect(result.applied).toBeUndefined();
      expect(db.allWikiPages().length).toBe(rowCountBefore);
      expect(fs.readdirSync(dirs.pages).sort()).toEqual(pagesBefore);
      expect(fs.readdirSync(dirs.pending).sort()).toEqual(pendingBefore);
      expect(fs.existsSync(path.posix.join(tmpDir, 'wiki', 'quarantine'))).toBe(false);
    } finally {
      db.close();
    }
  });
});
