/**
 * Smart compact — mechanical helpers.
 *
 * Stage 3 removed the policy surface (evaluateTrigger, defaults,
 * shadowThreshold, isShadow, WRAP_AND_COMMIT_PROMPT) and the legacy
 * re-exports. `lex/smart-compact-policy.ts` is the policy module and
 * Lex owns the decision loop now.
 *
 * Only `ctxPctFromJsonl` survives here, kept for any caller that
 * still wants a thin tail-to-percent helper without rolling its own
 * derivation. The Phase / EvalAction / EvalReason type unions live in
 * `lex/smart-compact-types.ts` and are re-exported here for callers
 * that historically imported them from this module path.
 */
import * as fs from 'node:fs';

export type {
  Phase,
  EvalAction,
  EvalReason,
} from './smart-compact-types.js';

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
