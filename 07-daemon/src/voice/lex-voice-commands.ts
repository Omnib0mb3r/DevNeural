/**
 * Lex voice-command dispatch matcher.
 *
 * Every voice command must start with the literal word "lex" so the
 * matcher cannot false-fire on meeting chatter (the lex-voice WS
 * normalises whisper output to lower-cased, punctuation-stripped,
 * whitespace-collapsed text before reaching this matcher; the
 * normalize step is reproduced here so the standalone function can
 * be unit-tested on raw user input).
 *
 * Patterns are evaluated in a fixed priority order:
 *   1. panic        ("lex emergency stop")
 *   2. end_session  ("lex end session")
 *   3. mute         ("lex mute" | "lex shut up" | "lex be quiet" |
 *                    "lex stop talking")
 *   4. unmute       ("lex unmute" | "lex resume" | "lex come back" |
 *                    "lex you can talk" | "lex start talking again")
 *   5. standby      ("lex stand by" | "lex pause listening" |
 *                    "lex hold on")  - pauses STT capture; TTS state
 *                                       and wake-word recognizer stay
 *                                       active so the operator can
 *                                       still rearm with `listen`.
 *   6. listen       ("lex listen" | "lex resume listening" |
 *                    "lex i'm back")  - rearms STT capture after a
 *                                        standby. Wake recognizer is
 *                                        already on; TTS untouched.
 *   7. disable      ("lex disable")  - ONE-WAY. Tears down mic + WS.
 *                                       No voice command can rearm
 *                                       (the recognizers are gone);
 *                                       user clicks `start voice` to
 *                                       recover.
 *
 * Semantic axes are independent:
 *   mute/unmute      govern TTS playback only.
 *   standby/listen   govern STT capture only.
 *   disable          tears down everything (one-way).
 *
 * Mute precedes disable so "lex stop talking" lands on mute rather
 * than tripping a substring of "lex stop". Standby is matched before
 * disable so "lex pause listening" lands on standby cleanly.
 */

export type VoiceCommandKind =
  | 'disable'
  | 'mute'
  | 'unmute'
  | 'panic'
  | 'end_session'
  | 'standby'
  | 'listen'
  | 'hold_up'
  | 'start_project';

/* LEX-AUTONOMY codex 10c (Fix 47 step 3): start_project carries the
 * captured project name. The lex-voice-ws handler resolves it to a
 * project registry id via fuzzy match before POSTing to
 * /projects/:id/start-claude. */
export type VoiceCommand =
  | { kind: Exclude<VoiceCommandKind, 'start_project'> }
  | { kind: 'start_project'; project_name: string };

export const ALL_VOICE_COMMAND_KINDS: ReadonlyArray<VoiceCommandKind> = [
  'disable',
  'mute',
  'unmute',
  'panic',
  'end_session',
  'standby',
  'listen',
  'hold_up',
  'start_project',
];

const LEX_PREFIX = String.raw`\blex\s+`;

const PANIC_RE = new RegExp(LEX_PREFIX + String.raw`emergency\s+stop\b`);
const END_SESSION_RE = new RegExp(LEX_PREFIX + String.raw`end\s+session\b`);
const MUTE_RE = new RegExp(
  LEX_PREFIX + String.raw`(?:mute|shut\s+up|be\s+quiet|stop\s+talking)\b`,
);
/* Unmute synonyms. The literal "unmute" is preserved for
 * back-compat. New natural-language inverses were added in Fix 10
 * after the user reported "Lex resume" failing to re-enable TTS:
 * the matcher only knew the literal token. */
const UNMUTE_RE = new RegExp(
  LEX_PREFIX +
    String.raw`(?:unmute|resume(?!\s+listening)|come\s+back|you\s+can\s+talk|start\s+talking\s+again)\b`,
);
/* Standby = soft mic pause. Wake recognizer stays armed so the user
 * can rearm with `listen`. */
const STANDBY_RE = new RegExp(
  LEX_PREFIX + String.raw`(?:stand\s+by|pause\s+listening|hold\s+on)\b`,
);
/* Listen = rearm STT capture after standby. "resume listening" is
 * explicitly scoped here so the bare "lex resume" stays an unmute
 * synonym (TTS path) and the qualified "lex resume listening" stays
 * a listen (STT path). */
const LISTEN_RE = new RegExp(
  LEX_PREFIX + String.raw`(?:listen|resume\s+listening|i\s+m\s+back)\b`,
);
const DISABLE_RE = new RegExp(LEX_PREFIX + String.raw`disable\b`);
/* Hold-up = hard abort of Lex's current activity (TTS + pending tool
 * calls) without touching the worker. Distinct from mute ("shut up")
 * which only stops TTS. Distinct from standby ("hold on") which only
 * pauses the mic. Matches "lex hold up" and "lex holdup". */
const HOLD_UP_RE = new RegExp(LEX_PREFIX + String.raw`(?:hold\s*up|holdup)\b`);
/* "lex start project <name>" — the trailing capture group eats the
 * rest of the utterance so multi-word project names ("dev neural")
 * round-trip through the matcher intact. The handler trims +
 * collapses whitespace before fuzzy-matching against the project
 * registry. */
const START_PROJECT_RE = new RegExp(
  LEX_PREFIX + String.raw`start\s+project\s+(.+)$`,
);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchVoiceCommand(text: string): VoiceCommand | null {
  if (!text) return null;
  const norm = normalize(text);
  if (!norm) return null;
  if (PANIC_RE.test(norm)) return { kind: 'panic' };
  if (END_SESSION_RE.test(norm)) return { kind: 'end_session' };
  /* hold_up before mute so "lex hold up" cannot be misread as part of
   * the mute family, and before standby so "lex hold up" never gets
   * absorbed by the "hold on" standby pattern when whisper drops a
   * phoneme. The 'hold\s*up' shape never overlaps 'hold\s+on'. */
  if (HOLD_UP_RE.test(norm)) return { kind: 'hold_up' };
  if (MUTE_RE.test(norm)) return { kind: 'mute' };
  /* Order: STANDBY + LISTEN before UNMUTE so the qualified
   * "resume listening" lands on listen, not on the unmute synonym
   * "resume". The UNMUTE pattern uses a negative lookahead to
   * exclude "resume listening" too, but evaluating LISTEN first
   * keeps the matcher easy to reason about. */
  if (STANDBY_RE.test(norm)) return { kind: 'standby' };
  if (LISTEN_RE.test(norm)) return { kind: 'listen' };
  if (UNMUTE_RE.test(norm)) return { kind: 'unmute' };
  if (DISABLE_RE.test(norm)) return { kind: 'disable' };
  /* start_project matched LAST so the matcher's prefix-keyed
   * commands always win on overlap. "lex start project" never
   * collides with the static commands above; the broad capture
   * group here is the reason it sits at the end. */
  const sp = START_PROJECT_RE.exec(norm);
  if (sp && sp[1]) {
    const project = sp[1].trim().replace(/\s+/g, ' ');
    if (project) return { kind: 'start_project', project_name: project };
  }
  return null;
}
