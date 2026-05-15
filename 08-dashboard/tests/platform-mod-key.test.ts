/**
 * Platform-aware keyboard-chord glyph picker.
 *
 * Pure helper used by the TopBar search-button hint: ⌘ on macOS,
 * Ctrl everywhere else. Pinned across the User-Agent Client Hints
 * platform strings + legacy navigator.platform values seen in the
 * wild.
 */
import { describe, expect, it } from "vitest";
import { pickModKey, pickModKeyStrict } from "../lib/platform-mod-key";

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

describe("pickModKeyStrict", () => {
  it("returns ⌘ only when both signals confirm macOS", () => {
    expect(pickModKeyStrict("macOS", "MacIntel")).toBe("\u2318");
    expect(pickModKeyStrict("macOS", "MacARM")).toBe("\u2318");
    expect(pickModKeyStrict("macOS", "Mac68K")).toBe("\u2318");
  });

  it("returns Ctrl when UA-CH says macOS but legacy.platform does not start with Mac", () => {
    /* Defends against UA-CH spoofing in jailbroken / dev-overridden
     * Chromium builds where userAgentData lies but navigator.platform
     * still reports the real host string. */
    expect(pickModKeyStrict("macOS", "Win32")).toBe("Ctrl");
    expect(pickModKeyStrict("macOS", "Linux x86_64")).toBe("Ctrl");
    expect(pickModKeyStrict("macOS", "iPhone")).toBe("Ctrl");
  });

  it("returns Ctrl when navigator.platform starts with Mac but UA-CH says something else", () => {
    /* Defends against the inverse: Safari on iPad lies about platform
     * in some configurations; we still want Ctrl. */
    expect(pickModKeyStrict("Windows", "MacIntel")).toBe("Ctrl");
    expect(pickModKeyStrict("Linux", "MacIntel")).toBe("Ctrl");
    expect(pickModKeyStrict("iOS", "MacIntel")).toBe("Ctrl");
  });

  it("returns Ctrl when either signal is missing", () => {
    expect(pickModKeyStrict(undefined, "MacIntel")).toBe("Ctrl");
    expect(pickModKeyStrict(null, "MacIntel")).toBe("Ctrl");
    expect(pickModKeyStrict("macOS", undefined)).toBe("Ctrl");
    expect(pickModKeyStrict("macOS", null)).toBe("Ctrl");
    expect(pickModKeyStrict(null, null)).toBe("Ctrl");
  });

  it("requires exact 'macOS' for the UA-CH signal (not just /^mac/i)", () => {
    /* UA-CH spec gives exactly the string "macOS"; anything else is a
     * non-spec quirk and shouldn't count. */
    expect(pickModKeyStrict("MacOS", "MacIntel")).toBe("Ctrl");
    expect(pickModKeyStrict("macos", "MacIntel")).toBe("Ctrl");
    expect(pickModKeyStrict("Mac OS X", "MacIntel")).toBe("Ctrl");
  });

  it("requires case-sensitive 'Mac' prefix on legacy.platform", () => {
    /* Real macOS browsers report capital-M Mac strings. A lowercase
     * 'mac' is a sign of a spoofed or non-Apple host. */
    expect(pickModKeyStrict("macOS", "mac")).toBe("Ctrl");
    expect(pickModKeyStrict("macOS", "macintosh")).toBe("Ctrl");
  });
});
