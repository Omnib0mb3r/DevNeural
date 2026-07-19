/**
 * Barge kill path (2026-07-19, SPEC-2026-07-18-voice-binding-fixes).
 *
 * Live failure: barge word-gate FIRED during active TTS (daemon.log)
 * but audio never stopped. Root cause: killActiveTts only shipped the
 * client tts-cancel when speakCtrl.killActive() returned true, and
 * killActive() returns false whenever state.ttsActive is null. During a
 * REAL barge the audio is CLIENT-buffered playback that outlives the
 * daemon synth ctx (voice-brain "ask replied" fires before the client
 * finishes playing), so state.ttsActive is already null, killActive()
 * returns false, and NO tts-cancel frame reached the client - audio kept
 * playing.
 *
 * Principle (locked): arm AND kill both point at the SPEECH/PLAYBACK
 * layer (clientPlaybackActive), never the brain (state.ttsActive). The
 * cancel (mouth-stop) keys off clientPlaybackActive; only the destructive
 * turn-teardown (bargeStash / PTY Ctrl+C) stays gated on a real synth
 * cancellation so a phantom barge never hard-interrupts the worker.
 */
import { describe, expect, it } from 'vitest';
import { _killActiveTtsDecision } from '../src/voice/lex-voice-ws.js';

describe('_killActiveTtsDecision (barge kill points at the playback layer)', () => {
  it('emits tts-cancel on a client-buffered barge even when killActive() returned false (state.ttsActive null)', () => {
    /* THE FIX: gate fired, synth ctx already gone, but the client is
     * still playing buffered audio - the cancel MUST reach the client. */
    const d = _killActiveTtsDecision({
      cancelled: false,
      clientPlaybackActive: true,
    });
    expect(d.emitCancel).toBe(true);
    /* Destructive parts stay off: no real synth ctx was cancelled, so a
     * phantom barge cannot lose the queue or Ctrl+C the worker. */
    expect(d.runTeardown).toBe(false);
  });

  it('stays silent when neither a synth ctx nor client playback is active (unchanged idle kill)', () => {
    const d = _killActiveTtsDecision({
      cancelled: false,
      clientPlaybackActive: false,
    });
    expect(d.emitCancel).toBe(false);
    expect(d.runTeardown).toBe(false);
  });

  it('emits tts-cancel AND runs teardown on a real synth cancellation (unchanged destructive path)', () => {
    const d = _killActiveTtsDecision({
      cancelled: true,
      clientPlaybackActive: false,
    });
    expect(d.emitCancel).toBe(true);
    expect(d.runTeardown).toBe(true);
  });

  it('runs teardown on a real synth cancellation regardless of client playback state', () => {
    const d = _killActiveTtsDecision({
      cancelled: true,
      clientPlaybackActive: true,
    });
    expect(d.emitCancel).toBe(true);
    expect(d.runTeardown).toBe(true);
  });
});
