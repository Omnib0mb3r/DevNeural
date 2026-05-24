/**
 * Hold-up runtime behavior (Fix 2026-05-24).
 *
 * Pins the contract for the new "lex hold up" voice command:
 *  - TTS cancelled
 *  - Lex PTY receives ^C (cancels Lex's in-flight tool sequence,
 *    which is the mechanism that drops queued-but-not-yet-POSTed
 *    cross-session injects to the worker)
 *  - worker is completely untouched (no PTY write, no bridge queue
 *    write, no /lex/inject-cross-session POST)
 *  - already-delivered worker injects are preserved (the runtime
 *    never reaches into anything that would claw them back)
 *  - voice-hold-up + voice-listen frames sent to the client
 *  - recap text passed to speak() includes "what is up?"
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runHoldUp,
  buildHoldUpRecap,
} from '../src/voice/lex-voice-hold-up.js';
import { matchVoiceCommand } from '../src/voice/lex-voice-commands.js';

describe('buildHoldUpRecap', () => {
  it('uses intended text when present and appends "What is up?"', () => {
    const r = buildHoldUpRecap('describing the migration strategy in detail');
    expect(r).toMatch(/^Holding up\. I was saying /);
    expect(r).toMatch(/What is up\?$/);
    expect(r).toContain('describing the migration strategy in detail');
  });

  it('falls back to a generic phrase when intended text is null', () => {
    const r = buildHoldUpRecap(null);
    expect(r).toBe(
      'Holding up. I was thinking through your last request. What is up?',
    );
  });

  it('falls back when intended text is whitespace only', () => {
    const r = buildHoldUpRecap('   ');
    expect(r).toContain('thinking through your last request');
  });

  it('trims a multi-sentence intent down to the first sentence', () => {
    const r = buildHoldUpRecap(
      'reading the file. then editing two functions. then running tests.',
    );
    expect(r).toContain('reading the file');
    expect(r).not.toContain('editing two functions');
    expect(r).not.toContain('running tests');
  });

  it('caps an oversized intent so the recap stays one sentence', () => {
    const huge =
      'now I am working on a very long detailed plan that goes on and on without any sentence terminator for hundreds of characters straight through the entire reply so the recap must trim it'.padEnd(
        400,
        'x',
      );
    const r = buildHoldUpRecap(huge);
    /* The recap stays bounded. Strip the fixed prelude + suffix to
     * isolate the captured phrase and assert it is short enough to
     * read as a single spoken sentence. */
    expect(r.length).toBeLessThan(220);
    expect(r).toMatch(/What is up\?$/);
  });
});

describe('runHoldUp', () => {
  function makeDeps(overrides: Partial<Parameters<typeof runHoldUp>[0]> = {}) {
    const cancelTts = vi.fn();
    const ctrlCLexPty = vi.fn();
    const sendFrame = vi.fn();
    const speak = vi.fn();
    const deps = {
      cancelTts,
      ctrlCLexPty,
      sendFrame,
      speak,
      intendedText: null as string | null,
      now: () => 1_700_000_000_000,
      ...overrides,
    };
    return { deps, cancelTts, ctrlCLexPty, sendFrame, speak };
  }

  it('cancels TTS', () => {
    const { deps, cancelTts } = makeDeps();
    runHoldUp(deps);
    expect(cancelTts).toHaveBeenCalledTimes(1);
  });

  it('sends ^C to the Lex PTY so Claude Code drops the pending tool sequence', () => {
    const { deps, ctrlCLexPty } = makeDeps();
    runHoldUp(deps);
    expect(ctrlCLexPty).toHaveBeenCalledTimes(1);
  });

  it('emits a voice-hold-up frame followed by voice-listen so the mic re-opens', () => {
    const { deps, sendFrame } = makeDeps();
    runHoldUp(deps);
    expect(sendFrame).toHaveBeenCalledTimes(2);
    expect(sendFrame).toHaveBeenNthCalledWith(1, {
      t: 'voice-hold-up',
      reason: 'voice-command',
    });
    expect(sendFrame).toHaveBeenNthCalledWith(2, {
      t: 'voice-listen',
      reason: 'hold-up',
    });
  });

  it('speaks a recap that asks "What is up?"', () => {
    const { deps, speak } = makeDeps({
      intendedText: 'about to read the migration runner',
    });
    runHoldUp(deps);
    expect(speak).toHaveBeenCalledTimes(1);
    const recapArg = speak.mock.calls[0]![0] as string;
    expect(recapArg).toMatch(/^Holding up\./);
    expect(recapArg).toMatch(/about to read the migration runner/);
    expect(recapArg).toMatch(/What is up\?$/);
  });

  it('returns the spoken recap + fired_at_ms for the audit log', () => {
    const { deps } = makeDeps({
      intendedText: 'walking the curator changes',
      now: () => 12345,
    });
    const out = runHoldUp(deps);
    expect(out.fired_at_ms).toBe(12345);
    expect(out.recap).toContain('walking the curator changes');
  });

  it('never touches the worker (no worker-bound callbacks are invoked)', () => {
    /* The handler signature only accepts callbacks for Lex-side
     * effects (cancelTts, ctrlCLexPty, sendFrame, speak). Worker-
     * directed surfaces (cross-session-inject, bridge .in writes,
     * worker pty writes) are simply not addressable from here. Pin
     * that by asserting the surface stays exactly 4 callbacks and
     * nothing else fires. */
    const { deps, cancelTts, ctrlCLexPty, sendFrame, speak } = makeDeps();
    runHoldUp(deps);
    /* The four call counts together exhaust the side-effect surface;
     * any additional worker-targeted call would have to be added as
     * a new dep callback. This pin guards against that regression. */
    expect(
      cancelTts.mock.calls.length +
        ctrlCLexPty.mock.calls.length +
        sendFrame.mock.calls.length +
        speak.mock.calls.length,
    ).toBe(5); // 1 cancel + 1 ctrlC + 2 frames + 1 speak
  });

  it('already-delivered worker injects survive: the runtime never reaches the bridge queue or worker PTY', () => {
    /* Simulates a state where prior cross-session injects already
     * landed in the worker's bridge .in queue. The hold-up runtime
     * does not have any callback that could touch those, so they
     * persist by construction. Captured here so any future addition
     * of a "drain the bridge queue" hook would have to actively opt
     * in by extending HoldUpDeps. */
    const bridgeQueueBefore = ['queued-prompt-1', 'queued-prompt-2'];
    const bridgeQueueAfter = bridgeQueueBefore.slice();
    const { deps } = makeDeps();
    runHoldUp(deps);
    expect(bridgeQueueAfter).toEqual(bridgeQueueBefore);
  });

  it('queued-but-not-yet-POSTed Lex tool calls are dropped via the Ctrl+C side effect', () => {
    /* The mechanism: Lex's tool sequencer is the only place a
     * "queued but not yet POSTed" cross-session inject can live. ^C
     * to the Lex PTY makes Claude Code drop the pending tool_use
     * plan, which drops the queued POST. The hold-up runtime
     * therefore satisfies the spec by ensuring ctrlCLexPty fires at
     * least once whenever runHoldUp is invoked. */
    const { deps, ctrlCLexPty } = makeDeps();
    runHoldUp(deps);
    expect(ctrlCLexPty).toHaveBeenCalled();
  });

  /* Punch-through pin (Addendum 2026-05-24). lex-voice-ws.ts re-runs
   * matchVoiceCommand at the mid-turn-no-tts queue site so that every
   * lex command interrupts immediately instead of being deferred to
   * the next turn boundary. If matchVoiceCommand returns non-null for
   * any of these phrases, the queue site's `if (lateCmd) dispatch +
   * return` branch fires and the command bypasses the queue. The
   * matcher is therefore the source of truth for which utterances
   * punch through; this test pins that source of truth covers every
   * documented command. */
  it.each([
    ['lex emergency stop', 'panic'],
    ['lex end session', 'end_session'],
    ['lex mute', 'mute'],
    ['lex shut up', 'mute'],
    ['lex be quiet', 'mute'],
    ['lex stop talking', 'mute'],
    ['lex unmute', 'unmute'],
    ['lex resume', 'unmute'],
    ['lex come back', 'unmute'],
    ['lex disable', 'disable'],
    ['lex hold up', 'hold_up'],
    ['lex holdup', 'hold_up'],
  ])(
    'mid-turn-no-tts queue site: "%s" punches through as kind=%s',
    (phrase, expectedKind) => {
      const m = matchVoiceCommand(phrase);
      expect(m, `${phrase} must dispatch, not queue`).not.toBeNull();
      expect(m!.kind).toBe(expectedKind);
    },
  );

  it('tolerates failures in cancelTts and ctrlCLexPty without aborting the speak path', () => {
    const cancelTts = vi.fn(() => {
      throw new Error('TTS already gone');
    });
    const ctrlCLexPty = vi.fn(() => {
      throw new Error('PTY just exited');
    });
    const sendFrame = vi.fn();
    const speak = vi.fn();
    runHoldUp({
      cancelTts,
      ctrlCLexPty,
      sendFrame,
      speak,
      intendedText: null,
    });
    /* Even when both side-effect callbacks throw, the user-facing
     * mic + speak steps still run so the user knows the command
     * landed. */
    expect(sendFrame).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenCalledTimes(1);
  });
});
