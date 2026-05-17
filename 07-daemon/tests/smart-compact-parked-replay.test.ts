/**
 * Fix 15 C3 — smart-compact resume replays parked injects.
 *
 * Verifies that when /lex/inject-cross-session previously rejected
 * with decision='dispatched_dead_session' (anchor was dormant), the
 * smart-compact resume hook scans the audit log on the new session's
 * readiness, replays the parked inject text through opts.injector,
 * and amends the audit row so the next resume does not double-fire.
 *
 * The event-driven branch in fireSmartCompact is exercised via a
 * stubbed awaitSessionReady that resolves ready=true synchronously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { fireSmartCompact } from '../src/dashboard/smart-compact-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let priors: {
  DEVNEURAL_DATA_ROOT?: string;
  DEVNEURAL_SMART_COMPACT_SHADOW_N?: string;
  DEVNEURAL_SMART_COMPACT_ENABLED?: string;
};

const ANCHOR_ID = 'anchor-parked';
const OLD_UUID = '00000000-0000-0000-0000-000000000aaa';
const NEW_UUID = '00000000-0000-0000-0000-000000000bbb';
const PTY = `pty-${ANCHOR_ID}`;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-fix15-c3-'));
  const dbFile = path.join(tmpDir, 'index.db');
  priors = {
    DEVNEURAL_DATA_ROOT: process.env.DEVNEURAL_DATA_ROOT,
    DEVNEURAL_SMART_COMPACT_SHADOW_N:
      process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N,
    DEVNEURAL_SMART_COMPACT_ENABLED:
      process.env.DEVNEURAL_SMART_COMPACT_ENABLED,
  };
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = '0';
  process.env.DEVNEURAL_SMART_COMPACT_ENABLED = 'true';

  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } })
    .db.prepare('DELETE FROM project_session')
    .run();
});

afterEach(() => {
  db.close();
  for (const [k, v] of Object.entries(priors)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedLiveAnchor(): void {
  db.insertProjectSession({
    id: ANCHOR_ID,
    project_slug: ANCHOR_ID,
    cwd: `C:/p/${ANCHOR_ID}`,
    title: ANCHOR_ID,
    status: 'live',
    current_session_id: NEW_UUID,
    current_bridge_id: 'b',
    current_pty_id: PTY,
    created_ms: 1,
    last_seen_ms: 1,
  });
}

function parkInject(text: string, idSuffix = '1'): string {
  const id = `parked-${idSuffix}`;
  db.insertCrossSessionLog({
    id,
    target_session: OLD_UUID,
    caller_label: 'test',
    text_preview: text.slice(0, 120),
    text_length: text.length,
    decision: 'dispatched_dead_session',
    reject_reason: JSON.stringify({
      anchor_id: ANCHOR_ID,
      reason: 'bound-anchor-dormant',
    }),
    payload_text: text,
  });
  return id;
}

describe('Fix 15 C3 — smart-compact parked-inject replay', () => {
  it('finds parked injects for an anchor via findParkedInjectsForAnchor', () => {
    parkInject('please continue with phase 4');
    const found = db.findParkedInjectsForAnchor(ANCHOR_ID);
    expect(found.length).toBe(1);
    expect(found[0]!.payload_text).toBe('please continue with phase 4');
  });

  it('ignores parked injects for other anchors', () => {
    parkInject('for other anchor', '1');
    db.insertCrossSessionLog({
      id: 'parked-other',
      target_session: OLD_UUID,
      text_preview: 'x',
      text_length: 1,
      decision: 'dispatched_dead_session',
      reject_reason: JSON.stringify({
        anchor_id: 'different-anchor',
        reason: 'bound-anchor-dormant',
      }),
      payload_text: 'x',
    });
    const found = db.findParkedInjectsForAnchor(ANCHOR_ID);
    expect(found.length).toBe(1);
  });

  it('caps replay at the provided limit', () => {
    for (let i = 0; i < 5; i += 1) {
      parkInject(`payload ${i}`, String(i));
    }
    const found = db.findParkedInjectsForAnchor(ANCHOR_ID, { limit: 3 });
    expect(found.length).toBe(3);
  });

  it('skips parked injects whose payload_text is null', () => {
    db.insertCrossSessionLog({
      id: 'parked-null',
      target_session: OLD_UUID,
      text_preview: 'x',
      text_length: 1,
      decision: 'dispatched_dead_session',
      reject_reason: JSON.stringify({ anchor_id: ANCHOR_ID }),
      payload_text: null,
    });
    const found = db.findParkedInjectsForAnchor(ANCHOR_ID);
    expect(found.length).toBe(0);
  });

  it('marks a replayed inject as accepted with replayedTo annotation', () => {
    const id = parkInject('to be replayed');
    db.markParkedInjectReplayed(id, NEW_UUID);
    const found = db.findParkedInjectsForAnchor(ANCHOR_ID);
    expect(found.length).toBe(0);
  });

  it('fireSmartCompact replays parked injects before the resume summary fires', async () => {
    seedLiveAnchor();
    parkInject('PARKED-PROMPT-A', 'a');
    parkInject('PARKED-PROMPT-B', 'b');

    const injectedCalls: Array<{ target: string; text: string }> = [];
    const injector = vi.fn((target: string, text: string) => {
      injectedCalls.push({ target, text });
      return { ok: true as const };
    });

    let resumeResolve: (() => void) | null = null;
    const resumeAwaitable = new Promise<void>((resolve) => {
      resumeResolve = resolve;
    });

    const result = fireSmartCompact(db, ANCHOR_ID, {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 70,
      summary: 'RESUME-SUMMARY',
      injector,
      awaitSessionReady: async () => ({
        ready: true,
        reason: 'ready',
        elapsed_ms: 5,
        new_jsonl: `C:/cc/projects/x/${NEW_UUID}.jsonl`,
      }),
      onResumeComplete: () => {
        resumeResolve?.();
      },
      fallbackWaitMs: 5,
    });

    expect(result.action).toBe('fire');
    /* inject 0 is the /clear; the parked injects + summary fire
     * inside the async resume sequence — wait for the
     * onResumeComplete callback before asserting. */
    await resumeAwaitable;

    const texts = injectedCalls.map((c) => c.text);
    expect(texts[0]).toBe('/clear');
    expect(texts).toContain('PARKED-PROMPT-A');
    expect(texts).toContain('PARKED-PROMPT-B');
    const summaryIdx = texts.indexOf('RESUME-SUMMARY');
    const parkedAIdx = texts.indexOf('PARKED-PROMPT-A');
    const parkedBIdx = texts.indexOf('PARKED-PROMPT-B');
    expect(parkedAIdx).toBeLessThan(summaryIdx);
    expect(parkedBIdx).toBeLessThan(summaryIdx);

    /* After replay the audit rows have been marked accepted, so a
     * second lookup returns nothing — no double-fire on the next
     * resume window. */
    expect(db.findParkedInjectsForAnchor(ANCHOR_ID).length).toBe(0);
  });
});
