/* Single mouth (pillar 3.1, sliver V1).
 *
 * Haiku owns ALL spoken output so two TTS streams are structurally
 * impossible - no double-talk under any stack-up, from any source (Lex
 * reply, heartbeat, conversational glue, a second voice connection). This
 * is the process-wide lock that enforces it: at most ONE holder at a
 * time, across every speak source in the daemon.
 *
 * When the haiku voice tier is OFF (DEVNEURAL_VOICE_HAIKU != 1) the mouth
 * is NOT enforced: acquire always grants a no-op release and touches no
 * shared state, so the existing per-connection speak path is byte-
 * identical to today. The single-mouth guarantee turns on only with the
 * flag.
 *
 * Token-scoped release: each acquire mints a private token and release
 * frees the mouth only if that token is still the holder, so a late
 * release from a finished stream can never free a mouth a newer stream
 * has since taken.
 */
import { useVoiceHaiku } from './voice-haiku.js';

export interface MouthGrant {
  /** Human label of the holder, for logs. */
  ownerId: string;
  /** Release the mouth. Idempotent; only frees if still the holder. */
  release(): void;
}

let holderToken: object | null = null;
let holderLabel: string | null = null;

/* Acquire the single mouth.
 *  - Haiku ON, mouth free  -> grants (records the holder).
 *  - Haiku ON, mouth held  -> returns null. The caller MUST NOT start a
 *    second TTS stream; that null IS the structural guarantee.
 *  - Haiku OFF             -> always grants a no-op release (current
 *    behavior, no shared state). */
export function acquireMouth(label: string): MouthGrant | null {
  if (!useVoiceHaiku()) {
    return { ownerId: label, release: () => undefined };
  }
  if (holderToken !== null) return null;
  const token = {};
  holderToken = token;
  holderLabel = label;
  return {
    ownerId: label,
    release: () => {
      if (holderToken === token) {
        holderToken = null;
        holderLabel = null;
      }
    },
  };
}

/** True when the mouth is currently held (haiku tier only; always false
 * when the flag is off since acquire records no state then). */
export function isMouthHeld(): boolean {
  return holderToken !== null;
}

/** Label of the current holder, or null. Diagnostics only. */
export function mouthHolder(): string | null {
  return holderLabel;
}

/** Test seam: force-release the mouth between cases. */
export function _resetMouth(): void {
  holderToken = null;
  holderLabel = null;
}
