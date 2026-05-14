/**
 * Platform-aware keyboard-chord glyph picker.
 *
 * Pure helper used by the TopBar search-button hint: ⌘ on macOS,
 * Ctrl everywhere else. Pinned across the User-Agent Client Hints
 * platform strings + legacy navigator.platform values seen in the
 * wild.
 */
import { describe, expect, it } from "vitest";
import { pickModKey } from "../lib/platform-mod-key";

describe("pickModKey", () => {
  it("returns ⌘ for macOS via UA-CH platform", () => {
    expect(pickModKey("macOS")).toBe("\u2318");
  });

  it("returns ⌘ for legacy navigator.platform MacIntel", () => {
    expect(pickModKey("MacIntel")).toBe("\u2318");
  });

  it("matches case-insensitively for macarm variants", () => {
    expect(pickModKey("macarm64")).toBe("\u2318");
    expect(pickModKey("Mac68K")).toBe("\u2318");
  });

  it("returns Ctrl for Windows", () => {
    expect(pickModKey("Windows")).toBe("Ctrl");
    expect(pickModKey("Win32")).toBe("Ctrl");
  });

  it("returns Ctrl for Linux + ChromeOS + Android", () => {
    expect(pickModKey("Linux")).toBe("Ctrl");
    expect(pickModKey("Linux x86_64")).toBe("Ctrl");
    expect(pickModKey("Chrome OS")).toBe("Ctrl");
    expect(pickModKey("Android")).toBe("Ctrl");
  });

  it("returns Ctrl for empty / null / undefined / non-string input", () => {
    expect(pickModKey("")).toBe("Ctrl");
    expect(pickModKey(null)).toBe("Ctrl");
    expect(pickModKey(undefined)).toBe("Ctrl");
    expect(pickModKey(42 as unknown as string)).toBe("Ctrl");
  });
});
