/**
 * Typed-input transcript fix (2026-07-19).
 *
 * The Lex transcript panel renders from live WS `assistant-text` frames,
 * never from a brainstorm_chunks poll. The direct-llm reply path used to
 * deliver the reply ONLY through speak(), so a typed turn (TTS
 * suppressed) persisted the reply to the DB but never emitted an
 * assistant-text frame - the reply was invisible in the transcript.
 *
 * planDirectLlmReplyDelivery decouples the transcript render from TTS:
 * a reply renders for EVERY turn with text (typed or voice); only
 * whether it is SPOKEN depends on mode/suppression.
 */
import { describe, expect, it } from 'vitest';
import { planDirectLlmReplyDelivery } from '../src/voice/lex-voice-ws.js';

describe('planDirectLlmReplyDelivery (transcript render decoupled from TTS)', () => {
  it('typed input: reply renders in the transcript, zero audio', () => {
    const d = planDirectLlmReplyDelivery({
      replyText: 'Here is the answer.',
      mode: 'conversation',
      suppressSpeakForTurn: true,
    });
    expect(d.renderTranscript).toBe(true);
    expect(d.speak).toBe(false);
    expect(d.ttsSkippedReason).toBe('text-input');
  });

  it('voice input: reply renders in the transcript AND is spoken', () => {
    const d = planDirectLlmReplyDelivery({
      replyText: 'Here is the answer.',
      mode: 'conversation',
      suppressSpeakForTurn: false,
    });
    expect(d.renderTranscript).toBe(true);
    expect(d.speak).toBe(true);
    expect(d.ttsSkippedReason).toBeNull();
  });

  it('notes mode: renders in the transcript, silent (no audio, no skip frame)', () => {
    const d = planDirectLlmReplyDelivery({
      replyText: 'Captured note.',
      mode: 'notes',
      suppressSpeakForTurn: false,
    });
    expect(d.renderTranscript).toBe(true);
    expect(d.speak).toBe(false);
    expect(d.ttsSkippedReason).toBeNull();
  });

  it('empty reply: nothing to render or speak', () => {
    const d = planDirectLlmReplyDelivery({
      replyText: '',
      mode: 'conversation',
      suppressSpeakForTurn: false,
    });
    expect(d.renderTranscript).toBe(false);
    expect(d.speak).toBe(false);
  });
});
