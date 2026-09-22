/**
 * One Layer 1 voice session PER BRAINSTORM ANCHOR (LAYER-1-CONTROL.md,
 * "Scope: one L1 per brainstorm, no cross-context"). The module used to
 * hold a single daemon-wide session; two open brainstorms would have
 * shared one voice brain and bled context across each other. Now every
 * anchor id keys its own session, warmup, ask queue and binding.
 *
 * Same virtual-clock rig as voice-brain-session.test.ts; nothing here
 * spawns a real `claude`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  askVoice,
  isVoiceBrainSessionWarm,
  killVoiceBrainSession,
  listVoiceBrainSessions,
  prewarmVoiceBrainSession,
  _resetVoiceBrainSessionStateForTests,
  _setVoiceBrainSessionDepsForTests,
  _voiceBrainWarmupForTests,
  type VoiceBrainSessionDeps,
} from '../src/lex/voice-brain-session.js';
import { transcriptPathFor } from '../src/lex/spawn-lex-session.js';

const CWD = 'C:/fake/voice-brain-cwd';
const HOME_DIR = 'C:/fake/home';

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
    scheduleAssistantRecord: (path, delayMs, text, stopReason) => {
      const message: {
        content: Array<{ type: string; text: string }>;
        stop_reason?: string;
      } = { content: text === null ? [] : [{ type: 'text', text }] };
      if (stopReason !== undefined) message.stop_reason = stopReason;
      pending.push({
        path,
        arrivesAt: ms + Math.max(delayMs, 1),
        line: `${JSON.stringify({ type: 'assistant', message })}\n`,
      });
    },
  };
}

function makeFakePtyLayer(): {
  spawnLex: VoiceBrainSessionDeps['spawnLex'];
  ptyInject: VoiceBrainSessionDeps['ptyInject'];
  ptyKill: VoiceBrainSessionDeps['ptyKill'];
  getPty: VoiceBrainSessionDeps['getPty'];
  randomUUID: () => string;
  spawnCalls: Array<{ cwd: string; args?: string[]; sessionId?: string }>;
  injectCalls: Array<{ ptyId: string; text: string; commit?: boolean }>;
  killCalls: string[];
} {
  const spawnCalls: Array<{ cwd: string; args?: string[]; sessionId?: string }> = [];
  const injectCalls: Array<{ ptyId: string; text: string; commit?: boolean }> = [];
  const killCalls: string[] = [];
  const killed = new Set<string>();
  let ptyCounter = 0;
  let uuidCounter = 0;
  return {
    spawnCalls,
    injectCalls,
    killCalls,
    spawnLex: (opts) => {
      spawnCalls.push(opts);
      ptyCounter += 1;
      return { ptyId: `pty-${ptyCounter}`, pid: 1000 + ptyCounter };
    },
    ptyInject: (ptyId, text, commit) => {
      injectCalls.push({ ptyId, text, commit });
      return killed.has(ptyId) ? { ok: false, error: 'pty has exited' } : { ok: true };
    },
    ptyKill: (ptyId) => {
      killCalls.push(ptyId);
      killed.add(ptyId);
      return true;
    },
    getPty: (ptyId) => ({ exited: killed.has(ptyId) }),
    randomUUID: () => {
      uuidCounter += 1;
      return `cc-session-${uuidCounter}`;
    },
  };
}

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
    runtimeConfig: () => ({ getRuntimeConfig: () => null }),
    persistBinding: () => undefined,
    ...extra,
  };
}

function pathForSession(n: number): string {
  return transcriptPathFor({ cwd: CWD, ccSessionId: `cc-session-${n}`, homeDir: HOME_DIR });
}

/* Spawn + boot-probe an anchor's session to warm. Returns its jsonl
 * path (the Nth spawn gets cc-session-N). */
async function warmSession(
  io: ReturnType<typeof makeVirtualIo>,
  pty: ReturnType<typeof makeFakePtyLayer>,
  anchorId: string | null,
): Promise<string> {
  const path = pathForSession(pty.spawnCalls.length + 1);
  io.scheduleAssistantRecord(path, 3_500, 'OK');
  prewarmVoiceBrainSession(anchorId);
  await _voiceBrainWarmupForTests(anchorId);
  expect(isVoiceBrainSessionWarm(anchorId)).toBe(true);
  return path;
}

beforeEach(() => {
  delete process.env.DEVNEURAL_VOICE_BRAIN_SESSION;
  _resetVoiceBrainSessionStateForTests();
});
afterEach(() => {
  _setVoiceBrainSessionDepsForTests(null);
  _resetVoiceBrainSessionStateForTests();
});

describe('one L1 per brainstorm anchor', () => {
  it('two anchors get two sessions, bindings persist per anchor, asks route to their own pty', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    const bindings: Array<[string, { voice_session_id: string | null; voice_pty_id: string | null }]> = [];
    _setVoiceBrainSessionDepsForTests(
      baseDeps(io, pty, { persistBinding: (a, b) => bindings.push([a, b]) }),
    );
    const pathA = await warmSession(io, pty, 'anchor-a');
    const pathB = await warmSession(io, pty, 'anchor-b');
    expect(pty.spawnCalls).toHaveLength(2);
    expect(bindings.map(([a]) => a)).toEqual(['anchor-a', 'anchor-b']);
    expect(bindings[0]![1]).toMatchObject({ voice_session_id: 'cc-session-1', voice_pty_id: 'pty-1' });
    expect(bindings[1]![1]).toMatchObject({ voice_session_id: 'cc-session-2', voice_pty_id: 'pty-2' });

    /* Schedule each reply right before its ask: the virtual clock only
     * advances while an ask polls, and a record that "arrived" before an
     * ask's baseline read is folded into the offset, never seen as new. */
    io.scheduleAssistantRecord(pathA, 50, 'from a', 'end_turn');
    expect(await askVoice({ anchorId: 'anchor-a', prompt: 'x', timeoutMs: 5000 })).toBe('from a');
    io.scheduleAssistantRecord(pathB, 50, 'from b', 'end_turn');
    expect(await askVoice({ anchorId: 'anchor-b', prompt: 'x', timeoutMs: 5000 })).toBe('from b');
    expect(pty.injectCalls.filter((c) => c.text === 'x').map((c) => c.ptyId)).toEqual([
      'pty-1',
      'pty-2',
    ]);
  });

  it('killVoiceBrainSession kills only that anchor and forgets it', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 'anchor-a');
    await warmSession(io, pty, 'anchor-b');
    killVoiceBrainSession('anchor-a', 'anchor-end');
    expect(pty.killCalls).toEqual(['pty-1']);
    expect(isVoiceBrainSessionWarm('anchor-a')).toBe(false);
    expect(isVoiceBrainSessionWarm('anchor-b')).toBe(true);
    expect(listVoiceBrainSessions().map((s) => s.anchorId)).toEqual(['anchor-b']);
  });

  it('a null anchor uses the shared default session and never persists a binding', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    const bindings: string[] = [];
    _setVoiceBrainSessionDepsForTests(
      baseDeps(io, pty, { persistBinding: (a) => bindings.push(a) }),
    );
    await warmSession(io, pty, null);
    expect(isVoiceBrainSessionWarm(null)).toBe(true);
    expect(isVoiceBrainSessionWarm(undefined)).toBe(true);
    expect(listVoiceBrainSessions().map((s) => s.anchorId)).toEqual(['default']);
    /* The registry key is 'default'; the persist dep decides what to do
     * with it (production skips it: there is no lex_session row). */
    expect(bindings).toEqual(['default']);
  });

  it('prewarm is idempotent per anchor', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 'anchor-a');
    prewarmVoiceBrainSession('anchor-a');
    prewarmVoiceBrainSession('anchor-a');
    expect(pty.spawnCalls).toHaveLength(1);
  });
});
