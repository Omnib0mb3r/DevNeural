import { describe, it, expect } from "vitest";
import { groupTranscriptTurns } from "../lib/transcript-grouping";
import type { TranscriptTurn } from "../lib/transcript-grouping";

/**
 * One Lex (2026-09-22, LAYER-1-CONTROL.md "Transcript and client"): the
 * transcript never reveals that two layers answer the operator. Every
 * assistant turn, voice (`top`) or brain (`mid`), is its own flat row in
 * order; nothing folds, nothing collapses.
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

describe("groupTranscriptTurns (one Lex, flat rows)", () => {
  it("renders voice and brain turns as their own rows, in order", () => {
    const groups = groupTranscriptTurns([
      op("start the build"),
      top("on it"),
      mid("build kicked off"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.row?.layer)).toEqual(["operator", "top", "mid"]);
    expect(groups[2]!.row?.text).toBe("build kicked off");
    for (const g of groups) expect(g.deep).toHaveLength(0);
  });

  it("consecutive brain turns stay separate rows", () => {
    const groups = groupTranscriptTurns([
      op("q"),
      top("ack"),
      mid("part one", "m1"),
      mid("part two", "m2"),
    ]);
    expect(groups.map((g) => g.row?.text)).toEqual(["q", "ack", "part one", "part two"]);
  });

  it("a brain reply with no preceding voice line is still a row, never hidden", () => {
    const groups = groupTranscriptTurns([mid("straight answer")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.row).toMatchObject({ layer: "mid", text: "straight answer" });
    expect(groups[0]!.deep).toHaveLength(0);
  });

  it("keeps back-compat: legacy assistant turns (no layer) are rows", () => {
    const groups = groupTranscriptTurns([
      { id: "u", role: "user", text: "hi" },
      { id: "a", role: "assistant", text: "hello" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.row?.role).toBe("user");
    expect(groups[1]!.row?.role).toBe("assistant");
  });

  it("group ids are stable on the turn id, index as the fallback", () => {
    const groups = groupTranscriptTurns([op("a", "x1"), { role: "user", text: "b" }]);
    expect(groups.map((g) => g.id)).toEqual(["g-x1", "g-1"]);
  });

  it("an ignored operator turn (Layer 1 dropped it) survives grouping with the flag intact", () => {
    const groups = groupTranscriptTurns([
      op("start the build", "o1"),
      { ...op("pass the remote", "i1"), ignored: true },
      top("on it", "t1"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[1]!.row).toMatchObject({
      layer: "operator",
      text: "pass the remote",
      ignored: true,
    });
    expect(groups[0]!.row?.ignored).toBeUndefined();
    expect(groups[2]!.row?.ignored).toBeUndefined();
  });
});
