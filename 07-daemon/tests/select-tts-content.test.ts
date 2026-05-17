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

describe('hashSegment', () => {
  it('is stable + collision-resistant for typical inputs', () => {
    expect(hashSegment('Investigating now.')).toBe(
      hashSegment('Investigating now.'),
    );
    expect(hashSegment('a')).not.toBe(hashSegment('b'));
    expect(hashSegment('short')).not.toBe(hashSegment('shorts'));
  });
});
