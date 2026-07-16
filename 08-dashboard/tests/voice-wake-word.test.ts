/**
 * Client-side wake-word matcher + dedupe guard.
 *
 * 2026-07-15 voice top layer v2: the spoken keyword grammar is gone;
 * control phrases are interpreted by the speech-first voice brain's
 * CONTROL lines instead. The ONE surviving mechanical keyword is the
 * panic phrase "lex emergency stop". These tests pin:
 *   - matchWakeWord recognizes ONLY the panic phrase (lex prefix
 *     required, case-insensitive, tolerant of leading filler and
 *     whisper punctuation) and returns null for every retired
 *     keyword the old grammar used to match.
 *   - createDedupe blocks a same-kind re-fire within the window so
 *     a tight burst of interim Web Speech results + a trailing
 *     whisper transcript carrying the same phrase do not double-
 *     dispatch.
 *   - processWakeResults walks only NEW results (the resultIndex
 *     cursor) and bails on the first matching alternative per
 *     result.
 */
import { describe, expect, it, vi } from "vitest";
import {
  matchWakeWord,
  createDedupe,
  processWakeResults,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionResultLike,
} from "../lib/voice-wake-word";

/* Build a Web Speech-shaped result event for tests. Each `results`
 * entry is one finalised fragment with a single alternative; the
 * resultIndex on the event marks where NEW results start, per the
 * Web Speech spec. */
function fakeEvent(
  transcripts: string[],
  resultIndex: number,
): SpeechRecognitionEventLike {
  const results: SpeechRecognitionResultLike[] = transcripts.map((t) => {
    const alts = [{ transcript: t, confidence: 0.95 }];
    return Object.assign(alts, { isFinal: true }) as SpeechRecognitionResultLike;
  });
  return { results, resultIndex };
}

describe("matchWakeWord", () => {
  it("matches the panic phrase", () => {
    expect(matchWakeWord("lex emergency stop")).toBe("panic");
    expect(matchWakeWord("Lex, emergency stop!")).toBe("panic");
    expect(matchWakeWord("LEX EMERGENCY STOP")).toBe("panic");
  });

  it("tolerates leading filler and sloppy whisper spacing", () => {
    expect(matchWakeWord("uh lex emergency stop please")).toBe("panic");
    expect(matchWakeWord("okay LEX  EMERGENCY  STOP!")).toBe("panic");
  });

  it("requires the lex prefix", () => {
    expect(matchWakeWord("emergency stop")).toBeNull();
  });

  it("does NOT match any retired keyword from the old grammar", () => {
    /* voice top layer v2: everything below is now interpreted by the
     * speech-first voice brain, not a client regex. The matcher must
     * stay dumb to all of it so the brain gets the utterance. */
    const retired = [
      "lex disable",
      "lex mute",
      "lex shut up",
      "lex be quiet",
      "lex stop talking",
      "lex unmute",
      "lex resume",
      "lex come back",
      "lex you can talk",
      "lex start talking again",
      "lex stand by",
      "lex pause listening",
      "lex hold on",
      "lex listen",
      "lex resume listening",
      "lex i'm back",
      "lex end session",
      "lex hold up",
      "lex holdup",
    ];
    for (const phrase of retired) {
      expect(matchWakeWord(phrase), phrase).toBeNull();
    }
  });

  it("returns null on empty / whitespace input", () => {
    expect(matchWakeWord("")).toBeNull();
    expect(matchWakeWord("   ")).toBeNull();
  });
});

describe("createDedupe", () => {
  it("returns true on the first fire and false within the window for the same kind", () => {
    const guard = createDedupe(1500);
    expect(guard.shouldFire("panic", 1000)).toBe(true);
    expect(guard.shouldFire("panic", 1500)).toBe(false);
    expect(guard.shouldFire("panic", 2499)).toBe(false);
  });

  it("allows the same kind again after the window has passed", () => {
    const guard = createDedupe(1500);
    expect(guard.shouldFire("panic", 1000)).toBe(true);
    expect(guard.shouldFire("panic", 2500)).toBe(true);
  });

  it("tracks each kind independently", () => {
    /* mute/unmute/disable still flow through the dedupe via the
     * keyboard-hotkey fallback, so the guard stays kind-scoped. */
    const guard = createDedupe(1500);
    expect(guard.shouldFire("mute", 1000)).toBe(true);
    expect(guard.shouldFire("disable", 1000)).toBe(true);
    expect(guard.shouldFire("unmute", 1000)).toBe(true);
    expect(guard.shouldFire("mute", 1100)).toBe(false);
    expect(guard.shouldFire("disable", 1100)).toBe(false);
  });

  it("uses Date.now when no timestamp is supplied", () => {
    /* Smoke test: two calls in immediate succession should land in
     * the dedupe window without an explicit timestamp argument. */
    const guard = createDedupe(1500);
    expect(guard.shouldFire("panic")).toBe(true);
    expect(guard.shouldFire("panic")).toBe(false);
  });
});

describe("processWakeResults", () => {
  /* Regression for bug 2026-05-14: Web Speech in continuous mode
   * never trims event.results; every finalised fragment from the
   * lifetime of the recognizer stays at its original index. The
   * walker reads from event.resultIndex so only NEW finals on THIS
   * event are dispatched. */
  it("only dispatches the NEW result when a prior panic final stays at index 0", () => {
    const dispatch = vi.fn();
    /* Simulates Chromium's second onresult after the user already
     * said the panic phrase once (now sitting permanently at
     * results[0] isFinal=true) and just said it again at results[1].
     * resultIndex=1 marks results[1] as the only new fragment; a
     * 0-based walk would dispatch twice. */
    processWakeResults(
      fakeEvent(["lex emergency stop", "lex emergency stop"], 1),
      { dispatch },
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("panic");
  });

  it("dispatches each new matching fragment when resultIndex=0 and both are new", () => {
    const dispatch = vi.fn();
    processWakeResults(
      fakeEvent(["lex emergency stop", "lex emergency stop"], 0),
      { dispatch },
    );
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(["panic", "panic"]);
  });

  it("defaults to resultIndex=0 when the event omits the field (older builds)", () => {
    const dispatch = vi.fn();
    const event: SpeechRecognitionEventLike = {
      results: fakeEvent(["lex emergency stop"], 0).results,
    };
    processWakeResults(event, { dispatch });
    expect(dispatch).toHaveBeenCalledWith("panic");
  });

  it("ignores already-delivered results before resultIndex even when they match", () => {
    const dispatch = vi.fn();
    processWakeResults(
      fakeEvent(
        ["lex emergency stop", "background noise", "lex emergency stop"],
        2,
      ),
      { dispatch },
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("panic");
  });

  it("does not dispatch retired keywords even as new results", () => {
    const dispatch = vi.fn();
    processWakeResults(fakeEvent(["lex shut up", "lex disable"], 0), {
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("walks alternatives within one result and bails on the first match", () => {
    const dispatch = vi.fn();
    const results: SpeechRecognitionResultLike[] = [
      Object.assign(
        [
          { transcript: "background", confidence: 0.4 },
          { transcript: "lex emergency stop", confidence: 0.92 },
          { transcript: "lex emergency stop please", confidence: 0.5 },
        ],
        { isFinal: true },
      ) as SpeechRecognitionResultLike,
    ];
    processWakeResults({ results, resultIndex: 0 }, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("panic");
  });

  it("fires onCandidate for every alternative the walker visits, with the matcher's verdict", () => {
    const candidates: Array<{
      transcript: string;
      matched: string | null;
    }> = [];
    processWakeResults(fakeEvent(["hello there", "lex emergency stop"], 0), {
      dispatch: () => {},
      onCandidate: ({ transcript, matched }) => {
        candidates.push({ transcript, matched });
      },
    });
    expect(candidates).toEqual([
      { transcript: "hello there", matched: null },
      { transcript: "lex emergency stop", matched: "panic" },
    ]);
  });
});
