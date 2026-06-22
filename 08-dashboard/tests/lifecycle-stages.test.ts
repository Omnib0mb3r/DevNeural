import { describe, it, expect } from "vitest";
import { LIFECYCLE_STAGES, stageIndex } from "@/lib/lifecycle-stages";

describe("lifecycle stages (rail)", () => {
  it("mirrors the daemon's six gates in order", () => {
    expect(LIFECYCLE_STAGES.map((s) => s.key)).toEqual([
      "new_project",
      "spec",
      "tdd",
      "execution",
      "test",
      "bug_handling",
    ]);
  });

  it("stageIndex resolves the forward position", () => {
    expect(stageIndex("new_project")).toBe(0);
    expect(stageIndex("execution")).toBe(3);
    expect(stageIndex("bug_handling")).toBe(5);
  });

  it("stageIndex returns -1 for unknown / empty", () => {
    expect(stageIndex("nope")).toBe(-1);
    expect(stageIndex(null)).toBe(-1);
    expect(stageIndex(undefined)).toBe(-1);
  });
});
