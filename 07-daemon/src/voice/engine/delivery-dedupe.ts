/**
 * Delivery dedupe: one utterance = one delivery (VOICE-TOP-LAYER-SPEC
 * duplicate-delivery kill). Live failure 2026-07-17 03:09Z: a single
 * spoken turn reached Lex three times via three independent re-send
 * paths (partial-landing repaste, CR-retry committing a stuck
 * composer, failure requeue at the next turn boundary). None of those
 * paths consulted a shared record of what had already been delivered.
 *
 * This registry is that record. Every path that is about to put an
 * utterance in front of Lex asks shouldDeliver(fingerprint) first;
 * every confirmed delivery calls markDelivered. A deliberate operator
 * repeat outside the window (or with force) always goes through: the
 * registry suppresses machine re-sends, never the human.
 *
 * Pure module: callers pass the clock.
 */

export interface DeliveryRegistry {
  shouldDeliver(
    fingerprint: string,
    nowMs: number,
    opts?: { force?: boolean },
  ): boolean;
  markDelivered(fingerprint: string, nowMs: number): void;
}

export interface DeliveryRegistryOptions {
  /** Suppression window for a repeated fingerprint. Default 90s:
   * long enough to cover the full repaste/CR/requeue storm around one
   * turn, short enough that a deliberate "run the tests again" a few
   * minutes later is honored. */
  windowMs?: number;
  /** Max fingerprints retained. Default 64. */
  cap?: number;
}

const DEFAULT_WINDOW_MS = 90_000;
const DEFAULT_CAP = 64;

/** Normalize an utterance to a stable fingerprint: case, punctuation,
 * and whitespace differences (whisper and paste mangling) collapse. */
export function fingerprintUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createDeliveryRegistry(
  opts: DeliveryRegistryOptions = {},
): DeliveryRegistry {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const cap = opts.cap ?? DEFAULT_CAP;
  /* Insertion-ordered: Map iteration order gives us the oldest entry
   * for cap eviction. */
  const delivered = new Map<string, number>();
  return {
    shouldDeliver(fingerprint, nowMs, o = {}) {
      if (o.force) return true;
      const at = delivered.get(fingerprint);
      if (at === undefined) return true;
      return nowMs - at > windowMs;
    },
    markDelivered(fingerprint, nowMs) {
      delivered.delete(fingerprint);
      delivered.set(fingerprint, nowMs);
      while (delivered.size > cap) {
        const oldest = delivered.keys().next().value;
        if (oldest === undefined) break;
        delivered.delete(oldest);
      }
    },
  };
}
