/**
 * Wiki index/disk reconciler.
 *
 * The daemon keeps two representations of every wiki page in sync on
 * every write: the markdown file under wiki/{pages,pending,archive}/
 * (source of truth for content) and a mirror row in wiki_pages_meta
 * (SQL, used for fast filter/sort + FTS). That mirroring only happens
 * when the normal write path runs (schema.writePage + indexPage /
 * upsertWikiPage, see src/wiki/ingest.ts and src/wiki/lint.ts). Any
 * gap in that path -- a starved lint queue, a crash mid-write, a test
 * run that wrote pages straight into the live data root -- leaves the
 * two representations disagreeing. This module finds and (optionally)
 * fixes that disagreement.
 *
 * Three disk/SQL cases, matching the schema's existing semantics:
 *   - file without row:  insert a row from the disk frontmatter (this
 *     is exactly what indexPage() does on a normal write).
 *   - row without file:  delete the row. There is no "archived but
 *     fileless" state in this schema -- archived pages still live in
 *     wiki/archive/ -- so a row with no backing file anywhere is
 *     orphaned garbage, not a real page.
 *   - both exist but disagree: disk wins (it is the human/LLM-authored
 *     source; SQL is a derived index). Re-run the same upsert the
 *     normal write path would have run.
 *
 * Plus one orthogonal concern: test-fixture pages that leaked into
 * the live data root (a test run that didn't override
 * DEVNEURAL_DATA_ROOT before writePage() resolved wikiPagesDir()).
 * A page only qualifies for quarantine when BOTH its slug matches the
 * known fixture list AND its content matches the literal fixture
 * generator patterns found in tests/backfill-brainstorms.test.ts
 * (plantWikiPage) and tests/wiki-drafts-promote.test.ts (makePage).
 * Either signal alone is only reported -- never auto-quarantined --
 * so a coincidentally-named real page is never destroyed.
 *
 * Pure-logic split for testability: scanWikiDisk/readAllMetaRows do
 * IO and return plain data; planReconcile is a pure function over
 * that data (no IO, deterministic, safe to unit test with in-memory
 * fixtures); applyReconcile is the only place that writes. Every
 * caller passes explicit directories and an explicit IndexDb instance
 * rather than reaching for paths.js singletons internally -- that
 * "read env-derived path lazily inside the function you call, not at
 * module load" discipline is precisely what the leaked test fixtures
 * violated (a static top-level import of wikiPagesDir() froze
 * DATA_ROOT before the test's beforeEach could override it).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPage, type ParsedPage, type PageFrontmatter } from './schema.js';
import type { IndexDb, WikiPageRow } from '../store/index-db.js';

export type WikiLocation = 'pages' | 'pending' | 'archive';

export interface DiskPageEntry {
  id: string;
  location: WikiLocation;
  filePath: string;
  parsed: ParsedPage;
}

export interface DiskScanResult {
  /** Every parsed page found on disk, one entry per file. */
  entries: DiskPageEntry[];
  /** Grouped by id; length > 1 means the same id exists in more than
   * one location (pages/ and pending/, say) -- an ambiguous state
   * the reconciler reports but never auto-resolves. */
  byId: Map<string, DiskPageEntry[]>;
  /** Files that failed to parse (missing frontmatter delimiters etc). */
  unparseable: { filePath: string; error: string }[];
}

export interface WikiDirs {
  pages: string;
  pending: string;
  archive: string;
}

function listMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.posix.join(dir, f));
}

export function scanWikiDisk(dirs: WikiDirs): DiskScanResult {
  const entries: DiskPageEntry[] = [];
  const unparseable: { filePath: string; error: string }[] = [];
  const locations: [WikiLocation, string][] = [
    ['pages', dirs.pages],
    ['pending', dirs.pending],
    ['archive', dirs.archive],
  ];

  for (const [location, dir] of locations) {
    for (const filePath of listMdFiles(dir)) {
      try {
        const parsed = readPage(filePath);
        const id =
          parsed.frontmatter.id ||
          path.basename(filePath, '.md');
        entries.push({ id, location, filePath, parsed });
      } catch (err) {
        unparseable.push({ filePath, error: (err as Error).message });
      }
    }
  }

  const byId = new Map<string, DiskPageEntry[]>();
  for (const e of entries) {
    const list = byId.get(e.id) ?? [];
    list.push(e);
    byId.set(e.id, list);
  }

  return { entries, byId, unparseable };
}

export function readAllMetaRows(db: IndexDb): WikiPageRow[] {
  return db.allWikiPages();
}

/* ── Test-fixture detection ─────────────────────────────────────── */

/* Verified fixture leak list (2026-07-15 goal audit). Sourced from
 * tests/backfill-brainstorms.test.ts (alpha-page, beta-page,
 * gamma-page, rerun-page via plantWikiPage) and
 * tests/wiki-drafts-promote.test.ts (frozen-page via makePage). */
export const KNOWN_FIXTURE_SLUGS: ReadonlySet<string> = new Set([
  'alpha-page',
  'beta-page',
  'gamma-page',
  'frozen-page',
  'rerun-page',
]);

/* Both test-file generators stamp the exact same literal
 * trigger/insight and a title ending in "-> existing":
 *   tests/backfill-brainstorms.test.ts plantWikiPage():
 *     trigger: 'pre-existing trigger', insight: 'pre-existing insight',
 *     title: `${title} -> existing`, pattern: `pattern body for ${title}`
 *   tests/wiki-drafts-promote.test.ts makePage():
 *     trigger: 'pre-existing trigger', insight: 'pre-existing insight',
 *     title: `${id} -> existing`, pattern: 'existing body'
 * No real LLM-authored page produces this literal text (DEVNEURAL.md
 * requires a trigger describing an actual situation, not the string
 * "pre-existing trigger"), so an exact match on all three fields is a
 * strong, low-false-positive content signature. */
export function fixtureContentMatch(fm: PageFrontmatter): boolean {
  return (
    fm.trigger === 'pre-existing trigger' &&
    fm.insight === 'pre-existing insight' &&
    /→\s*existing\s*$/.test(fm.title.trim())
  );
}

export type FixtureClass =
  | 'quarantine'
  | 'ambiguous-slug'
  | 'ambiguous-content'
  | 'none';

export function classifyFixture(entry: DiskPageEntry): FixtureClass {
  const slugMatch = KNOWN_FIXTURE_SLUGS.has(entry.id);
  const contentMatch = fixtureContentMatch(entry.parsed.frontmatter);
  if (slugMatch && contentMatch) return 'quarantine';
  if (slugMatch) return 'ambiguous-slug';
  if (contentMatch) return 'ambiguous-content';
  return 'none';
}

/* ── Pure plan ───────────────────────────────────────────────────── */

export type ReconcileActionKind =
  | 'insert-missing-row'
  | 'delete-orphan-row'
  | 'sync-meta'
  | 'quarantine-fixture'
  | 'report-fixture-ambiguous'
  | 'report-duplicate-id'
  | 'report-unparseable';

export interface ReconcileAction {
  kind: ReconcileActionKind;
  id: string;
  location?: WikiLocation;
  detail: string;
}

export interface ReconcilePlan {
  scanned_disk: number;
  scanned_meta: number;
  actions: ReconcileAction[];
  generated_at: string;
}

function diffRowVsFrontmatter(row: WikiPageRow, fm: PageFrontmatter): string[] {
  const diffs: string[] = [];
  if (row.status !== fm.status) diffs.push(`status: ${row.status} -> ${fm.status}`);
  if (row.title !== fm.title) diffs.push('title differs');
  if (row.trigger !== fm.trigger) diffs.push('trigger differs');
  if (row.insight !== fm.insight) diffs.push('insight differs');
  if (Math.abs(row.weight - fm.weight) > 1e-9) {
    diffs.push(`weight: ${row.weight} -> ${fm.weight}`);
  }
  if (row.hits !== fm.hits) diffs.push(`hits: ${row.hits} -> ${fm.hits}`);
  if (row.corrections !== fm.corrections) {
    diffs.push(`corrections: ${row.corrections} -> ${fm.corrections}`);
  }
  const fmHumanEdited = fm.human_edited ? 1 : 0;
  if (row.human_edited !== fmHumanEdited) {
    diffs.push(`human_edited: ${row.human_edited} -> ${fmHumanEdited}`);
  }
  const fmProjectsJson = JSON.stringify(fm.projects ?? []);
  if (row.projects_json !== fmProjectsJson) diffs.push('projects differ');
  return diffs;
}

export function planReconcile(
  disk: DiskScanResult,
  meta: WikiPageRow[],
): ReconcilePlan {
  const actions: ReconcileAction[] = [];
  const metaById = new Map(meta.map((m) => [m.id, m]));
  const handledIds = new Set<string>();

  for (const u of disk.unparseable) {
    actions.push({
      kind: 'report-unparseable',
      id: path.basename(u.filePath, '.md'),
      detail: u.error,
    });
  }

  // Duplicate ids (same id in more than one location) are handled
  // first and exclusively -- we cannot safely act on any file for
  // that id while it's ambiguous which one is authoritative.
  for (const [id, list] of disk.byId) {
    if (list.length > 1) {
      handledIds.add(id);
      actions.push({
        kind: 'report-duplicate-id',
        id,
        detail: `present in ${list.length} locations: ${list
          .map((e) => `${e.location}/${path.basename(e.filePath)}`)
          .join(', ')}`,
      });
    }
  }

  for (const [id, list] of disk.byId) {
    if (handledIds.has(id)) continue;
    const entry = list[0]!;
    const cls = classifyFixture(entry);
    if (cls === 'quarantine') {
      handledIds.add(id);
      actions.push({
        kind: 'quarantine-fixture',
        id,
        location: entry.location,
        detail:
          'slug + content signature match a known test fixture (trigger/insight/title pattern)',
      });
      continue;
    }
    if (cls === 'ambiguous-slug' || cls === 'ambiguous-content') {
      handledIds.add(id);
      actions.push({
        kind: 'report-fixture-ambiguous',
        id,
        location: entry.location,
        detail: `only one fixture signal matched (${cls}); not auto-quarantined, needs human review`,
      });
      continue;
    }

    const row = metaById.get(id);
    if (!row) {
      actions.push({
        kind: 'insert-missing-row',
        id,
        location: entry.location,
        detail: `disk status=${entry.parsed.frontmatter.status}, no meta row`,
      });
    } else {
      const diffs = diffRowVsFrontmatter(row, entry.parsed.frontmatter);
      if (diffs.length > 0) {
        actions.push({
          kind: 'sync-meta',
          id,
          location: entry.location,
          detail: diffs.join('; '),
        });
      }
    }
  }

  for (const m of meta) {
    if (!disk.byId.has(m.id)) {
      actions.push({
        kind: 'delete-orphan-row',
        id: m.id,
        detail: `meta row status=${m.status}, no disk file in pages/pending/archive`,
      });
    }
  }

  return {
    scanned_disk: disk.entries.length,
    scanned_meta: meta.length,
    actions,
    generated_at: new Date().toISOString(),
  };
}

/* ── Apply (the only place that writes) ─────────────────────────── */

export interface ApplyOptions {
  db: IndexDb;
  quarantineDir: string;
}

export interface ApplyResult {
  inserted: number;
  synced: number;
  deletedOrphanRows: number;
  quarantined: number;
  errors: { id: string; error: string }[];
}

function upsertRowFromDisk(db: IndexDb, entry: DiskPageEntry): void {
  const fm = entry.parsed.frontmatter;
  const createdMs = new Date(fm.created).getTime() || Date.now();
  // Deliberately derived from disk's last_touched, not Date.now(): this
  // is a repair pass catching up stale metadata, not a new touch event.
  // Stamping "now" would make long-stale pending pages look freshly
  // active in SQL-driven recency views without anything actually having
  // happened to them.
  const lastTouchedMs = new Date(fm.last_touched).getTime() || Date.now();
  db.upsertWikiPage(
    {
      id: fm.id,
      title: fm.title,
      trigger: fm.trigger,
      insight: fm.insight,
      status: fm.status,
      weight: fm.weight,
      hits: fm.hits,
      corrections: fm.corrections,
      created_ms: createdMs,
      last_touched_ms: lastTouchedMs,
      projects_json: JSON.stringify(fm.projects ?? []),
      human_edited: fm.human_edited ? 1 : 0,
    },
    entry.parsed.sections.pattern,
  );
}

function quarantineFile(entry: DiskPageEntry, quarantineDir: string): void {
  fs.mkdirSync(quarantineDir, { recursive: true });
  const base = path.basename(entry.filePath);
  let dest = path.posix.join(quarantineDir, base);
  if (fs.existsSync(dest)) {
    // Re-run or naming collision inside quarantine itself: never
    // silently overwrite a previously quarantined file.
    dest = path.posix.join(quarantineDir, `${entry.id}.${Date.now()}.md`);
  }
  // fs.renameSync is atomic on the same volume, which wiki/quarantine/
  // always is (sibling of pages/pending/archive under the same wiki root).
  fs.renameSync(entry.filePath, dest);
}

export function applyReconcile(
  plan: ReconcilePlan,
  disk: DiskScanResult,
  opts: ApplyOptions,
): ApplyResult {
  const result: ApplyResult = {
    inserted: 0,
    synced: 0,
    deletedOrphanRows: 0,
    quarantined: 0,
    errors: [],
  };

  for (const action of plan.actions) {
    try {
      switch (action.kind) {
        case 'insert-missing-row': {
          const entry = disk.byId.get(action.id)?.[0];
          if (!entry) break;
          upsertRowFromDisk(opts.db, entry);
          result.inserted += 1;
          break;
        }
        case 'sync-meta': {
          const entry = disk.byId.get(action.id)?.[0];
          if (!entry) break;
          upsertRowFromDisk(opts.db, entry);
          result.synced += 1;
          break;
        }
        case 'delete-orphan-row': {
          opts.db.deleteWikiPage(action.id);
          result.deletedOrphanRows += 1;
          break;
        }
        case 'quarantine-fixture': {
          const entry = disk.byId.get(action.id)?.[0];
          if (!entry) break;
          quarantineFile(entry, opts.quarantineDir);
          // Remove any meta row for the quarantined id; no-op (and no
          // error) if there was none.
          opts.db.deleteWikiPage(action.id);
          result.quarantined += 1;
          break;
        }
        // report-* kinds are observational only; no mutation.
        default:
          break;
      }
    } catch (err) {
      result.errors.push({ id: action.id, error: (err as Error).message });
    }
  }

  return result;
}

/* ── Orchestration ───────────────────────────────────────────────── */

export interface RunReconcileOptions {
  db: IndexDb;
  dirs: WikiDirs;
  quarantineDir: string;
  apply: boolean;
}

export interface RunReconcileResult {
  disk: DiskScanResult;
  plan: ReconcilePlan;
  applied?: ApplyResult;
}

export function runReconcile(opts: RunReconcileOptions): RunReconcileResult {
  const disk = scanWikiDisk(opts.dirs);
  const meta = readAllMetaRows(opts.db);
  const plan = planReconcile(disk, meta);
  if (!opts.apply) return { disk, plan };
  const applied = applyReconcile(plan, disk, {
    db: opts.db,
    quarantineDir: opts.quarantineDir,
  });
  return { disk, plan, applied };
}
