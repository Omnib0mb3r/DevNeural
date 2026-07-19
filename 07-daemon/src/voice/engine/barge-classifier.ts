/**
 * Front-line barge classifier (VOICE-BARGE-CLASSIFIER-SPEC §3).
 *
 * Pure, deterministic bucketing of an utterance that arrives during
 * TTS. The voice layer is the front line: it resolves the fast,
 * deterministic buckets here (emergency stop, echo, backchannel,
 * noise) and only 'escalate' hands off to the top-layer LLM, which
 * then decides an AI-interpreted command (§3.1b) vs a real turn
 * (§3.5). No resume exists anywhere in the pipeline (operator decision
 * 2026-07-19): echo/noise/backchannel mean the gate should never have
 * stopped playback; emergency-stop/escalate mean a real stop that
 * STAYS stopped.
 *
 * Precedence (§3): command > echo > noise > backchannel > real turn.
 * Implementation note: backchannel is checked BEFORE the sub-2-word
 * noise rule so a single agreement word ("yeah") labels as backchannel
 * rather than noise. Behaviour is identical (both keep playing, nothing
 * to the brain), the label is just more honest.
 */

export type BargeBucket =
  | 'emergency-stop' // §3.1a deterministic hard interrupt
  | 'echo' // §3.2
  | 'backchannel' // §3.4
  | 'noise' // §3.3 blank / sub-floor
  | 'escalate'; // top-layer LLM decides command(§3.1b) vs real-turn(§3.5)

export interface BargeSignals {
  /** classifyEcho verdict: the transcript fuzzy-matches a line Lex
   * recently spoke (Lex's own audio bleeding back). */
  isEcho: boolean;
  /** [BLANK_AUDIO] / sub-floor: no real speech content. */
  isBlank: boolean;
  /** isBackchannelUtterance: a bare agreement ("yeah", "got it"). */
  isBackchannel: boolean;
  /** Count of real transcript words. */
  wordCount: number;
  /** classifyStopUtterance verdict: a recognized deterministic stop
   * command. Non-null means the emergency-stop bucket. */
  stopVerdict: 'stop_speaking' | 'interrupt_work' | null;
}

export function classifyBarge(sig: BargeSignals): BargeBucket {
  if (sig.stopVerdict !== null) return 'emergency-stop';
  if (sig.isEcho) return 'echo';
  if (sig.isBackchannel) return 'backchannel';
  if (sig.isBlank || sig.wordCount < 2) return 'noise';
  return 'escalate';
}

/* Backchannel allowlist (§3.4). Bare agreement words / phrases that
 * must NOT cut Lex off when the operator murmurs them while listening.
 * Kept deliberately small and closed; anything not fully covered by it
 * falls through to escalate/real-turn. */
const BACKCHANNEL_WORDS = new Set([
  'yeah',
  'yea',
  'yep',
  'yup',
  'yes',
  'ok',
  'okay',
  'k',
  'right',
  'mhm',
  'mmhm',
  'mm',
  'mmm',
  'uhhuh',
  'sure',
  'gotcha',
  'cool',
  'totally',
  'exactly',
]);

const BACKCHANNEL_PHRASES = new Set([
  'uh huh',
  'got it',
  'i see',
  'makes sense',
  'of course',
  'for sure',
  'right on',
  'sounds good',
]);

/** True when the whole utterance is nothing but agreement/backchannel.
 * Case- and punctuation-insensitive. A single non-backchannel token
 * makes it false so a real instruction is never swallowed. */
export function isBackchannelUtterance(text: string): boolean {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return false;
  if (BACKCHANNEL_PHRASES.has(norm)) return true;
  return norm.split(' ').every((t) => BACKCHANNEL_WORDS.has(t));
}
