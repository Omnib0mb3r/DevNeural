/* Two lanes (pillar 3.2, sliver V4).
 *
 * Every inbound utterance routes to exactly one lane, in priority order:
 *
 *   control -> the control channel (V2): stop/quiet/abort/redirect, never
 *      queued, handled instantly.
 *   fast    -> haiku alone (V3 glue): pure conversational glue answered
 *      with ZERO Opus round-trip.
 *   slow    -> haiku + Lex: anything needing a project/code/state fact.
 *      Haiku drops an instant bridging line, Lex reasons behind it, haiku
 *      speaks the result the moment it lands.
 *
 * The bridge line is what hides the Opus latency on the slow lane (no
 * block-and-wait). Pure router; composes the V2 control classifier and
 * the V3 deny-by-default whitelist.
 */
import { classifyControl, type ControlDecision } from './voice-control-channel.js';
import { classifyTurn } from './voice-whitelist.js';

export type Lane = 'control' | 'fast' | 'slow';

export interface LaneDecision {
  lane: Lane;
  /** Present when lane === 'control'. */
  control?: ControlDecision;
  /** Present when lane === 'slow': the instant filler haiku speaks while
   * Lex reasons. */
  bridge?: string;
  reason: string;
}

/* Short, low-commitment fillers. Deterministically chosen per-utterance
 * (hash) so the same question reads the same in tests but the set varies
 * across different questions to avoid a robotic single phrase. The real
 * haiku-generated bridge is the flag-flip capstone; this is the default. */
const BRIDGE_LINES = [
  'Let me pull that up.',
  'One sec, checking.',
  'Give me a moment on that.',
  "Let me see what's there.",
  'Taking a look now.',
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function pickBridgeLine(text: string): string {
  return BRIDGE_LINES[hash(text) % BRIDGE_LINES.length]!;
}

export function routeTurn(
  text: string,
  opts?: { digestFresh?: boolean },
): LaneDecision {
  /* Control jumps the data lane entirely - never queued, never
   * classified as glue. */
  const control = classifyControl(text);
  if (control) {
    return { lane: 'control', control, reason: `control:${control.intent}` };
  }
  const wl = classifyTurn(text, opts ?? {});
  if (wl.class === 'handle') {
    return { lane: 'fast', reason: wl.reason };
  }
  return { lane: 'slow', bridge: pickBridgeLine(text), reason: wl.reason };
}
