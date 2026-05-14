/**
 * Resolve the platform-appropriate keyboard chord glyph.
 *
 * Renders ⌘ on macOS, Ctrl everywhere else (Windows, Linux, ChromeOS,
 * unknown). Pure module so the lookup is unit-testable; the TopBar
 * search-button chip reads it via useEffect to avoid SSR/CSR
 * hydration mismatches.
 *
 * Prefers `navigator.userAgentData.platform` (User-Agent Client Hints)
 * because the legacy `navigator.platform` is being frozen in
 * Chromium-derived browsers and Safari already lies about it on some
 * iPad configurations. Falls back to the legacy field when UA-CH is
 * unavailable (Firefox, older Safari).
 */

export type ModKey = "\u2318" | "Ctrl"; // U+2318 is ⌘ (place-of-interest sign)

const MAC_RE = /^mac/i;

/** Pure helper: classify a platform string. Tests pin every branch
 * without touching navigator. */
export function pickModKey(platform: string | null | undefined): ModKey {
  if (typeof platform !== "string") return "Ctrl";
  return MAC_RE.test(platform) ? "\u2318" : "Ctrl";
}

/** Browser-side resolver. Returns "Ctrl" when called from a non-DOM
 * environment (SSR, jsdom without navigator) so the caller can use it
 * as the initial useState value without producing a hydration
 * mismatch on the server render. The useEffect that follows refreshes
 * the value once the real navigator is available. */
export function resolveModKey(): ModKey {
  if (typeof navigator === "undefined") return "Ctrl";
  const uaData = (
    navigator as unknown as {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  return pickModKey(platform);
}
