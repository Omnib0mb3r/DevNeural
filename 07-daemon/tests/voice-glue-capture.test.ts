/**
 * Fast-lane transcript hole fix (2026-07-15).
 *
 * The haiku fast lane ('fast' route of haikuRoute -> composeGlueReply in
 * lex-voice-ws.ts's handleUtteranceEnd) absorbs conversation-mode asides -
 * greetings, acks, delivery hints - by speaking a glue reply with NOTHING
 * ever injected into Lex's PTY. Two pieces close the resulting transcript
 * hole:
 *
 *   1. _captureAbsorbedAsideImpl (lex-voice-ws.ts) persists both sides to
 *      brainstorm_chunks the instant the fast lane absorbs, mirroring
 *      _captureNotesUtteranceOnlyImpl's capture-only shape (no ptyInject /
 *      handleDirectLlmUtterance dependency in sight - it cannot forward by
 *      construction).
 *   2. _pushAbsorbedAsideImpl / _formatAbsorbedAsideBlockImpl (voice-haiku-
 *      wiring.ts) accumulate a bounded ring and render it as a one-line-
 *      per-aside prefix for the NEXT real inject to Lex.
 *   3. shouldCaptureAbsorbedAside (voice-haiku-wiring.ts) is the mode gate:
 *      conversation only, so notes mode - which owns its own capture story
 *      via captureNotesUtteranceOnly and never speaks TTS - is untouched.
 */
import { describe, expect, it, vi } from 'vitest';
import { _captureAbsorbedAsideImpl } from '../src/voice/lex-voice-ws.js';
import {
  shouldCaptureAbsorbedAside,
  _pushAbsorbedAsideImpl,
  _formatAbsorbedAsideBlockImpl,
  ABSORBED_ASIDE_RING_MAX,
  type AbsorbedAsideEntry,
} from '../src/voice/voice-haiku-wiring.js';

describe('_captureAbsorbedAsideImpl', () => {
  it('writes exactly two chunks (user aside, lex reply) both tagged voice-glue-capture', () => {
    const insertChunk = vi.fn();
    const nextTurnIndex = vi
      .fn()
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(6);
    let idCalls = 0;
    const newId = () => `fixed-id-${++idCalls}`;

    _captureAbsorbedAsideImpl({
      brainstormId: 'bs-1',
      aside: 'good morning',
      reply: 'Morning.',
      insertChunk,
      nextTurnIndex,
      newId,
    });

    expect(nextTurnIndex).toHaveBeenCalledTimes(2);
    expect(nextTurnIndex).toHaveBeenNthCalledWith(1, 'bs-1');
    expect(nextTurnIndex).toHaveBeenNthCalledWith(2, 'bs-1');
    expect(insertChunk).toHaveBeenCalledTimes(2);
    expect(insertChunk).toHaveBeenNthCalledWith(1, {
      id: 'fixed-id-1',
      brainstorm_id: 'bs-1',
      turn_index: 5,
      role: 'user',
      mode: 'conversation',
      text: 'good morning',
      model_id: 'voice-glue-capture',
      cc_session_id: null,
    });
    expect(insertChunk).toHaveBeenNthCalledWith(2, {
      id: 'fixed-id-2',
      brainstorm_id: 'bs-1',
      turn_index: 6,
      role: 'lex',
      mode: 'conversation',
      text: 'Morning.',
      model_id: 'voice-glue-capture',
      cc_session_id: null,
    });
  });

  it('requests the reply turn_index AFTER the aside row lands (sequential, not batched)', () => {
    /* nextTurnIndex reads MAX(turn_index)+1 fresh from the DB on every
     * call in production; the two calls here must be separate calls (not
     * one shared value) so a real DB backing this would give the reply
     * row a HIGHER index than the aside row. */
    const insertChunk = vi.fn();
    const nextTurnIndex = vi.fn().mockReturnValue(0);
    _captureAbsorbedAsideImpl({
      brainstormId: 'bs-2',
      aside: 'hi',
      reply: 'Hey.',
      insertChunk,
      nextTurnIndex,
    });
    expect(nextTurnIndex).toHaveBeenCalledTimes(2);
  });

  it('defaults to a fresh randomUUID id per row when newId is not supplied', () => {
    const insertChunk = vi.fn();
    _captureAbsorbedAsideImpl({
      brainstormId: 'bs-3',
      aside: 'thanks',
      reply: 'You got it.',
      insertChunk,
      nextTurnIndex: () => 0,
    });
    const rows = insertChunk.mock.calls.map((c) => c[0] as { id: string });
    expect(rows).toHaveLength(2);
    expect(typeof rows[0]!.id).toBe('string');
    expect(rows[0]!.id.length).toBeGreaterThan(0);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it('is best-effort: an insertChunk throw on either row is swallowed and logged, never rethrown', () => {
    const log = vi.fn();
    const insertChunk = vi.fn(() => {
      throw new Error('db is locked');
    });
    expect(() =>
      _captureAbsorbedAsideImpl({
        brainstormId: 'bs-4',
        aside: 'hello',
        reply: 'Hi there.',
        insertChunk,
        nextTurnIndex: () => 0,
        log,
      }),
    ).not.toThrow();
    /* Both inserts are attempted independently (each in its own
     * try/catch), so a throw on the first must not block the second. */
    expect(insertChunk).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toContain('absorbed-aside capture (user) insert failed');
    expect(log.mock.calls[1]![0]).toContain('absorbed-aside capture (reply) insert failed');
  });

  it('the deps type has no ptyInject / handleDirectLlmUtterance field: capture-only cannot forward by construction', () => {
    const deps = {
      brainstormId: 'bs-5',
      aside: 'x',
      reply: 'y',
      insertChunk: vi.fn(),
      nextTurnIndex: () => 0,
    };
    expect(Object.keys(deps)).toEqual([
      'brainstormId',
      'aside',
      'reply',
      'insertChunk',
      'nextTurnIndex',
    ]);
  });
});

describe('shouldCaptureAbsorbedAside (mode gate)', () => {
  it('is true for conversation mode', () => {
    expect(shouldCaptureAbsorbedAside('conversation')).toBe(true);
  });

  it('is false for notes mode: notes owns its own capture story and this fix must not touch it', () => {
    expect(shouldCaptureAbsorbedAside('notes')).toBe(false);
  });

  it('is false for push-to-talk mode (out of the stated scope)', () => {
    expect(shouldCaptureAbsorbedAside('push-to-talk')).toBe(false);
  });
});

describe('_pushAbsorbedAsideImpl (ring accumulation)', () => {
  const entry = (n: number): AbsorbedAsideEntry => ({
    atMs: n,
    aside: `aside-${n}`,
    reply: `reply-${n}`,
  });

  it('appends to an empty ring', () => {
    const next = _pushAbsorbedAsideImpl([], entry(1));
    expect(next).toEqual([entry(1)]);
  });

  it('does not mutate the input ring', () => {
    const ring = [entry(1)];
    const next = _pushAbsorbedAsideImpl(ring, entry(2));
    expect(ring).toEqual([entry(1)]);
    expect(next).toEqual([entry(1), entry(2)]);
  });

  it('is bounded: pushing past the max drops the oldest entries first', () => {
    let ring: AbsorbedAsideEntry[] = [];
    for (let i = 1; i <= ABSORBED_ASIDE_RING_MAX + 4; i++) {
      ring = _pushAbsorbedAsideImpl(ring, entry(i));
    }
    expect(ring).toHaveLength(ABSORBED_ASIDE_RING_MAX);
    /* Oldest 4 (1..4) dropped; ring now holds 5..14 in order. */
    expect(ring[0]).toEqual(entry(5));
    expect(ring[ring.length - 1]).toEqual(entry(ABSORBED_ASIDE_RING_MAX + 4));
  });

  it('honors an explicit max override', () => {
    let ring: AbsorbedAsideEntry[] = [];
    for (let i = 1; i <= 5; i++) {
      ring = _pushAbsorbedAsideImpl(ring, entry(i), 2);
    }
    expect(ring).toEqual([entry(4), entry(5)]);
  });
});

describe('_formatAbsorbedAsideBlockImpl (drain prefix)', () => {
  it('returns empty string for an empty ring: no prefix added', () => {
    expect(_formatAbsorbedAsideBlockImpl([])).toBe('');
  });

  it('renders a single aside in the exact documented format', () => {
    const out = _formatAbsorbedAsideBlockImpl([
      { atMs: 1, aside: 'good morning', reply: 'Morning.' },
    ]);
    expect(out).toBe('[voice asides since last turn: "good morning" -> "Morning."]');
  });

  it('renders multiple asides (<=3) as one line each inside a single block, no drop suffix', () => {
    const out = _formatAbsorbedAsideBlockImpl([
      { atMs: 1, aside: 'good morning', reply: 'Morning.' },
      { atMs: 2, aside: 'thanks', reply: 'You got it.' },
    ]);
    expect(out).toBe(
      '[voice asides since last turn:\n"good morning" -> "Morning."\n"thanks" -> "You got it."]',
    );
  });

  it('caps display at 3 lines, oldest dropped, with a "+N more" header suffix', () => {
    const ring: AbsorbedAsideEntry[] = [
      { atMs: 1, aside: 'a1', reply: 'r1' },
      { atMs: 2, aside: 'a2', reply: 'r2' },
      { atMs: 3, aside: 'a3', reply: 'r3' },
      { atMs: 4, aside: 'a4', reply: 'r4' },
      { atMs: 5, aside: 'a5', reply: 'r5' },
    ];
    const out = _formatAbsorbedAsideBlockImpl(ring);
    /* 5 entries, cap 3 -> drop the oldest 2 (a1, a2); show a3..a5. */
    expect(out).toBe(
      '[voice asides since last turn (+2 more):\n"a3" -> "r3"\n"a4" -> "r4"\n"a5" -> "r5"]',
    );
  });

  it('does not mutate the ring passed in', () => {
    const ring: AbsorbedAsideEntry[] = [{ atMs: 1, aside: 'a', reply: 'b' }];
    const snapshot = [...ring];
    _formatAbsorbedAsideBlockImpl(ring);
    expect(ring).toEqual(snapshot);
  });
});
