/**
 * Interrupt arbiter (VOICE-TOP-LAYER-SPEC.md, conclusions 5 and 6, and
 * the OpenAI Realtime interrupt contract):
 *
 *   - Stop-class utterances interrupt Lex's in-flight turn IMMEDIATELY,
 *     never queue to a turn boundary, and never wait on an LLM round
 *     trip. classifyStopUtterance is the deterministic detector.
 *   - On interrupt, conversational context is truncated to the words
 *     the operator actually HEARD (truncateToHeard): the assistant
 *     must never believe it said words that never played.
 *   - Stop-playback and generate-response are independent actions.
 *     decideInterruptPolicy is the policy step over the new transcript:
 *     rethink the in-flight answer, or finish the thought then answer.
 *
 * Pure module. Callers own every effect (PTY interrupt, TTS kill,
 * context rewrite).
 */

export type StopClass = 'stop_speaking' | 'interrupt_work';

export interface StopVerdict {
  stop: StopClass | null;
  /** Substantive content beyond the stop phrase, verbatim-ish (from
   * the normalized token stream). Empty when the utterance was pure
   * stop. When stop is null, the full original text. */
  remainder: string;
}

/* Filler tokens that ride along with a bare stop without making it
 * content: "wait a second", "hold on a sec please", "okay stop lex". */
const FILLERS = new Set([
  'a',
  'an',
  'the',
  'second',
  'sec',
  'seconds',
  'minute',
  'moment',
  'please',
  'lex',
  'okay',
  'ok',
  'now',
  'just',
]);

/* Silence-the-voice phrases: Lex keeps working, audio stops. */
const SPEAK_STOP_LEADS = [
  ['shut', 'up'],
  ['be', 'quiet'],
  ['quiet'],
  ['shush'],
  ['stop', 'talking'],
  ['stop', 'speaking'],
];

/* Hard work-interrupt phrases (leading). */
const WORK_STOP_LEADS = [
  ['stop', 'what', "you're", 'doing'],
  ['stop', 'what', 'you', 'are', 'doing'],
  ['cancel', 'that'],
  ['never', 'mind'],
  ['nevermind'],
  ['forget', 'it'],
  ['stand', 'down'],
  ['abort'],
  ['hold', 'everything'],
];

/* Prepositions that turn a leading stop verb into ordinary content:
 * "wait for the research", "stop by the settings page". */
const CONTENT_PREPOSITIONS = new Set(['for', 'by', 'until', 'till', 'to', 'at']);

function norm(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function startsWith(tokens: string[], lead: string[]): boolean {
  if (tokens.length < lead.length) return false;
  for (let i = 0; i < lead.length; i++) {
    if (tokens[i] !== lead[i]) return false;
  }
  return true;
}

function joinRemainder(tokens: string[]): string {
  return tokens.join(' ').trim();
}

/* Strip repeats of the lead word plus fillers: "wait, wait, wait" ->
 * []; "hold on a second" (after 'hold on') -> []. */
function stripRepeatsAndFillers(tokens: string[], leadWords: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (leadWords.includes(t)) continue;
    if (FILLERS.has(t)) continue;
    out.push(t);
  }
  return out;
}

export function classifyStopUtterance(text: string): StopVerdict {
  const tokens = norm(text);
  if (tokens.length === 0) return { stop: null, remainder: text };

  /* Voice-silence class first: it is the narrower intent. */
  for (const lead of SPEAK_STOP_LEADS) {
    if (startsWith(tokens, lead)) {
      return {
        stop: 'stop_speaking',
        remainder: joinRemainder(tokens.slice(lead.length)),
      };
    }
  }

  /* Explicit hard-interrupt phrases. */
  for (const lead of WORK_STOP_LEADS) {
    if (startsWith(tokens, lead)) {
      return {
        stop: 'interrupt_work',
        remainder: joinRemainder(tokens.slice(lead.length)),
      };
    }
  }

  /* Leading "hold on" / "hold up": a genuine floor-grab. Bare (or
   * fillers only) is a pure stop; content after it still interrupts
   * and forwards ("hold on, stop what you're doing" recurses so the
   * inner phrase classifies too). */
  if (startsWith(tokens, ['hold', 'on']) || startsWith(tokens, ['hold', 'up'])) {
    const rest = tokens.slice(2);
    const meat = stripRepeatsAndFillers(rest, ['hold', 'on', 'up']);
    if (meat.length === 0) return { stop: 'interrupt_work', remainder: '' };
    const inner = classifyStopUtterance(joinRemainder(rest));
    return { stop: 'interrupt_work', remainder: inner.remainder };
  }

  /* Leading bare "stop": interrupt, with any substantive tail
   * forwarded - unless the tail begins with a content preposition
   * ("stop by the store"), which reads as an ordinary sentence. */
  if (tokens[0] === 'stop') {
    const rest = tokens.slice(1);
    if (rest.length > 0 && CONTENT_PREPOSITIONS.has(rest[0]!)) {
      return { stop: null, remainder: text };
    }
    const meat = stripRepeatsAndFillers(rest, ['stop']);
    return {
      stop: 'interrupt_work',
      remainder: meat.length === 0 ? '' : joinRemainder(rest),
    };
  }

  /* Leading "wait": too content-prone for a hard interrupt unless the
   * whole utterance is the wait itself ("wait", "wait wait wait",
   * "wait a second"). "wait for the research" is content. */
  if (tokens[0] === 'wait') {
    const meat = stripRepeatsAndFillers(tokens.slice(1), ['wait']);
    if (meat.length === 0) return { stop: 'interrupt_work', remainder: '' };
    return { stop: null, remainder: text };
  }

  return { stop: null, remainder: text };
}

/* Piper speech rate: roughly 16 chars/second of audio at the default
 * voice and length scale, i.e. ~62ms per character. The exact rate
 * varies with voice/speed; callers with a better estimate (actual
 * synth duration per segment) should pass msPerChar. Precision is not
 * load-bearing: the contract is "never claim words that never
 * played", so rounding DOWN to a word boundary is the safe side. */
export const DEFAULT_MS_PER_CHAR = 62;

export function truncateToHeard(
  fullText: string,
  playedMs: number,
  opts: { msPerChar?: number } = {},
): string {
  const msPerChar = opts.msPerChar ?? DEFAULT_MS_PER_CHAR;
  if (playedMs <= 0) return '';
  const budget = Math.floor(playedMs / msPerChar);
  if (budget <= 0) return '';
  if (budget >= fullText.length) return fullText;
  const slice = fullText.slice(0, budget);
  /* Never cut mid-word: back up to the last completed word. */
  if (fullText.charAt(budget) === ' ') return slice.trimEnd();
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace <= 0) return '';
  return slice.slice(0, lastSpace).trimEnd();
}

export type InterruptPolicy = 'drop-reply' | 'rethink' | 'finish-then-answer';

/* Redirect/contradiction markers: the new words change the in-flight
 * answer, so the assistant should say so and rethink rather than
 * finish a reply the operator just invalidated. */
const RETHINK_LEADS = new Set(['no', 'nope', 'actually', 'wrong', 'not']);
const RETHINK_MARKERS = [
  'instead',
  'rather',
  "that's wrong",
  'thats wrong',
  "that's not",
  'thats not',
  "don't",
  'dont',
  'not that',
  'wrong',
];

export function decideInterruptPolicy(args: {
  newText: string;
  stop: StopClass | null;
}): InterruptPolicy {
  if (args.stop) return 'drop-reply';
  const tokens = norm(args.newText);
  if (tokens.length > 0 && RETHINK_LEADS.has(tokens[0]!)) return 'rethink';
  const joined = tokens.join(' ');
  for (const m of RETHINK_MARKERS) {
    if (joined.includes(m)) return 'rethink';
  }
  return 'finish-then-answer';
}
