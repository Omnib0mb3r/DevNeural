/**
 * Persistent Max-plan judge session (src/lex/judge-session.ts).
 *
 * Never spawns a real `claude` process: every pty-host / fs primitive
 * is replaced via _setJudgeSessionDepsForTests. Timing is driven by a
 * virtual clock (makeVirtualIo below) so timeout/respawn scenarios run
 * instantly and deterministically instead of waiting out real ms.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  askJudge,
  askText,
  isJudgeSessionEnabled,
  _judgeSessionSnapshotForTests,
  _resetJudgeSessionStateForTests,
  _setJudgeSessionDepsForTests,
  type JudgeSessionDeps,
} from '../src/lex/judge-session.js';
import { transcriptPathFor } from '../src/lex/spawn-lex-session.js';

const CWD = 'C:/fake/judge-cwd';
const HOME_DIR = 'C:/fake/home';

/* Virtual filesystem + clock. statSync/readRange only ever see content
 * that has "arrived" as of the current virtual time, so a scheduled
 * reply with a nonzero delay genuinely isn't visible until enough
 * sleep() calls (or an explicit advanceClock) have elapsed past it --
 * exactly like a real polling loop racing a real clock, but with zero
 * real wall-clock cost in the test. */
function makeVirtualIo(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  statSync: (path: string) => { size: number };
  readRange: (path: string, start: number, length: number) => string;
  scheduleAssistantReply: (path: string, delayMs: number, text: string) => void;
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
    scheduleAssistantReply: (path: string, delayMs: number, text: string) => {
      const rec = {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      };
      /* Math.max(delayMs, 1): a delay of exactly 0 must still land
       * STRICTLY after "now" at schedule time, otherwise it would
       * already be visible to the pre-inject baseline statSync read
       * (which runs at the same virtual instant when the test
       * schedules the reply before calling askJudge/askText) and get
       * folded into the baseline offset instead of being seen as new
       * content by the poll loop. */
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
  spawnLex: JudgeSessionDeps['spawnLex'];
  ptyInject: JudgeSessionDeps['ptyInject'];
  ptyKill: JudgeSessionDeps['ptyKill'];
  getPty: JudgeSessionDeps['getPty'];
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

beforeEach(() => {
  priorFlag = process.env.DEVNEURAL_JUDGE_SESSION;
  delete process.env.DEVNEURAL_JUDGE_SESSION;
  _resetJudgeSessionStateForTests();
});

afterEach(() => {
  if (priorFlag === undefined) delete process.env.DEVNEURAL_JUDGE_SESSION;
  else process.env.DEVNEURAL_JUDGE_SESSION = priorFlag;
  _setJudgeSessionDepsForTests(null);
  _resetJudgeSessionStateForTests();
});

function baseDeps(
  io: ReturnType<typeof makeVirtualIo>,
  pty: ReturnType<typeof makeFakePtyLayer>,
  extra: Partial<JudgeSessionDeps> = {},
): JudgeSessionDeps {
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

describe('askJudge: ask/reply round trip', () => {
  it('parses a strict-JSON reply and tags the injected question with [judge:<kind>]', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));

    const expectedPath = transcriptPathFor({
      cwd: CWD,
      ccSessionId: 'cc-session-1',
      homeDir: HOME_DIR,
    });
    io.scheduleAssistantReply(expectedPath, 0, '{"verdict":"contradicts"}');

    const result = await askJudge({
      kind: 'supersede',
      prompt: 'Open instruction: X\nNew instruction: Y',
      timeoutMs: 5000,
    });

    expect(result).toEqual({ verdict: 'contradicts' });
    expect(pty.spawnCalls.length).toBe(1);
    expect(pty.spawnCalls[0]!.args).toContain('--session-id');
    expect(pty.spawnCalls[0]!.args).toContain('cc-session-1');
    expect(pty.injectCalls.length).toBe(1);
    expect(pty.injectCalls[0]!.text).toContain('[judge:supersede]');
    expect(pty.injectCalls[0]!.text).toContain('Open instruction: X');
    expect(pty.injectCalls[0]!.commit).toBe(true);
  });

  it('tolerates prose around the JSON object (extracts the first {...} block)', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));
    const expectedPath = transcriptPathFor({
      cwd: CWD,
      ccSessionId: 'cc-session-1',
      homeDir: HOME_DIR,
    });
    io.scheduleAssistantReply(
      expectedPath,
      0,
      'sure: {"verdict":"used","reason":"applies the note"} done.',
    );

    const result = await askJudge({
      kind: 'inject_verdict',
      prompt: 'q',
      timeoutMs: 5000,
    });

    expect(result).toEqual({ verdict: 'used', reason: 'applies the note' });
  });

  it('resolves null when the reply has no JSON object at all', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));
    const expectedPath = transcriptPathFor({
      cwd: CWD,
      ccSessionId: 'cc-session-1',
      homeDir: HOME_DIR,
    });
    io.scheduleAssistantReply(expectedPath, 0, 'no idea what you mean');

    const result = await askJudge({ kind: 'alignment', prompt: 'q', timeoutMs: 5000 });
    expect(result).toBeNull();
  });
});

describe('askText: natural-language round trip', () => {
  it('returns the trimmed raw reply text, untagged and unparsed', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));
    const expectedPath = transcriptPathFor({
      cwd: CWD,
      ccSessionId: 'cc-session-1',
      homeDir: HOME_DIR,
    });
    io.scheduleAssistantReply(expectedPath, 0, '  Hi there, what are we building today?  \n');

    const result = await askText({ prompt: 'greet the operator', timeoutMs: 5000 });

    expect(result).toBe('Hi there, what are we building today?');
    expect(pty.injectCalls[0]!.text).toContain('[text]');
    expect(pty.injectCalls[0]!.text).toContain('greet the operator');
  });

  it('prepends an optional system framing line ahead of the prompt', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));
    const expectedPath = transcriptPathFor({
      cwd: CWD,
      ccSessionId: 'cc-session-1',
      homeDir: HOME_DIR,
    });
    io.scheduleAssistantReply(expectedPath, 0, 'On it.');

    await askText({
      system: 'Reply in one short sentence, Jarvis voice.',
      prompt: 'Acknowledge the request.',
      timeoutMs: 5000,
    });

    expect(pty.injectCalls[0]!.text).toContain('[text] Reply in one short sentence, Jarvis voice.');
    expect(pty.injectCalls[0]!.text).toContain('Acknowledge the request.');
  });
});

describe('serialization: one in-flight ask at a time', () => {
  it('a second ask (of either kind) does not inject until the first has resolved', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));
    const path1 = transcriptPathFor({ cwd: CWD, ccSessionId: 'cc-session-1', homeDir: HOME_DIR });
    io.scheduleAssistantReply(path1, 100, '{"verdict":"independent"}');
    io.scheduleAssistantReply(path1, 250, 'second reply text');

    const order: string[] = [];
    const p1 = askJudge({ kind: 'supersede', prompt: 'first', timeoutMs: 5000 }).then((r) => {
      order.push('resolved-1');
      return r;
    });
    const p2 = askText({ prompt: 'second', timeoutMs: 5000 }).then((r) => {
      order.push('resolved-2');
      return r;
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(order).toEqual(['resolved-1', 'resolved-2']);
    expect(r1).toEqual({ verdict: 'independent' });
    expect(r2).toBe('second reply text');
    // Only ONE session was ever spawned -- the second ask reused the
    // already-live PTY rather than racing a second spawn.
    expect(pty.spawnCalls.length).toBe(1);
    expect(pty.injectCalls.length).toBe(2);
    // The second inject's baseline offset must be past the first
    // reply's bytes -- proven indirectly by r2 being exactly the
    // second scheduled line, not a re-read of the first.
  });
});

describe('liveness: timeout marks the session suspect', () => {
  it('a timed-out ask resolves null and increments consecutive_timeouts', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));
    // No reply ever scheduled: the poll loop exhausts its deadline.

    const result = await askJudge({ kind: 'supersede', prompt: 'q', timeoutMs: 300 });

    expect(result).toBeNull();
    expect(_judgeSessionSnapshotForTests().consecutiveTimeouts).toBe(1);
    expect(pty.killCalls.length).toBe(0); // one timeout alone does not kill
  });

  it('a successful reply after a timeout resets the streak to zero', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));

    const missed = await askJudge({ kind: 'supersede', prompt: 'q1', timeoutMs: 200 });
    expect(missed).toBeNull();
    expect(_judgeSessionSnapshotForTests().consecutiveTimeouts).toBe(1);

    const path1 = transcriptPathFor({ cwd: CWD, ccSessionId: 'cc-session-1', homeDir: HOME_DIR });
    io.scheduleAssistantReply(path1, 0, '{"verdict":"independent"}');
    const ok = await askJudge({ kind: 'supersede', prompt: 'q2', timeoutMs: 5000 });

    expect(ok).toEqual({ verdict: 'independent' });
    expect(_judgeSessionSnapshotForTests().consecutiveTimeouts).toBe(0);
  });
});

describe('liveness: respawn after two consecutive timeouts, bounded', () => {
  it('kills the session on the second consecutive timeout, then suppresses a respawn attempt inside the cooldown window', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty, { respawnCooldownMs: 10_000 }));

    const t1 = await askJudge({ kind: 'supersede', prompt: 'q1', timeoutMs: 100 });
    const t2 = await askJudge({ kind: 'supersede', prompt: 'q2', timeoutMs: 100 });
    expect(t1).toBeNull();
    expect(t2).toBeNull();
    // Two consecutive timeouts -> the session was killed.
    expect(pty.killCalls.length).toBe(1);
    expect(_judgeSessionSnapshotForTests().ptyId).toBeNull();
    expect(pty.spawnCalls.length).toBe(1); // still just the original spawn

    // Cooldown has not elapsed (virtual clock only advanced ~200ms of
    // the 10s window) -- a third ask must NOT trigger a second spawn.
    const t3 = await askJudge({ kind: 'supersede', prompt: 'q3', timeoutMs: 50 });
    expect(t3).toBeNull();
    expect(pty.spawnCalls.length).toBe(1);
  });

  it('respawns once the cooldown window has elapsed, and the fresh session answers normally', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty, { respawnCooldownMs: 10_000 }));

    await askJudge({ kind: 'supersede', prompt: 'q1', timeoutMs: 100 });
    await askJudge({ kind: 'supersede', prompt: 'q2', timeoutMs: 100 });
    expect(pty.killCalls.length).toBe(1);
    expect(pty.spawnCalls.length).toBe(1);

    // Fast-forward past the cooldown window.
    io.advanceClock(10_000);

    const path2 = transcriptPathFor({ cwd: CWD, ccSessionId: 'cc-session-2', homeDir: HOME_DIR });
    io.scheduleAssistantReply(path2, 0, '{"verdict":"contradicts"}');
    const result = await askJudge({ kind: 'supersede', prompt: 'q4', timeoutMs: 5000 });

    expect(result).toEqual({ verdict: 'contradicts' });
    expect(pty.spawnCalls.length).toBe(2); // the bounded respawn happened
  });

  it('also respawns when the PTY is found exited externally (not just on timeout)', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty, { respawnCooldownMs: 10_000 }));

    const path1 = transcriptPathFor({ cwd: CWD, ccSessionId: 'cc-session-1', homeDir: HOME_DIR });
    io.scheduleAssistantReply(path1, 0, '{"verdict":"independent"}');
    await askJudge({ kind: 'supersede', prompt: 'q1', timeoutMs: 5000 });
    expect(pty.spawnCalls.length).toBe(1);

    // Simulate an external death (e.g. the claude process crashed)
    // without going through two timeouts.
    pty.killedPtys.add('pty-1');
    io.advanceClock(10_000); // clear the cooldown so the respawn is allowed

    const path2 = transcriptPathFor({ cwd: CWD, ccSessionId: 'cc-session-2', homeDir: HOME_DIR });
    io.scheduleAssistantReply(path2, 0, '{"verdict":"contradicts"}');
    const result = await askJudge({ kind: 'supersede', prompt: 'q2', timeoutMs: 5000 });

    expect(result).toEqual({ verdict: 'contradicts' });
    expect(pty.spawnCalls.length).toBe(2);
  });
});

describe('DEVNEURAL_JUDGE_SESSION flag', () => {
  it('under Vitest, stays disabled until a test explicitly overrides deps (safety backstop)', () => {
    /* No _setJudgeSessionDepsForTests call in THIS test: proves the
     * Vitest-detection guard -- not the env var -- is what gates this.
     * This is the fix for the real-world incident this suite exists to
     * prevent: the moment classifySupersede / judgeInjectionUse /
     * evaluateExpectation were wired through askJudge, pre-existing
     * test files that never mock judge-session.js started spawning
     * real `claude --dangerously-skip-permissions` subprocesses. */
    expect(isJudgeSessionEnabled()).toBe(false);
  });

  it('once a test overrides deps, the flag defaults to enabled', () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));
    expect(isJudgeSessionEnabled()).toBe(true);
  });

  it('"0" disables the session even with deps overridden; askJudge/askText resolve null without ever spawning', async () => {
    process.env.DEVNEURAL_JUDGE_SESSION = '0';
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));

    const judged = await askJudge({ kind: 'supersede', prompt: 'q', timeoutMs: 5000 });
    const texted = await askText({ prompt: 'q', timeoutMs: 5000 });

    expect(judged).toBeNull();
    expect(texted).toBeNull();
    expect(pty.spawnCalls.length).toBe(0);
    expect(pty.injectCalls.length).toBe(0);
  });

  it('any value other than "0" is treated as enabled once deps are overridden', () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setJudgeSessionDepsForTests(baseDeps(io, pty));
    process.env.DEVNEURAL_JUDGE_SESSION = '1';
    expect(isJudgeSessionEnabled()).toBe(true);
    process.env.DEVNEURAL_JUDGE_SESSION = 'true';
    expect(isJudgeSessionEnabled()).toBe(true);
  });
});
