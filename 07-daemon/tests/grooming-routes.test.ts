/**
 * LEX-AUTONOMY codex 11c (Fix 48 partial closure step 3): grooming
 * routes + push integration pins.
 *
 * Three pins:
 *   1. GET /lex/grooming/recent surfaces grooming-watch notifications
 *      sorted ts DESC with limit honored and unrelated rows filtered
 *      out. Exercised against the exported recentGroomingNotifications
 *      helper so the test does not need to boot fastify.
 *   2. Alert-severity grooming gap forwards push='force' to the
 *      emit hook (and therefore to maybePushNotification).
 *   3. Info-severity grooming gap forwards push='auto' so the legacy
 *      severity gate keeps info-level rows out of the push channel.
 *
 * The notifications.ts module captures DATA_ROOT at load time, so the
 * test resets modules per-test with DEVNEURAL_DATA_ROOT pointed at a
 * fresh tmp dir. Existing per-test daemon fixtures (anchor, refs) are
 * scoped to the same tmpDir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { runGroomingTick } from '../src/lex/grooming-watch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

const ANCHOR = 'codex11c-anchor';
const CC = '22222222-1111-3333-4444-555555555555';
const NOW = 10_000_000_000;

let tmpDir: string;
let db: IndexDb;
let priorDataRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-codex11c-'));
  priorDataRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  /* notifications.ts and routes.ts both capture DATA_ROOT at module
   * load; reset so the per-test tmp dir wins. */
  vi.resetModules();
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
    /* */
  }
  if (priorDataRoot === undefined) {
    delete process.env.DEVNEURAL_DATA_ROOT;
  } else {
    process.env.DEVNEURAL_DATA_ROOT = priorDataRoot;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recentGroomingNotifications helper (GET /lex/grooming/recent)', () => {
  it('returns grooming-watch rows only, sorted ts DESC, limit honored', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    /* Seed five rows with controlled timestamps so the DESC sort is
     * deterministic. emitNotification stamps `new Date().toISOString()`,
     * so use vi.useFakeTimers + setSystemTime to step each insert
     * one second forward. Real Date.parse round-trips milliseconds
     * precisely. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    mod.emitNotification({
      severity: 'info',
      source: 'grooming-watch',
      notify_class: 'signal',
      title: 'Grooming: idle_no_distill (older)',
      push: 'auto',
    });
    vi.setSystemTime(new Date('2026-05-29T12:00:01.000Z'));
    mod.emitNotification({
      severity: 'warn',
      source: 'curator',
      notify_class: 'signal',
      title: 'Wiki match (noise)',
    });
    vi.setSystemTime(new Date('2026-05-29T12:00:02.000Z'));
    mod.emitNotification({
      severity: 'alert',
      source: 'grooming-watch',
      notify_class: 'signal',
      title: 'Grooming: parked_question_persistent (newer)',
      push: 'force',
    });
    vi.setSystemTime(new Date('2026-05-29T12:00:03.000Z'));
    mod.emitNotification({
      severity: 'info',
      source: 'lex',
      notify_class: 'conversation',
      title: 'Lex spoke (noise)',
    });
    vi.setSystemTime(new Date('2026-05-29T12:00:04.000Z'));
    mod.emitNotification({
      severity: 'warn',
      source: 'grooming-watch',
      notify_class: 'signal',
      title: 'Grooming: distill_failure_persistent (newest)',
      push: 'auto',
    });
    vi.useRealTimers();
    const routesMod = await import('../src/dashboard/routes.js');
    const recent = routesMod.recentGroomingNotifications();
    expect(recent.length).toBe(3);
    expect(recent.every((n) => n.source === 'grooming-watch')).toBe(true);
    /* Sorted by ts DESC (newest first). */
    expect(recent[0]!.title).toMatch(/distill_failure_persistent/);
    expect(recent[1]!.title).toMatch(/parked_question_persistent/);
    expect(recent[2]!.title).toMatch(/idle_no_distill/);
    /* Limit honored. */
    const capped = routesMod.recentGroomingNotifications(2);
    expect(capped.length).toBe(2);
    expect(capped[0]!.title).toMatch(/distill_failure_persistent/);
  });
});

describe('grooming push integration (severity gating)', () => {
  function seedAnchor(): void {
    db.insertBrainstorm({
      id: ANCHOR,
      claude_session_id: CC,
      pty_id: null,
      cwd: 'C:/dev/codex11c',
      user_label: 'codex11c',
      derived_label: null,
      mode: 'conversation',
      status: 'active',
      started_ms: NOW - 30 * 24 * 3_600_000,
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
      cwd: 'C:/dev/codex11c',
    });
  }

  it('alert-severity gap (parked_question_persistent) emits with push=force', () => {
    seedAnchor();
    db.insertLexTranscriptRef({
      lex_session_id: ANCHOR,
      cc_session_id: CC,
      transcript_path: '/tmp/codex11c-alert.jsonl',
      started_ms: NOW - 60 * 60_000,
      ended_ms: null,
      ordering: 1,
    });
    const jsonl = JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW - 45 * 60_000).toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Should I keep going with the rebuild?' },
        ],
      },
    });
    const emit = vi.fn();
    runGroomingTick({
      db,
      now: () => NOW,
      emit,
      readTranscript: (p) =>
        p === '/tmp/codex11c-alert.jsonl' ? jsonl : null,
    });
    const alertCall = emit.mock.calls.find((c) => {
      const input = c[0] as { severity?: string; title?: string };
      return (
        input.severity === 'alert' &&
        String(input.title ?? '').includes('parked_question_persistent')
      );
    });
    expect(alertCall).toBeDefined();
    expect((alertCall![0] as { push?: string }).push).toBe('force');
  });

  it('info-severity gap (idle_no_distill) emits with push=auto', () => {
    /* Same anchor seed but no parked-question fixture; the anchor's
     * 30-day-old started_ms trips the idle_no_distill detector
     * (info severity). The detector should fire emit with push=auto
     * so the legacy severity gate keeps info rows out of the push
     * channel. */
    seedAnchor();
    const emit = vi.fn();
    runGroomingTick({
      db,
      now: () => NOW,
      emit,
      readTranscript: () => null,
    });
    const idleCall = emit.mock.calls.find((c) => {
      const input = c[0] as { severity?: string; title?: string };
      return (
        input.severity === 'info' &&
        String(input.title ?? '').includes('idle_no_distill')
      );
    });
    expect(idleCall).toBeDefined();
    expect((idleCall![0] as { push?: string }).push).toBe('auto');
  });
});
