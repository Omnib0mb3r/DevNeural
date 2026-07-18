import { describe, it, expect, vi } from "vitest";
import {
  emitVoiceAnchorSwitch,
  onVoiceAnchorSwitch,
} from "../lib/voice-anchor-bus";

/**
 * SESSIONS-VIEW read-only (2026-07-18) defect 2, switch path: switching
 * the live voice to another brainstorm must be a soft, in-app signal -
 * NOT a full-page reload (which remounts VoiceClient and blips voice).
 * The nav sites router.push the URL and emit this event; VoiceClient and
 * the Lex page subscribe and re-pin the bind on the live socket, so the
 * switch never tears voice down.
 */
describe("voice-anchor-bus", () => {
  it("delivers an emitted anchor id to a subscriber", () => {
    const seen: (string | null)[] = [];
    const off = onVoiceAnchorSwitch((id) => seen.push(id));
    emitVoiceAnchorSwitch("bs-42");
    emitVoiceAnchorSwitch(null);
    off();
    expect(seen).toEqual(["bs-42", null]);
  });

  it("stops delivering after unsubscribe", () => {
    const cb = vi.fn();
    const off = onVoiceAnchorSwitch(cb);
    off();
    emitVoiceAnchorSwitch("bs-1");
    expect(cb).not.toHaveBeenCalled();
  });

  it("emitting with no subscriber does not throw", () => {
    expect(() => emitVoiceAnchorSwitch("x")).not.toThrow();
    const off = onVoiceAnchorSwitch(() => undefined);
    expect(typeof off).toBe("function");
    off();
  });
});
