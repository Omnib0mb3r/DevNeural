/* Haiku voice talk-layer scaffold (pillar 3, sliver V1).
 *
 * The voice tier is a separate fast model (Haiku) that owns the mouth
 * and the front desk: single mouth, two lanes, deny-by-default
 * whitelist, control channel, renderer-not-rethinker. This module is the
 * flag + model config every later slice of the pillar builds on. It does
 * NOT make model calls yet (V1 is single-mouth ownership + scaffold); the
 * lane/classifier/renderer slices fill in the client.
 *
 * Default OFF: with DEVNEURAL_VOICE_HAIKU unset the current voice path is
 * untouched. Nothing in this pillar changes runtime behavior until the
 * flag is flipped (a separate Michael step that needs a daemon restart).
 */

/* Voice-tier API key. Read ANTHROPIC_API_KEY first, then fall back to
 * BRIDGER_ANTHROPIC_API. Two reasons for the fallback (2026-07-09):
 *   1. Robustness. BRIDGER_ANTHROPIC_API is a persistent User env var, so
 *      the daemon inherits it no matter how it was launched (Task
 *      Scheduler, /admin restart, or a manual `node dist/daemon.js` that
 *      skips start-daemon.ps1's env block - the last of which is exactly
 *      why the voice key kept coming up absent).
 *   2. Billing safety. Claude Code only treats ANTHROPIC_API_KEY as a
 *      Max->API billing override; it ignores BRIDGER_ANTHROPIC_API. So a
 *      spawned Lex inherits the BRIDGER var harmlessly and stays on Max,
 *      while the daemon still gets a live voice key. (spawnLex also
 *      strips ANTHROPIC_API_KEY as defense-in-depth.) */
export function voiceApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY ?? process.env.BRIDGER_ANTHROPIC_API;
}

/** True when the haiku voice tier owns the mouth + front desk. Strictly
 * gated on DEVNEURAL_VOICE_HAIKU==='1'. The daemon self-enables this at
 * boot when a voice key is present (see enableVoiceHaikuIfKeyPresent),
 * so the flag no longer depends on start-daemon.ps1's env block reaching
 * the process - but the gate itself stays a pure, explicit '1' check so
 * flag-off behavior is deterministic and unit-testable. */
export function useVoiceHaiku(): boolean {
  return process.env.DEVNEURAL_VOICE_HAIKU === '1';
}

/* Daemon boot self-enable (2026-07-09). The smart voice lane needs the
 * flag on AND a key present. The key is now robust (BRIDGER fallback,
 * always inherited), but the flag rode on start-daemon.ps1's env block,
 * which a manual `node dist/daemon.js` restart skips - so the daemon kept
 * booting with voice flat. Called once at boot: when a voice key is
 * present and the operator has not explicitly opted out (=== '0'), turn
 * the flag on IN THIS PROCESS. Mutates only the daemon's own env (never
 * a persistent/user var), so tests and unrelated processes are untouched.
 * Returns the resolved on/off for the boot log. */
export function enableVoiceHaikuIfKeyPresent(): boolean {
  if (process.env.DEVNEURAL_VOICE_HAIKU === '0') return false;
  if (process.env.DEVNEURAL_VOICE_HAIKU === '1') return true;
  if (voiceApiKey()) {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    return true;
  }
  return false;
}

/* Talk-layer model. Default: Anthropic Haiku (latency-optimal; the plan
 * names Haiku for the voice tier - voice lives or dies on latency).
 *
 * BF-4 posture (documented for the lane/classifier slices): the haiku
 * layer never receives raw brainstorm transcripts. By the deny-by-default
 * whitelist it only ever handles (a) pure conversational glue with no
 * project content, or (b) Lex's already-synthesized user-facing reply to
 * RENDER for speech - text already destined for the user's ears. Any
 * project/code/state fact queues to Opus-Lex instead, so brainstorm
 * content is never reasoned about by this model. */
export const VOICE_HAIKU_MODEL =
  process.env.DEVNEURAL_VOICE_HAIKU_MODEL ?? 'claude-haiku-4-5-20251001';

export interface VoiceHaikuConfig {
  enabled: boolean;
  model: string;
}

export function voiceHaikuConfig(): VoiceHaikuConfig {
  return { enabled: useVoiceHaiku(), model: VOICE_HAIKU_MODEL };
}

/* Local-context clock (2026-07-14). Operator complaint: the fast-lane
 * quick replies were context-blind about the time of day - "good
 * morning" could land a canned "on it" or, worse, an incongruent
 * mirrored greeting at 2am. Neither the live glue/bridge model nor the
 * deterministic canned fallback knew what time it actually was. This is
 * the daemon's own local clock, read fresh at call time; it carries no
 * project/user content, so it stays inside the BF-4 boundary (persona +
 * digest + this clock block + the aside, never raw transcript). */
export type Daypart =
  | 'early morning'
  | 'morning'
  | 'afternoon'
  | 'evening'
  | 'late night';

/* Coarse daypart from a 24h local hour. Boundaries:
 *   late night     21:00 - 04:59
 *   early morning  05:00 - 06:59
 *   morning        07:00 - 11:59
 *   afternoon      12:00 - 16:59
 *   evening        17:00 - 20:59
 * A pure function of the hour (not the clock) so the boundaries are
 * unit-testable without mocking Date. */
export function daypartOf(hour: number): Daypart {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5) return 'late night';
  if (h < 7) return 'early morning';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'late night';
}

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
];

export interface LocalContext {
  hour: number;
  minute: number;
  weekday: string;
  dateLabel: string;
  daypart: Daypart;
  timeLabel: string;
}

/* Snapshot of the daemon's own clock. Pure aside from reading `now`, so a
 * fixed Date makes every caller (glue prompt, bridge prompt, tests)
 * deterministic. Never derived from anything the user said. */
export function buildLocalContext(now: Date = new Date()): LocalContext {
  const hour = now.getHours();
  const minute = now.getMinutes();
  return {
    hour,
    minute,
    weekday: WEEKDAYS[now.getDay()]!,
    dateLabel: `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`,
    daypart: daypartOf(hour),
    timeLabel: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/* The exact block appended to the glue/bridge system prompt (BF-4 safe:
 * daemon clock only, no project/user content). Told explicitly to trust
 * the clock over the user's words, so a mismatched greeting ("good
 * morning" at 2am) gets a light correction instead of an echo. */
export function localContextBlock(now: Date = new Date()): string {
  const ctx = buildLocalContext(now);
  const lines = [
    '--- LOCAL CONTEXT (daemon clock, right now) ---',
    `It is ${ctx.timeLabel} on ${ctx.weekday}, ${ctx.dateLabel} - ${ctx.daypart}.`,
    'Speak from this real time, not from what the user says. Greet with',
    'the correct time of day; if a greeting does not match the real time',
    '(for example "good morning" said late at night), gently correct it',
    'in passing instead of mirroring it back.',
  ];
  return lines.join('\n');
}
