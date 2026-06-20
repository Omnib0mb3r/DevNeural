import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  assembleInvestigatorContext,
  runInvestigator,
  buildInvestigatorPrompt,
  cacheInvestigatorBlock,
  takeInvestigatorBlock,
  prewarmInvestigator,
  gateColdStart,
  _resetInvestigatorCache,
} from '../src/lex/lex-investigator.js';
import {
  readLatestColdStartReport,
  investigatorReportDir,
} from '../src/lex/cold-start-report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
/* Real writable project dir so cold-start report writes land in tmp, not
 * a literal path on the host. resolveProjectDir reads the brainstorm row
 * cwd, so this is the report location. */
let projectCwd: string;

function insertBs(opts: {
  id: string;
  user_label: string | null;
  started_ms: number;
  last_summary?: string | null;
}): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: projectCwd,
    user_label: opts.user_label,
    derived_label: null,
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

function insertLexSession(id: string): void {
  db.insertLexSession({
    id,
    created_ms: 1_000,
    title: null,
    derived_title: null,
    status: 'dormant',
    current_pty_id: null,
    cwd: 'C:/p/lex',
  });
}

function insertRef(opts: {
  anchorId: string;
  cc: string;
  transcriptPath: string;
  ordering: number;
  startedMs: number;
}): void {
  db.insertLexTranscriptRef({
    lex_session_id: opts.anchorId,
    cc_session_id: opts.cc,
    transcript_path: opts.transcriptPath,
    started_ms: opts.startedMs,
    ended_ms: null,
    ordering: opts.ordering,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-investigator-'));
  projectCwd = path.join(tmpDir, 'project').replace(/\\/g, '/');
  fs.mkdirSync(projectCwd, { recursive: true });
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
  _resetInvestigatorCache();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('assembleInvestigatorContext - fail closed', () => {
  it('returns empty + hasContent false when the anchor has no brainstorm row', () => {
    const out = assembleInvestigatorContext({
      db,
      anchorId: 'ghost-anchor',
      cwd: 'C:/p/lex',
      readFile: () => null,
      listDir: () => [],
    });
    expect(out.block).toBe('');
    expect(out.hasContent).toBe(false);
  });

  it('returns empty when the anchor exists but has no siblings, no live tail, no docs', () => {
    insertBs({ id: 'a-empty', user_label: 'Empty Anchor', started_ms: 1_000 });
    const out = assembleInvestigatorContext({
      db,
      anchorId: 'a-empty',
      cwd: 'C:/p/lex',
      readFile: () => null,
      listDir: () => [],
    });
    expect(out.hasContent).toBe(false);
    expect(out.block).toBe('');
  });
});

describe('assembleInvestigatorContext - content', () => {
  it('includes the live transcript tail and project docs, scope-isolated header', () => {
    insertLexSession('a-live');
    insertBs({
      id: 'a-live',
      user_label: 'DevNeural',
      started_ms: 1_000,
      last_summary: 'prior decision / prior open item',
    });
    insertRef({
      anchorId: 'a-live',
      cc: 'cc-1',
      transcriptPath: '/fake/live.jsonl',
      ordering: 0,
      startedMs: Date.now() - 60_000,
    });
    const out = assembleInvestigatorContext({
      db,
      anchorId: 'a-live',
      cwd: 'C:/p/lex',
      readFile: (p) => {
        if (p === '/fake/live.jsonl') {
          return JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'the live thing we just said' },
          });
        }
        if (p.endsWith('PROJECT.md')) return '# DevNeural\nThe project overview.';
        return null;
      },
      listDir: () => ['PROJECT.md', 'README.md'],
    });
    expect(out.hasContent).toBe(true);
    expect(out.block).toMatch(/scope-isolated|Scope-isolated/i);
    expect(out.block).toContain('the live thing we just said');
    expect(out.block).toContain('The project overview.');
  });

  it('reads project docs in priority order and never reads README', () => {
    insertBs({ id: 'a-docs', user_label: 'Docs', started_ms: 1_000 });
    const seen: string[] = [];
    const out = assembleInvestigatorContext({
      db,
      anchorId: 'a-docs',
      cwd: 'C:/p/lex',
      readFile: (p) => {
        seen.push(p);
        if (p.endsWith('PROJECT.md')) return 'project body';
        return null;
      },
      listDir: () => ['README.md', 'PROJECT.md', 'random.txt'],
    });
    expect(out.block).toContain('project body');
    expect(seen.some((p) => p.endsWith('README.md'))).toBe(false);
  });

  it('emits the NEWEST handover first within the HANDOVER family (mtime tie-break)', () => {
    insertBs({ id: 'a-handover', user_label: 'HO', started_ms: 1_000 });
    /* listDir returns the dated handovers alphabetical = oldest first;
     * the mtime sort must flip them so the current handover leads. */
    const out = assembleInvestigatorContext({
      db,
      anchorId: 'a-handover',
      cwd: 'C:/p/lex',
      listDir: () => [
        'HANDOVER-2026-05-22-voice-and-index.md',
        'HANDOVER-2026-06-19.md',
      ],
      readFile: (p) => {
        if (p.endsWith('HANDOVER-2026-05-22-voice-and-index.md')) {
          return 'OLD-MAY-HANDOVER-BODY';
        }
        if (p.endsWith('HANDOVER-2026-06-19.md')) {
          return 'NEW-JUNE-HANDOVER-BODY';
        }
        return null;
      },
      statMtimeMs: (p) =>
        p.endsWith('HANDOVER-2026-06-19.md')
          ? 1_718_800_000_000 // newer
          : 1_716_300_000_000, // older (May)
    });
    const newIdx = out.block.indexOf('NEW-JUNE-HANDOVER-BODY');
    const oldIdx = out.block.indexOf('OLD-MAY-HANDOVER-BODY');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    /* Freshest leads; older history follows. */
    expect(newIdx).toBeLessThan(oldIdx);
  });
});

describe('runInvestigator - fail safe', () => {
  const assembled = {
    block: '# ctx\nreal assembled content',
    hasContent: true,
    anchorId: 'a',
  };

  it('returns the assembled block when no headless spawn is provided', async () => {
    const out = await runInvestigator({ assembled, cwd: 'C:/p/lex' });
    expect(out).toBe(assembled.block);
  });

  it('prepends the Opus briefing when the headless pass succeeds', async () => {
    const out = await runInvestigator({
      assembled,
      cwd: 'C:/p/lex',
      spawnHeadless: async () => 'tight opus briefing',
    });
    expect(out).toContain('tight opus briefing');
    expect(out).toContain('real assembled content');
    expect(out).toMatch(/Opus investigator/);
  });

  it('falls back to the assembled block when the headless pass throws', async () => {
    const out = await runInvestigator({
      assembled,
      cwd: 'C:/p/lex',
      spawnHeadless: async () => {
        throw new Error('claude binary not found');
      },
    });
    expect(out).toBe(assembled.block);
  });

  it('falls back when the headless pass returns null or empty', async () => {
    const outNull = await runInvestigator({
      assembled,
      cwd: 'C:/p/lex',
      spawnHeadless: async () => null,
    });
    expect(outNull).toBe(assembled.block);
    const outEmpty = await runInvestigator({
      assembled,
      cwd: 'C:/p/lex',
      spawnHeadless: async () => '   ',
    });
    expect(outEmpty).toBe(assembled.block);
  });

  it('does not invoke the headless pass for empty assembled context', async () => {
    let called = false;
    const out = await runInvestigator({
      assembled: { block: '', hasContent: false, anchorId: 'a' },
      cwd: 'C:/p/lex',
      spawnHeadless: async () => {
        called = true;
        return 'should not run';
      },
    });
    expect(called).toBe(false);
    expect(out).toBe('');
  });
});

describe('buildInvestigatorPrompt', () => {
  it('embeds the context and forbids cross-project references', () => {
    const p = buildInvestigatorPrompt('SOME CONTEXT');
    expect(p).toContain('SOME CONTEXT');
    expect(p).toMatch(/not reference any other project/i);
  });
});

describe('prewarmInvestigator', () => {
  function liveAnchor(id: string): void {
    insertLexSession(id);
    insertBs({ id, user_label: 'PrewarmProj', started_ms: 1_000 });
    insertRef({
      anchorId: id,
      cc: 'cc-pw',
      transcriptPath: '/fake/pw.jsonl',
      ordering: 0,
      startedMs: Date.now() - 30_000,
    });
  }
  const readFile = (p: string): string | null => {
    if (p === '/fake/pw.jsonl') {
      return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'prewarm live turn' },
      });
    }
    if (p.endsWith('PROJECT.md')) return 'prewarm project body';
    return null;
  };
  const listDir = (): string[] => ['PROJECT.md'];

  it('caches the refined block when headless succeeds; cold-start can take it', async () => {
    liveAnchor('pw-1');
    const res = await prewarmInvestigator({
      db,
      anchorId: 'pw-1',
      cwd: 'C:/p/lex',
      spawnHeadless: async () => 'refined briefing',
      now: () => 5_000,
      readFile,
      listDir,
    });
    expect(res.hasContent).toBe(true);
    expect(res.refined).toBe(true);
    const served = takeInvestigatorBlock('pw-1', 600_000, 6_000);
    expect(served).toContain('refined briefing');
    expect(served).toContain('prewarm live turn');
  });

  it('caches the deterministic block when headless is disabled', async () => {
    liveAnchor('pw-2');
    const res = await prewarmInvestigator({
      db,
      anchorId: 'pw-2',
      cwd: 'C:/p/lex',
      enableHeadless: false,
      now: () => 5_000,
      readFile,
      listDir,
    });
    expect(res.hasContent).toBe(true);
    expect(res.refined).toBe(false);
    const served = takeInvestigatorBlock('pw-2', 600_000, 6_000);
    expect(served).toContain('prewarm project body');
  });

  it('caches nothing for a confidently-empty anchor (no regression on cold-cold start)', async () => {
    insertBs({ id: 'pw-empty', user_label: 'Empty', started_ms: 1_000 });
    const res = await prewarmInvestigator({
      db,
      anchorId: 'pw-empty',
      cwd: 'C:/p/lex',
      spawnHeadless: async () => 'should not be cached',
      now: () => 5_000,
      readFile: () => null,
      listDir: () => [],
    });
    expect(res.hasContent).toBe(false);
    expect(takeInvestigatorBlock('pw-empty', 600_000, 6_000)).toBeNull();
  });

  it('still caches the assembled block when the headless pass throws (fail-safe)', async () => {
    liveAnchor('pw-3');
    const res = await prewarmInvestigator({
      db,
      anchorId: 'pw-3',
      cwd: 'C:/p/lex',
      spawnHeadless: async () => {
        throw new Error('boom');
      },
      now: () => 5_000,
      readFile,
      listDir,
    });
    expect(res.hasContent).toBe(true);
    expect(res.refined).toBe(false);
    expect(takeInvestigatorBlock('pw-3', 600_000, 6_000)).toContain(
      'prewarm live turn',
    );
  });

  it('sliver 3: persists the block as a cold-start report on disk', async () => {
    liveAnchor('pw-disk');
    await prewarmInvestigator({
      db,
      anchorId: 'pw-disk',
      cwd: 'C:/p/lex',
      spawnHeadless: async () => 'refined briefing',
      now: () => 1_700_000_000_000,
      readFile,
      listDir,
    });
    const report = readLatestColdStartReport(db, 'pw-disk');
    expect(report).not.toBeNull();
    expect(report!.ms).toBe(1_700_000_000_000);
    /* Same object as the served seed: refined briefing + live tail. */
    expect(report!.block).toContain('refined briefing');
    expect(report!.block).toContain('prewarm live turn');
  });

  it('sliver 3: a confidently-empty anchor persists no report', async () => {
    insertBs({ id: 'pw-disk-empty', user_label: 'Empty', started_ms: 1_000 });
    await prewarmInvestigator({
      db,
      anchorId: 'pw-disk-empty',
      cwd: 'C:/p/lex',
      spawnHeadless: async () => 'should not persist',
      now: () => 1_700_000_000_000,
      readFile: () => null,
      listDir: () => [],
    });
    expect(readLatestColdStartReport(db, 'pw-disk-empty')).toBeNull();
  });
});

describe('investigator cache', () => {
  it('serves a fresh block once then deletes it', () => {
    cacheInvestigatorBlock('anchor-c', 'cached block', 1_000);
    expect(takeInvestigatorBlock('anchor-c', 60_000, 1_500)).toBe('cached block');
    /* one-shot: second take is a miss */
    expect(takeInvestigatorBlock('anchor-c', 60_000, 1_600)).toBeNull();
  });

  it('returns null for a stale block', () => {
    cacheInvestigatorBlock('anchor-stale', 'old block', 1_000);
    expect(takeInvestigatorBlock('anchor-stale', 10_000, 50_000)).toBeNull();
  });

  it('returns null on a cache miss', () => {
    expect(takeInvestigatorBlock('nope', 60_000, 1_000)).toBeNull();
  });

  it('ignores empty blocks', () => {
    cacheInvestigatorBlock('anchor-empty', '   ', 1_000);
    expect(takeInvestigatorBlock('anchor-empty', 60_000, 1_100)).toBeNull();
  });
});

describe('gateColdStart (boot gate, on-disk)', () => {
  const readFile = (p: string): string | null => {
    if (p === '/fake/gate.jsonl') {
      return JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'gate live turn' },
      });
    }
    if (p.endsWith('PROJECT.md')) return 'gate project body';
    return null;
  };
  const listDir = (): string[] => ['PROJECT.md'];

  function liveAnchor(id: string): void {
    insertLexSession(id);
    insertBs({ id, user_label: 'GateProj', started_ms: 1_000 });
    insertRef({
      anchorId: id,
      cc: 'cc-gate',
      transcriptPath: '/fake/gate.jsonl',
      ordering: 0,
      startedMs: Date.now() - 30_000,
    });
  }

  it('writes a real cold-start report file on disk for an anchor with content', () => {
    liveAnchor('gate-1');
    const res = gateColdStart({
      db,
      anchorId: 'gate-1',
      cwd: 'C:/p/lex',
      now: () => 1_700_000_000_000,
      readFile,
      listDir,
    });
    expect(res.seeded).toBe(true);
    expect(res.reportPath).not.toBeNull();
    /* The acceptance: a real file exists on disk under the anchor's
     * cold-start folder. */
    expect(fs.existsSync(res.reportPath!)).toBe(true);
    expect(fs.existsSync(investigatorReportDir(db, 'gate-1')!)).toBe(true);
    /* And it is the seed the route will serve. */
    const latest = readLatestColdStartReport(db, 'gate-1');
    expect(latest?.block).toContain('gate project body');
    expect(latest?.block).toContain('gate live turn');
  });

  it('seeds nothing (no file) for a confidently-empty anchor', () => {
    insertBs({ id: 'gate-empty', user_label: 'Empty', started_ms: 1_000 });
    const res = gateColdStart({
      db,
      anchorId: 'gate-empty',
      cwd: 'C:/p/lex',
      now: () => 1_700_000_000_000,
      readFile: () => null,
      listDir: () => [],
    });
    expect(res.seeded).toBe(false);
    expect(res.reportPath).toBeNull();
    expect(readLatestColdStartReport(db, 'gate-empty')).toBeNull();
  });

  it('treats a prior report as a PRIOR and writes a newer one (newest-wins)', () => {
    liveAnchor('gate-prior');
    /* First gate writes report A. */
    const a = gateColdStart({
      db,
      anchorId: 'gate-prior',
      cwd: 'C:/p/lex',
      now: () => 1_700_000_000_000,
      readFile,
      listDir,
    });
    expect(a.hadPriorReport).toBe(false);
    /* Second gate sees the prior and writes a newer report. */
    const b = gateColdStart({
      db,
      anchorId: 'gate-prior',
      cwd: 'C:/p/lex',
      now: () => 1_700_000_060_000,
      readFile,
      listDir,
    });
    expect(b.hadPriorReport).toBe(true);
    expect(readLatestColdStartReport(db, 'gate-prior')?.ms).toBe(
      1_700_000_060_000,
    );
  });
});
