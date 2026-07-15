import { describe, expect, it } from 'vitest';
import { composeBridgeReply } from '../src/voice/voice-haiku-wiring.js';
import { generateBridgeReply } from '../src/voice/voice-haiku-glue.js';

/**
 * DRIVE-QUEUE slow-lane bridge: the "let me look" filler is now a live,
 * request-specific line instead of a canned hash pick. composeBridgeReply
 * returns the live line when the model answers, and the deterministic
 * fallback on no-key / miss - it must NEVER be silent (the bridge always
 * speaks something while Lex reasons).
 */
describe('composeBridgeReply', () => {
  it('returns the deterministic fallback when the model is disabled', async () => {
    const out = await composeBridgeReply('what is the academy worker doing', 'one sec', {
      modelEnabled: false,
    });
    expect(out).toBe('one sec');
  });

  it('returns the live line when the model answers', async () => {
    const out = await composeBridgeReply('what is the academy worker doing', 'one sec', {
      modelEnabled: true,
      generate: async () => 'let me pull up the academy status',
    });
    expect(out).toBe('let me pull up the academy status');
  });

  it('falls back (never silent) when the model call misses', async () => {
    const out = await composeBridgeReply('what is the academy worker doing', 'checking now', {
      modelEnabled: true,
      generate: async () => null,
    });
    expect(out).toBe('checking now');
  });

  it('passes the utterance through to the generator', async () => {
    let seen = '';
    await composeBridgeReply('status of the lesson 1 review', 'one sec', {
      modelEnabled: true,
      generate: async (input) => {
        seen = input.utterance;
        return 'on the lesson 1 review now';
      },
    });
    expect(seen).toBe('status of the lesson 1 review');
  });
});

describe('generateBridgeReply', () => {
  it('returns the trimmed model line via the injected call seam', async () => {
    const out = await generateBridgeReply(
      { utterance: 'where did we leave the schema' },
      { call: async () => '  right, the schema. let me check.  ' },
    );
    expect(out).toBe('right, the schema. let me check.');
  });

  it('returns null on an empty/<none> model reply', async () => {
    const out = await generateBridgeReply(
      { utterance: 'anything' },
      { call: async () => '<none>' },
    );
    expect(out).toBeNull();
  });
});
