/* Renderer, not re-thinker (pillar 3.4, sliver V5).
 *
 * When haiku speaks Lex's output it styles + trims connective prose only.
 * Critical content - numbers, decisions, negations, blockers - is marked
 * and passed through VERBATIM, never reworded. The guard here makes that
 * structural: whatever the renderer produces is checked against the
 * preserve-list, and any render that dropped or changed a preserved span
 * is rejected in favor of a deterministic safe render that cannot lose
 * content.
 *
 * Phrasing ownership (decided): Lex produces substance, haiku owns spoken
 * style + brevity, but only within these verbatim guardrails. Lex MAY
 * mark preserve spans explicitly (opts.preserve); on top of that the
 * renderer auto-protects numbers, SHAs/hex ids, and negation words as a
 * safety net so a flipped meaning ("not" dropped) can never ship.
 *
 * Pure module. The haiku LLM render is injected (opts.haikuRender) and is
 * wired in the flag-flip capstone; with no injection the renderer returns
 * the safe deterministic render.
 */

export type PreserveKind = 'number' | 'sha' | 'negation' | 'marked';

export interface PreserveSpan {
  text: string;
  kind: PreserveKind;
}

const NUMBER_RE = /\d+(?:[.,]\d+)*%?/g;
const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
const NEGATION_RE =
  /\b(not|no|never|none|neither|nor|cannot|can'?t|won'?t|do(?:es)?n'?t|did'?n'?t|is'?n'?t|are'?n'?t|was'?n'?t|without)\b/gi;

/* Strip markdown to spoken text. Mirrors the speak controller's
 * cleanForTts: removes fences/emphasis/headers/links, collapses
 * whitespace. Crucially it removes only MARKUP, never words or numbers,
 * so every preserve span survives it - that is why it is the safe
 * fallback. */
export function safeRender(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractPreserveSpans(text: string): PreserveSpan[] {
  const spans: PreserveSpan[] = [];
  const seen = new Set<string>();
  const push = (raw: string, kind: PreserveKind): void => {
    const key = `${kind}:${raw.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    spans.push({ text: raw, kind });
  };
  /* SHAs first so a hex id is not split into a bare number. */
  for (const m of text.matchAll(SHA_RE)) {
    if (/[a-f]/i.test(m[0])) push(m[0], 'sha');
  }
  for (const m of text.matchAll(NUMBER_RE)) push(m[0], 'number');
  for (const m of text.matchAll(NEGATION_RE)) push(m[0], 'negation');
  return spans;
}

export interface VerifyResult {
  ok: boolean;
  missing: string[];
}

/* A preserved span survives if it appears in the rendered text: exact
 * substring for numbers / SHAs / Lex-marked spans (a number reworded to
 * words must fail so the fallback fires); case-insensitive word match for
 * negations (casing/styling may change, the word may not vanish). */
export function verifyVerbatim(
  spans: PreserveSpan[],
  rendered: string,
): VerifyResult {
  const missing: string[] = [];
  for (const s of spans) {
    if (s.kind === 'negation') {
      const re = new RegExp(
        `\\b${s.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i',
      );
      if (!re.test(rendered)) missing.push(s.text);
    } else if (!rendered.includes(s.text)) {
      missing.push(s.text);
    }
  }
  return { ok: missing.length === 0, missing };
}

export interface RenderResult {
  spoken: string;
  /** True when all preserve spans survived in the spoken output. */
  preserved: boolean;
  /** True when a haiku render was rejected and the safe render shipped. */
  usedFallback: boolean;
}

export interface RenderOptions {
  /** Spans Lex explicitly marked critical (verbatim, on top of the
   * auto-extracted numbers/SHAs/negations). */
  preserve?: string[];
  /** Injected haiku style+brevity render. Capstone wires the real model;
   * omitted = deterministic safe render. */
  haikuRender?: (text: string, preserve: string[]) => string;
}

export function renderSpoken(
  text: string,
  opts?: RenderOptions,
): RenderResult {
  const spans: PreserveSpan[] = [
    ...(opts?.preserve ?? []).map(
      (t): PreserveSpan => ({ text: t, kind: 'marked' }),
    ),
    ...extractPreserveSpans(text),
  ];
  const fallback = safeRender(text);
  if (!opts?.haikuRender) {
    return {
      spoken: fallback,
      preserved: verifyVerbatim(spans, fallback).ok,
      usedFallback: false,
    };
  }
  let candidate: string;
  try {
    candidate = opts.haikuRender(
      text,
      spans.map((s) => s.text),
    );
  } catch {
    return { spoken: fallback, preserved: true, usedFallback: true };
  }
  if (candidate && candidate.trim() && verifyVerbatim(spans, candidate).ok) {
    return { spoken: candidate.trim(), preserved: true, usedFallback: false };
  }
  /* Haiku dropped or reworded a preserved span -> reject the paraphrase,
   * ship the safe render. Renderer, not re-thinker. */
  return { spoken: fallback, preserved: true, usedFallback: true };
}

export interface AsyncRenderOptions {
  /** Spans Lex explicitly marked critical, on top of auto-extracted
   * numbers/SHAs/negations. */
  preserve?: string[];
  /** Async live-haiku style+brevity render. The same verbatim guard as
   * renderSpoken applies: a candidate that drops or rewords a preserve
   * span is rejected for the safe render. */
  haikuRender: (text: string, preserve: string[]) => Promise<string>;
}

/* Async twin of renderSpoken for the LIVE haiku render of Lex's reply
 * body (DRIVE-QUEUE 1b). Same verbatim contract: warm phrasing is kept
 * only if every preserve span survived, else the safe markdown-strip
 * render ships. A throwing/empty render also falls back. Pure: the model
 * call is the injected haikuRender. */
export async function renderSpokenAsync(
  text: string,
  opts: AsyncRenderOptions,
): Promise<RenderResult> {
  const spans: PreserveSpan[] = [
    ...(opts.preserve ?? []).map(
      (t): PreserveSpan => ({ text: t, kind: 'marked' }),
    ),
    ...extractPreserveSpans(text),
  ];
  const fallback = safeRender(text);
  let candidate: string;
  try {
    candidate = await opts.haikuRender(
      text,
      spans.map((s) => s.text),
    );
  } catch {
    return { spoken: fallback, preserved: true, usedFallback: true };
  }
  if (candidate && candidate.trim() && verifyVerbatim(spans, candidate).ok) {
    return { spoken: candidate.trim(), preserved: true, usedFallback: false };
  }
  return { spoken: fallback, preserved: true, usedFallback: true };
}
