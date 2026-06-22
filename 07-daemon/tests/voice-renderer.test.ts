/**
 * Renderer-not-rethinker + verbatim preserve-list (pillar 3.4, sliver V5).
 *
 * Pins: numbers / SHAs / negations are extracted as preserve spans; the
 * verbatim guard rejects a render that drops or rewords one; a faithful
 * render is kept; a meaning-flipping render (drops "not", spells a number)
 * falls back to the safe render; Lex-marked spans are enforced.
 */
import { describe, expect, it } from 'vitest';
import {
  extractPreserveSpans,
  verifyVerbatim,
  safeRender,
  renderSpoken,
  renderSpokenAsync,
} from '../src/voice/voice-renderer.js';

describe('preserve-list extraction', () => {
  it('extracts numbers, SHAs, and negations', () => {
    const spans = extractPreserveSpans(
      'HEAD f5cf406 has 1205 tests, do not flip the flag, 40% done',
    );
    const kinds = (k: string) => spans.filter((s) => s.kind === k).map((s) => s.text);
    expect(kinds('sha')).toContain('f5cf406');
    expect(kinds('number')).toEqual(expect.arrayContaining(['1205', '40%']));
    expect(kinds('negation').map((s) => s.toLowerCase())).toContain('not');
  });
});

describe('verbatim guard', () => {
  it('ok when every span survives', () => {
    const spans = extractPreserveSpans('1205 tests, do not ship');
    expect(verifyVerbatim(spans, 'there are 1205 tests, do not ship').ok).toBe(
      true,
    );
  });

  it('flags a dropped number and a dropped negation', () => {
    const spans = extractPreserveSpans('1205 tests, do not ship');
    const v = verifyVerbatim(spans, 'there are a lot of tests, go ahead and ship');
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(expect.arrayContaining(['1205']));
  });
});

describe('renderSpoken', () => {
  it('with no haiku render, returns the safe render and preserves spans', () => {
    const r = renderSpoken('**1205** tests pass, do `not` flip the flag');
    expect(r.usedFallback).toBe(false);
    expect(r.preserved).toBe(true);
    expect(r.spoken).toContain('1205');
    expect(r.spoken).toMatch(/\bnot\b/);
    /* markdown stripped */
    expect(r.spoken).not.toContain('**');
    expect(r.spoken).not.toContain('`');
  });

  it('keeps a faithful haiku render', () => {
    const r = renderSpoken('1205 tests pass, do not ship yet', {
      haikuRender: () => '1205 tests pass; do not ship yet.',
    });
    expect(r.usedFallback).toBe(false);
    expect(r.spoken).toBe('1205 tests pass; do not ship yet.');
  });

  it('rejects a meaning-flipping render (drops "not") and falls back', () => {
    const r = renderSpoken('do not ship the build', {
      haikuRender: () => 'go ahead and ship the build',
    });
    expect(r.usedFallback).toBe(true);
    expect(r.spoken).toMatch(/\bnot\b/);
  });

  it('rejects a render that spells out a preserved number, falls back', () => {
    const r = renderSpoken('there are 1205 tests', {
      haikuRender: () => 'there are twelve hundred tests',
    });
    expect(r.usedFallback).toBe(true);
    expect(r.spoken).toContain('1205');
  });

  it('enforces a Lex-marked span verbatim', () => {
    const r = renderSpoken('we are going with Postgres for the store', {
      preserve: ['Postgres'],
      haikuRender: () => 'we are going with the database for the store',
    });
    /* "Postgres" was marked but the render dropped it -> fallback to the
     * safe render, which keeps it. */
    expect(r.usedFallback).toBe(true);
    expect(r.spoken).toContain('Postgres');
  });

  it('a throwing haiku render falls back safely', () => {
    const r = renderSpoken('1205 tests', {
      haikuRender: () => {
        throw new Error('haiku down');
      },
    });
    expect(r.usedFallback).toBe(true);
    expect(r.spoken).toContain('1205');
  });
});

describe('renderSpokenAsync (live-haiku render, DRIVE-QUEUE 1b)', () => {
  it('keeps a faithful warm render that preserves numbers + negations', async () => {
    const r = await renderSpokenAsync('**1205** tests pass, do `not` ship.', {
      haikuRender: async () => '1205 tests pass, but do not ship yet.',
    });
    expect(r.usedFallback).toBe(false);
    expect(r.spoken).toBe('1205 tests pass, but do not ship yet.');
  });

  it('falls back to the safe render when the model drops a number', async () => {
    const r = await renderSpokenAsync('1205 tests pass.', {
      haikuRender: async () => 'all the tests pass.',
    });
    expect(r.usedFallback).toBe(true);
    expect(r.spoken).toContain('1205');
  });

  it('falls back when the model flips a negation', async () => {
    const r = await renderSpokenAsync('do not ship the build.', {
      haikuRender: async () => 'ship the build.',
    });
    expect(r.usedFallback).toBe(true);
    expect(r.spoken).toMatch(/\bnot\b/);
  });

  it('falls back to the safe render when the model throws', async () => {
    const r = await renderSpokenAsync('1205 tests pass.', {
      haikuRender: async () => {
        throw new Error('timeout');
      },
    });
    expect(r.usedFallback).toBe(true);
    expect(r.spoken).toContain('1205');
  });

  it('falls back on an empty render', async () => {
    const r = await renderSpokenAsync('hello there.', {
      haikuRender: async () => '',
    });
    expect(r.usedFallback).toBe(true);
    expect(r.spoken).toBe('hello there.');
  });
});
