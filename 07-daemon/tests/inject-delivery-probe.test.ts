import { beforeEach, describe, expect, it } from 'vitest';
import {
  INJECT_PROBE_MARKER,
  INJECT_PROBE_MESSAGE,
  _resetInjectDeliveryForTests,
  classifyProbeScreen,
  getInjectDeliveryStatus,
  isInputReady,
  runInjectDeliveryProbe,
  type InjectProbeDeps,
} from '../src/lex/inject-delivery-probe.js';

/**
 * BUG-059 (2026-09-30): Claude Code held typed messages as a paste
 * ("Removed 1 invisible character · review and press Enter to send") and
 * nothing in the daemon noticed. The probe types a long message into a
 * real session after boot and reports whether it was answered.
 */
describe('classifyProbeScreen', () => {
  it('reads the model reply as answered', () => {
    expect(classifyProbeScreen(`\x1b[1m● ${INJECT_PROBE_MARKER}\x1b[0m`)).toBe('answered');
  });

  it('reads the Claude Code paste hold as held', () => {
    expect(
      classifyProbeScreen('Removed 1 invisible character · review and press Enter to send'),
    ).toBe('held');
  });

  it('is pending while neither has appeared', () => {
    expect(classifyProbeScreen('❯ Delivery probe from the DevNeural daemon')).toBe('pending');
  });

  it('the probe message never contains the marker, so an echo of the input cannot pass', () => {
    expect(INJECT_PROBE_MESSAGE.includes(INJECT_PROBE_MARKER)).toBe(false);
    expect(INJECT_PROBE_MESSAGE.length).toBeGreaterThan(118);
    expect(INJECT_PROBE_MESSAGE.includes('\n')).toBe(false);
  });
});

describe('isInputReady', () => {
  it('waits for the input box glyph', () => {
    expect(isInputReady('Claude Code v2.1.285')).toBe(false);
    expect(isInputReady('\x1b[2m❯\x1b[0m Try "fix lint errors"')).toBe(true);
  });

  it('recognises the box under the daemon, where the glyph is a plain ">" and spaces are swallowed', () => {
    /* Screen captured from the in-daemon probe, 2026-09-30. */
    expect(
      isInputReady('> Try"refactor<filepath>" ⏵⏵bypasspermissionson (shift+tabtocycle)'),
    ).toBe(true);
  });
});

/* A fake session: screen output is pushed by the test; the clock only
 * moves when the probe waits, so timeouts run instantly. */
function fakeDeps(onInject: (emit: (d: string) => void) => void): {
  deps: InjectProbeDeps;
  killed: string[];
  injected: string[];
  logs: string[];
} {
  let t = 0;
  let emit: (d: string) => void = () => undefined;
  const killed: string[] = [];
  const injected: string[] = [];
  const logs: string[] = [];
  const deps: InjectProbeDeps = {
    log: (m) => logs.push(m),
    spawn: () => ({ ptyId: `pty-${killed.length + 1}` }),
    onData: (_id, cb) => {
      emit = cb;
      cb('Claude Code v2.1.285\r\n❯ ');
    },
    inject: (_id, text) => {
      injected.push(text);
      onInject(emit);
      return { ok: true };
    },
    kill: (id) => killed.push(id),
    delay: async (ms) => {
      t += Math.max(ms, 1);
    },
    now: () => t,
  };
  return { deps, killed, injected, logs };
}

describe('runInjectDeliveryProbe', () => {
  beforeEach(() => _resetInjectDeliveryForTests());

  it('reports ok when the typed message is answered, and kills the session', async () => {
    const f = fakeDeps((emit) => emit(`\r\n● ${INJECT_PROBE_MARKER}`));
    const r = await runInjectDeliveryProbe(f.deps);
    expect(r.status).toBe('ok');
    expect(getInjectDeliveryStatus().status).toBe('ok');
    expect(f.injected).toEqual([INJECT_PROBE_MESSAGE]);
    expect(f.killed).toEqual(['pty-1']);
    expect(f.logs.some((l) => l.startsWith('[inject-probe] ok'))).toBe(true);
  });

  it('reports failed with the held reason, retries once, kills both sessions', async () => {
    const f = fakeDeps((emit) =>
      emit('Removed 1 invisible character · review and press Enter to send'),
    );
    const r = await runInjectDeliveryProbe(f.deps);
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/attempt 2: Claude Code held the message/);
    expect(f.killed.length).toBe(2);
    expect(f.logs.filter((l) => l.startsWith('[inject-probe] FAILED')).length).toBe(2);
  });

  it('reports failed on silence instead of hanging', async () => {
    const f = fakeDeps(() => undefined);
    const r = await runInjectDeliveryProbe(f.deps);
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/no reply within/);
  });

  it('ignores a marker that was on screen before the inject', async () => {
    const f = fakeDeps(() => undefined);
    const base = f.deps.onData!;
    f.deps.onData = (id, cb) => {
      base(id, cb);
      cb(`system prompt mentions ${INJECT_PROBE_MARKER}`);
    };
    const r = await runInjectDeliveryProbe(f.deps);
    expect(r.status).toBe('failed');
  });
});
