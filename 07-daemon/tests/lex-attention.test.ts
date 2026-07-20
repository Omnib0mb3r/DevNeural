/**
 * Real-time Lex attention notification pipeline.
 *
 * Three layers pinned here:
 *   - detectAttentionInText: regex + tail-line heuristic.
 *   - isInQuietHours / parseQuietHours: local-clock window with
 *     wrap-around.
 *   - fireForLexTurn + fireForStall: emit shape + quiet-hours
 *     suppression vs. live push.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  defaultQuietHours,
  detectAttentionInText,
  fireForLexTurn,
  fireForStall,
  isInQuietHours,
  parseQuietHours,
} from '../src/dashboard/lex-attention.js';

describe('detectAttentionInText', () => {
  it('matches decision-head question tails', () => {
    expect(detectAttentionInText('Want me to ship it?')).toBe(true);
    expect(detectAttentionInText('Should we keep the cap at 5?')).toBe(true);
    expect(detectAttentionInText('Which option do you want?')).toBe(true);
  });

  it('rejects soft / rhetorical tail questions (2026-07-20: no more false "Lex needs you")', () => {
    /* These end in a question but carry no decision head and no y/n
     * marker - conversational rhythm, not a blocking ask. They must NOT
     * bell; the activity rail still shows them. */
    expect(detectAttentionInText('Make sense?')).toBe(false);
    expect(detectAttentionInText('Sound good?')).toBe(false);
    expect(detectAttentionInText('Cool?')).toBe(false);
    expect(detectAttentionInText('Does that look right?')).toBe(false);
    expect(
      detectAttentionInText('I shipped the fix and reran the suite. Any questions?'),
    ).toBe(false);
  });

  it('matches explicit yes/no markers anywhere in the text', () => {
    expect(detectAttentionInText('Ready to commit? (y/n)')).toBe(true);
    expect(
      detectAttentionInText('Ship the patch now, yes or no.'),
    ).toBe(true);
    expect(detectAttentionInText('Run the migration. [y/n]')).toBe(true);
  });

  it('matches decision verbs on the tail line even when long', () => {
    const longHead = 'I traced the bug through three modules.\n';
    const tail = 'Should we revert commit 0119710 to unblock the merge?';
    expect(detectAttentionInText(longHead + tail)).toBe(true);
  });

  it('rejects long explanatory paragraphs that happen to end with ?', () => {
    const wall =
      'The supervision tick currently classifies a worker as stalled when ' +
      'three consecutive ticks elapse without any forward progress in the ' +
      'jsonl tail, which means a slow tool call that takes more than fifteen ' +
      'minutes can trigger a false positive even though the worker is healthy ' +
      'and just waiting on the network, which raises the question of whether ' +
      'the threshold should adapt to the observed tool latency over a rolling ' +
      'window rather than the current fixed cap?';
    expect(detectAttentionInText(wall)).toBe(false);
  });

  it('rejects statements with no ? and no decision verbs', () => {
    expect(detectAttentionInText('Patch landed at 0119710.')).toBe(false);
    expect(detectAttentionInText('All tests passed.')).toBe(false);
  });

  it('returns false on empty / whitespace', () => {
    expect(detectAttentionInText('')).toBe(false);
    expect(detectAttentionInText('   ')).toBe(false);
  });
});

describe('parseQuietHours', () => {
  it('parses "22-08"', () => {
    expect(parseQuietHours('22-08')).toEqual({ startHour: 22, endHour: 8 });
  });

  it('parses "08:22" with a colon separator', () => {
    expect(parseQuietHours('08:22')).toEqual({ startHour: 8, endHour: 22 });
  });

  it('returns null on malformed input', () => {
    expect(parseQuietHours('bogus')).toBeNull();
    expect(parseQuietHours('')).toBeNull();
    expect(parseQuietHours(undefined)).toBeNull();
    expect(parseQuietHours('25-08')).toBeNull();
  });
});

describe('isInQuietHours', () => {
  const hours = { startHour: 22, endHour: 8 };

  it('flags midnight as quiet for a wrap-around window', () => {
    const t = new Date(2026, 4, 14, 0, 30, 0);
    expect(isInQuietHours(t, hours)).toBe(true);
  });

  it('flags 22:00 onward as quiet', () => {
    expect(isInQuietHours(new Date(2026, 4, 14, 22, 0), hours)).toBe(true);
    expect(isInQuietHours(new Date(2026, 4, 14, 23, 59), hours)).toBe(true);
  });

  it('flags 08:00 as outside (window endHour is exclusive)', () => {
    expect(isInQuietHours(new Date(2026, 4, 14, 8, 0), hours)).toBe(false);
  });

  it('flags daytime as outside the wrap-around window', () => {
    expect(isInQuietHours(new Date(2026, 4, 14, 14, 0), hours)).toBe(false);
  });

  it('handles a same-day window (08-22 = quiet during the day)', () => {
    const day = { startHour: 8, endHour: 22 };
    expect(isInQuietHours(new Date(2026, 4, 14, 12, 0), day)).toBe(true);
    expect(isInQuietHours(new Date(2026, 4, 14, 23, 0), day)).toBe(false);
  });

  it('treats startHour === endHour as fully quiet', () => {
    const always = { startHour: 9, endHour: 9 };
    expect(isInQuietHours(new Date(2026, 4, 14, 3, 0), always)).toBe(true);
    expect(isInQuietHours(new Date(2026, 4, 14, 15, 0), always)).toBe(true);
  });
});

describe('fireForLexTurn', () => {
  function emitSpy() {
    return vi.fn(
      (input: { title: string }): { id: string; title: string } => ({
        id: 'n-1',
        title: input.title,
      }),
    );
  }

  it('skips empty text', () => {
    const emit = emitSpy();
    const r = fireForLexTurn(
      { brainstorm_id: 'bs-1', turn_id: 't-1', text: '   ' },
      { emit: emit as never },
    );
    expect(r.outcome).toBe('empty');
    expect(emit).not.toHaveBeenCalled();
  });

  it('skips when detection fails and no explicit flag', () => {
    const emit = emitSpy();
    const r = fireForLexTurn(
      {
        brainstorm_id: 'bs-1',
        turn_id: 't-1',
        text: 'Patch landed cleanly.',
      },
      { emit: emit as never },
    );
    expect(r.outcome).toBe('not-detected');
    expect(emit).not.toHaveBeenCalled();
  });

  it('fires outside quiet hours with auto push and the right shape', () => {
    const emit = emitSpy();
    const r = fireForLexTurn(
      {
        brainstorm_id: 'bs-7',
        turn_id: 't-9',
        text: 'Ship the migration? (y/n)',
      },
      {
        emit: emit as never,
        hours: { startHour: 22, endHour: 8 },
        now: () => new Date(2026, 4, 14, 14, 0),
      },
    );
    expect(r.outcome).toBe('fired');
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.severity).toBe('warn');
    expect(call.source).toBe('lex-attention');
    expect(call.event_type).toBe('attention');
    expect(call.push).toBe('auto');
    expect(call.link).toBe('/brainstorms/bs-7#turn-t-9');
    expect((call.push_data as Record<string, unknown>).kind).toBe('lex-turn');
    expect((call.push_data as Record<string, unknown>).brainstorm_id).toBe(
      'bs-7',
    );
    expect((call.push_data as Record<string, unknown>).turn_id).toBe('t-9');
    expect((call.push_data as Record<string, unknown>).snippet).toBe(
      'Ship the migration? (y/n)',
    );
  });

  it('suppresses push inside quiet hours but still emits the notification log row', () => {
    const emit = emitSpy();
    const r = fireForLexTurn(
      {
        brainstorm_id: 'bs-7',
        turn_id: 't-9',
        text: 'Ship the migration? (y/n)',
      },
      {
        emit: emit as never,
        hours: { startHour: 22, endHour: 8 },
        now: () => new Date(2026, 4, 14, 3, 0),
      },
    );
    expect(r.outcome).toBe('fired-quiet-suppressed');
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.push).toBe('suppress');
    /* Notification still landed in the log, so the in-app bell can
     * show the missed prompt. */
    expect(call.title).toBe('Lex needs you');
  });

  it('honours the explicit needs_attention flag from the LLM-tagged emit path', () => {
    const emit = emitSpy();
    const r = fireForLexTurn(
      {
        brainstorm_id: 'bs-1',
        turn_id: 't-1',
        text: 'Patch landed cleanly.',
        needs_attention: true,
      },
      {
        emit: emit as never,
        now: () => new Date(2026, 4, 14, 14, 0),
      },
    );
    expect(r.outcome).toBe('fired');
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('fireForStall', () => {
  function emitSpy() {
    return vi.fn(
      (input: { title: string }): { id: string; title: string } => ({
        id: 'n-1',
        title: input.title,
      }),
    );
  }

  it('always fires regardless of question detection and tags push_data.kind=stall', () => {
    const emit = emitSpy();
    const r = fireForStall(
      {
        brainstorm_id: 'bs-7',
        anchor_id: 'a-1',
        reason: 'idle 12m on permission prompt',
      },
      {
        emit: emit as never,
        now: () => new Date(2026, 4, 14, 14, 0),
      },
    );
    expect(r.outcome).toBe('fired');
    const call = emit.mock.calls[0]![0] as Record<string, unknown>;
    /* 2026-07-20: a stall is warn-level supervision, not an alert-level
     * emergency, so it stays off the bell (signal@warn) and on the
     * activity rail. */
    expect(call.severity).toBe('warn');
    expect(call.notify_class).toBe('signal');
    expect(call.event_type).toBe('attention');
    expect((call.push_data as Record<string, unknown>).kind).toBe('stall');
    expect((call.push_data as Record<string, unknown>).reason).toBe(
      'idle 12m on permission prompt',
    );
    expect(call.link).toBe('/brainstorms/bs-7');
  });

  it('suppresses push inside quiet hours, still logs the row', () => {
    const emit = emitSpy();
    const r = fireForStall(
      {
        brainstorm_id: null,
        anchor_id: 'a-1',
        reason: 'idle 12m',
      },
      {
        emit: emit as never,
        hours: { startHour: 22, endHour: 8 },
        now: () => new Date(2026, 4, 14, 3, 0),
      },
    );
    expect(r.outcome).toBe('fired-quiet-suppressed');
    const call = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.push).toBe('suppress');
    expect(call.link).toBe('/projects/a-1');
  });
});

describe('defaultQuietHours', () => {
  it('returns the 22-08 default when no env override is set', () => {
    const prior = process.env.DEVNEURAL_QUIET_HOURS;
    delete process.env.DEVNEURAL_QUIET_HOURS;
    try {
      expect(defaultQuietHours()).toEqual({ startHour: 22, endHour: 8 });
    } finally {
      if (prior !== undefined) process.env.DEVNEURAL_QUIET_HOURS = prior;
    }
  });

  it('respects DEVNEURAL_QUIET_HOURS override', () => {
    const prior = process.env.DEVNEURAL_QUIET_HOURS;
    process.env.DEVNEURAL_QUIET_HOURS = '0-6';
    try {
      expect(defaultQuietHours()).toEqual({ startHour: 0, endHour: 6 });
    } finally {
      if (prior === undefined) delete process.env.DEVNEURAL_QUIET_HOURS;
      else process.env.DEVNEURAL_QUIET_HOURS = prior;
    }
  });
});
