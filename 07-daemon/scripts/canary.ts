/**
 * Synthetic curator canary (CI-7).
 *
 * Fires a small set of known prompts that SHOULD match a known wiki
 * page, then asserts the curator either injected the expected page
 * or returned a non-silence result. Failures append a row to
 * audit_findings (source='canary') and write a one-line summary to
 * stderr so the scheduler logs it.
 *
 * Usage:
 *   npm run canary
 *   # or directly:
 *   npx tsx 07-daemon/scripts/canary.ts
 *
 * Exit codes:
 *   0 - all canaries green
 *   1 - one or more canary failed (silence or wrong page)
 *
 * Fixture file: docs/spec/canary-fixtures.json. The fixture is
 * project-aware so the runner registers a synthetic project_slug
 * in case the real registry is empty. Each fixture is:
 *   { prompt: string, expected_page_slug: string | null,
 *     expected_source_class?: 'wiki' | 'draft' | 'raw' | null }
 *
 * Add fixtures over time as the wiki accumulates well-known
 * trigger / insight pairs. Five seed fixtures live in the JSON to
 * start.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store/index.js';
import { curate } from '../src/curation/curator.js';
import { runMigrations } from '../src/db/migrate.js';
import Database from 'better-sqlite3';
import { DATA_ROOT } from '../src/paths.js';

interface CanaryFixture {
  id: string;
  prompt: string;
  expected_page_slug: string | null;
  expected_source_class?: 'wiki' | 'draft' | 'raw' | null;
}

interface CanaryResult {
  fixture_id: string;
  ok: boolean;
  decision: 'inject' | 'silence';
  page_slug: string | null;
  expected_page_slug: string | null;
  reason: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const FIXTURE_FILE = path.posix.join(
  HERE,
  '..',
  '..',
  'docs',
  'spec',
  'canary-fixtures.json',
);

function loadFixtures(): CanaryFixture[] {
  if (!fs.existsSync(FIXTURE_FILE)) {
    process.stderr.write(
      `[canary] no fixture file at ${FIXTURE_FILE}; skipping\n`,
    );
    return [];
  }
  const raw = fs.readFileSync(FIXTURE_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('canary-fixtures.json must be an array');
  }
  return parsed as CanaryFixture[];
}

async function runOne(
  store: Store,
  fixture: CanaryFixture,
): Promise<CanaryResult> {
  const out = await curate(
    store,
    {
      prompt: fixture.prompt,
      sessionId: `canary-${fixture.id}`,
      projectId: 'canary-synthetic',
    },
    () => undefined,
  );
  const decision = out.injection.length > 0 ? 'inject' : 'silence';
  const page_slug = out.page_slug ?? null;
  if (fixture.expected_page_slug === null) {
    // expecting silence
    if (decision === 'silence') {
      return {
        fixture_id: fixture.id,
        ok: true,
        decision,
        page_slug,
        expected_page_slug: null,
        reason: 'expected silence, got silence',
      };
    }
    return {
      fixture_id: fixture.id,
      ok: false,
      decision,
      page_slug,
      expected_page_slug: null,
      reason: `expected silence but injected ${page_slug ?? 'raw'}`,
    };
  }
  if (decision === 'silence') {
    return {
      fixture_id: fixture.id,
      ok: false,
      decision,
      page_slug,
      expected_page_slug: fixture.expected_page_slug,
      reason: `expected ${fixture.expected_page_slug} but curator silenced`,
    };
  }
  if (page_slug !== fixture.expected_page_slug) {
    return {
      fixture_id: fixture.id,
      ok: false,
      decision,
      page_slug,
      expected_page_slug: fixture.expected_page_slug,
      reason: `expected ${fixture.expected_page_slug} but injected ${page_slug ?? 'raw'}`,
    };
  }
  return {
    fixture_id: fixture.id,
    ok: true,
    decision,
    page_slug,
    expected_page_slug: fixture.expected_page_slug,
    reason: 'match',
  };
}

function recordFinding(
  dbFile: string,
  result: CanaryResult,
): void {
  const db = new Database(dbFile);
  try {
    db.prepare(
      `INSERT INTO audit_findings
         (id, source, severity, page_slug, finding, detail)
       VALUES (?, 'canary', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      result.ok ? 'low' : 'high',
      result.expected_page_slug,
      `canary ${result.ok ? 'green' : 'red'}: ${result.fixture_id}`,
      JSON.stringify(result),
    );
  } catch (err) {
    /* audit_findings ships in Wave 2 (migration 010); on a Wave 1
     * install the table is missing and we silently skip the row.
     * The canary still exits with the right code so the scheduler
     * sees the failure. */
    process.stderr.write(
      `[canary] audit_findings write skipped: ${(err as Error).message}\n`,
    );
  } finally {
    db.close();
  }
}

async function main(): Promise<number> {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    process.stderr.write('[canary] no fixtures; PASS by vacuous truth\n');
    return 0;
  }
  const store = await Store.open(() => undefined);
  await runMigrations({
    dbPath: path.posix.join(DATA_ROOT, 'index.db'),
    migrationsDir: path.posix.join(HERE, 'migrations'),
  });
  const dbFile = path.posix.join(DATA_ROOT, 'index.db');
  let failed = 0;
  for (const fixture of fixtures) {
    const result = await runOne(store, fixture);
    recordFinding(dbFile, result);
    process.stderr.write(
      `[canary] ${result.fixture_id}: ${result.ok ? 'GREEN' : 'RED'}: ${result.reason}\n`,
    );
    if (!result.ok) failed += 1;
  }
  process.stderr.write(
    `[canary] summary: ${fixtures.length - failed}/${fixtures.length} green\n`,
  );
  return failed > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[canary] FATAL: ${(err as Error).stack ?? err}\n`);
      process.exit(2);
    });
}
