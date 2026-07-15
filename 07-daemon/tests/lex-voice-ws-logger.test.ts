import { describe, expect, it } from 'vitest';
import {
  _flushPendingUtterancesImpl,
  type _FlushPendingUtterancesState,
  setVoiceWsLogger,
} from '../src/voice/lex-voice-ws.js';

/**
 * daemon.stdout.log / daemon.stderr.log sit at 0 bytes after days of
 * uptime (Start-Process redirect targets are never actually written to),
 * so every console.log in lex-voice-ws.ts was an invisible diagnostic.
 * setVoiceWsLogger wires the module's console.* call sites into the
 * daemon's rotation-capped daemon.log instead. This pins the wiring: a
 * representative diagnostic (the mid-turn-no-tts queue flush, exercised
 * without a `deps.log` override so it falls through to the module-level
 * logger) must reach the injected logger, and the module must default
 * to a silent no-op when no logger has been set.
 */
describe('lex-voice-ws injected logger', () => {
  it('defaults to a silent no-op when no logger has been set', () => {
    const state: _FlushPendingUtterancesState = {
      pendingUserUtterances: ['hello'],
      bindKey: 'pty-default-noop',
      mode: 'conversation',
      awaitingResponseSince: 0,
    };
    // No setVoiceWsLogger call in this test, and deps.log omitted:
    // must not throw when the flush falls through to the module default.
    expect(() =>
      _flushPendingUtterancesImpl({
        state,
        ptyInject: () => ({ ok: true }),
        send: () => undefined,
        scheduleFollowupCr: () => undefined,
      }),
    ).not.toThrow();
  });

  it('routes a representative diagnostic through setVoiceWsLogger when deps.log is omitted', () => {
    const captured: string[] = [];
    setVoiceWsLogger((msg) => captured.push(msg));

    const state: _FlushPendingUtterancesState = {
      pendingUserUtterances: ['queued utterance'],
      bindKey: 'pty-logger-test',
      mode: 'conversation',
      awaitingResponseSince: 0,
    };

    _flushPendingUtterancesImpl({
      state,
      ptyInject: () => ({ ok: true }),
      send: () => undefined,
      scheduleFollowupCr: () => undefined,
      // deps.log intentionally omitted: exercises the `deps.log ?? logFn`
      // fallback added when migrating this call site off console.log.
    });

    expect(
      captured.some((m) => m === '[voice-ws] mid-turn-no-tts queue flush count=1'),
    ).toBe(true);

    // Restore the no-op so later assertions in other files never see
    // this test's spy fire.
    setVoiceWsLogger(() => undefined);
  });
});
