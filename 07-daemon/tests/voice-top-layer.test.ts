/**
 * Voice top layer: Lex reply delivery (speech-first, 2026-07-15). Pins
 * voiceLexReply - the live path that streams the deep brain's reply to
 * TTS in Lex's own voice: streamed partials, resolved-text fallback,
 * and the miss/directive outcomes. Every test injects a fake ask; the
 * real voice-brain session is never loaded, let alone called.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AskFn } from '../src/voice/voice-top-layer.js';
import { _resetGlueHistory } from '../src/voice/voice-haiku-glue.js';

describe('voiceLexReply (TTS hooked only to the top layer)', () => {
  beforeEach(() => _resetGlueHistory());

  it('streams the delivery through onSpeech and reports delivered', async () => {
    const { voiceLexReply } = await import('../src/voice/voice-top-layer.js');
    const spoken: string[] = [];
    const ask: AskFn = async (args) => {
      args.onPartial?.('The build passed.');
      args.onPartial?.('Three of three tests are green.');
      return 'The build passed.\nThree of three tests are green.';
    };
    const delivered = await voiceLexReply('build: 3/3 pass', {
      onSpeech: (l) => spoken.push(l),
      deps: { ask },
    });
    expect(delivered).toBe('delivered');
    expect(spoken).toEqual([
      'The build passed.',
      'Three of three tests are green.',
    ]);
  });

  it('falls back to the resolved text when no partials stream', async () => {
    const { voiceLexReply } = await import('../src/voice/voice-top-layer.js');
    const spoken: string[] = [];
    const ask: AskFn = async () => 'Delivered as one block.';
    const delivered = await voiceLexReply('body', {
      onSpeech: (l) => spoken.push(l),
      deps: { ask },
    });
    expect(delivered).toBe('delivered');
    expect(spoken).toEqual(['Delivered as one block.']);
  });

  it('reports a miss on null so the caller speaks the raw body', async () => {
    const { voiceLexReply } = await import('../src/voice/voice-top-layer.js');
    const ask: AskFn = async () => null;
    const delivered = await voiceLexReply('body', {
      onSpeech: () => undefined,
      deps: { ask },
    });
    expect(delivered).toBe('miss');
  });

  it('reports a miss on a throwing ask, never throws itself', async () => {
    const { voiceLexReply } = await import('../src/voice/voice-top-layer.js');
    const ask: AskFn = async () => {
      throw new Error('session died');
    };
    const delivered = await voiceLexReply('body', {
      onSpeech: () => undefined,
      deps: { ask },
    });
    expect(delivered).toBe('miss');
  });

  it('an empty body is trivially delivered (nothing to speak)', async () => {
    const { voiceLexReply } = await import('../src/voice/voice-top-layer.js');
    const spoken: string[] = [];
    const delivered = await voiceLexReply('   ', {
      onSpeech: (l) => spoken.push(l),
      deps: { ask: async () => 'never called' },
    });
    expect(delivered).toBe('delivered');
    expect(spoken).toEqual([]);
  });

  it('a directive-shaped delivery is treated as a miss, not spoken', async () => {
    const { voiceLexReply } = await import('../src/voice/voice-top-layer.js');
    const spoken: string[] = [];
    const ask: AskFn = async () => 'FORWARD: do not speak directives';
    const delivered = await voiceLexReply('body', {
      onSpeech: (l) => spoken.push(l),
      deps: { ask },
    });
    expect(delivered).toBe('miss');
    expect(spoken).toEqual([]);
  });
});
