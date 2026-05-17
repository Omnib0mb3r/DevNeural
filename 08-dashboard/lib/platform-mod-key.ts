/**
 * Resolve the platform-appropriate keyboard chord glyph.
 *
 * Strict policy: ⌘ requires BOTH signals to agree on macOS:
 *   - userAgentData.platform === "macOS" (exact, UA-CH)
 *   - navigator.platform starts with "Mac" (case-sensitive legacy field;
 *     real macOS browsers report MacIntel, MacARM, Mac68K, etc.)
 *
 * Any other combination (one signal missing, signals disagreeing,
 * Windows, Linux, iOS Safari, ChromeOS, Android, SSR) returns "Ctrl".
 * The conservative default exists because the dashboard ships
 * meta+enter / ctrl+enter bindings that must not lie about which key
 * to press; if we cannot prove the host is macOS, instruct the user
 * to use Ctrl (which Chromium maps to meta on actual macOS anyway,
 * but is the correct hint everywhere else).
 *
 * Pure helpers (pickModKey, pickModKeyStrict) take the platform
 * strings as arguments so tests can pin every branch without touching
 * navigator. resolveModKey is the browser-side entry point and is
 * SSR-safe (returns "Ctrl" when navigator is absent).
 */

export type ModKey = "\u2318" | "Ctrl"; // U+2318 is ⌘ (place-of-interest sign)

/** Strict two-signal classifier. Returns ⌘ only when both UA-CH
 * and the legacy navigator.platform string confirm macOS. */
export function pickModKeyStrict(
  uaPlatform: string | null | undefined,
  legacyPlatform: string | null | undefined,
): ModKey {
  if (typeof uaPlatform !== "string") return "Ctrl";
  if (typeof legacyPlatform !== "string") return "Ctrl";
  if (uaPlatform !== "macOS") return "Ctrl";
  if (!legacyPlatform.startsWith("Mac")) return "Ctrl";
  return "\u2318";
}

/** Single-signal classifier retained for callers that only have one
 * platform string in hand (e.g. legacy code paths, narrow tests).
 * Prefer pickModKeyStrict for new code. */
export function pickModKey(platform: string | null | undefined): ModKey {
  if (typeof platform !== "string") return "Ctrl";
  return /^mac/i.test(platform) ? "\u2318" : "Ctrl";
}

/** Browser-side resolver. DevNeural ships as a Windows-only build, so
 * every host renders "Ctrl" regardless of what the navigator reports.
 * The pickModKey / pickModKeyStrict pure helpers stay exported (and
 * tested) for the day the dashboard ships cross-platform builds; if
 * that day arrives, swap this body back to pickModKeyStrict on the
 * UA-CH + legacy navigator strings. Until then, hard-coding Ctrl is
 * what the rendered UI must show. */
export function resolveModKey(): ModKey {
  return "Ctrl";
}
