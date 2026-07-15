import { describe, expect, it } from 'vitest';
import { readLastAssistantTurn } from '../src/voice/lex-voice-ws.js';

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
