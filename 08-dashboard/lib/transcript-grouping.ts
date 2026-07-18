/**
 * Transcript grouping (P4, 2026-07-18 VOICE-TOP-LAYER-SMARTS-SPEC).
 *
 * The three-way voice transcript (operator -> TOP fast voice -> MID
 * deep reasoning) must READ as a two-party conversation between the
 * operator and VOICE. The deep (MID) layer is never a bubble that
 * addresses the operator; it renders as a thin COLLAPSED step-down node
 * under the voice line it answered.
 *
 * This pure helper turns the flat turn list into that shape: operator
 * and voice turns become top-level rows; each `mid` turn folds into the
 * `deep` list of the most recent row (the voice line it belongs under),
 * never a row of its own. Kept separate from the React component so the
 * grouping contract pins without mounting a tree.
 */

/** Structural turn shape shared with the transcript bus / panel. */
export interface TranscriptTurn {
  id?: string;
  role: "user" | "assistant";
  text: string;
  layer?: "operator" | "top" | "mid";
  silent?: boolean;
}

export interface TranscriptGroup {
  /** Stable key for the group (row id, else first deep id, else index). */
  id: string;
  /** The top-level conversation line (operator / voice / legacy). Null
   * for an orphan deep-only group (a mid with no preceding row) so the
   * deep still renders collapsed, never as an operator-addressed
   * bubble. */
  row: TranscriptTurn | null;
  /** Deep (MID) turns folded under this row, rendered collapsed. */
  deep: TranscriptTurn[];
}

export function groupTranscriptTurns(
  turns: readonly TranscriptTurn[],
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  turns.forEach((t, i) => {
    if (t.layer === "mid") {
      let last = groups[groups.length - 1];
      if (!last) {
        /* Orphan deep (no voice line yet): a row-less group so it still
         * renders as a collapsed node, never a top-level bubble. */
        last = { id: `g-${t.id ?? `deep-${i}`}`, row: null, deep: [] };
        groups.push(last);
      }
      last.deep.push(t);
      return;
    }
    groups.push({ id: `g-${t.id ?? String(i)}`, row: t, deep: [] });
  });
  return groups;
}
