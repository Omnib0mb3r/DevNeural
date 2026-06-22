/* Smart-clear: automated context-full wind-down (DRIVE-QUEUE 4).
 *
 * The auto version of the manual context-full wind-down, spec section 2b.
 * Upgrades smart-compact's reseed to the investigator engine and adds the
 * trigger + the choreography primitives.
 *
 * Division of labor (spec): the INVESTIGATOR assembles the report + the
 * two artifacts (a safe stopping point, the restart/reseed prompt) and
 * logs/closes; LEX decides + fires (tell the worker to stop, wait for the
 * /clear, inject the VETTED reseed, trail the new jsonl to confirm). This
 * module is the daemon's transport + assembly + gate half: pure, testable
 * functions Lex's loop calls. The daemon never blind-injects investigator
 * output - the vet gate sits between assembly and inject.
 *
 * Behind a runtime flag (smart_clear_mode, default off) so live behavior
 * is unchanged until the operator opts in.
 */
import type { IndexDb } from '../store/index-db.js';

/* ── config (settings-adjustable threshold + ceiling + mode) ──────── */

export const SMART_CLEAR_MODE_KEY = 'smart_clear_mode';
export const SMART_CLEAR_THRESHOLD_KEY = 'smart_clear_threshold_pct';
export const SMART_CLEAR_CEILING_KEY = 'smart_clear_ceiling_pct';

/* off: inert. shadow: compute + log, never inject. live: Lex drives the
 * real stop/clear/reseed. Default off so wiring it in changes nothing. */
export type SmartClearMode = 'off' | 'shadow' | 'live';

/* Fire deliberately EARLY (40%) to leave runway to a graceful landing by
 * the ceiling (60%). Past the ceiling Lex forces the commit-first stop. */
export const DEFAULT_THRESHOLD_PCT = 40;
export const DEFAULT_CEILING_PCT = 60;

export function parseSmartClearMode(
  raw: string | null | undefined,
): SmartClearMode | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === '' ) return null;
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'shadow') return 'shadow';
  if (v === 'live' || v === 'on' || v === 'true' || v === '1') return 'live';
  return null;
}

function clampPct(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  if (v < 1) return 1;
  if (v > 99) return 99;
  return Math.round(v);
}

export interface SmartClearConfig {
  mode: SmartClearMode;
  thresholdPct: number;
  ceilingPct: number;
}

export function smartClearConfig(db: IndexDb): SmartClearConfig {
  const mode =
    parseSmartClearMode(db.getRuntimeConfig(SMART_CLEAR_MODE_KEY)) ?? 'off';
  /* getRuntimeConfig returns null when unset; Number(null) is 0 (finite),
   * so guard on the raw value to fall back to the default rather than
   * clamp 0 up to 1. */
  const rawThreshold = db.getRuntimeConfig(SMART_CLEAR_THRESHOLD_KEY);
  const threshold = rawThreshold
    ? clampPct(Number(rawThreshold), DEFAULT_THRESHOLD_PCT)
    : DEFAULT_THRESHOLD_PCT;
  /* The ceiling must sit above the threshold; if a bad config inverts
   * them, push the ceiling to at least threshold + 5. */
  const rawCeiling = db.getRuntimeConfig(SMART_CLEAR_CEILING_KEY);
  let ceiling = rawCeiling
    ? clampPct(Number(rawCeiling), DEFAULT_CEILING_PCT)
    : DEFAULT_CEILING_PCT;
  if (ceiling <= threshold) ceiling = Math.min(99, threshold + 5);
  return { mode, thresholdPct: threshold, ceilingPct: ceiling };
}

/* ── trigger ──────────────────────────────────────────────────────── */

export type SmartClearStage = 'idle' | 'wind-down' | 'force-stop';

export interface SmartClearTriggerInput {
  /** Worker context usage 0-100, or null when unknown (no jsonl yet). */
  ctxPct: number | null;
  thresholdPct: number;
  ceilingPct: number;
}

export interface SmartClearTriggerResult {
  stage: SmartClearStage;
  /** At/over the early threshold: begin the graceful wind-down. */
  windDown: boolean;
  /** At/over the ceiling: the worker did not land in time; Lex forces
   * the commit-first stop now. */
  forceStop: boolean;
  reason: string;
}

/* Pure verdict. The cheap watcher / state endpoint feeds ctxPct; Lex
 * reads the verdict and decides. Debounce (fire once per session) is the
 * caller's concern - this stays a stateless function of the inputs. */
export function evaluateSmartClearTrigger(
  input: SmartClearTriggerInput,
): SmartClearTriggerResult {
  const { ctxPct, thresholdPct, ceilingPct } = input;
  if (ctxPct === null || !Number.isFinite(ctxPct)) {
    return { stage: 'idle', windDown: false, forceStop: false, reason: 'ctx unknown' };
  }
  if (ctxPct >= ceilingPct) {
    return {
      stage: 'force-stop',
      windDown: true,
      forceStop: true,
      reason: `ctx ${ctxPct}% >= ceiling ${ceilingPct}% (force commit-first stop)`,
    };
  }
  if (ctxPct >= thresholdPct) {
    return {
      stage: 'wind-down',
      windDown: true,
      forceStop: false,
      reason: `ctx ${ctxPct}% >= threshold ${thresholdPct}% (wind down to a safe stop)`,
    };
  }
  return {
    stage: 'idle',
    windDown: false,
    forceStop: false,
    reason: `ctx ${ctxPct}% < threshold ${thresholdPct}%`,
  };
}
