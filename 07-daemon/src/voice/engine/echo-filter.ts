/**
 * Echo filter: daemon-side backstop against the voice layer hearing
 * itself (VOICE-TOP-LAYER-SPEC.md, "Echo, second line").
 *
 * The first line of defense is playback through an HTMLAudioElement so
 * the browser echo canceller has a reference signal. This module is
 * the backstop behind it: every line piper speaks is remembered here,
 * and every whisper transcript is fuzzy-matched against the recent
 * spoken set before it can become a user turn. Fuzzy, not exact,
 * because whisper mangles ("tests are green" comes back "tests our
 * green"). Deepgram documents this pattern; Alibaba's production
 * system names self-echo as a barge-in rejection category.
 *
 * Safety contract (the filter must never eat a real operator turn):
 *   - single-token transcripts are NEVER suppressed. "stop" must
 *     survive even when the spoken reply contained the word stop.
 *   - multi-token transcripts suppress only on a high token-overlap
 *     score against ONE remembered line, or on contiguous containment
 *     of the whole transcript inside one remembered line.
 *   - entries expire on a TTL and the registry is bounded, so a line
 *     spoken minutes ago cannot suppress anything.
 *
 * Pure module: no timers, no I/O; callers pass the clock.
 */

export interface EchoRegistryEntry {
  text: string;
  atMs: number;
  /** Normalized token list, precomputed at remember() time. */
  tokens: string[];
  /** Normalized joined text for containment checks. */
  normalized: string;
}

export interface EchoRegistry {
  remember(text: string, atMs: number): void;
  entries(): readonly EchoRegistryEntry[];
}

export interface EchoRegistryOptions {
  /** Max remembered spoken lines. Default 8. */
  cap?: number;
  /** How long a spoken line can suppress transcripts. Default 45s:
   * covers the longest plausible playback + drain tail. */
  ttlMs?: number;
}

export interface EchoVerdict {
  echo: boolean;
  /** Best token-overlap score across live entries, 0..1. */
  score: number;
  /** The remembered line that matched, verbatim as spoken. */
  matched: string | null;
}

const DEFAULT_CAP = 8;
const DEFAULT_TTL_MS = 45_000;
/** Token-overlap fraction at or above which a transcript is echo. */
const ECHO_SCORE_THRESHOLD = 0.72;
/** Containment path needs at least this many normalized chars so a
 * trivially short fragment cannot suppress. */
const CONTAINMENT_MIN_CHARS = 8;

export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  const n = normalizeSpeech(text);
  return n ? n.split(' ') : [];
}

/* Whisper-tolerant token equality: exact, or edit distance 1 for
 * tokens of 4+ chars ("are" vs "our" fails this on purpose at 3
 * chars; "restarted" vs "restated" passes). */
function tokensAlike(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  /* Edit distance <= 1 check without a full DP table. */
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return true;
  }
  const long = a.length > b.length ? a : b;
  const short = a.length > b.length ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < long.length && j < short.length) {
    if (long[i] === short[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    i++;
  }
  return true;
}

function overlapScore(
  transcriptTokens: string[],
  entryTokens: string[],
): number {
  if (transcriptTokens.length === 0) return 0;
  const pool = entryTokens.slice();
  let hits = 0;
  for (const t of transcriptTokens) {
    const idx = pool.findIndex((p) => tokensAlike(t, p));
    if (idx >= 0) {
      hits++;
      pool.splice(idx, 1);
    }
  }
  return hits / transcriptTokens.length;
}

export function createEchoRegistry(
  opts: EchoRegistryOptions = {},
): EchoRegistry {
  const cap = opts.cap ?? DEFAULT_CAP;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const entries: EchoRegistryEntry[] = [];
  return {
    remember(text: string, atMs: number): void {
      const normalized = normalizeSpeech(text);
      if (!normalized) return;
      entries.push({ text, atMs, tokens: normalized.split(' '), normalized });
      while (entries.length > cap) entries.shift();
      /* TTL is enforced at read time (classifyEcho) so remember()
       * stays clock-free beyond the caller's stamp. ttlMs is carried
       * via closure below. */
      void ttlMs;
    },
    entries(): readonly EchoRegistryEntry[] {
      return entries;
    },
  };
}

/* The registry options are re-derivable at classify time: the caller
 * that created the registry passes the same ttl through classify's
 * opts when non-default. Keeping the verdict function pure over
 * (transcript, entries, now) makes it unit-testable without the
 * registry at all. */
export function classifyEcho(
  transcript: string,
  registry: EchoRegistry,
  nowMs: number,
  opts: { ttlMs?: number; scoreThreshold?: number } = {},
): EchoVerdict {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const threshold = opts.scoreThreshold ?? ECHO_SCORE_THRESHOLD;
  const tokens = tokenize(transcript);
  const normalized = tokens.join(' ');
  const out: EchoVerdict = { echo: false, score: 0, matched: null };
  /* Single-token transcripts are never suppressed: a bare "stop" or
   * "wait" must always survive the filter no matter what was spoken. */
  if (tokens.length <= 1) return out;
  for (const e of registry.entries()) {
    if (nowMs - e.atMs > ttlMs) continue;
    /* Containment: the whole transcript appears verbatim inside one
     * spoken line (fragment echo). Requires a minimum length so a
     * short common phrase cannot suppress. */
    if (
      normalized.length >= CONTAINMENT_MIN_CHARS &&
      e.normalized.includes(normalized)
    ) {
      return { echo: true, score: 1, matched: e.text };
    }
    const score = overlapScore(tokens, e.tokens);
    if (score > out.score) {
      out.score = score;
      out.matched = e.text;
    }
  }
  if (out.score >= threshold) {
    return { echo: true, score: out.score, matched: out.matched };
  }
  return { echo: false, score: out.score, matched: null };
}
