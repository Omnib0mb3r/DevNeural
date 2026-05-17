/**
 * Pure helper that decides what (if anything) the voice WS should
 * speak from a Claude Code jsonl assistant record.
 *
 * Extracted from the inline logic in `attachLexVoiceWs` so the
 * stop_reason + per-segment dedupe rules can be unit-tested without
 * standing up the WS, the brainstorm store, or any of the
 * downstream pipelines (artifacts, attention, compaction).
 *
 * Two stop_reason values are user-visible speech:
 *   - end_turn  - the assistant turn finished. Run the full
 *                 pipeline.
 *   - tool_use  - the assistant emitted a pre-tool ack ("Investigating",
 *                 "On it", etc.) followed by a tool call. The text
 *                 content is what we want spoken; the tool call
 *                 itself is handled by the worker side. Fix 13: the
 *                 legacy filter early-returned on anything but
 *                 end_turn, silently dropping every pre-tool ack
 *                 from the TTS path.
 *
 * Per-segment dedupe lives outside this helper (caller owns the
 * spoken-hashes set). The hashSegment function is exposed so tests
 * + production share the same hash.
 */

export interface AssistantJsonlRecord {
  type?: string;
  uuid?: string;
  message?: {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
  };
}

export interface SelectTtsContentResult {
  /** Drop the record entirely; the caller's handler should return
   * without touching any downstream pipeline. */
  drop: boolean;
  /** True when stop_reason is 'tool_use' (pre-tool ack path). The
   * caller speaks but skips end-of-turn artifacts / attention /
   * compaction. */
  is_pre_tool_ack: boolean;
  /** Text the caller should pass to speak() / send as assistant-
   * text. May be empty when every text block has already been
   * spoken; combine with `full_text` to know if the end_turn
   * pipeline still has work to do. */
  new_text: string;
  /** The full assistant message text, with already-spoken segments
   * INCLUDED. Caller uses this for artifacts / attention / large-fs
   * extraction on the end_turn path. */
  full_text: string;
  /** Hashes the caller should add to its spoken-segment set after
   * the speak() / send() succeeds. */
  new_hashes: string[];
}

export function hashSegment(text: string): string {
  /* djb2 variant + xor. Cheap, deterministic, fine for collision
   * probability on the volumes one brainstorm produces. The dedupe
   * failure mode of a collision is a missed re-speak, not a double-
   * speak, so the bar is low. */
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h * 33) ^ text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${h}`;
}

export function selectTtsContent(
  rec: AssistantJsonlRecord,
  alreadySpoken: ReadonlySet<string>,
): SelectTtsContentResult {
  const drop: SelectTtsContentResult = {
    drop: true,
    is_pre_tool_ack: false,
    new_text: '',
    full_text: '',
    new_hashes: [],
  };
  if (rec.type !== 'assistant') return drop;
  const message = rec.message;
  if (!message) return drop;
  const stopReason = message.stop_reason;
  if (stopReason !== 'end_turn' && stopReason !== 'tool_use') return drop;
  const isPreToolAck = stopReason === 'tool_use';
  const allTexts: string[] = [];
  const newTexts: string[] = [];
  const newHashes: string[] = [];
  for (const c of message.content ?? []) {
    if (c?.type !== 'text' || typeof c.text !== 'string') continue;
    allTexts.push(c.text);
    const h = hashSegment(c.text);
    if (!alreadySpoken.has(h)) {
      newTexts.push(c.text);
      newHashes.push(h);
    }
  }
  const newText = newTexts.join('\n').trim();
  const fullText = allTexts.join('\n').trim();
  /* Pre-tool ack with nothing new to speak (e.g. tool_use turn that
   * holds only the tool_use block, no text): drop the record so the
   * caller's handler short-circuits before running any side
   * effects. */
  if (isPreToolAck && !newText) return drop;
  /* end_turn with no text content at all: drop. The pipeline below
   * has nothing user-visible to surface. */
  if (!isPreToolAck && !fullText) return drop;
  return {
    drop: false,
    is_pre_tool_ack: isPreToolAck,
    new_text: newText,
    full_text: fullText,
    new_hashes: newHashes,
  };
}
