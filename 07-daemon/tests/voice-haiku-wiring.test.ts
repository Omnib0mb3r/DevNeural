/**
 * Wiring helpers surviving the spec-v2 teardown (2026-07-15).
 *
 * The front desk, lanes, whitelist, glue/bridge composers, and the
 * live-haiku reply restyle all died with spec v2; their pins died with
 * them (routing behavior is now voice-top-layer.test.ts's job). What
 * this file pins is the surviving trio: the safe spoken-output strip,
 * the heartbeat line, and the absorbed-aside ring helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderForSpeech,
  heartbeatLine,
  shouldCaptureAbsorbedAside,
  ABSORBED_ASIDE_RING_MAX,
  _pushAbsorbedAsideImpl,
  _formatAbsorbedAsideBlockImpl,
  type AbsorbedAsideEntry,
} from '../src/voice/voice-haiku-wiring.js';

let priorFlag: string | undefined;
beforeEach(() => {
  priorFlag = process.env.DEVNEURAL_VOICE_HAIKU;
});
afterEach(() => {
  if (priorFlag === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = priorFlag;
});

describe('renderForSpeech', () => {
  it('flag OFF: identity passthrough', () => {
    delete process.env.DEVNEURAL_VOICE_HAIKU;
    const text = '**bold** stays `code` stays';
    expect(renderForSpeech(text)).toBe(text);
  });

  it('flag ON: safe markdown strip, content preserved', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    const spoken = renderForSpeech('The build passed with **3 of 3** tests.');
    expect(spoken).toContain('3 of 3');
    expect(spoken).not.toContain('**');
  });
});

describe('heartbeatLine', () => {
  it('flag OFF: the duration-aware legacy phrase', () => {
    delete process.env.DEVNEURAL_VOICE_HAIKU;
    expect(heartbeatLine(65_000)).toBeTruthy();
  });

  it('flag ON: a grounded first-person line', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    const line = heartbeatLine(5 * 60_000);
    expect(line).toBeTruthy();
    expect(line.toLowerCase()).not.toContain('lex is');
  });
});

describe('absorbed-aside helpers', () => {
  const entry = (n: number): AbsorbedAsideEntry => ({
    atMs: n,
    aside: `aside ${n}`,
    reply: `reply ${n}`,
  });

  it('capture is conversation-mode only', () => {
    expect(shouldCaptureAbsorbedAside('conversation')).toBe(true);
    expect(shouldCaptureAbsorbedAside('notes')).toBe(false);
    expect(shouldCaptureAbsorbedAside('push-to-talk')).toBe(false);
  });

  it('push caps the ring without mutating the input', () => {
    let ring: AbsorbedAsideEntry[] = [];
    for (let i = 0; i < ABSORBED_ASIDE_RING_MAX + 3; i += 1) {
      const next = _pushAbsorbedAsideImpl(ring, entry(i));
      expect(next).not.toBe(ring);
      ring = next;
    }
    expect(ring.length).toBe(ABSORBED_ASIDE_RING_MAX);
    expect(ring[0]!.atMs).toBe(3);
  });

  it('formats one entry as a single-bracket single line', () => {
    const block = _formatAbsorbedAsideBlockImpl([entry(1)]);
    expect(block).toBe(
      '[voice asides since last turn: "aside 1" -> "reply 1"]',
    );
  });

  it('formats overflow with a (+N more) header and shows the newest', () => {
    const ring = [entry(1), entry(2), entry(3), entry(4), entry(5)];
    const block = _formatAbsorbedAsideBlockImpl(ring);
    expect(block).toContain('(+2 more)');
    expect(block).toContain('aside 5');
    expect(block).not.toContain('aside 2');
  });

  it('renders nothing for an empty ring', () => {
    expect(_formatAbsorbedAsideBlockImpl([])).toBe('');
  });
});
