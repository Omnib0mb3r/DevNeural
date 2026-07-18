import { describe, expect, it } from 'vitest';
import {
  _topOwnsAckAfterForwardImpl,
  _shouldSpeakDeepAckImpl,
} from '../src/voice/lex-voice-ws.js';

/**
 * P1 (2026-07-18 VOICE-TOP-LAYER-SMARTS-SPEC): the TOP (haiku) layer
 * OWNS its ack. On every escalated utterance the top emits its own
 * instant handoff line as the ack; the DEEP layer then stops emitting
 * pre-tool acks for that turn (kills the double-ack + the stale-ack
 * race where Lex's first sentence, echoed up late, was the ack).
 *
 * The safety net: when the top produced NO handoff at all (the
 * fail-safe forward: session down / timeout, forward-only, no speech),
 * the deep pre-tool ack is allowed through so the operator still hears
 * an ack. Exactly one ack per escalated utterance, never two.
 *
 * Both decisions are pure + module-level so they pin without a socket.
 */

describe('_topOwnsAckAfterForwardImpl (P1 did the top ack?)', () => {
  it('owns the ack when the top streamed a handoff line', () => {
    expect(
      _topOwnsAckAfterForwardImpl({ earlySpokenCount: 1, remainderSpeech: null }),
    ).toBe(true);
  });

  it('owns the ack when the top spoke a final remainder handoff', () => {
    expect(
      _topOwnsAckAfterForwardImpl({
        earlySpokenCount: 0,
        remainderSpeech: 'On it, checking with Lex.',
      }),
    ).toBe(true);
  });

  it('owns the ack when the top both streamed and left a remainder', () => {
    expect(
      _topOwnsAckAfterForwardImpl({ earlySpokenCount: 2, remainderSpeech: 'x' }),
    ).toBe(true);
  });

  it('does NOT own the ack on the fail-safe forward (no speech at all)', () => {
    /* Session down / timeout: forward = raw utterance, speech = null,
     * nothing streamed. The top never acked, so the deep fallback must
     * be allowed. */
    expect(
      _topOwnsAckAfterForwardImpl({ earlySpokenCount: 0, remainderSpeech: null }),
    ).toBe(false);
  });
});

describe('_shouldSpeakDeepAckImpl (P1 deep stops acking once top owns it)', () => {
  it('suppresses the deep pre-tool ack when the top owns the ack', () => {
    const d = _shouldSpeakDeepAckImpl({ topOwnsAck: true });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('top-owns-ack');
  });

  it('speaks the deep pre-tool ack as the fallback when the top did not ack', () => {
    const d = _shouldSpeakDeepAckImpl({ topOwnsAck: false });
    expect(d.speak).toBe(true);
    expect(d.reason).toBe('no-top-ack-fallback');
  });

  it('composed: a normal forward yields exactly one ack (top), never two', () => {
    /* Top streamed a handoff -> owns the ack -> deep ack suppressed. */
    const owns = _topOwnsAckAfterForwardImpl({
      earlySpokenCount: 1,
      remainderSpeech: null,
    });
    expect(owns).toBe(true);
    expect(_shouldSpeakDeepAckImpl({ topOwnsAck: owns }).speak).toBe(false);
  });

  it('composed: a fail-safe forward still yields one ack (deep fallback)', () => {
    const owns = _topOwnsAckAfterForwardImpl({
      earlySpokenCount: 0,
      remainderSpeech: null,
    });
    expect(owns).toBe(false);
    expect(_shouldSpeakDeepAckImpl({ topOwnsAck: owns }).speak).toBe(true);
  });
});
