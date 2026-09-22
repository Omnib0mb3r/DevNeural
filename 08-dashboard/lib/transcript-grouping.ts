/**
 * Transcript grouping.
 *
 * One Lex (2026-09-22, LAYER-1-CONTROL.md "Transcript and client"): the
 * operator should never be able to tell that a fast voice layer and a
 * deeper reasoning layer answer him. Every assistant line, whether it
 * came from the voice (`top`: the spoken lines) or the brain (`mid`: the
 * reply text), is a top-level `lex:` row, rendered flat in order.
 *
 * History: the P4 shape (2026-07-18) folded every `mid` turn into a
 * collapsed "brain replied" step-down node under the voice line, back
 * when the voice re-spoke the brain's reply as its own visible bubble
 * and the two would otherwise have read as a duplicate. The voice no
 * longer emits its delivery as transcript lines, so the brain's text IS
 * the visible answer and must not hide behind a toggle.
 *
 * The group shape is kept (row + deep) so the panel API stays stable;
 * `deep` is always empty now. Kept separate from the React component so
 * the contract pins without mounting a tree.
 */

/** Structural turn shape shared with the transcript bus / panel. */
export interface TranscriptTurn {
  id?: string;
  role: "user" | "assistant";
  text: string;
  layer?: "operator" | "top" | "mid";
  silent?: boolean;
  /** Layer 1 dropped this operator utterance (background noise or not
   * addressed to Lex; LAYER-1-CONTROL.md "Transcript and client").
   * Nothing was forwarded. The row still renders, greyed, so the
   * operator can see what was dropped. Grouping passes it through
   * untouched. */
  ignored?: boolean;
}

export interface TranscriptGroup {
  /** Stable key for the group (row id, else index). */
  id: string;
  /** The conversation line. Never null since 2026-09-22 (every turn is
   * a row); the type stays nullable for the panel's back-compat. */
  row: TranscriptTurn | null;
  /** Always empty since 2026-09-22 (no collapsed step-down nodes). */
  deep: TranscriptTurn[];
}

export function groupTranscriptTurns(
  turns: readonly TranscriptTurn[],
): TranscriptGroup[] {
  return turns.map((t, i) => ({ id: `g-${t.id ?? String(i)}`, row: t, deep: [] }));
}
