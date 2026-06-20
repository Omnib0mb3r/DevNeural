/**
 * Cold-start investigator reports (relocated to the project folder).
 *
 * Pins: reports write to <projectDir>/investigator-reports/ with dated
 * lexically-sortable filenames; newest = the active seed; project dir
 * resolves from the project_session mapping then the brainstorm cwd;
 * scope isolation per project; archive-when-old moves (never deletes)
 * older reports into archive/.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  resolveProjectDir,
  investigatorReportDir,
  writeColdStartReport,
  listColdStartReports,
  readLatestColdStartReport,
  pruneColdStartReports,
} from '../src/lex/cold-start-report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let projectDir: string;
let db: IndexDb;

function seedBrainstorm(id: string, cwd: string, scopeId?: string): void {
  db.insertBrainstorm({
    id,
    claude_session_id: null,
    pty_id: null,
    cwd,
    user_label: 'CSR',
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: 1,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
    ...(scopeId ? { project_scope_id: scopeId } : {}),
  } as unknown as Parameters<typeof db.insertBrainstorm>[0]);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-csr-'));
  projectDir = path.join(tmpDir, 'MyProject').replace(/\\/g, '/');
  fs.mkdirSync(projectDir, { recursive: true });
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

describe('project dir resolution', () => {
  it('falls back to the brainstorm cwd when there is no mapping', () => {
    seedBrainstorm('a1', projectDir);
    expect(resolveProjectDir(db, 'a1')).toBe(projectDir);
    expect(investigatorReportDir(db, 'a1')).toBe(
      path.posix.join(projectDir, 'investigator-reports'),
    );
  });

  it('prefers the project_session mapping over the brainstorm cwd', () => {
    const psDir = path.join(tmpDir, 'CanonicalProject').replace(/\\/g, '/');
    db.insertProjectSession({
      id: 'ps-1',
      project_slug: 'canonical',
      cwd: psDir,
      title: null,
      status: 'live',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    } as unknown as Parameters<typeof db.insertProjectSession>[0]);
    seedBrainstorm('a2', projectDir, 'ps-1');
    expect(resolveProjectDir(db, 'a2')).toBe(psDir);
  });

  it('returns null for an unknown anchor', () => {
    expect(resolveProjectDir(db, 'nobody')).toBeNull();
    expect(investigatorReportDir(db, 'nobody')).toBeNull();
  });
});

describe('write + read', () => {
  it('writes a dated file under <project>/investigator-reports and reads it back', () => {
    seedBrainstorm('a1', projectDir);
    const out = writeColdStartReport(db, 'a1', '# seed block', 1_700_000_000_000);
    expect(out).not.toBeNull();
    expect(out!.startsWith(path.posix.join(projectDir, 'investigator-reports'))).toBe(
      true,
    );
    /* dated, lexically sortable filename */
    expect(path.basename(out!)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}\.md$/);
    expect(fs.existsSync(out!)).toBe(true);
    const latest = readLatestColdStartReport(db, 'a1');
    expect(latest?.block).toBe('# seed block');
  });

  it('empty block writes nothing', () => {
    seedBrainstorm('a1', projectDir);
    expect(writeColdStartReport(db, 'a1', '   ', 1_700_000_000_000)).toBeNull();
    expect(listColdStartReports(db, 'a1')).toEqual([]);
  });

  it('newest is the active seed', () => {
    seedBrainstorm('a1', projectDir);
    writeColdStartReport(db, 'a1', 'OLD', 1_700_000_000_000);
    writeColdStartReport(db, 'a1', 'NEW', 1_700_000_120_000);
    expect(readLatestColdStartReport(db, 'a1')?.block).toBe('NEW');
    const list = listColdStartReports(db, 'a1');
    expect(list[0]!.ms).toBeGreaterThan(list[1]!.ms);
  });
});

describe('scope isolation per project', () => {
  it('two projects keep separate report folders', () => {
    const projB = path.join(tmpDir, 'OtherProject').replace(/\\/g, '/');
    fs.mkdirSync(projB, { recursive: true });
    seedBrainstorm('a1', projectDir);
    seedBrainstorm('b1', projB);
    writeColdStartReport(db, 'a1', 'A-SEED', 1_700_000_000_000);
    writeColdStartReport(db, 'b1', 'B-SEED', 1_700_000_000_000);
    expect(readLatestColdStartReport(db, 'a1')?.block).toBe('A-SEED');
    expect(readLatestColdStartReport(db, 'b1')?.block).toBe('B-SEED');
    expect(
      fs.existsSync(path.posix.join(projectDir, 'investigator-reports')),
    ).toBe(true);
    expect(fs.existsSync(path.posix.join(projB, 'investigator-reports'))).toBe(
      true,
    );
  });
});

describe('archive-when-old (move, never delete)', () => {
  it('keeps the newest few active and moves the rest into archive/', () => {
    seedBrainstorm('a1', projectDir);
    for (let i = 0; i < 7; i++) {
      writeColdStartReport(db, 'a1', `seed ${i}`, 1_700_000_000_000 + i * 60_000);
    }
    const active = listColdStartReports(db, 'a1');
    expect(active).toHaveLength(5); // KEEP_ACTIVE_DEFAULT
    const archiveDir = path.posix.join(
      projectDir,
      'investigator-reports',
      'archive',
    );
    const archived = fs.readdirSync(archiveDir).filter((n) => n.endsWith('.md'));
    expect(archived).toHaveLength(2); // 7 - 5, nothing deleted
    /* newest five survive active */
    expect(active[0]!.ms).toBe(1_700_000_000_000 + 6 * 60_000);
  });

  it('explicit prune archives older reports too', () => {
    seedBrainstorm('a1', projectDir);
    for (let i = 0; i < 4; i++) {
      writeColdStartReport(db, 'a1', `s${i}`, 1_700_000_000_000 + i * 60_000);
    }
    const moved = pruneColdStartReports(db, 'a1', 2);
    expect(moved).toBe(2);
    expect(listColdStartReports(db, 'a1')).toHaveLength(2);
  });
});
