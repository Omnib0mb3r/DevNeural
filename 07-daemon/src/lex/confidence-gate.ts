/* Calibrated confidence (DRIVE-QUEUE 5c, EXPLORATORY first slice).
 *
 * Makes NEVER-SPECULATE structural: a confidence tag on a claim Lex is
 * about to make, and a GATE that auto-routes a low-confidence claim to a
 * verify step (run the deterministic fact-validator: a cited SHA exists,
 * a cited count matches) BEFORE asserting, instead of speaking on a guess.
 *
 * First slice: the tag + the below-threshold -> verify hook wired to the
 * fact-validator primitives. Pure over injected validator seams (git /
 * count probes) so it is unit-testable; the live speak path can consult
 * the gate later. Additive; no live behavior change without a caller.
 */

/* Hedging lowers confidence; verified-state citations raise it. */
const HEDGE_RE = /\b(maybe|probably|i think|i believe|likely|might|should be|seems|guess|not sure|possibly|afaik|iirc)\b/i;
const SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const COUNT_RE = /\b(\d+)\s+(tests?|files?|rows?|chunks?|commits?|lines?)\b/i;
const FILELINE_RE = /\b[\w./-]+\.[a-z]{1,4}:\d+\b/i;

export interface ConfidenceTag {
  /** 0 (pure guess) .. 1 (cited / verified). */
  confidence: number;
  signals: string[];
}

/* Heuristic confidence tag for a claim. Citations (a SHA, a concrete
 * count, a file:line) raise it; hedging language drops it. */
export function tagConfidence(claim: string): ConfidenceTag {
  const text = (claim ?? '').trim();
  const signals: string[] = [];
  let score = 0.6; // neutral default
  if (HEDGE_RE.test(text)) {
    score -= 0.35;
    signals.push('hedging');
  }
  if (SHA_RE.test(text)) {
    score += 0.2;
    signals.push('cites-sha');
  }
  if (COUNT_RE.test(text)) {
    score += 0.15;
    signals.push('cites-count');
  }
  if (FILELINE_RE.test(text)) {
    score += 0.15;
    signals.push('cites-file-line');
  }
  if (!text) {
    score = 0;
    signals.push('empty');
  }
  return { confidence: Math.max(0, Math.min(1, score)), signals };
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export function shouldVerify(
  confidence: number,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): boolean {
  return confidence < threshold;
}

/* Deterministic fact-validator seams (the investigator integrity layer).
 * Injected so the gate is testable without git / a live db. */
export interface FactValidators {
  /** True when the SHA exists in the repo (e.g. git cat-file -e). */
  shaExists?: (sha: string) => boolean;
  /** Actual count for a subject ("tests" -> 1388), or null if unknown. */
  countOf?: (subject: string) => number | null;
}

export interface ClaimCheck {
  /** What was checked. */
  kind: 'sha' | 'count';
  value: string;
  ok: boolean;
  detail: string;
}

export interface GateResult {
  confidence: number;
  signals: string[];
  /** Below threshold: the gate routed to verify instead of asserting. */
  needsVerify: boolean;
  action: 'assert' | 'verify';
  /** Validator results when needsVerify ran. Empty when asserting or when
   * the claim carried nothing checkable. */
  checks: ClaimCheck[];
  /** True when verify ran AND every check passed (safe to assert now);
   * false when a check failed; null when nothing was checkable. */
  verified: boolean | null;
}

/* The gate: tag the claim; if confidence is below the bar, run the
 * fact-validator against any citations it carries (SHA exists, count
 * matches) so Lex verifies before asserting. Returns the verdict; the
 * caller decides whether to speak or go check. Never speaks itself. */
export function gateClaim(
  claim: string,
  opts: { threshold?: number; validators?: FactValidators } = {},
): GateResult {
  const tag = tagConfidence(claim);
  const threshold = opts.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const needsVerify = shouldVerify(tag.confidence, threshold);
  if (!needsVerify) {
    return {
      confidence: tag.confidence,
      signals: tag.signals,
      needsVerify: false,
      action: 'assert',
      checks: [],
      verified: null,
    };
  }

  const checks: ClaimCheck[] = [];
  const v = opts.validators ?? {};

  const shaMatch = SHA_RE.exec(claim);
  if (shaMatch && v.shaExists) {
    const sha = shaMatch[0];
    const ok = v.shaExists(sha);
    checks.push({
      kind: 'sha',
      value: sha,
      ok,
      detail: ok ? 'sha exists' : 'sha NOT found in repo',
    });
  }

  const countMatch = COUNT_RE.exec(claim);
  if (countMatch && v.countOf) {
    const claimed = Number(countMatch[1]);
    const subject = countMatch[2]!.toLowerCase();
    const actual = v.countOf(subject);
    const ok = actual !== null && actual === claimed;
    checks.push({
      kind: 'count',
      value: `${claimed} ${subject}`,
      ok,
      detail:
        actual === null
          ? 'count unknown'
          : ok
            ? `count matches (${actual})`
            : `count mismatch (claimed ${claimed}, actual ${actual})`,
    });
  }

  const verified =
    checks.length === 0 ? null : checks.every((c) => c.ok);
  return {
    confidence: tag.confidence,
    signals: tag.signals,
    needsVerify: true,
    action: 'verify',
    checks,
    verified,
  };
}
