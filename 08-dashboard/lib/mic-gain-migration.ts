/* Legacy mic-gain migration (2026-07-15).
 *
 * Until the VAD stream fix (8e7e03d), the mic-gain slider did not
 * affect what triggered listening at all: VAD ran on its own raw
 * getUserMedia stream and gain only scaled the bytes shipped to
 * whisper. Operators (reasonably) cranked the slider way down while
 * it was a placebo. The fix made the slider real, which silently
 * turned those stale near-zero settings into an actual mute: VAD
 * never crosses its speech threshold, the UI sits on "listening"
 * forever, and nothing ever reaches Lex.
 *
 * Any persisted gain below LEGACY_FLOOR that predates the fix is
 * therefore treated as placebo-era and reset to 1.0 exactly once,
 * marked in localStorage so a deliberate post-fix low setting is
 * respected. The correction is also POSTed to the daemon so its
 * persisted pref (which would otherwise re-push the stale value on
 * the next connect) heals too. */

export const MIC_GAIN_LEGACY_FLOOR = 0.5;
export const MIC_GAIN_MIGRATED_KEY = "lex-mic-gain-migrated-2026-07";

/* Same one-time correction for the pause-tolerance slider. It was
 * fully dead until the ms-based option fix (vad-web silently dropped
 * the legacy frame-count key and used its 1400ms default), so a
 * placebo-era value like 6000ms never mattered. Live, it means VAD
 * demands SIX SECONDS of unbroken silence before ending an utterance;
 * with normal room noise that never accumulates and the UI sits on
 * "listening" forever. Anything above the legacy ceiling that predates
 * the fix resets to the default once. */
export const VAD_REDEMPTION_LEGACY_CEILING_MS = 2500;
export const VAD_REDEMPTION_MIGRATED_KEY = "lex-vad-redemption-migrated-2026-07";

export function migrateLegacyVadRedemption(
  valueMs: number,
  opts: {
    storageKey: string;
    defaultMs: number;
    postCorrection: (correctedMs: number) => void;
  },
): number {
  if (typeof window === "undefined") return valueMs;
  if (!Number.isFinite(valueMs)) return valueMs;
  if (valueMs <= VAD_REDEMPTION_LEGACY_CEILING_MS) return valueMs;
  try {
    if (window.localStorage.getItem(VAD_REDEMPTION_MIGRATED_KEY) === "1") {
      return valueMs;
    }
    window.localStorage.setItem(VAD_REDEMPTION_MIGRATED_KEY, "1");
    window.localStorage.setItem(opts.storageKey, String(opts.defaultMs));
  } catch {
    /* storage unavailable; correction still applies this session */
  }
  opts.postCorrection(opts.defaultMs);
  return opts.defaultMs;
}

function markMigrated(): void {
  try {
    window.localStorage.setItem(MIC_GAIN_MIGRATED_KEY, "1");
  } catch {
    /* storage unavailable; correction still applies this session */
  }
}

function alreadyMigrated(): boolean {
  try {
    return window.localStorage.getItem(MIC_GAIN_MIGRATED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Returns the gain value to actually use. When the stored/incoming
 * value is a placebo-era near-mute and the one-time migration has not
 * run yet, returns 1.0, persists the correction (localStorage +
 * daemon pref) and sets the migration marker. Pass-through in every
 * other case. Safe to call from any apply site; only the first
 * qualifying call performs side effects. */
export function migrateLegacyMicGain(
  value: number,
  opts: {
    storageKey: string;
    postCorrection: (corrected: number) => void;
  },
): number {
  if (typeof window === "undefined") return value;
  if (!Number.isFinite(value)) return value;
  if (value >= MIC_GAIN_LEGACY_FLOOR) return value;
  if (alreadyMigrated()) return value;
  markMigrated();
  try {
    window.localStorage.setItem(opts.storageKey, "1");
  } catch {
    /* ignore */
  }
  opts.postCorrection(1.0);
  return 1.0;
}
