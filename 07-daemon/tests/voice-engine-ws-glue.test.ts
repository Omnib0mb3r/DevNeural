import { describe, expect, it } from 'vitest';
import {
  classifyIncomingTranscript,
  extendedDuringTts,
} from '../src/voice/engine/ws-glue.js';
import { createEchoRegistry } from '../src/voice/engine/echo-filter.js';

/**
 * Glue contracts for wiring the engine into lex-voice-ws:
 *
 * 1. Classification ORDER is the safety property: deterministic
 *    stop-class detection runs BEFORE the echo filter, so a spoken
 *    "hold on" always interrupts even when Lex's own reply contained
 *    those words. Echo discard runs before the top layer so echo can
 *    never become a user turn.
 * 2. The during-TTS window extends to CLIENT DRAIN, not synth end:
 *    daemon ttsActive is null seconds before the speakers go quiet.
 */
describe('classifyIncomingTranscript: stop-class first, echo second, then process', () => {
  it('stop-class wins even when the words appear in the spoken reply', () => {
    const reg = createEchoRegistry();
    reg.remember('hold on while I check the tests for you', 1_000);
    const v = classifyIncomingTranscript({
      text: 'hold on',
      echoRegistry: reg,
      nowMs: 2_000,
      duringTts: true,
    });
    expect(v.action).toBe('interrupt_work');
  });

  it('"shut up" classifies stop_speaking', () => {
    const reg = createEchoRegistry();
    const v = classifyIncomingTranscript({
      text: 'shut up',
      echoRegistry: reg,
      nowMs: 1_000,
      duringTts: true,
    });
    expect(v.action).toBe('stop_speaking');
  });

  it('an echo of the spoken reply is dropped with the matched line', () => {
    const reg = createEchoRegistry();
    reg.remember('Cancelled call.', 1_000);
    const v = classifyIncomingTranscript({
      text: 'cancelled call',
      echoRegistry: reg,
      nowMs: 3_000,
      duringTts: false,
    });
    expect(v.action).toBe('echo-drop');
    expect(v.echoMatched).toBe('Cancelled call.');
  });

  it('a real utterance processes with remainder intact', () => {
    const reg = createEchoRegistry();
    reg.remember('The build finished and everything is green.', 1_000);
    const v = classifyIncomingTranscript({
      text: 'okay now run the deploy script',
      echoRegistry: reg,
      nowMs: 2_000,
      duringTts: false,
    });
    expect(v.action).toBe('process');
    expect(v.remainder).toBe('okay now run the deploy script');
  });

  it('a leading stop with content carries the remainder for forwarding', () => {
    const reg = createEchoRegistry();
    const v = classifyIncomingTranscript({
      text: 'Stop, use the staging database instead.',
      echoRegistry: reg,
      nowMs: 1_000,
      duringTts: true,
    });
    expect(v.action).toBe('interrupt_work');
    expect(v.remainder.length).toBeGreaterThan(0);
  });
});

describe('extendedDuringTts: the window closes at client drain, not synth end', () => {
  it('active daemon synthesis counts', () => {
    expect(
      extendedDuringTts({ ttsActive: true, clientPlaybackActive: false }),
    ).toBe(true);
  });

  it('the drain tail counts: synth done, client still playing', () => {
    expect(
      extendedDuringTts({ ttsActive: false, clientPlaybackActive: true }),
    ).toBe(true);
  });

  it('fully quiet is not during TTS', () => {
    expect(
      extendedDuringTts({ ttsActive: false, clientPlaybackActive: false }),
    ).toBe(false);
  });
});
