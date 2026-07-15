import { describe, expect, it, vi } from 'vitest';
import { composeBridgeReply } from '../src/voice/voice-haiku-wiring.js';
import { generateBridgeReply } from '../src/voice/voice-haiku-glue.js';

/**
 * Slow-lane bridge (2026-07-15 rework): composeBridgeReply went back to
 * being a synchronous passthrough of the caller's own instant
 * deterministic pick (dec.route.bridge / pickBridgeLine). The bridge's
 * entire purpose is to fill the silence the INSTANT Lex starts reasoning;
 * any model round trip here - live Haiku or the persistent judge session
 * - would BE the delay it exists to hide. generateBridgeReply itself
 * stays exported and tested below (deprecated, no longer called from
 * composeBridgeReply) so the metered path is not lost.
 */
describe('composeBridgeReply', () => {
  it('always returns the fallback (no model call of any kind)', async () => {
    const out = await composeBridgeReply('what is the academy worker doing', 'one sec');
    expect(out).toBe('one sec');
  });

  it('returns the fallback verbatim regardless of the utterance', async () => {
    const out = await composeBridgeReply('status of the lesson 1 review', 'checking now');
    expect(out).toBe('checking now');
  });

  it('never calls the deprecated generateBridgeReply', async () => {
    const glueModule = await import('../src/voice/voice-haiku-glue.js');
    const spy = vi.spyOn(glueModule, 'generateBridgeReply');
    await composeBridgeReply('what is the academy worker doing', 'one sec');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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

  /* Requirement 5: the same LOCAL CONTEXT block goes into the bridge
   * composer's system prompt (committed b5cbf69), so slow-lane bridge
   * lines are daypart-aware too, not just glue. */
  describe('local context (bridge line is daypart-aware)', () => {
    it('includes the LOCAL CONTEXT block, sourced from the injected clock', async () => {
      let system = '';
      const call = async (i: { system: string }) => {
        system = i.system;
        return 'let me pull that up';
      };
      await generateBridgeReply(
        { utterance: 'what is the academy worker doing' },
        { call, now: () => new Date(2026, 6, 14, 18, 15, 0) },
      );
      expect(system).toContain('LOCAL CONTEXT');
      expect(system).toContain('18:15');
      expect(system.toLowerCase()).toContain('evening');
    });

    it('defaults to the real clock when no `now` dep is supplied', async () => {
      let system = '';
      const call = async (i: { system: string }) => {
        system = i.system;
        return 'checking';
      };
      await generateBridgeReply({ utterance: 'status' }, { call });
      expect(system).toContain('LOCAL CONTEXT');
    });
  });

  it('BF-4: local context carries only time/day/date, never raw content', async () => {
    let system = '';
    const call = async (i: { system: string }) => {
      system = i.system;
      return 'looking';
    };
    await generateBridgeReply(
      { utterance: 'what is the academy worker doing' },
      { call, now: () => new Date(2026, 6, 14, 9, 0, 0) },
    );
    const block = system.slice(
      system.indexOf('LOCAL CONTEXT'),
      system.indexOf('VOICE FAST LANE: BRIDGE'),
    );
    expect(block).not.toMatch(/brainstorm|academy|worker/i);
  });
});
