/**
 * selectTtsContent (Fix 13).
 *
 * Confirms the stop_reason filter and the per-segment dedupe agree
 * with the spec:
 *
 *   - stop_reason='tool_use' with text + tool_use blocks -> caller
 *     should speak the text
 *   - stop_reason='tool_use' with ONLY a tool_use block -> drop
 *   - stop_reason='end_turn' speaks new text; pipeline runs on
 *     fullText
 *   - same uuid replayed across pre-tool and end_turn -> end_turn
 *     does NOT re-speak the pre-tool text
 *   - other stop reasons (max_tokens, etc.) -> drop
 */
import { describe, expect, it } from 'vitest';
import {
  accountSpeech,
  decidePreToolAck,
  hashSegment,
  selectTtsContent,
  type AssistantJsonlRecord,
} from '../src/voice/select-tts-content.js';

function rec(opts: {
  stop_reason: string;
  texts?: string[];
  tool_use?: boolean;
  uuid?: string;
}): AssistantJsonlRecord {
  const content: Array<{ type?: string; text?: string }> = [];
  for (const t of opts.texts ?? []) content.push({ type: 'text', text: t });
  if (opts.tool_use) content.push({ type: 'tool_use' });
  return {
    type: 'assistant',
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
    message: {
      content,
      stop_reason: opts.stop_reason,
    },
  };
}

describe('selectTtsContent', () => {
  it('drops non-assistant records', () => {
    const r = selectTtsContent(
      { type: 'user', message: { content: [], stop_reason: 'end_turn' } },
      new Set(),
    );
    expect(r.drop).toBe(true);
  });

  it('drops records with stop_reason other than end_turn / tool_use', () => {
    expect(
      selectTtsContent(rec({ stop_reason: 'max_tokens', texts: ['hi'] }), new Set())
        .drop,
    ).toBe(true);
    expect(
      selectTtsContent(rec({ stop_reason: 'stop_sequence', texts: ['hi'] }), new Set())
        .drop,
    ).toBe(true);
  });

  it('tool_use with text + tool_use block -> speak the text', () => {
    const r = selectTtsContent(
      rec({
        stop_reason: 'tool_use',
        texts: ['Investigating the smart-compact race now.'],
        tool_use: true,
        uuid: 'turn-1',
      }),
      new Set(),
    );
    expect(r.drop).toBe(false);
    expect(r.is_pre_tool_ack).toBe(true);
    expect(r.new_text).toBe('Investigating the smart-compact race now.');
    expect(r.new_hashes.length).toBe(1);
  });

  it('tool_use with ONLY a tool_use block -> drop, no speak', () => {
    const r = selectTtsContent(
      rec({ stop_reason: 'tool_use', tool_use: true, uuid: 'turn-2' }),
      new Set(),
    );
    expect(r.drop).toBe(true);
  });

  it('end_turn with text content -> speak + pipeline on fullText', () => {
    const r = selectTtsContent(
      rec({
        stop_reason: 'end_turn',
        texts: ['Done. Smart-compact now ready.'],
        uuid: 'turn-3',
      }),
      new Set(),
    );
    expect(r.drop).toBe(false);
    expect(r.is_pre_tool_ack).toBe(false);
    expect(r.new_text).toBe('Done. Smart-compact now ready.');
    expect(r.full_text).toBe('Done. Smart-compact now ready.');
  });

  it('end_turn with NO text content -> drop', () => {
    const r = selectTtsContent(
      rec({ stop_reason: 'end_turn', tool_use: true, uuid: 'turn-4' }),
      new Set(),
    );
    expect(r.drop).toBe(true);
  });

  it('same uuid replayed across pre-tool and end_turn -> no double-speak', () => {
    const spoken = new Set<string>();
    const ack = 'Investigating now.';
    const final = 'Done.';

    /* Pre-tool ack lands first. */
    const r1 = selectTtsContent(
      rec({
        stop_reason: 'tool_use',
        texts: [ack],
        tool_use: true,
        uuid: 'turn-X',
      }),
      spoken,
    );
    expect(r1.drop).toBe(false);
    expect(r1.new_text).toBe(ack);
    for (const h of r1.new_hashes) spoken.add(h);

    /* Same uuid lands later as end_turn echoing the pre-tool ack
     * plus a new final text block. */
    const r2 = selectTtsContent(
      rec({
        stop_reason: 'end_turn',
        texts: [ack, final],
        uuid: 'turn-X',
      }),
      spoken,
    );
    expect(r2.drop).toBe(false);
    expect(r2.is_pre_tool_ack).toBe(false);
    /* Only the new `final` block should be spoken; `ack` already
     * landed in the speaker. */
    expect(r2.new_text).toBe(final);
    /* fullText still includes both so artifacts / attention /
     * compaction see the complete turn. */
    expect(r2.full_text).toBe(`${ack}\n${final}`);
  });

  it('end_turn that echoes ONLY already-spoken text -> drop=false (pipeline runs)', () => {
    const spoken = new Set<string>([hashSegment('Already spoken.')]);
    const r = selectTtsContent(
      rec({
        stop_reason: 'end_turn',
        texts: ['Already spoken.'],
        uuid: 'turn-Y',
      }),
      spoken,
    );
    /* drop=false because fullText is non-empty; new_text is empty
     * so the caller's `if (text)` block skips the speak/send/chunk
     * insert but still runs the artifacts/attention/compaction
     * pipeline on full_text. */
    expect(r.drop).toBe(false);
    expect(r.new_text).toBe('');
    expect(r.full_text).toBe('Already spoken.');
  });
});

/* Mid-turn (tool_use) speech is spoken IN FULL, identical to the
 * end_turn body (2026-07-19). The old clampAck truncated every mid-turn
 * reply to its first sentence or dropped it to the canned 'On it.'
 * sentinel, so the operator heard silence after the first period on
 * every substantive mid-turn reply. The fundamental mid-turn vs
 * end-turn divergence WAS the bug; decidePreToolAck now speaks the whole
 * thing. Double-speak of an identical end_turn block is still prevented
 * by the caller's per-segment hash dedupe, not by clamping. P0 no-silent-
 * drop still holds: empty text yields a NAMED drop, never a silent
 * nothing. */
describe('decidePreToolAck (mid-turn spoken IN FULL, no clamp)', () => {
  it('speaks a short mid-turn line in full', () => {
    const d = decidePreToolAck('Got it boss, looking now');
    expect(d.speak).toBe('Got it boss, looking now');
    expect(d.dropReason).toBeNull();
  });

  it('speaks a MULTI-SENTENCE substantive mid-turn reply IN FULL (2026-07-19 live drop)', () => {
    /* The live failure: every substantive mid-turn reply was clamped to
     * its first sentence or dropped, so the operator heard nothing after
     * the first period. */
    const body =
      "Confirmed drop: the worker's transcript is byte-for-byte unchanged. " +
      'The inject never landed. Re-firing into the live session now.';
    const d = decidePreToolAck(body);
    expect(d.speak).toBe(body);
    expect(d.dropReason).toBeNull();
  });

  it('speaks a long answer-bearing mid-turn line in full (no canned clamp)', () => {
    const fat =
      'Right you cold-started me after the bounce that is the only reason I have context';
    const d = decidePreToolAck(fat);
    expect(d.speak).toBe(fat);
    expect(d.dropReason).toBeNull();
  });

  it('trims but preserves the whole body', () => {
    const d = decidePreToolAck('  Found the real problem, and it is the binding bug.  ');
    expect(d.speak).toBe('Found the real problem, and it is the binding bug.');
    expect(d.dropReason).toBeNull();
  });

  it('names the drop on empty / whitespace text (no silent drop)', () => {
    expect(decidePreToolAck('').speak).toBeNull();
    expect(decidePreToolAck('').dropReason).not.toBeNull();
    expect(decidePreToolAck('   ').dropReason).not.toBeNull();
  });

  it('is TOTAL: every input yields exactly one of speak / dropReason', () => {
    const samples = [
      'On it.',
      'Short ack.',
      'Confirmed drop: transcript unchanged. Re-firing now.',
      'Right you cold-started me after the bounce that is the only reason I have context',
      '',
      '   ',
      'word '.repeat(40),
    ];
    for (const s of samples) {
      const d = decidePreToolAck(s);
      const speakSet = d.speak !== null;
      const dropSet = d.dropReason !== null;
      /* exactly one populated - never both, never neither (no silent drop) */
      expect(speakSet !== dropSet).toBe(true);
    }
  });
});

describe('accountSpeech (P0 no-silent-drop)', () => {
  it('speaks trimmed non-empty text', () => {
    const a = accountSpeech('  hello there  ');
    expect(a.speak).toBe('hello there');
    expect(a.dropReason).toBeNull();
  });

  it('names the drop for null / undefined / empty / whitespace', () => {
    expect(accountSpeech(null).dropReason).toBe('null');
    expect(accountSpeech(undefined).dropReason).toBe('null');
    expect(accountSpeech('').dropReason).toBe('empty');
    expect(accountSpeech('   ').dropReason).toBe('empty');
  });

  it('is TOTAL: every input yields exactly one of speak / dropReason', () => {
    const samples: Array<string | null | undefined> = [
      'hi',
      '  spaced  ',
      '',
      '   ',
      null,
      undefined,
    ];
    for (const s of samples) {
      const a = accountSpeech(s);
      expect((a.speak !== null) !== (a.dropReason !== null)).toBe(true);
    }
  });
});

describe('hashSegment', () => {
  it('is stable + collision-resistant for typical inputs', () => {
    expect(hashSegment('Investigating now.')).toBe(
      hashSegment('Investigating now.'),
    );
    expect(hashSegment('a')).not.toBe(hashSegment('b'));
    expect(hashSegment('short')).not.toBe(hashSegment('shorts'));
  });
});
