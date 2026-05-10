/**
 * Wave 2 day 4. audit_findings DB helpers + lint integration +
 * runtime_config pause-mode override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let priorRoot: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-d4-'))
    .replace(/\\/g, '/');
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const { IndexDb } = await import('../src/store/index-db.js');
  const bootstrap = new IndexDb(dbFile);
  bootstrap.close();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('audit_findings helpers', () => {
  it('insert + list + status update with terminal resolved_at stamp', async () => {
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    db.insertAuditFinding({
      id: 'f1',
      source: 'lint',
      severity: 'medium',
      page_slug: 'p1',
      finding: 'archive canonical stale',
      detail: 'weight 0.10, 95d stale',
    });
    db.insertAuditFinding({
      id: 'f2',
      source: 'self-audit',
      severity: 'high',
      page_slug: 'p2',
      finding: 'self-audit flagged page',
      detail: 'inaccurate insight',
    });
    /* High severity sorts first. */
    const open = db.listAuditFindings({ status: 'open' });
    expect(open.map((r) => r.id)).toEqual(['f2', 'f1']);
    /* INSERT OR IGNORE makes re-insert with same id a no-op. */
    db.insertAuditFinding({
      id: 'f1',
      source: 'lint',
      severity: 'low',
      finding: 'duplicate attempt',
    });
    expect(db.listAuditFindings({ status: 'open' }).length).toBe(2);
    /* Terminal status stamps resolved_at. */
    const acked = db.updateAuditFindingStatus('f1', 'acknowledged');
    expect(acked?.status).toBe('acknowledged');
    expect(acked?.resolved_at).toBeNull();
    const resolved = db.updateAuditFindingStatus('f1', 'resolved');
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolved_at).not.toBeNull();
    db.close();
  });
});

describe('runtime_config + pause mode override', () => {
  it('runtime override beats env var', async () => {
    const { IndexDb } = await import('../src/store/index-db.js');
    const reinforce = await import('../src/reinforcement/index.js');
    const db = new IndexDb(dbFile);
    /* The store-stub the gate consults. */
    const stubStore = { db } as unknown as import('../src/store/index.js').Store;
    reinforce.setPauseModeStore(stubStore);
    /* Env says off; runtime says on; runtime wins. */
    process.env.DEVNEURAL_PAUSE_MODE = 'off';
    db.setRuntimeConfig('pause_mode', 'on', 'tests');
    expect(reinforce.isPauseModeActive()).toBe(true);
    /* Flip runtime back to off; gate releases. */
    db.setRuntimeConfig('pause_mode', 'off', 'tests');
    expect(reinforce.isPauseModeActive()).toBe(false);
    /* When runtime override is absent, env wins. */
    db['db'].prepare(`DELETE FROM runtime_config WHERE key = 'pause_mode'`).run();
    process.env.DEVNEURAL_PAUSE_MODE = 'on';
    expect(reinforce.isPauseModeActive()).toBe(true);
    delete process.env.DEVNEURAL_PAUSE_MODE;
    reinforce.setPauseModeStore(null);
    db.close();
  });
});

describe('runLint last_verified flags + audit_findings writes', () => {
  it('flags never-verified + stale-verified canonical pages', async () => {
    const { IndexDb } = await import('../src/store/index-db.js');
    const { writePage } = await import('../src/wiki/schema.js');
    const { wikiPagesDir } = await import('../src/paths.js');
    const today = new Date().toISOString().slice(0, 10);
    const stale = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    /* Page A: never verified -> low. */
    writePage(wikiPagesDir(), {
      frontmatter: {
        id: 'page-a',
        title: 'a → x',
        trigger: 't',
        insight: 'i',
        summary: 's',
        status: 'canonical',
        weight: 0.5,
        hits: 0,
        corrections: 0,
        created: today,
        last_touched: today,
        projects: [],
        human_edited: true,
      },
      sections: { pattern: 'p', crossRefs: [], crossRefsRaw: [], evidence: [], openQuestions: [], log: [] },
    });
    /* Page B: verified 120d ago -> medium. */
    writePage(wikiPagesDir(), {
      frontmatter: {
        id: 'page-b',
        title: 'b → x',
        trigger: 't',
        insight: 'i',
        summary: 's',
        status: 'canonical',
        weight: 0.5,
        hits: 0,
        corrections: 0,
        created: today,
        last_touched: today,
        projects: [],
        human_edited: true,
        last_verified: stale,
      },
      sections: { pattern: 'p', crossRefs: [], crossRefsRaw: [], evidence: [], openQuestions: [], log: [] },
    });
    const db = new IndexDb(dbFile);
    const { runLint } = await import('../src/wiki/lint.js');
    const r = await runLint({ db, sampleCanonical: 50 });
    expect(r.actions.find((a) => a.kind === 'flag-never-verified' && a.page_id === 'page-a')).toBeTruthy();
    expect(r.actions.find((a) => a.kind === 'flag-stale-verified' && a.page_id === 'page-b')).toBeTruthy();
    /* audit_findings rows landed for both. Severity: low for never-
     * verified, medium for stale-verified. */
    const findings = db.listAuditFindings({ status: 'open' });
    const a = findings.find((f) => f.page_slug === 'page-a' && f.finding === 'flag never verified');
    const b = findings.find((f) => f.page_slug === 'page-b' && f.finding === 'flag stale verified');
    expect(a?.severity).toBe('low');
    expect(b?.severity).toBe('medium');
    /* Re-running lint with same page state does not duplicate the
     * findings (idempotent via content hash id). */
    await runLint({ db, sampleCanonical: 50 });
    const after = db.listAuditFindings({ status: 'open' });
    expect(after.length).toBe(findings.length);
    db.close();
  });
});

describe('runSelfAudit', () => {
  it('skips when no LLM provider configured', async () => {
    process.env.DEVNEURAL_LLM_PROVIDER = 'none';
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    const stubStore = { db } as unknown as import('../src/store/index.js').Store;
    const { runSelfAudit } = await import('../src/wiki/self-audit.js');
    const r = await runSelfAudit(stubStore, { sample: 5 });
    expect(r.skipped_reason).toBe('no_provider');
    expect(r.findings_written).toBe(0);
    db.close();
    delete process.env.DEVNEURAL_LLM_PROVIDER;
  });
});
