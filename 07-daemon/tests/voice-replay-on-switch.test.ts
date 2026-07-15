import { describe, expect, it } from 'vitest';
import {
  readLastAssistantTurn,
  _seedDigestFromLastTurnImpl,
} from '../src/voice/lex-voice-ws.js';
import type { LexDigest } from '../src/voice/voice-digest.js';

/**
 * Item 2 (2026-07-09): switching to a session replays its last reply once
 * (recency-guarded) so you catch up on what you may have missed. This
 * pins the pure extraction: the newest assistant text block wins, tool
 * and user turns are skipped, and the mtime comes back for the caller's
 * recency window.
 */
const A = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });
const U = (text: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } });

describe('readLastAssistantTurn', () => {
  it('returns the newest assistant reply and the file mtime', () => {
    const body = [A('a1', 'first reply'), U('a question'), A('a2', 'the latest reply')].join('\n');
    const out = readLastAssistantTurn('x.jsonl', {
      readTail: () => body,
      statMtimeMs: () => 1234,
    });
    expect(out?.text).toBe('the latest reply');
    expect(out?.uuid).toBe('a2');
    expect(out?.mtimeMs).toBe(1234);
  });

  it('skips a trailing user turn to find the last assistant reply', () => {
    const body = [A('a1', 'lex answer'), U('ok thanks')].join('\n');
    const out = readLastAssistantTurn('x.jsonl', { readTail: () => body, statMtimeMs: () => 1 });
    expect(out?.text).toBe('lex answer');
  });

  it('concatenates multiple text blocks in one assistant record', () => {
    const rec = JSON.stringify({
      type: 'assistant',
      uuid: 'a3',
      message: { content: [{ type: 'text', text: 'part one. ' }, { type: 'text', text: 'part two.' }] },
    });
    const out = readLastAssistantTurn('x.jsonl', { readTail: () => rec, statMtimeMs: () => 1 });
    expect(out?.text).toBe('part one. part two.');
  });

  it('tolerates a partial first line (tail read cut mid-record)', () => {
    const body = ['ent","message":{}}', A('a4', 'clean reply')].join('\n');
    const out = readLastAssistantTurn('x.jsonl', { readTail: () => body, statMtimeMs: () => 1 });
    expect(out?.text).toBe('clean reply');
  });

  it('returns null when there is no assistant text', () => {
    const out = readLastAssistantTurn('x.jsonl', {
      readTail: () => [U('just a user turn')].join('\n'),
      statMtimeMs: () => 1,
    });
    expect(out).toBeNull();
  });

  it('returns null when the file cannot be read', () => {
    expect(readLastAssistantTurn('x.jsonl', { readTail: () => null, statMtimeMs: () => 1 })).toBeNull();
  });
});

/**
 * Fast-lane cold-start-on-switch fix (2026-07-14). buildVoiceDigest only
 * pushes at end_turn boundaries, so right after a bind/switch the digest
 * is stale or absent until Lex's next reply and the fast lane degrades
 * (queues everything). _seedDigestFromLastTurnImpl seeds the digest from
 * the session's real last turn at bind time, reusing the same
 * readLastAssistantTurn extraction the replay-on-switch feature already
 * does. Pure + dependency-injected: no real WS, filesystem, or clock.
 */
describe('_seedDigestFromLastTurnImpl (fast-lane cold-start-on-switch fix)', () => {
  const digest = (over: Partial<LexDigest> = {}): LexDigest => ({
    currentTask: '',
    lastDecision: '',
    openQuestion: '',
    workerStatus: '',
    nextSteps: '',
    ...over,
  });

  it('seeds the digest and returns the fresh stamp when the last turn is recent', () => {
    const pushed: Array<{ digest: LexDigest; ms: number }> = [];
    const out = _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => ({
        text: 'the migration landed, tests are green',
        mtimeMs: 1_000,
        uuid: 'a1',
      }),
      getDigest: () => null,
      pushDigest: (d, ms) => pushed.push({ digest: d, ms }),
      buildVoiceDigest: (text) => digest({ lastDecision: text }),
      now: () => 1_000 + 5_000, // 5s after the turn: within any window
      replayWindowMs: 8 * 60 * 1000,
    });
    expect(out).toBe(6_000);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.ms).toBe(6_000);
    expect(pushed[0]!.digest.lastDecision).toBe(
      'the migration landed, tests are green',
    );
  });

  it('carries the prior digest forward into buildVoiceDigest (same contract as the turn-boundary push)', () => {
    const prior = digest({ currentTask: 'wiring the voice lane' });
    let seenPrev: LexDigest | null | undefined;
    _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => ({ text: 'reply', mtimeMs: 0, uuid: null }),
      getDigest: () => ({ digest: prior, ms: 0 }),
      pushDigest: () => {},
      buildVoiceDigest: (_text, prev) => {
        seenPrev = prev;
        return digest();
      },
      now: () => 0,
    });
    expect(seenPrev).toBe(prior);
  });

  it('does not seed when there is no jsonl path', () => {
    let called = false;
    const out = _seedDigestFromLastTurnImpl(null, {
      readLastAssistantTurn: () => {
        called = true;
        return null;
      },
      getDigest: () => null,
      pushDigest: () => {
        throw new Error('must not push');
      },
      buildVoiceDigest: () => digest(),
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it('does not seed when there is no last assistant turn', () => {
    const out = _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => null,
      getDigest: () => null,
      pushDigest: () => {
        throw new Error('must not push');
      },
      buildVoiceDigest: () => digest(),
    });
    expect(out).toBeNull();
  });

  it('does not seed when the last turn is older than the recency window (leaves the gate as before)', () => {
    const out = _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => ({ text: 'old reply', mtimeMs: 0, uuid: null }),
      getDigest: () => null,
      pushDigest: () => {
        throw new Error('must not push');
      },
      buildVoiceDigest: () => digest(),
      now: () => 9 * 60 * 1000, // 9 minutes later
      replayWindowMs: 8 * 60 * 1000,
    });
    expect(out).toBeNull();
  });

  it('is best-effort: a read failure never throws, just leaves the gate untouched', () => {
    const out = _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => {
        throw new Error('fs error');
      },
      getDigest: () => null,
      pushDigest: () => {},
      buildVoiceDigest: () => digest(),
    });
    expect(out).toBeNull();
  });
});
