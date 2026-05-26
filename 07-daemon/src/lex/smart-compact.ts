/**
 * Smart compact (SMART-COMPACT.md).
 *
 * Stage 2 split: `evaluateTrigger` + `WRAP_AND_COMMIT_PROMPT` now live
 * in `smart-compact-policy.ts` and are re-exported here for back-compat
 * through the cutover. The mechanical helpers below (isShadow,
 * shadowThreshold, ctxPctFromJsonl, defaults) stay until Stage 3
 * deletes the legacy surface.
 */
import * as fs from 'node:fs';
import type { IndexDb } from '../store/index-db.js';

export type {
  Phase,
  EvalAction,
  EvalReason,
} from './smart-compact-types.js';
export {
  evaluateTrigger,
  WRAP_AND_COMMIT_PROMPT,
} from './smart-compact-policy.js';
export type {
  EvalInput,
  EvalResult,
} from './smart-compact-policy.js';

const DEFAULT_SHADOW_N = 3;

export function shadowThreshold(): number {
  const raw = process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return DEFAULT_SHADOW_N;
}

export function isShadow(
  db: IndexDb,
  anchorId: string,
  n: number = shadowThreshold(),
): boolean {
  const count = db.countSmartCompactsForAnchor(anchorId);
  return count < n;
}

/* Convenience: derive ctx_pct (0-100) from a Claude Code jsonl tail.
 * Returns null when the file is missing or the tail has no usage
 * record yet (e.g. a freshly-spawned session). */
export interface CtxSnapshot {
  ctxPct: number;
  tokens: number;
  max: number;
}

export function ctxPctFromJsonl(
  file: string,
  deriver: (file: string) => { tokens: number; max: number } | null,
): CtxSnapshot | null {
  if (!file) return null;
  if (!fs.existsSync(file)) return null;
  const ctx = deriver(file);
  if (!ctx || ctx.max <= 0) return null;
  return {
    tokens: ctx.tokens,
    max: ctx.max,
    ctxPct: Math.round((ctx.tokens / ctx.max) * 1000) / 10,
  };
}

export interface Defaults {
  threshold: number;
  bandHalf: number;
  hardCeiling: number;
  stopWindowMs: number;
}

export function defaults(): Defaults {
  const env = process.env;
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    threshold: num('DEVNEURAL_SMART_COMPACT_THRESHOLD_PCT', 60),
    bandHalf: 5,
    hardCeiling: 90,
    stopWindowMs: 30_000,
  };
}
