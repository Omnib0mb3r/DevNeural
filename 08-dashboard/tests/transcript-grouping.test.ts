import { describe, it, expect } from "vitest";
import { groupTranscriptTurns } from "../lib/transcript-grouping";
import type { TranscriptTurn } from "../lib/transcript-grouping";

/**
 * P4 (2026-07-18 VOICE-TOP-LAYER-SMARTS-SPEC): the three-way transcript
 * must read as a TWO-PARTY conversation between the operator and VOICE.
 * The deep (MID) layer is NOT a bubble that addresses the operator; it
 * renders as a thin COLLAPSED step-down node UNDER the voice line.
 *
 * groupTranscriptTurns is the pure grouping the panel renders: operator
 * and voice turns become top-level rows; each mid (deep) turn is folded
 * into the `deep` list of the most recent row (the voice line it
 * answered), never a row of its own.
 */
const op = (text: string, id = "o"): TranscriptTurn => ({
  id,
  role: "user",
  text,
  layer: "operator",
});
const top = (text: string, id = "t"): TranscriptTurn => ({
  id,
  role: "assistant",
  text,
  layer: "top",
});
const mid = (text: string, id = "m"): TranscriptTurn => ({
  id,
  role: "assistant",
  text,
  layer: "mid",
});

describe("groupTranscriptTurns (P4 two-party + collapsed deep)", () => {
  it("folds a mid turn under the preceding voice line", () => {
    const groups = groupTranscriptTurns([
      op("start the build"),
      top("on it, handing to Lex"),
      mid("build kicked off"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.row).toMatchObject({ layer: "operator" });
    expect(groups[0]!.deep).toHaveLength(0);
    expect(groups[1]!.row).toMatchObject({ layer: "top" });
    expect(groups[1]!.deep).toHaveLength(1);
    expect(groups[1]!.deep[0]!.text).toBe("build kicked off");
  });

  it("never emits a mid turn as its own top-level row", () => {
    const groups = groupTranscriptTurns([
      op("q"),
      top("ack"),
      mid("deep answer"),
    ]);
    for (const g of groups) {
      expect(g.row?.layer).not.toBe("mid");
    }
  });

  it("attaches multiple consecutive mids to the same voice line", () => {
    const groups = groupTranscriptTurns([
      op("q"),
      top("ack"),
      mid("part one", "m1"),
      mid("part two", "m2"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.deep.map((d) => d.text)).toEqual(["part one", "part two"]);
  });

  it("a conversational (top-only) turn has no deep child", () => {
    /* P2 case: the top fielded a greeting itself, nothing went deep. */
    const groups = groupTranscriptTurns([op("good morning"), top("morning boss")]);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.row).toMatchObject({ layer: "top" });
    expect(groups[1]!.deep).toHaveLength(0);
  });

  it("keeps back-compat: legacy assistant turns (no layer) are voice rows", () => {
    const groups = groupTranscriptTurns([
      { id: "u", role: "user", text: "hi" },
      { id: "a", role: "assistant", text: "hello" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.row?.role).toBe("user");
    expect(groups[1]!.row?.role).toBe("assistant");
    expect(groups[1]!.deep).toHaveLength(0);
  });

  it("an orphan mid (no preceding row) folds into a row-less deep group, never a bubble", () => {
    const groups = groupTranscriptTurns([mid("orphan deep")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.row).toBeNull();
    expect(groups[0]!.deep).toHaveLength(1);
  });

  it("two full exchanges each keep their own deep child", () => {
    const groups = groupTranscriptTurns([
      op("first", "o1"),
      top("ack1", "t1"),
      mid("deep1", "m1"),
      op("second", "o2"),
      top("ack2", "t2"),
      mid("deep2", "m2"),
    ]);
    expect(groups).toHaveLength(4);
    expect(groups[1]!.deep[0]!.text).toBe("deep1");
    expect(groups[3]!.deep[0]!.text).toBe("deep2");
  });
});
