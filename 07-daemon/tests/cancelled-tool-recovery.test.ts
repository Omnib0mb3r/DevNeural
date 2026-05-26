import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  RECOVERY_INJECT_BODY,
  _resetCancelledToolRecoveryForTests,
  _peekCancelledToolRecoveryState,
  runCancelledToolRecoveryTick,
} from '../src/lex/cancelled-tool-recovery.js';
import type { BrainstormSessionRow } from '../src/store/index-db.js';
import type { InjectResult } from '../src/lex/cross-session-inject.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

const BRAINSTORM_ID = 'bs-recovery-1234';
const CC_SESSION_ID = 'cc-session-recovery-aaaa-bbbb-cccc-dddd';

function makeRow(): BrainstormSessionRow {
  return {
    id: BRAINSTORM_ID,
    claude_session_id: CC_SESSION_ID,
    pty_id: null,
    cwd: 'C:/dev/Projects/DevNeural/brainstorm',
    user_label: null,
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: 1700000000000,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  } as BrainstormSessionRow;
}

function userRejectLine(uuid: string, text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid,
      sessionId: CC_SESSION_ID,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-' + uuid,
            content: text,
            is_error: false,
          },
        ],
      },
    }) + '\n'
  );
}

function assistantLine(uuid: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid,
      sessionId: CC_SESSION_ID,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok continuing' }],
      },
    }) + '\n'
  );
}

interface RecordedInject {
  target: string;
  text: string;
  callerLabel: string;
}

interface Harness {
  jsonl: string;
  appendLines: (lines: string[]) => void;
  injects: RecordedInject[];
  exhaustNotifies: Array<{ ccId: string; reason: string }>;
  /* Fake clock: tests advance this via advance(ms). The deps now()
   * defaults to this, so each tick reads the configured wall time. */
  advance: (ms: number) => void;
  nowMs: () => number;
  tick: () => void;
}

function makeHarness(): Harness {
  const jsonl = path.join(tmpDir, `${CC_SESSION_ID}.jsonl`);
  fs.writeFileSync(jsonl, '');
  let clock = 1_000_000_000_000;
  const injects: RecordedInject[] = [];
  const exhaustNotifies: Array<{ ccId: string; reason: string }> = [];
  function tick(): void {
    runCancelledToolRecoveryTick(
      {
        db,
        listActiveBrainstorms: () => [makeRow()],
        resolveJsonlPath: () => jsonl,
        crossSessionInject: (
          target: string,
          text: string,
          callerLabel: string,
        ): InjectResult => {
          injects.push({ target, text, callerLabel });
          return { ok: true, decision: 'accepted', transport: 'pty' };
        },
        notifyExhausted: (ccId, reason) => {
          exhaustNotifies.push({ ccId, reason });
        },
        now: () => clock,
        log: () => undefined,
      },
      { recoveryDelayMs: 5_000, exhaustWindowMs: 30_000 },
    );
  }
  return {
    jsonl,
    appendLines: (lines) => fs.appendFileSync(jsonl, lines.join('')),
    injects,
    exhaustNotifies,
    advance: (ms) => {
      clock += ms;
    },
    nowMs: () => clock,
    tick,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-cancrec-'));
  dbFile = path.join(tmpDir, 'index.db');
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  db = new IndexDb(dbFile);
  db.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  _resetCancelledToolRecoveryForTests();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  if (priorRoot === undefined) {
    delete process.env.DEVNEURAL_DATA_ROOT;
  } else {
    process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('cancelled-tool-recovery', () => {
  it('fires one recovery inject when no assistant follow-up arrives within 5s', () => {
    const h = makeHarness();
    h.appendLines([
      userRejectLine('u-1', "The user doesn't want to proceed with this tool use"),
    ]);
    h.tick(); // detect + arm
    expect(h.injects).toHaveLength(0);
    expect(_peekCancelledToolRecoveryState().get(CC_SESSION_ID)?.armedAt).not.toBeNull();

    h.advance(6_000); // past the 5s window
    h.tick(); // firing pass
    expect(h.injects).toHaveLength(1);
    expect(h.injects[0]?.target).toBe(CC_SESSION_ID);
    expect(h.injects[0]?.text).toBe(RECOVERY_INJECT_BODY);
    expect(h.injects[0]?.callerLabel).toBe('lex-cancelled-tool-recovery');
    /* Disarm + record lastRecoveryAt so the next tick is idle. */
    const st = _peekCancelledToolRecoveryState().get(CC_SESSION_ID);
    expect(st?.armedAt).toBeNull();
    expect(st?.lastRecoveryAt).not.toBeNull();

    h.advance(1_000);
    h.tick();
    expect(h.injects).toHaveLength(1); // still one
  });

  it('does NOT fire recovery when assistant follow-up lands within the window', () => {
    const h = makeHarness();
    h.appendLines([
      userRejectLine('u-2', 'Request interrupted by user'),
    ]);
    h.tick(); // detect + arm
    expect(_peekCancelledToolRecoveryState().get(CC_SESSION_ID)?.armedAt).not.toBeNull();

    h.advance(2_000);
    h.appendLines([assistantLine('a-2')]);
    h.tick(); // assistant line clears state

    const st = _peekCancelledToolRecoveryState().get(CC_SESSION_ID);
    expect(st?.armedAt).toBeNull();
    expect(st?.armedTurnUuid).toBeNull();

    h.advance(10_000);
    h.tick(); // firing pass — nothing armed, no inject
    expect(h.injects).toHaveLength(0);
  });

  it('escalates to recovery_exhausted on the second strike inside 30s', () => {
    const h = makeHarness();
    h.appendLines([
      userRejectLine('u-3a', "The user doesn't want to proceed with this tool use"),
    ]);
    h.tick(); // arm
    h.advance(6_000);
    h.tick(); // fire recovery
    expect(h.injects).toHaveLength(1);

    /* Second cancellation lands ~10s after the recovery fired,
     * inside the 30s exhaust window. */
    h.advance(10_000);
    h.appendLines([
      userRejectLine('u-3b', 'Request interrupted by user'),
    ]);
    h.tick();
    /* No second auto-inject; exhaustion was raised. */
    expect(h.injects).toHaveLength(1);
    expect(h.exhaustNotifies).toHaveLength(1);
    expect(h.exhaustNotifies[0]?.ccId).toBe(CC_SESSION_ID);
    expect(h.exhaustNotifies[0]?.reason).toMatch(/recovery_exhausted/);

    /* Audit row landed with decision='shadow' + caller_label tag. */
    const logs = db.db
      .prepare(
        `SELECT decision, caller_label, reject_reason FROM cross_session_injection_log WHERE target_session = ? AND caller_label = 'lex-cancelled-tool-recovery'`,
      )
      .all(CC_SESSION_ID) as Array<{
      decision: string;
      caller_label: string;
      reject_reason: string | null;
    }>;
    expect(
      logs.some(
        (r) => r.decision === 'shadow' && /recovery_exhausted/.test(r.reject_reason ?? ''),
      ),
    ).toBe(true);
  });

  it('debounces two cancellations inside the 5s window to one recovery', () => {
    const h = makeHarness();
    h.appendLines([
      userRejectLine('u-4a', "The user doesn't want to proceed with this tool use"),
    ]);
    h.tick(); // arm at t=0
    const armedAt = _peekCancelledToolRecoveryState().get(CC_SESSION_ID)?.armedAt;

    h.advance(2_000);
    h.appendLines([
      userRejectLine('u-4b', "The user doesn't want to proceed with this tool use"),
    ]);
    h.tick(); // second reject 2s later — debounced
    /* armedAt should NOT have moved; debounce preserves the first stamp. */
    expect(_peekCancelledToolRecoveryState().get(CC_SESSION_ID)?.armedAt).toBe(armedAt);

    h.advance(4_000); // total 6s since first arm
    h.tick(); // firing pass
    expect(h.injects).toHaveLength(1);
  });
});
