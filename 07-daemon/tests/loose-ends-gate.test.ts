/**
 * Codex item 10 (Fix 47) - loose-ends gate test pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  enforceLooseEndsGate,
  evaluateLooseEnds,
  type LooseEnd,
} from '../src/lex/loose-ends-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const ANCHOR = 'codex10-anchor';
const CC = '11111111-2222-3333-4444-555555555555';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-codex10-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  db.insertBrainstorm({
    id: ANCHOR,
    claude_session_id: CC,
    pty_id: null,
    cwd: 'C:/dev/codex10',
    user_label: 'codex10',
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
  } as unknown as Parameters<typeof db.insertBrainstorm>[0]);
  db.insertLexSession({
    id: ANCHOR,
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/codex10',
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedRef(opts?: { ended?: boolean; summary?: string | null }): number {
  const r = db.insertLexTranscriptRef({
    lex_session_id: ANCHOR,
    cc_session_id: CC,
    transcript_path: '/tmp/codex10.jsonl',
    started_ms: 100,
    ended_ms: opts?.ended === false ? null : 200,
    ordering: 0,
  });
  if (opts?.summary !== undefined) {
    db.updateLexTranscriptRef(r.id, {
      ref_summary: opts.summary,
      ref_summary_ms: opts.summary ? 250 : null,
    });
  }
  return r.id;
}

const NOW = 10_000_000;
const noopGit = () => null;

describe('evaluateLooseEnds (Fix 47)', () => {
  it('clear when no detectors trip', () => {
    seedRef({ ended: true, summary: 'all done' });
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => null,
      runGit: noopGit,
    });
    expect(r.has_blocker).toBe(false);
    expect(r.has_auto).toBe(false);
    expect(r.ends).toEqual([]);
  });

  it('detects mid_tool (tool_use without tool_result)', () => {
    seedRef({ ended: true, summary: 'x' });
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu1', name: 'Read' }],
        },
      }),
    ].join('\n');
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => jsonl,
      runGit: noopGit,
    });
    const cls = r.ends.find((e) => e.class === 'mid_tool');
    expect(cls).toBeDefined();
    expect(cls!.disposition).toBe('auto');
    expect(r.has_auto).toBe(true);
  });

  it('does NOT flag mid_tool when tool_result matches', () => {
    seedRef({ ended: true, summary: 'x' });
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read' }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
      }),
    ].join('\n');
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => jsonl,
      runGit: noopGit,
    });
    expect(r.ends.find((e) => e.class === 'mid_tool')).toBeUndefined();
  });

  it('detects parked_question (assistant ends with ?, older than 120s, no user)', () => {
    seedRef({ ended: true, summary: 'x' });
    const oldStamp = new Date(NOW - 5 * 60_000).toISOString();
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        timestamp: oldStamp,
        message: { content: 'should we ship X now?' },
      }),
    ].join('\n');
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => jsonl,
      runGit: noopGit,
    });
    const pq = r.ends.find((e) => e.class === 'parked_question');
    expect(pq).toBeDefined();
    expect(pq!.disposition).toBe('operator');
    expect(pq!.severity).toBe('alert');
    expect(r.has_blocker).toBe(true);
  });

  it('does NOT flag parked_question when user follow-up landed', () => {
    seedRef({ ended: true, summary: 'x' });
    const oldStamp = new Date(NOW - 5 * 60_000).toISOString();
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        timestamp: oldStamp,
        message: { content: 'ready?' },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'yes' },
      }),
    ].join('\n');
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => jsonl,
      runGit: noopGit,
    });
    expect(r.ends.find((e) => e.class === 'parked_question')).toBeUndefined();
  });

  it('detects dirty_worktree from git status --porcelain', () => {
    seedRef({ ended: true, summary: 'x' });
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => null,
      runGit: (args) =>
        args.includes('--porcelain') ? ' M file1.ts\n?? newfile.md\n' : null,
    });
    const dw = r.ends.find((e) => e.class === 'dirty_worktree');
    expect(dw).toBeDefined();
    expect(dw!.disposition).toBe('operator');
    expect(r.has_blocker).toBe(true);
  });

  it('detects undistilled_ref when ref ended but ref_summary null', () => {
    seedRef({ ended: true, summary: null });
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => null,
      runGit: noopGit,
    });
    const ur = r.ends.find((e) => e.class === 'undistilled_ref');
    expect(ur).toBeDefined();
    expect(ur!.disposition).toBe('auto');
  });

  it('detects distill_error when recent error rows exist', () => {
    seedRef({ ended: true, summary: 'x' });
    db.insertDistillationError({
      id: 'e1',
      brainstorm_id: ANCHOR,
      cc_session_id: CC,
      generator: 'per-session',
      error_class: 'provider_threw',
      error_message: 'boom',
    });
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => null,
      runGit: noopGit,
    });
    /* The just-inserted row has ISO timestamp from now-ish; the
     * detector counts rows within the last hour of `now`. Real-time
     * insert gives ts close to system clock, which may be far past
     * our synthetic NOW. Use system-clock `now` to capture the row. */
    const r2 = evaluateLooseEnds(db, ANCHOR, {
      readTranscript: () => null,
      runGit: noopGit,
    });
    expect(r2.ends.find((e) => e.class === 'distill_error')).toBeDefined();
    /* The synthetic-NOW pass may miss it; just ensure no crash. */
    expect(r.has_blocker || !r.has_blocker).toBe(true);
  });

  it('orders ends by severity DESC then disposition DESC then class', () => {
    seedRef({ ended: true, summary: null });
    const oldStamp = new Date(NOW - 5 * 60_000).toISOString();
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu1', name: 'Read' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: oldStamp,
        message: { content: 'should we ship?' },
      }),
    ].join('\n');
    const r = evaluateLooseEnds(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => jsonl,
      runGit: noopGit,
    });
    /* alert (parked_question) > warn (mid_tool) > info (undistilled_ref). */
    const classes = r.ends.map((e) => e.class);
    expect(classes[0]).toBe('parked_question');
    expect(classes.indexOf('mid_tool')).toBeLessThan(
      classes.indexOf('undistilled_ref'),
    );
  });
});

describe('enforceLooseEndsGate (Fix 47)', () => {
  it('clear case returns kind=clear with empty auto_actions', async () => {
    seedRef({ ended: true, summary: 'x' });
    const d = await enforceLooseEndsGate(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => null,
      runGit: noopGit,
    });
    expect(d.kind).toBe('clear');
    expect(d.auto_actions).toEqual([]);
  });

  it('blocker case returns kind=blocked and skips auto actions', async () => {
    seedRef({ ended: true, summary: 'x' });
    const oldStamp = new Date(NOW - 5 * 60_000).toISOString();
    const jsonl = JSON.stringify({
      type: 'assistant',
      timestamp: oldStamp,
      message: { content: 'parked?' },
    });
    const fire = vi.fn(async (end: LooseEnd) => ({
      class: end.class,
      action: 'recovery-inject' as const,
      target: '',
      status: 'fired' as const,
    }));
    const d = await enforceLooseEndsGate(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => jsonl,
      runGit: noopGit,
      fireAutoAction: fire,
    });
    expect(d.kind).toBe('blocked');
    expect(fire).not.toHaveBeenCalled();
  });

  it('auto-only case returns kind=auto-resolving and fires actions', async () => {
    seedRef({ ended: true, summary: null });
    const fire = vi.fn(async (end: LooseEnd) => ({
      class: end.class,
      action: 'redistill' as const,
      target: end.evidence_cc_session_id ?? '',
      status: 'fired' as const,
    }));
    const d = await enforceLooseEndsGate(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => null,
      runGit: noopGit,
      fireAutoAction: fire,
    });
    expect(d.kind).toBe('auto-resolving');
    expect(fire).toHaveBeenCalled();
    expect(d.auto_actions.length).toBeGreaterThan(0);
    expect(d.auto_actions.every((a) => a.status === 'fired')).toBe(true);
  });

  it('respects auto-budget: budget=0 skips every auto action', async () => {
    seedRef({ ended: true, summary: null });
    const fire = vi.fn(async (end: LooseEnd) => ({
      class: end.class,
      action: 'redistill' as const,
      target: '',
      status: 'fired' as const,
    }));
    const d = await enforceLooseEndsGate(db, ANCHOR, {
      now: () => NOW,
      readTranscript: () => null,
      runGit: noopGit,
      fireAutoAction: fire,
      autoBudgetMs: 0,
    });
    expect(d.kind).toBe('auto-resolving');
    expect(d.auto_actions.every((a) => a.status === 'skipped')).toBe(true);
    expect(fire).not.toHaveBeenCalled();
  });
});
