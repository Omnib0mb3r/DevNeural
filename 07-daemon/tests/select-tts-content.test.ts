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
  clampAck,
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

describe('clampAck', () => {
  it('keeps a short single-sentence ack as-is', () => {
    expect(clampAck('On it.')).toBe('On it.');
    expect(clampAck('Got it boss, looking now')).toBe('Got it boss, looking now');
  });

  it('keeps only the first sentence when an ack runs on', () => {
    expect(clampAck('Hold on. If you pressed restart something is off. Let me check.')).toBe(
      'Hold on.',
    );
  });

  it('replaces a fat answer-bearing ack with a canned ack (over 10 words, no early period)', () => {
    const fat =
      'Right you cold-started me after the bounce that is the only reason I have context';
    expect(clampAck(fat)).toBe('On it.');
  });

  it('falls back to canned ack on empty input', () => {
    expect(clampAck('')).toBe('On it.');
    expect(clampAck('   ')).toBe('On it.');
  });
});

/* P0 (2026-07-18 VOICE-TOP-LAYER-SMARTS-SPEC): no silent drops. Every
 * speech emission decision is TOTAL - it either yields text to speak or
 * a NAMED drop reason, never a silent nothing. These pins prove the
 * invariant at the decision layer; the WS logs the named reason. */
describe('decidePreToolAck (P0 no-silent-drop)', () => {
  it('yields the clamped ack to speak for a short first sentence', () => {
    const d = decidePreToolAck('Got it boss, looking now');
    expect(d.speak).toBe('Got it boss, looking now');
    expect(d.dropReason).toBeNull();
  });

  it('names the drop when the ack clamps to the canned sentinel', () => {
    /* A fat, answer-bearing ack (>10 words, no early period) clamps to
     * the canned 'On it.' - which the no-hardcoded-talking rule refuses
     * to speak. Pre-fix this was a SILENT nothing; now it is a NAMED
     * drop the caller logs loudly. */
    const fat =
      'Right you cold-started me after the bounce that is the only reason I have context';
    const d = decidePreToolAck(fat);
    expect(d.speak).toBeNull();
    expect(d.dropReason).toBe('ack-clamped-to-canned');
  });

  it('names the drop on empty / whitespace ack text', () => {
    expect(decidePreToolAck('').dropReason).toBe('ack-clamped-to-canned');
    expect(decidePreToolAck('   ').dropReason).toBe('ack-clamped-to-canned');
  });

  it('is TOTAL: every input yields exactly one of speak / dropReason', () => {
    const samples = [
      'On it.',
      'Short ack.',
      'Got it boss, looking now',
      'Hold on. Let me check.',
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
