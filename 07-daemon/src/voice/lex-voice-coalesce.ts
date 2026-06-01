/**
 * Coalesce-utterance-queue helpers (Fix 35 Phase A, 2026-05-26).
 *
 * Pure utilities for the sealed coalesce contract (full spec at
 * docs/spec/COALESCE-UTTERANCE-QUEUE.md). This module owns three
 * concerns deliberately separated from the WS state machine:
 *
 *   1. Format a queued-utterance batch into a single combined
 *      payload Lex sees as one structured turn.
 *   2. Detect "contradiction" patterns (cancel / never mind / forget
 *      it) so the WS state machine can short-circuit the queue and
 *      ack the cancel instead of replaying the original request.
 *
 * The WS file orchestrates state, this file owns the rules. Keeps
 * both testable without standing up a real socket.
 */

export interface DrainBatch {
  /** Single combined payload to inject to Lex as one user turn. */
  text: string;
  /** Number of original utterances that landed in this batch.
   * Surfaced in the WS `t:'injected'` frame for client telemetry. */
  count: number;
}

/* Drain a pending-utterance queue into one structured payload. The
 * head/list shape mirrors the cc-pty mid-turn flush header
 * (lex-voice-ws.ts:447) so the system-prompt rule that recognises
 * the [voice-context] marker stays in one place. */
export function formatQueueDrain(queued: readonly string[]): DrainBatch | null {
  if (queued.length === 0) return null;
  if (queued.length === 1) {
    return { text: queued[0]!, count: 1 };
  }
  const header =
    `[voice-context: queued-utterances (${queued.length})] ` +
    `The user spoke these in sequence while you were replying. ` +
    `Compose ONE reply addressing all of them; if the latest contradicts ` +
    `the earlier ones, treat the latest as the cancellation and ack briefly:`;
  const body = queued.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return { text: `${header}\n\n${body}`, count: queued.length };
}

/* Per the sealed contract (point 5, contradiction case): "user
 * countermands original instruction; latest wins. Stop work, ack the
 * cancel, drop the original, do not double-reply."
 *
 * Detected via a small lexicon of cancel-intent phrases. Broad on
 * purpose; the gate is "we are currently mid-reply" — these phrases
 * only contradict when there is something to contradict. The voice
 * path also has the `lex hold up` wake-command for explicit barge;
 * this catches the same intent when said without the "lex" prefix.
 *
 * Patterns are word-bounded so e.g. "stopwatch" or "cancellation" in
 * a normal sentence does not false-fire. */
const CONTRADICTION_PATTERNS: readonly RegExp[] = [
  /\bcancel(?:\s+(?:it|that|this))?\b/i,
  /\bnever\s*mind\b/i,
  /\bforget\s+(?:it|that|this)\b/i,
  /\b(?:stop|halt|abort)\s+(?:it|that|this|now|please)\b/i,
  /\bdrop\s+(?:it|that|this)\b/i,
  /\bhold\s+(?:up|on)\b/i,
];

export function detectContradiction(text: string): boolean {
  if (!text) return false;
  for (const re of CONTRADICTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

/* ───────────────── Phase B: classifier + push-back ─────────────────
 * Fix 57 (2026-06-01). The sealed COALESCE spec (Phase B) calls for
 * relevance / follow-up / new / noise tags on each queued item so the
 * drain preamble can carry structured metadata rather than a raw
 * numbered list. Tags drive a deterministic composition rule on the
 * Lex side: follow-up extends, new switches topic, noise is dropped,
 * cancel short-circuits the rest of the queue (already handled by
 * detectContradiction above; the classifier surfaces the same intent
 * as the 'cancel' kind so downstream callers see one taxonomy). */
export type UtteranceKind = 'follow-up' | 'new' | 'noise' | 'cancel';

export interface ClassifiedUtterance {
  text: string;
  kind: UtteranceKind;
}

export interface ClassifyContext {
  /** Prior queued items (most-recent last) so the classifier can see
   * what the user has been adding. Empty list = first item in batch. */
  prior?: readonly string[];
  /** The in-flight reply text Lex is currently composing (optional;
   * if absent the classifier still works but cannot detect
   * "follow-up to the in-flight reply" specifically). */
  inFlightReplyText?: string;
}

const FOLLOW_UP_PATTERNS: readonly RegExp[] = [
  /^\s*(?:and|also|plus|oh\s+and|wait|actually|one\s+more\s+thing)\b/i,
  /^\s*(?:add|append|include)\b/i,
];

const NOISE_PATTERNS: readonly RegExp[] = [
  /^\s*(?:um+|uh+|hmm+|err+|like|you\s+know)\s*$/i,
  /^\s*(?:ok(?:ay)?|alright|right|sure|yeah|yep|nope|got\s+it)\s*\.?\s*$/i,
  /^\s*$/,
];

/* Classify a single utterance against the running queue context. Pure
 * heuristic. No LLM call. The cost matters because this fires on
 * every utterance event during a mid-reply window. */
export function classifyUtterance(
  text: string,
  ctx: ClassifyContext = {},
): ClassifiedUtterance {
  const t = (text ?? '').trim();
  if (!t) return { text: t, kind: 'noise' };
  if (detectContradiction(t)) return { text: t, kind: 'cancel' };
  for (const re of NOISE_PATTERNS) {
    if (re.test(t)) return { text: t, kind: 'noise' };
  }
  for (const re of FOLLOW_UP_PATTERNS) {
    if (re.test(t)) return { text: t, kind: 'follow-up' };
  }
  /* Tail-overlap heuristic: when the new utterance reuses a noun
   * phrase the prior queue item or the in-flight reply already
   * mentioned, treat as follow-up. Cheap shared-token check, biased
   * conservative (>=2 shared content tokens of length >=4). */
  const prior = (ctx.prior ?? []).slice(-2).join(' ');
  const inFlight = ctx.inFlightReplyText ?? '';
  const haystack = `${prior}\n${inFlight}`.toLowerCase();
  if (haystack.trim()) {
    const newTokens = t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4);
    let shared = 0;
    for (const w of newTokens) {
      if (haystack.includes(w)) shared++;
      if (shared >= 2) break;
    }
    if (shared >= 2) return { text: t, kind: 'follow-up' };
  }
  return { text: t, kind: 'new' };
}

export interface ConflictRule {
  /** Human label for the rule (e.g. "use Settings reset button"). */
  label: string;
  /** Pattern that must match the rule's keywords. Word-bounded. */
  match: RegExp;
}

export interface ConflictResult {
  hit: boolean;
  rule?: string;
}

/* Conflict push-back: when an incoming utterance contradicts a
 * durable rule, surface the rule so the Lex composition can include a
 * `[voice-context: conflict]` block instead of blindly applying the
 * new instruction. Lookup is in-memory against caller-supplied rules;
 * a future cycle can plumb the memory store into this signature
 * without changing the call site contract. */
export function detectRuleConflict(
  text: string,
  rules: readonly ConflictRule[],
): ConflictResult {
  if (!text || rules.length === 0) return { hit: false };
  for (const r of rules) {
    if (r.match.test(text)) return { hit: true, rule: r.label };
  }
  return { hit: false };
}

export interface DrainV2Options {
  /** Optional list of conflict rules to scan each item against. If
   * any item hits a rule, the drain prepends a structured
   * [voice-context: conflict] header so Lex can push back instead of
   * silently applying the latest. */
  conflictRules?: readonly ConflictRule[];
}

/* Phase B v2 drain: takes classified utterances, emits a drain with
 * kind tags + an optional conflict block. Drops every item the
 * classifier tagged as noise. Cancel short-circuits the queue and
 * yields the same single-line ack formatQueueDrain produced for
 * single-item queues. */
export function formatQueueDrainV2(
  items: readonly ClassifiedUtterance[],
  opts: DrainV2Options = {},
): DrainBatch | null {
  const filtered = items.filter((it) => it.kind !== 'noise');
  if (filtered.length === 0) return null;
  /* Cancel wins regardless of position. The latest cancel is the
   * authoritative one; everything queued before it gets dropped. */
  const lastCancelIdx = filtered.map((it) => it.kind).lastIndexOf('cancel');
  if (lastCancelIdx >= 0) {
    const cancel = filtered[lastCancelIdx]!;
    return { text: cancel.text, count: 1 };
  }
  /* Conflict scan: surface every rule hit so Lex's reply can name the
   * specific rule rather than guess. Multiple hits are OK; dedupe by
   * label so a repeated phrase does not stack. */
  const conflicts: string[] = [];
  if (opts.conflictRules && opts.conflictRules.length > 0) {
    const seen = new Set<string>();
    for (const it of filtered) {
      const r = detectRuleConflict(it.text, opts.conflictRules);
      if (r.hit && r.rule && !seen.has(r.rule)) {
        seen.add(r.rule);
        conflicts.push(r.rule);
      }
    }
  }
  if (filtered.length === 1 && conflicts.length === 0) {
    return { text: filtered[0]!.text, count: 1 };
  }
  const parts: string[] = [];
  if (conflicts.length > 0) {
    parts.push(
      `[voice-context: conflict] The latest utterance contradicts these durable rules: ${conflicts
        .map((r) => `"${r}"`)
        .join(', ')}. Push back before applying.`,
    );
  }
  parts.push(
    `[voice-context: queued-utterances (${filtered.length})] ` +
      `The user spoke these in sequence while you were replying. ` +
      `Compose ONE reply addressing all of them; tags below classify each so ` +
      `you can decide composition (follow-up extends, new switches topic):`,
  );
  parts.push(
    filtered.map((it, i) => `${i + 1}. [${it.kind}] ${it.text}`).join('\n'),
  );
  return { text: parts.join('\n\n'), count: filtered.length };
}
