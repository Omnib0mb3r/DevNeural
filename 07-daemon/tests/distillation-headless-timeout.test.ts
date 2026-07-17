import { describe, expect, it } from 'vitest';
import {
  createHeadlessDistillationGenerator,
  createHeadlessPerSessionDistillationGenerator,
  HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT,
} from '../src/lex/distillation-generator.js';
import type { BrainstormSessionRow, IndexDb } from '../src/store/index-db.js';

/**
 * Headless distill timeout fix (2026-07-17). Every headless distillation
 * since 11:28Z failed with "[distill-headless] empty reply" - dozens of
 * attempts, zero successes, for 12+ hours. Live probe: a trivial
 * `claude -p` pass takes 26s on this box; a realistic 8KB distillation
 * prompt took 57s. The old 60s default timeout killed essentially every
 * real pass, and spawnHeadlessOpus collapsed timeout / non-zero exit /
 * empty stdout into one null, so the log line blamed an "empty reply"
 * that never happened. These tests pin the new default (180s,
 * env-overridable) actually reaching the spawn seam.
 */

const chunk = (i: number, role: string, text: string) => ({
  id: `c${i}`,
  brainstorm_id: 'b1',
  cc_session_id: 'cc1',
  turn_index: i,
  role,
  text,
  timestamp_ms: 1_000 + i,
});

function fakeDb(): IndexDb {
  return {
    listBrainstormChunks: () => [chunk(0, 'user', 'hello'), chunk(1, 'lex', 'hi')],
    listBrainstormChunksForSession: () => [
      chunk(0, 'user', 'hello'),
      chunk(1, 'lex', 'hi'),
    ],
    insertDistillationError: () => undefined,
  } as unknown as IndexDb;
}

const row = { id: 'b1' } as BrainstormSessionRow;

describe('headless distillation timeout default', () => {
  it('is 180s, not the 60s that killed every real pass', () => {
    expect(HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT).toBe(180_000);
  });

  it('anchor-flat generator hands the default to the spawn seam', async () => {
    let seen: number | null = null;
    const gen = createHeadlessDistillationGenerator({
      db: fakeDb(),
      spawnHeadless: (_p, _cwd, timeoutMs) => {
        seen = timeoutMs;
        return Promise.resolve('summary text');
      },
    });
    await gen(row);
    expect(seen).toBe(HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT);
  });

  it('per-session generator hands the default to the spawn seam', async () => {
    let seen: number | null = null;
    const gen = createHeadlessPerSessionDistillationGenerator({
      db: fakeDb(),
      spawnHeadless: (_p, _cwd, timeoutMs) => {
        seen = timeoutMs;
        return Promise.resolve('summary text');
      },
    });
    await gen({
      brainstorm_id: 'b1',
      cc_session_id: 'cc1',
      totalChunksInSession: 2,
    });
    expect(seen).toBe(HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT);
  });

  it('an explicit timeoutMs option still wins', async () => {
    let seen: number | null = null;
    const gen = createHeadlessDistillationGenerator({
      db: fakeDb(),
      timeoutMs: 12_345,
      spawnHeadless: (_p, _cwd, timeoutMs) => {
        seen = timeoutMs;
        return Promise.resolve('summary text');
      },
    });
    await gen(row);
    expect(seen).toBe(12_345);
  });
});
