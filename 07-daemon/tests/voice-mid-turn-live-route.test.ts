import { describe, it, expect } from 'vitest';
import { _shouldDeferForwardToMidTurnBoundary } from '../src/voice/lex-voice-ws.js';

/* Phase 2 R3/R5: the top layer is the always-reachable arbiter, so an
 * operator forward is NEVER held to mid's next turn boundary. Before
 * Phase 2 the WS "mid-turn-no-tts queue" pushed the forward onto
 * state.pendingUserUtterances whenever Lex was mid-turn with no TTS and
 * only drained it at Lex's end_turn - exactly the queue R3 kills. The
 * mid session is a real Claude Code PTY whose composer buffers a live
 * inject that arrives mid-turn and picks it up at the next boundary
 * (how Claude Code voice already behaves), so routing the forward LIVE
 * is both safe and required ("top never blocks on mid being busy").
 *
 * This predicate is the single wired seam that governs the branch; a
 * regression that re-introduces turn-boundary holding must flip it and
 * fight this test. */
describe('Phase 2 R3/R5: operator forward is never deferred to a mid turn boundary', () => {
  it('does not defer even under the old hold condition (Lex mid-turn, no TTS)', () => {
    expect(
      _shouldDeferForwardToMidTurnBoundary({ lexMidTurn: true, ttsActive: false }),
    ).toBe(false);
  });

  it('never defers in any (lexMidTurn, ttsActive) state', () => {
    for (const lexMidTurn of [true, false]) {
      for (const ttsActive of [true, false]) {
        expect(
          _shouldDeferForwardToMidTurnBoundary({ lexMidTurn, ttsActive }),
        ).toBe(false);
      }
    }
  });
});
