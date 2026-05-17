/**
 * Real-time Lex attention notifications.
 *
 * Distinct from the scheduled-reminders pipeline: these fire whenever
 * Lex needs the user's eyeballs RIGHT NOW, regardless of where the
 * user is. Phone-first use case: the user steps away while a worker
 * runs in another room, and we pull them back via the existing PWA
 * web-push channel the moment a decision-shaped question lands or
 * the supervision tick escalates a stall.
 *
 * Three trigger sources are supported today:
 *   - fireForLexTurn:  Lex emitted an end-of-turn message whose tail
 *                      reads as a yes/no or pick-one prompt. Detection
 *                      runs detectAttentionInText on the text body.
 *   - fireForStall:    Worker supervision tick classified a session
 *                      as stalled and would prompt the user; the
 *                      supervisor calls in regardless of detection.
 *   - fireForCustom:   TODO future hook for brainstorm-tagged escala-
 *                      tions. The dispatch path is already symmetric;
 *                      surface a tiny wrapper once the brainstorm
 *                      side wires the marker.
 *
 * Quiet hours (default 22:00 - 08:00 local; override via env
 * DEVNEURAL_QUIET_HOURS=HH-HH) suppress the web push while still
 * appending the notification row to the log so the in-app notification
 * surfaces (top-bar bell, activity rail) show the missed attention
 * after the user wakes up.
 */
import { emitNotification, type Notification } from './notifications.js';

export const DEFAULT_QUIET_START_HOUR = 22;
export const DEFAULT_QUIET_END_HOUR = 8;

export interface QuietHours {
  /** Local-clock hour the window opens, inclusive. */
  startHour: number;
  /** Local-clock hour the window closes, exclusive. Equal to startHour
   * means the window covers the full day (always quiet). */
  endHour: number;
}

/* Parse "HH-HH" out of an env var. Returns null on malformed input
 * so the caller falls back to the default window. */
export function parseQuietHours(value: string | undefined): QuietHours | null {
  if (!value) return null;
  const m = /^(\d{1,2})\s*[-:]\s*(\d{1,2})$/.exec(value.trim());
  if (!m) return null;
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (
    !Number.isFinite(startHour) ||
    !Number.isFinite(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23
  ) {
    return null;
  }
  return { startHour, endHour };
}

export function defaultQuietHours(): QuietHours {
  const parsed = parseQuietHours(process.env.DEVNEURAL_QUIET_HOURS);
  return (
    parsed ?? {
      startHour: DEFAULT_QUIET_START_HOUR,
      endHour: DEFAULT_QUIET_END_HOUR,
    }
  );
}

/* Wrap-around aware. A "22-08" window is quiet across midnight; a
 * "08-22" window is quiet during the day (unusual but valid for a
 * night-shift user). startHour === endHour is treated as always
 * quiet so the user can fully silence pushes via env. */
export function isInQuietHours(
  now: Date,
  hours: QuietHours = defaultQuietHours(),
): boolean {
  const h = now.getHours();
  if (hours.startHour === hours.endHour) return true;
  if (hours.startHour < hours.endHour) {
    return h >= hours.startHour && h < hours.endHour;
  }
  return h >= hours.startHour || h < hours.endHour;
}

/* Heuristic. We prefer an explicit { needs_attention: true } flag in
 * the Lex generation step over a regex, but the regex is the working
 * fallback while the LLM-tagged emit path is on the roadmap. Three
 * acceptance signals, evaluated in order:
 *   - explicit yes/no markers anywhere in the tail: "(y/n)", "yes
 *     or no", "yes/no", "[y/n]"
 *   - decision verbs at the head of a tail clause: "should we",
 *     "do you want", "should i", "want me to", "ready to", "shall
 *     we", "which option", "which one"
 *   - the tail clause ends with '?' AND the question line itself is
 *     short (<= 200 chars, <= 24 words). Long explanatory paragraphs
 *     that happen to end with '?' are not decision-shaped.
 *
 * Returns true when any signal fires. Operates on the raw assistant
 * text (no normalization needed beyond lowercasing inside the
 * sub-checks). */
const YES_NO_RE =
  /\(\s*y\s*\/\s*n\s*\)|\[\s*y\s*\/\s*n\s*\]|\byes\s*(?:\/|or)\s*no\b/i;
const DECISION_HEAD_RE =
  /\b(?:should\s+we|should\s+i|shall\s+we|shall\s+i|do\s+you\s+want|want\s+me\s+to|ready\s+to|which\s+(?:option|one|approach)|pick\s+one)\b/i;

export function detectAttentionInText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (YES_NO_RE.test(trimmed)) return true;
  /* Pull the tail clause: last block ending with '?' (or the whole
   * text when no '?' exists). We split on hard newlines first so
   * a long paragraph above a one-line question doesn't pollute
   * the word count. */
  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const tailLine = lines.length > 0 ? lines[lines.length - 1]! : trimmed;
  if (DECISION_HEAD_RE.test(tailLine) && tailLine.endsWith('?')) return true;
  if (tailLine.endsWith('?')) {
    const words = tailLine.split(/\s+/).filter(Boolean);
    if (tailLine.length <= 200 && words.length <= 24) return true;
  }
  return false;
}

export interface AttentionFireDeps {
  /** Test seam. Defaults to emitNotification which routes through
   * the push pipeline. */
  emit?: typeof emitNotification;
  /** Test seam for the quiet-hours window. */
  hours?: QuietHours;
  /** Test seam for current time. */
  now?: () => Date;
  /** Severity. Defaults to 'warn' (audible push when subscribed,
   * skipped at info). The supervision stall path bumps this to
   * 'alert' for a more urgent SW render. */
  severity?: 'warn' | 'alert';
  /** Override push mode. Defaults to 'auto' outside quiet hours and
   * 'suppress' inside. Tests pin behaviour with explicit overrides. */
  pushOverride?: 'auto' | 'force' | 'suppress';
}

export interface AttentionTurnInput {
  /** Brainstorm session id surfacing the question. Used to build
   * the deep link the SW opens on click. */
  brainstorm_id: string | null;
  /** Lex assistant turn uuid. Forwarded into push_data so the SW
   * can scroll the dashboard target tab to the matching turn. */
  turn_id: string | null;
  /** Full assistant text. We snip a short preview for the body
   * line so the system notification reads like a single yes/no
   * prompt rather than a wall of text. */
  text: string;
  /** Pre-computed needs_attention flag from a future LLM-tagged
   * emit path. When provided, skips detectAttentionInText. */
  needs_attention?: boolean;
}

export type AttentionOutcome =
  | 'fired'
  | 'fired-quiet-suppressed'
  | 'not-detected'
  | 'empty';

export interface AttentionFireResult {
  outcome: AttentionOutcome;
  notification: Notification | null;
}

function snippetForBody(text: string, max: number = 140): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
}

function deepLinkFor(brainstormId: string | null, turnId: string | null): string {
  if (brainstormId && turnId) {
    return `/brainstorms/${encodeURIComponent(brainstormId)}#turn-${encodeURIComponent(turnId)}`;
  }
  if (brainstormId) return `/brainstorms/${encodeURIComponent(brainstormId)}`;
  return '/lex';
}

export function fireForLexTurn(
  input: AttentionTurnInput,
  deps: AttentionFireDeps = {},
): AttentionFireResult {
  const text = (input.text ?? '').trim();
  if (!text) return { outcome: 'empty', notification: null };
  const needs = input.needs_attention ?? detectAttentionInText(text);
  if (!needs) return { outcome: 'not-detected', notification: null };
  const now = (deps.now ?? (() => new Date()))();
  const hours = deps.hours ?? defaultQuietHours();
  const quiet = isInQuietHours(now, hours);
  const emit = deps.emit ?? emitNotification;
  const mode = deps.pushOverride ?? (quiet ? 'suppress' : 'auto');
  const snippet = snippetForBody(text);
  const link = deepLinkFor(input.brainstorm_id, input.turn_id);
  const notification = emit({
    severity: deps.severity ?? 'warn',
    source: 'lex-attention',
    title: 'Lex needs you',
    body: snippet,
    link,
    event_type: 'attention',
    notify_class: 'followup',
    push: mode,
    push_data: {
      kind: 'lex-turn',
      brainstorm_id: input.brainstorm_id ?? null,
      turn_id: input.turn_id ?? null,
      snippet,
    },
  });
  return {
    outcome: quiet ? 'fired-quiet-suppressed' : 'fired',
    notification,
  };
}

export interface AttentionStallInput {
  brainstorm_id: string | null;
  anchor_id: string | null;
  /** Short human-readable reason ("idle 12m", "permission prompt
   * open", etc.). Surfaces in the push body. */
  reason: string;
}

export function fireForStall(
  input: AttentionStallInput,
  deps: AttentionFireDeps = {},
): AttentionFireResult {
  const now = (deps.now ?? (() => new Date()))();
  const hours = deps.hours ?? defaultQuietHours();
  const quiet = isInQuietHours(now, hours);
  const emit = deps.emit ?? emitNotification;
  const mode = deps.pushOverride ?? (quiet ? 'suppress' : 'auto');
  const link = input.brainstorm_id
    ? `/brainstorms/${encodeURIComponent(input.brainstorm_id)}`
    : input.anchor_id
      ? `/projects/${encodeURIComponent(input.anchor_id)}`
      : '/lex';
  const notification = emit({
    severity: deps.severity ?? 'alert',
    source: 'lex-attention',
    title: 'Worker stalled',
    body: input.reason.slice(0, 200),
    link,
    event_type: 'attention',
    notify_class: 'signal',
    push: mode,
    push_data: {
      kind: 'stall',
      brainstorm_id: input.brainstorm_id ?? null,
      anchor_id: input.anchor_id ?? null,
      reason: input.reason,
    },
  });
  return {
    outcome: quiet ? 'fired-quiet-suppressed' : 'fired',
    notification,
  };
}

/* TODO (future): fireForCustom. The brainstorm side will emit a
 * tagged marker when it wants to escalate something specific (build
 * failure, test regression, "lex flagged this for the user"). The
 * dispatch shape mirrors fireForLexTurn / fireForStall; wire the
 * marker scanner when the brainstorm pipeline lands the tag. */
