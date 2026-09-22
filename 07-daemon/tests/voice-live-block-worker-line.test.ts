/**
 * BUG-029 (2026-09-22): the [live] block told Layer 1 only that the
 * worker was "live (DevNeural)". Asked what the worker was doing, Layer 1
 * invented "idle, no active brainstorm" while /sessions said thinking.
 * _workerLineImpl pins the wording of the richer line: phase, activity
 * age, and the worker's last words when idle. Pure, no store, no fs.
 */
import { describe, expect, it } from 'vitest';
import { _workerLineImpl } from '../src/voice/lex-voice-ws.js';

describe('_workerLineImpl (BUG-029)', () => {
  const base = {
    status: 'live',
    slug: 'DevNeural',
    phase: 'idle' as const,
    lastActivityMs: null as number | null,
    nowMs: 100_000,
    lastText: null as string | null,
  };

  it('names the phase and the slug', () => {
    expect(_workerLineImpl({ ...base, phase: 'thinking', lastActivityMs: 88_000 })).toBe(
      'live, thinking (DevNeural), last activity 12s ago',
    );
    expect(_workerLineImpl({ ...base, phase: 'tool', lastActivityMs: 99_000 })).toBe(
      'live, running a tool (DevNeural), last activity 1s ago',
    );
    expect(_workerLineImpl({ ...base, phase: 'permission' })).toBe(
      'live, waiting on a permission prompt (DevNeural)',
    );
    expect(_workerLineImpl({ ...base, phase: 'unknown' })).toBe('live (DevNeural)');
  });

  it('idle carries how long it has been quiet and the last thing the worker said, trimmed', () => {
    expect(
      _workerLineImpl({
        ...base,
        lastActivityMs: 100_000 - 3 * 60_000,
        lastText: 'Done. Tests green.\nNext?',
      }),
    ).toBe('live, idle (DevNeural), quiet for 3m, last said: "Done. Tests green. Next?"');
    expect(_workerLineImpl({ ...base, lastActivityMs: 100_000 - 2 * 3_600_000 })).toBe(
      'live, idle (DevNeural), quiet for 2h',
    );
  });

  it('caps the last words at 120 characters', () => {
    const long = 'x'.repeat(300);
    const line = _workerLineImpl({ ...base, lastText: long });
    expect(line).toContain(`last said: "${'x'.repeat(120)}"`);
    expect(line).not.toContain('x'.repeat(121));
  });

  it('offline keeps the old wording', () => {
    expect(_workerLineImpl({ ...base, status: 'dormant', phase: 'thinking' })).toBe(
      'bound, offline (DevNeural)',
    );
  });
});
