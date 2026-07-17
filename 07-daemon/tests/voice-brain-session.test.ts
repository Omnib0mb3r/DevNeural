/**
 * Dedicated voice-brain session (src/lex/voice-brain-session.ts).
 *
 * Never spawns a real `claude` process: every pty-host / fs primitive
 * is replaced via _setVoiceBrainSessionDepsForTests. Timing is driven
 * by a virtual clock (makeVirtualIo below, same rig as
 * judge-session.test.ts) so timeout/respawn scenarios run instantly
 * and deterministically. The one addition over the judge rig: a
 * scheduled record can carry a stop_reason so the phase 2 onPartial
 * streaming path (per-record delivery, end_turn resolution) is
 * exercised against realistic jsonl shapes.
 *
 * Warmup lifecycle (2026-07-16 smoke-test fix 2/3): a fresh spawn
 * accepts no asks until its boot probe has seen a real assistant
 * reply, so every scenario that needs a live session first drives
 * warmSession() below - the same spawn -> probe -> warm dance
 * production runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  askVoice,
  isVoiceBrainSessionEnabled,
  isVoiceBrainSessionWarm,
  prewarmVoiceBrainSession,
  _resetVoiceBrainSessionStateForTests,
  _setVoiceBrainSessionDepsForTests,
  _voiceBrainSessionSnapshotForTests,
  _voiceBrainWarmupForTests,
  type VoiceBrainSessionDeps,
} from '../src/lex/voice-brain-session.js';
import { transcriptPathFor } from '../src/lex/spawn-lex-session.js';

const CWD = 'C:/fake/voice-brain-cwd';
const HOME_DIR = 'C:/fake/home';

/* Virtual filesystem + clock. statSync/readRange only ever see content
 * that has "arrived" as of the current virtual time, so a scheduled
 * record with a nonzero delay genuinely isn't visible until enough
 * sleep() calls (or an explicit advanceClock) have elapsed past it. */
function makeVirtualIo(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  statSync: (path: string) => { size: number };
  readRange: (path: string, start: number, length: number) => string;
  scheduleAssistantRecord: (
    path: string,
    delayMs: number,
    text: string | null,
    stopReason?: string,
  ) => void;
  advanceClock: (ms: number) => void;
} {
  let ms = 0;
  const files = new Map<string, string>();
  const pending: Array<{ path: string; arrivesAt: number; line: string }> = [];

  function flush(): void {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!;
      if (p.arrivesAt <= ms) {
        files.set(p.path, (files.get(p.path) ?? '') + p.line);
        pending.splice(i, 1);
      }
    }
  }

  return {
    now: () => ms,
    sleep: async (dur: number) => {
      ms += dur;
    },
    statSync: (path: string) => {
      flush();
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return { size: Buffer.byteLength(content, 'utf-8') };
    },
    readRange: (path: string, start: number, length: number) => {
      flush();
      const content = files.get(path) ?? '';
      return Buffer.from(content, 'utf-8')
        .subarray(start, start + length)
        .toString('utf-8');
    },
    scheduleAssistantRecord: (
      path: string,
      delayMs: number,
      text: string | null,
      stopReason?: string,
    ) => {
      const message: {
        content: Array<{ type: string; text: string }>;
        stop_reason?: string;
      } = {
        content: text === null ? [] : [{ type: 'text', text }],
      };
      if (stopReason !== undefined) message.stop_reason = stopReason;
      const rec = { type: 'assistant', message };
      /* Math.max(delayMs, 1): a delay of exactly 0 must still land
       * STRICTLY after "now" at schedule time, otherwise it would
       * already be visible to the pre-inject baseline statSync read
       * and get folded into the baseline offset instead of being seen
       * as new content by the poll loop. */
      pending.push({
        path,
        arrivesAt: ms + Math.max(delayMs, 1),
        line: `${JSON.stringify(rec)}\n`,
      });
    },
    advanceClock: (dur: number) => {
      ms += dur;
    },
  };
}

interface SpawnCall {
  cwd: string;
  systemPrompt?: string;
  args?: string[];
  sessionId?: string;
}

function makeFakePtyLayer(): {
  spawnLex: VoiceBrainSessionDeps['spawnLex'];
  ptyInject: VoiceBrainSessionDeps['ptyInject'];
  ptyKill: VoiceBrainSessionDeps['ptyKill'];
  getPty: VoiceBrainSessionDeps['getPty'];
  randomUUID: () => string;
  spawnCalls: SpawnCall[];
  injectCalls: Array<{ ptyId: string; text: string; commit?: boolean }>;
  killCalls: string[];
  killedPtys: Set<string>;
} {
  const spawnCalls: SpawnCall[] = [];
  const injectCalls: Array<{ ptyId: string; text: string; commit?: boolean }> = [];
  const killCalls: string[] = [];
  const killedPtys = new Set<string>();
  let ptyCounter = 0;
  let uuidCounter = 0;

  return {
    spawnCalls,
    injectCalls,
    killCalls,
    killedPtys,
    spawnLex: (opts) => {
      spawnCalls.push(opts);
      ptyCounter += 1;
      return { ptyId: `pty-${ptyCounter}`, pid: 1000 + ptyCounter };
    },
    ptyInject: (ptyId, text, commit) => {
      injectCalls.push({ ptyId, text, commit });
      if (killedPtys.has(ptyId)) {
        return { ok: false, error: 'pty has exited' };
      }
      return { ok: true };
    },
    ptyKill: (ptyId) => {
      killCalls.push(ptyId);
      killedPtys.add(ptyId);
      return true;
    },
    getPty: (ptyId) => ({ exited: killedPtys.has(ptyId) }),
    randomUUID: () => {
      uuidCounter += 1;
      return `cc-session-${uuidCounter}`;
    },
  };
}

let priorFlag: string | undefined;
let priorTimeout: string | undefined;

beforeEach(() => {
  priorFlag = process.env.DEVNEURAL_VOICE_BRAIN_SESSION;
  priorTimeout = process.env.DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS;
  delete process.env.DEVNEURAL_VOICE_BRAIN_SESSION;
  delete process.env.DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS;
  _resetVoiceBrainSessionStateForTests();
});

afterEach(() => {
  if (priorFlag === undefined) delete process.env.DEVNEURAL_VOICE_BRAIN_SESSION;
  else process.env.DEVNEURAL_VOICE_BRAIN_SESSION = priorFlag;
  if (priorTimeout === undefined) delete process.env.DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS;
  else process.env.DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS = priorTimeout;
  _setVoiceBrainSessionDepsForTests(null);
  _resetVoiceBrainSessionStateForTests();
});

function baseDeps(
  io: ReturnType<typeof makeVirtualIo>,
  pty: ReturnType<typeof makeFakePtyLayer>,
  extra: Partial<VoiceBrainSessionDeps> = {},
): VoiceBrainSessionDeps {
  return {
    spawnLex: pty.spawnLex,
    ptyInject: pty.ptyInject,
    ptyKill: pty.ptyKill,
    getPty: pty.getPty,
    statSync: io.statSync,
    readRange: io.readRange,
    now: io.now,
    randomUUID: pty.randomUUID,
    sleep: io.sleep,
    log: () => undefined,
    cwd: CWD,
    homeDir: HOME_DIR,
    pollIntervalMs: 50,
    respawnCooldownMs: 5 * 60 * 1000,
    ...extra,
  };
}

function pathForSession(n: number): string {
  return transcriptPathFor({
    cwd: CWD,
    ccSessionId: `cc-session-${n}`,
    homeDir: HOME_DIR,
  });
}

/* Warmup traffic = banner/re-nudge bare CRs + the boot probe. Every
 * REAL ask inject is what's left. */
function askInjectCalls(
  pty: ReturnType<typeof makeFakePtyLayer>,
): Array<{ ptyId: string; text: string; commit?: boolean }> {
  return pty.injectCalls.filter(
    (c) => c.text !== '\r' && !c.text.startsWith('Warmup check'),
  );
}

/* Drive a cold state through spawn + boot probe to a warm session.
 * The probe reply is scheduled to land after the warmup baseline read
 * (boot delay is 3000ms on the virtual clock); the trigger ask itself
 * must resolve null - that IS the warming gate. */
async function warmSession(
  io: ReturnType<typeof makeVirtualIo>,
  pty: ReturnType<typeof makeFakePtyLayer>,
  sessionN: number,
): Promise<void> {
  io.scheduleAssistantRecord(pathForSession(sessionN), 3_500, 'OK');
  const trigger = await askVoice({ prompt: 'warm trigger', timeoutMs: 100 });
  expect(trigger).toBeNull();
  await _voiceBrainWarmupForTests();
  expect(_voiceBrainSessionSnapshotForTests().warm).toBe(true);
}

describe('warmup gate (2026-07-16 smoke-test fix 2/3)', () => {
  it('asks made while the session is warming resolve null, inject nothing, and count no timeouts', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));

    const r1 = await askVoice({ prompt: 'cold ask', timeoutMs: 100 });
    const r2 = await askVoice({ prompt: 'still cold', timeoutMs: 100 });

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(askInjectCalls(pty).length).toBe(0);
    /* The pre-fix death spiral: these nulls used to count as timeouts
     * and the two-strike rule killed the BOOTING session. */
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(0);
    expect(pty.killCalls.length).toBe(0);
    expect(pty.spawnCalls.length).toBe(1);
  });

  it('after the boot probe sees a reply, the session is warm and answers normally', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));

    await warmSession(io, pty, 1);
    io.scheduleAssistantRecord(pathForSession(1), 10, 'real answer');
    const result = await askVoice({ prompt: 'real ask', timeoutMs: 5000 });

    expect(result).toBe('real answer');
    /* Warmup traffic: two banner CRs + the probe, all on the same pty. */
    const probe = pty.injectCalls.find((c) => c.text.startsWith('Warmup check'));
    expect(probe).toBeDefined();
    expect(probe!.commit).toBe(true);
  });

  it('a warmup that never sees a reply kills the session; the cooldown gates the respawn', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty, { respawnCooldownMs: 100_000 }));

    const r = await askVoice({ prompt: 'cold ask', timeoutMs: 100 });
    expect(r).toBeNull();
    await _voiceBrainWarmupForTests(); // burns the 45s warmup window

    expect(pty.killCalls.length).toBe(1);
    const snap = _voiceBrainSessionSnapshotForTests();
    expect(snap.ptyId).toBeNull();
    expect(snap.warm).toBe(false);

    const r2 = await askVoice({ prompt: 'again', timeoutMs: 100 });
    expect(r2).toBeNull();
    expect(pty.spawnCalls.length).toBe(1); // cooldown suppressed the respawn
  });

  it('re-nudges an idempotent bare CR while waiting out a slow boot', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));

    /* Reply lands 9.5s in: probe at 3s, one re-nudge due at 8s. */
    io.scheduleAssistantRecord(pathForSession(1), 9_500, 'OK');
    await askVoice({ prompt: 'trigger', timeoutMs: 100 });
    await _voiceBrainWarmupForTests();

    expect(_voiceBrainSessionSnapshotForTests().warm).toBe(true);
    const bareCrs = pty.injectCalls.filter((c) => c.text === '\r');
    /* 2 banner pre-dismiss CRs + at least one re-nudge. */
    expect(bareCrs.length).toBeGreaterThanOrEqual(3);
  });

  it('prewarmVoiceBrainSession spawns and warms with no ask in sight', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));

    io.scheduleAssistantRecord(pathForSession(1), 3_500, 'OK');
    prewarmVoiceBrainSession();
    await _voiceBrainWarmupForTests();

    expect(_voiceBrainSessionSnapshotForTests().warm).toBe(true);
    expect(pty.spawnCalls.length).toBe(1);
    expect(askInjectCalls(pty).length).toBe(0);

    io.scheduleAssistantRecord(pathForSession(1), 10, 'first real reply');
    const result = await askVoice({ prompt: 'first real ask', timeoutMs: 5000 });
    expect(result).toBe('first real reply');
  });
});

describe('askVoice: ask/reply round trip', () => {
  it('resolves with the first assistant record text when onPartial is not provided', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    io.scheduleAssistantRecord(pathForSession(1), 10, 'On it, boss.');

    const result = await askVoice({
      system: 'Reply in one short spoken sentence.',
      prompt: 'Say hello.',
      timeoutMs: 5000,
    });

    expect(result).toBe('On it, boss.');
    expect(pty.spawnCalls.length).toBe(1);
    expect(pty.spawnCalls[0]!.args).toContain('--session-id');
    expect(pty.spawnCalls[0]!.args).toContain('cc-session-1');
    expect(pty.spawnCalls[0]!.sessionId).toBe('cc-session-1');
    const asks = askInjectCalls(pty);
    expect(asks.length).toBe(1);
    expect(asks[0]!.text).toContain('Reply in one short spoken sentence.');
    expect(asks[0]!.text).toContain('Say hello.');
    expect(asks[0]!.commit).toBe(true);
  });

  it('sends the bare prompt when no system framing is given', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    io.scheduleAssistantRecord(pathForSession(1), 10, 'Sure.');

    await askVoice({ prompt: 'Just the prompt.', timeoutMs: 5000 });

    expect(askInjectCalls(pty)[0]!.text).toBe('Just the prompt.');
  });
});

describe('session spawn deduplication', () => {
  it('spawns once and reuses the live PTY across sequential asks', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);
    io.scheduleAssistantRecord(path1, 10, 'first reply');

    const r1 = await askVoice({ prompt: 'one', timeoutMs: 5000 });
    io.scheduleAssistantRecord(path1, 10, 'second reply');
    const r2 = await askVoice({ prompt: 'two', timeoutMs: 5000 });

    expect(r1).toBe('first reply');
    expect(r2).toBe('second reply');
    expect(pty.spawnCalls.length).toBe(1);
    const asks = askInjectCalls(pty);
    expect(asks.length).toBe(2);
    expect(asks[0]!.ptyId).toBe('pty-1');
    expect(asks[1]!.ptyId).toBe('pty-1');
  });

  it('serializes concurrent asks onto the one session: second ask waits, no second spawn', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);
    io.scheduleAssistantRecord(path1, 100, 'first reply');
    io.scheduleAssistantRecord(path1, 250, 'second reply');

    const order: string[] = [];
    const p1 = askVoice({ prompt: 'one', timeoutMs: 5000 }).then((r) => {
      order.push('resolved-1');
      return r;
    });
    const p2 = askVoice({ prompt: 'two', timeoutMs: 5000 }).then((r) => {
      order.push('resolved-2');
      return r;
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(order).toEqual(['resolved-1', 'resolved-2']);
    expect(r1).toBe('first reply');
    expect(r2).toBe('second reply');
    expect(pty.spawnCalls.length).toBe(1);
    expect(askInjectCalls(pty).length).toBe(2);
  });
});

describe('timeout: resolves null, never throws', () => {
  it('a timed-out ask resolves null and increments consecutive_timeouts', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    // No record ever scheduled: the poll loop exhausts its deadline.

    const result = await askVoice({ prompt: 'anyone home?', timeoutMs: 300 });

    expect(result).toBeNull();
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(1);
    expect(pty.killCalls.length).toBe(0); // one timeout alone does not kill
  });

  it('uses DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS as the default deadline when timeoutMs is omitted', async () => {
    process.env.DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS = '300';
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);

    const t0 = io.now();
    const result = await askVoice({ prompt: 'q' });

    expect(result).toBeNull();
    // The poll loop slept exactly up to the 300ms env-configured
    // deadline (poll interval 50ms divides it evenly), so the virtual
    // clock pins the default that was actually applied.
    expect(io.now() - t0).toBe(300);
  });

  it('falls back to the 6000ms built-in default when the env var is unset', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);

    const t0 = io.now();
    const result = await askVoice({ prompt: 'q' });

    expect(result).toBeNull();
    expect(io.now() - t0).toBe(6000);
  });

  it('a successful reply after a timeout resets the streak to zero', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);

    const missed = await askVoice({ prompt: 'q1', timeoutMs: 200 });
    expect(missed).toBeNull();
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(1);

    io.scheduleAssistantRecord(pathForSession(1), 10, 'still here');
    const ok = await askVoice({ prompt: 'q2', timeoutMs: 5000 });

    expect(ok).toBe('still here');
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(0);
  });
});

describe('onPartial: per-record streaming, end_turn resolution', () => {
  it('delivers each record text to onPartial as it lands and resolves with the concatenation on end_turn', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);
    io.scheduleAssistantRecord(path1, 10, 'Checking the build now.');
    io.scheduleAssistantRecord(path1, 120, 'Two workers are still running.');
    io.scheduleAssistantRecord(path1, 240, 'Nothing needs you yet.', 'end_turn');

    const partials: string[] = [];
    const result = await askVoice({
      prompt: 'status?',
      timeoutMs: 5000,
      onPartial: (text) => partials.push(text),
    });

    expect(partials).toEqual([
      'Checking the build now.',
      'Two workers are still running.',
      'Nothing needs you yet.',
    ]);
    expect(result).toBe(
      'Checking the build now.\nTwo workers are still running.\nNothing needs you yet.',
    );
  });

  it('does NOT resolve on a text record without end_turn; the idle grace eventually times it out with NO liveness strike', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);
    // A partial lands but no end_turn ever arrives: the ask must time
    // out (null) rather than resolve early with the fragment. Since
    // 2026-07-16, progress extends the deadline (idle grace) and a
    // stalled-after-partial timeout is NOT a liveness strike.
    io.scheduleAssistantRecord(path1, 10, 'Well, the thing is');

    const partials: string[] = [];
    const result = await askVoice({
      prompt: 'q',
      timeoutMs: 300,
      onPartial: (text) => partials.push(text),
    });

    expect(partials).toEqual(['Well, the thing is']);
    expect(result).toBeNull();
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(0);
  });

  it('an end_turn record with no text blocks still closes the ask with the accumulated text', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);
    io.scheduleAssistantRecord(path1, 10, 'All done.');
    io.scheduleAssistantRecord(path1, 60, null, 'end_turn');

    const partials: string[] = [];
    const result = await askVoice({
      prompt: 'q',
      timeoutMs: 5000,
      onPartial: (text) => partials.push(text),
    });

    expect(partials).toEqual(['All done.']);
    expect(result).toBe('All done.');
  });

  it('a throwing onPartial is swallowed; the ask still resolves with the full text', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);
    io.scheduleAssistantRecord(path1, 10, 'First.');
    io.scheduleAssistantRecord(path1, 60, 'Second.', 'end_turn');

    const result = await askVoice({
      prompt: 'q',
      timeoutMs: 5000,
      onPartial: () => {
        throw new Error('speaker exploded');
      },
    });

    expect(result).toBe('First.\nSecond.');
  });

  it('without onPartial, a single end_turn record resolves on its text alone (fallback parity)', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    io.scheduleAssistantRecord(pathForSession(1), 10, 'Quick answer.', 'end_turn');

    const result = await askVoice({ prompt: 'q', timeoutMs: 5000 });

    expect(result).toBe('Quick answer.');
  });
});

describe('streaming asks: idle extension + no liveness strike on progress (2026-07-16 failure 1)', () => {
  it('records arriving past the base deadline keep the ask alive; it resolves on end_turn', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);
    /* Base deadline 300ms; the turn keeps producing well past it. */
    io.scheduleAssistantRecord(path1, 100, 'Sentence one.');
    io.scheduleAssistantRecord(path1, 5_000, 'Sentence two.');
    io.scheduleAssistantRecord(path1, 9_000, 'Sentence three.', 'end_turn');

    const partials: string[] = [];
    const result = await askVoice({
      prompt: 'deliver',
      timeoutMs: 300,
      onPartial: (t) => partials.push(t),
    });

    expect(result).toBe('Sentence one.\nSentence two.\nSentence three.');
    expect(partials.length).toBe(3);
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(0);
    expect(pty.killCalls.length).toBe(0);
  });

  it('a stream that stalls after partials times out via the idle grace but scores NO liveness strike - twice in a row never kills', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);

    /* The 04:30Z incident shape, twice: partials flow, then silence.
     * Pre-fix each counted a strike and the second kill clipped the
     * spoken reply mid-sentence. */
    io.scheduleAssistantRecord(path1, 100, 'First half of the reply,');
    const r1 = await askVoice({
      prompt: 'deliver A',
      timeoutMs: 300,
      onPartial: () => undefined,
    });
    io.scheduleAssistantRecord(path1, 100, 'Another half of a reply,');
    const r2 = await askVoice({
      prompt: 'deliver B',
      timeoutMs: 300,
      onPartial: () => undefined,
    });

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(0);
    expect(pty.killCalls.length).toBe(0);
    expect(_voiceBrainSessionSnapshotForTests().ptyId).not.toBeNull();
  });

  it('the absolute wall still bounds a turn that streams forever without end_turn', async () => {
    const priorIdle = process.env.DEVNEURAL_VOICE_BRAIN_STREAM_IDLE_MS;
    const priorMax = process.env.DEVNEURAL_VOICE_BRAIN_STREAM_MAX_MS;
    process.env.DEVNEURAL_VOICE_BRAIN_STREAM_IDLE_MS = '1000';
    process.env.DEVNEURAL_VOICE_BRAIN_STREAM_MAX_MS = '3000';
    try {
      const io = makeVirtualIo();
      const pty = makeFakePtyLayer();
      _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
      await warmSession(io, pty, 1);
      const path1 = pathForSession(1);
      /* Steady records every 800ms, never an end_turn: idle grace
       * alone would extend forever; the wall cuts at +3000ms. */
      for (let d = 100; d <= 6_000; d += 800) {
        io.scheduleAssistantRecord(path1, d, `chunk at ${d}`);
      }
      const t0 = io.now();
      const result = await askVoice({
        prompt: 'runaway',
        timeoutMs: 300,
        onPartial: () => undefined,
      });
      expect(result).toBeNull();
      expect(io.now() - t0).toBeLessThanOrEqual(3_100);
      /* Progress was made, so still no liveness strike. */
      expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(0);
    } finally {
      if (priorIdle === undefined) delete process.env.DEVNEURAL_VOICE_BRAIN_STREAM_IDLE_MS;
      else process.env.DEVNEURAL_VOICE_BRAIN_STREAM_IDLE_MS = priorIdle;
      if (priorMax === undefined) delete process.env.DEVNEURAL_VOICE_BRAIN_STREAM_MAX_MS;
      else process.env.DEVNEURAL_VOICE_BRAIN_STREAM_MAX_MS = priorMax;
    }
  });

  it('a NON-streaming ask (heartbeat shape) whose jsonl grew without a text record times out with NO strike - the 04:46Z heartbeat kill', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const path1 = pathForSession(1);

    /* Two heartbeat asks in a row: the session writes jsonl bytes
     * (claude picked the prompt up; textless record models the user
     * record / a content-free assistant record) but no reply lands
     * inside the deadline. Pre-fix: strike 1, strike 2, session
     * killed mid-heartbeat (04:46:25Z). */
    io.scheduleAssistantRecord(path1, 100, null);
    const r1 = await askVoice({ prompt: 'pulse A', timeoutMs: 300 });
    io.scheduleAssistantRecord(path1, 100, null);
    const r2 = await askVoice({ prompt: 'pulse B', timeoutMs: 300 });

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(0);
    expect(pty.killCalls.length).toBe(0);
  });

  it('zero-record timeouts still strike and kill on the second (dead-session detection intact)', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);

    await askVoice({ prompt: 'q1', timeoutMs: 100, onPartial: () => undefined });
    expect(_voiceBrainSessionSnapshotForTests().consecutiveTimeouts).toBe(1);
    await askVoice({ prompt: 'q2', timeoutMs: 100, onPartial: () => undefined });
    expect(pty.killCalls.length).toBe(1);
  });
});

describe('isVoiceBrainSessionWarm', () => {
  it('true after warmup, false after the session is killed', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));

    expect(isVoiceBrainSessionWarm()).toBe(false);
    await warmSession(io, pty, 1);
    expect(isVoiceBrainSessionWarm()).toBe(true);

    /* Two zero-record timeouts kill the session. */
    await askVoice({ prompt: 'q1', timeoutMs: 100 });
    await askVoice({ prompt: 'q2', timeoutMs: 100 });
    expect(isVoiceBrainSessionWarm()).toBe(false);
  });
});

describe('liveness: respawn after two consecutive timeouts, bounded by cooldown', () => {
  it('kills the session on the second consecutive timeout, then suppresses a respawn attempt inside the cooldown window', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty, { respawnCooldownMs: 100_000 }));
    await warmSession(io, pty, 1);

    const t1 = await askVoice({ prompt: 'q1', timeoutMs: 100 });
    const t2 = await askVoice({ prompt: 'q2', timeoutMs: 100 });
    expect(t1).toBeNull();
    expect(t2).toBeNull();
    // Two consecutive timeouts ON A WARM SESSION: the session was killed.
    expect(pty.killCalls.length).toBe(1);
    expect(_voiceBrainSessionSnapshotForTests().ptyId).toBeNull();
    expect(pty.spawnCalls.length).toBe(1); // still just the original spawn

    // Cooldown has not elapsed: a third ask must NOT trigger a second spawn.
    const t3 = await askVoice({ prompt: 'q3', timeoutMs: 50 });
    expect(t3).toBeNull();
    expect(pty.spawnCalls.length).toBe(1);
  });

  it('respawns once the cooldown window has elapsed, and the fresh session answers after its own warmup', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty, { respawnCooldownMs: 10_000 }));
    await warmSession(io, pty, 1);

    await askVoice({ prompt: 'q1', timeoutMs: 100 });
    await askVoice({ prompt: 'q2', timeoutMs: 100 });
    expect(pty.killCalls.length).toBe(1);
    expect(pty.spawnCalls.length).toBe(1);

    // Fast-forward past the cooldown window; the next spawn runs the
    // same warmup dance before answering.
    io.advanceClock(10_000);
    await warmSession(io, pty, 2);

    io.scheduleAssistantRecord(pathForSession(2), 10, 'fresh session speaking');
    const result = await askVoice({ prompt: 'q3', timeoutMs: 5000 });

    expect(result).toBe('fresh session speaking');
    expect(pty.spawnCalls.length).toBe(2); // the bounded respawn happened
  });

  it('also respawns when the PTY is found exited externally (not just on timeout)', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty, { respawnCooldownMs: 10_000 }));
    await warmSession(io, pty, 1);

    io.scheduleAssistantRecord(pathForSession(1), 10, 'alive');
    await askVoice({ prompt: 'q1', timeoutMs: 5000 });
    expect(pty.spawnCalls.length).toBe(1);

    // Simulate an external death (claude process crashed) without
    // going through two timeouts.
    pty.killedPtys.add('pty-1');
    io.advanceClock(10_000); // clear the cooldown so the respawn is allowed
    await warmSession(io, pty, 2);

    io.scheduleAssistantRecord(pathForSession(2), 10, 'back again');
    const result = await askVoice({ prompt: 'q2', timeoutMs: 5000 });

    expect(result).toBe('back again');
    expect(pty.spawnCalls.length).toBe(2);
  });
});

describe('DEVNEURAL_VOICE_BRAIN_SESSION flag', () => {
  it('under Vitest, stays disabled until a test explicitly overrides deps (safety backstop)', () => {
    /* No _setVoiceBrainSessionDepsForTests call in THIS test: proves
     * the Vitest-detection guard, not the env var, is what gates this.
     * Same incident class judge-session's backstop exists for: a test
     * file that merely calls into a voice call site must never launch
     * a real `claude --dangerously-skip-permissions` subprocess. */
    expect(isVoiceBrainSessionEnabled()).toBe(false);
  });

  it('once a test overrides deps, the flag defaults to enabled', () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    expect(isVoiceBrainSessionEnabled()).toBe(true);
  });

  it('"0" disables the session even with deps overridden; askVoice resolves null without ever spawning', async () => {
    process.env.DEVNEURAL_VOICE_BRAIN_SESSION = '0';
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));

    const result = await askVoice({ prompt: 'q', timeoutMs: 5000 });

    expect(result).toBeNull();
    expect(pty.spawnCalls.length).toBe(0);
    expect(pty.injectCalls.length).toBe(0);

    prewarmVoiceBrainSession();
    expect(pty.spawnCalls.length).toBe(0);
  });
});

/* Signal-based liveness (2026-07-17 operator directive: "time based is
 * likely bad, it is too short"). Alive = transcript-jsonl growth OR
 * pty output within the quiet window, at EVERY phase; timeouts bound
 * time-to-first-SIGNAL and silence, never total reply time. Tonight's
 * evidence: asks returned chars=0 at 6-7s while the session was
 * provably generating (bytes_grew=true), producing silent turns. */
describe('signal-based liveness (2026-07-17)', () => {
  it('an ask with jsonl growth but a late answer resolves past the base timeout', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    /* Growth signal (record with no text) at 2s, real answer at 9s -
     * past the 6s base ask deadline. Old behavior: null at ~6s. */
    io.scheduleAssistantRecord(pathForSession(1), 2_000, null);
    io.scheduleAssistantRecord(pathForSession(1), 9_000, 'late but alive');
    const r = await askVoice({ prompt: 'slow ask', timeoutMs: 6_000 });
    expect(r).toBe('late but alive');
  });

  it('a fully quiet session still times out at the base deadline', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 1);
    const before = io.now();
    const r = await askVoice({ prompt: 'dead ask', timeoutMs: 6_000 });
    expect(r).toBeNull();
    /* No signals: the wait must not balloon to the wall. */
    expect(io.now() - before).toBeLessThan(10_000);
  });

  it('warmup survives past its base timeout while the jsonl keeps growing', async () => {
    process.env.DEVNEURAL_VOICE_BRAIN_WARMUP_TIMEOUT_MS = '1000';
    try {
      const io = makeVirtualIo();
      const pty = makeFakePtyLayer();
      _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
      /* The fake pty boots in ~3s (probe baseline lands then), so the
       * 1000ms base warmup bound expires ~4s. A growth-only record at
       * 3.5s keeps the boot alive; the real reply at 5.5s is past the
       * base bound - old behavior: WARMUP FAILED kill. */
      io.scheduleAssistantRecord(pathForSession(1), 3_500, null);
      io.scheduleAssistantRecord(pathForSession(1), 5_500, 'boot OK');
      const trigger = await askVoice({ prompt: 'warm trigger', timeoutMs: 100 });
      expect(trigger).toBeNull();
      await _voiceBrainWarmupForTests();
      expect(_voiceBrainSessionSnapshotForTests().warm).toBe(true);
    } finally {
      delete process.env.DEVNEURAL_VOICE_BRAIN_WARMUP_TIMEOUT_MS;
    }
  });
});
