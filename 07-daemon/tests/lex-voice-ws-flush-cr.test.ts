import { describe, it, expect } from 'vitest';
import {
  _flushPendingUtterancesImpl,
  type _FlushPendingUtterancesState,
} from '../src/voice/lex-voice-ws.js';

/* Regression: mid-turn flush must follow the atomic write with an
 * explicit bare-CR ~850 ms later. Same belt-and-suspenders the
 * cross-session-inject path applies, because bridge-attached workers
 * occasionally accept the paste into the input field but never
 * submit. Without the follow-up the cursor sits after the voice tag
 * and the worker stays idle. */
describe('flushPendingUtterances bare-CR follow-up', () => {
  it('fires two ptyInject calls: body+commit then bare CR no-commit', () => {
    const calls: Array<{ key: string; text: string; commit: boolean }> = [];
    const ptyInject = (
      key: string,
      text: string,
      commit: boolean,
    ): { ok: true } => {
      calls.push({ key, text, commit });
      return { ok: true };
    };

    const sends: Array<Record<string, unknown>> = [];
    const send = (msg: Record<string, unknown>): void => {
      sends.push(msg);
    };

    let scheduledCallback: (() => void) | null = null;
    let scheduledDelay = 0;
    const scheduleFollowupCr = (fn: () => void, delayMs: number): void => {
      scheduledCallback = fn;
      scheduledDelay = delayMs;
    };

    const state: _FlushPendingUtterancesState = {
      pendingUserUtterances: ['hello lex test utterance'],
      bindKey: 'pty-test-123',
      mode: 'conversation',
      awaitingResponseSince: 0,
    };

    _flushPendingUtterancesImpl({
      state,
      ptyInject,
      send,
      scheduleFollowupCr,
      log: () => undefined,
    });

    // After the primary inject, exactly one call has fired and the
    // follow-up has been scheduled but not yet executed.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.commit).toBe(true);
    expect(calls[0]?.key).toBe('pty-test-123');
    expect(calls[0]?.text).toContain('hello lex test utterance');
    expect(calls[0]?.text).toContain('[voice mode]');
    expect(scheduledDelay).toBe(850);
    expect(scheduledCallback).toBeTypeOf('function');

    // Fire the scheduled follow-up.
    scheduledCallback?.();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe('pty-test-123');
    expect(calls[1]?.text).toBe('\r');
    expect(calls[1]?.commit).toBe(false);

    // State side-effects: queue cleared, awaiting stamped, success
    // frame emitted to the WS.
    expect(state.pendingUserUtterances).toEqual([]);
    expect(state.awaitingResponseSince).toBeGreaterThan(0);
    expect(
      sends.some((s) => s.t === 'injected' && s.source === 'mid-turn-queue-flush'),
    ).toBe(true);
  });

  it('skips the follow-up when the primary inject fails', () => {
    const calls: Array<{ text: string; commit: boolean }> = [];
    const ptyInject = (
      _key: string,
      text: string,
      commit: boolean,
    ): { ok: false; error: string } => {
      calls.push({ text, commit });
      return { ok: false, error: 'pty exited' };
    };

    let scheduledFired = false;
    const scheduleFollowupCr = (): void => {
      scheduledFired = true;
    };

    const state: _FlushPendingUtterancesState = {
      pendingUserUtterances: ['queued message'],
      bindKey: 'pty-dead',
      mode: 'conversation',
      awaitingResponseSince: 0,
    };

    _flushPendingUtterancesImpl({
      state,
      ptyInject,
      send: () => undefined,
      scheduleFollowupCr,
      log: () => undefined,
    });

    // Primary inject attempted exactly once, follow-up never scheduled,
    // queue restored so a later retry can recover.
    expect(calls).toHaveLength(1);
    expect(scheduledFired).toBe(false);
    expect(state.pendingUserUtterances).toEqual(['queued message']);
    expect(state.awaitingResponseSince).toBe(0);
  });
});
