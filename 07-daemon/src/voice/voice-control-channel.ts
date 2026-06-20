/* Control channel (pillar 3.5, sliver V2).
 *
 * stop / quiet / abort / redirect are recognized INSTANTLY by the haiku
 * front desk and are NEVER queued to Lex. They jump the data lane:
 *
 *   quiet / (ambiguous) stop  -> kill-tts: kill the local TTS stream,
 *      zero Lex round-trip (the existing barge-in kill). Ambiguous "stop"
 *      defaults to the voice (safest + fastest) per plan Hole 6c.
 *   stop-work / abort         -> interrupt: out-of-band interrupt to free
 *      Lex / the worker; no queued inject.
 *   redirect                  -> interrupt-then-inject: interrupt, then
 *      inject the carried instruction once Lex is free.
 *
 * Pure classifier. The WS layer maps the action onto killActive() / the
 * out-of-band interrupt path; this module only decides. Conservative by
 * design: redirect needs an explicit marker so ordinary speech that
 * happens to contain "actually" is not hijacked.
 */

export type ControlIntent = 'quiet' | 'stop-work' | 'abort' | 'redirect';
export type ControlAction = 'kill-tts' | 'interrupt' | 'interrupt-then-inject';

export interface ControlDecision {
  intent: ControlIntent;
  action: ControlAction;
  /** Control is never queued; this is always false (documents intent). */
  queued: false;
  /** For redirect: the instruction to inject after the interrupt. */
  payload?: string;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
}

/* Quiet / kill-the-voice phrases. Ambiguous bare "stop" lives here:
 * Hole 6c says an unqualified stop defaults to silencing the voice. */
const QUIET_RE =
  /^(quiet|be quiet|shush|hush|shut up|stop talking|stop speaking|stop it|enough|that'?s enough|ok stop|stop)$/;

/* Stop-the-work phrases: a qualified stop aimed at the task/worker. */
const STOP_WORK_RE =
  /^(stop (the )?(work|working|worker|task|build|job)|halt|pause (the )?(work|task)|stop that (task|work))$/;

const ABORT_RE = /^(abort|abort that|cancel that|cancel it|kill it)$/;

/* Redirect: explicit marker + a carried instruction. Conservative so a
 * normal sentence beginning "actually" is not treated as a redirect
 * unless it reads like a course-correction. */
const REDIRECT_RE =
  /^(redirect|change of plans?|scratch that|no wait|no,? wait|actually|instead)[,:]?\s+(.*\S.*)$/;

export function classifyControl(text: string): ControlDecision | null {
  const t = norm(text);
  if (!t) return null;

  if (QUIET_RE.test(t)) {
    return { intent: 'quiet', action: 'kill-tts', queued: false };
  }
  if (STOP_WORK_RE.test(t)) {
    return { intent: 'stop-work', action: 'interrupt', queued: false };
  }
  if (ABORT_RE.test(t)) {
    return { intent: 'abort', action: 'interrupt', queued: false };
  }
  const m = REDIRECT_RE.exec(t);
  if (m) {
    const payload = (m[2] ?? '').trim();
    if (payload.length > 0) {
      return {
        intent: 'redirect',
        action: 'interrupt-then-inject',
        queued: false,
        payload,
      };
    }
  }
  return null;
}

/** True when the utterance is a control-channel command (never queued). */
export function isControl(text: string): boolean {
  return classifyControl(text) !== null;
}
