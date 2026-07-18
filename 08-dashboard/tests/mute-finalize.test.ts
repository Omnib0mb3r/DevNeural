import { describe, it, expect } from "vitest";
import { shouldFinalizeUtteranceOnMute } from "../lib/mute-finalize";

/**
 * P5 (2026-07-18 VOICE-TOP-LAYER-SMARTS-SPEC): mute is a SOFT ENDPOINT,
 * not a discard. Pressing mute mid-utterance finalizes the in-progress
 * utterance and SUBMITS what was captured, then goes muted. Real case:
 * a loud room, the operator mutes the instant he finishes speaking. A
 * true cancel / "scrap that" is a separate gesture (out of scope).
 *
 * This decision gates the finalize+ship: only when MUTING (not
 * unmuting) AND an utterance is actively being captured.
 */
describe("shouldFinalizeUtteranceOnMute (P5)", () => {
  it("finalizes + ships when muting mid-utterance (capture in flight)", () => {
    expect(
      shouldFinalizeUtteranceOnMute({ muting: true, capturing: true }),
    ).toBe(true);
  });

  it("does nothing to ship when muting with no utterance in flight", () => {
    expect(
      shouldFinalizeUtteranceOnMute({ muting: true, capturing: false }),
    ).toBe(false);
  });

  it("never finalizes on unmute", () => {
    expect(
      shouldFinalizeUtteranceOnMute({ muting: false, capturing: true }),
    ).toBe(false);
    expect(
      shouldFinalizeUtteranceOnMute({ muting: false, capturing: false }),
    ).toBe(false);
  });
});
