/**
 * Hold-up voice-command runtime (Fix 2026-05-24).
 *
 * Distinct from the "lex shut up" mute family. Mute only cancels TTS
 * playback; Lex keeps thinking and keeps executing tool calls in the
 * background. Hold-up is a hard abort of Lex's current activity:
 *
 *   1. Cut TTS mid-sentence immediately.
 *   2. Cancel pending Lex-side tool calls + drop any queued tool calls
 *      for the current turn. Implemented by writing ^C to the Lex PTY;
 *      Claude Code's tool sequencer drops the in-flight tool_use plan
 *      and returns control to the user.
 *   3. Drop any cross-session injects to the worker that have been
 *      queued but not yet POSTed to /lex/inject-cross-session.
 *      Already-delivered injects are NOT clawed back. The drop is a
 *      natural consequence of step 2: queued POSTs live inside Lex's
 *      tool sequencer; cancelling the sequencer drops them. We never
 *      touch the worker session.
 *   4. Leave the worker completely alone. NO worker PTY write,
 *      NO POST to /lex/inject-cross-session, NO bridge queue write.
 *   5. Re-open the mic by sending a voice-listen frame so a soft
 *      standby state does not silently swallow the user's follow-up.
 *   6. Speak a brief recap of what Lex was in the middle of, then
 *      ask "what is up?".
 *   7. Wait for the user to redirect. handleUtteranceEnd's normal path
 *      handles the next utterance; hold-up itself never injects.
 *
 * The module is pure aside from the injected dependency callbacks so
 * the dispatch wiring inside attachLexVoiceWs stays testable without
 * standing up a real PTY / piper / WS.
 */

export interface HoldUpDeps {
  /** Cancel the in-flight TTS context (mirrors the TTS-cancel half of
   * killActiveTts). No-op when no TTS is active. */
  cancelTts: () => void;
  /** Write ^C (\\x03) to the bound Lex PTY so Claude Code's tool
   * sequencer drops the in-flight tool_use plan. No-op when the bind
   * key is unset or the PTY has exited. */
  ctrlCLexPty: () => void;
  /** Send a WS frame to the client. Used for voice-hold-up
   * acknowledgement and voice-listen mic-rearm. */
  sendFrame: (frame: Record<string, unknown>) => void;
  /** Speak the recap text via piper. Called fire-and-forget; failures
   * inside speak() are observed via the caller's existing logging. */
  speak: (text: string) => void;
  /** The cleaned text that piper was synthesising when hold-up fired
   * (state.currentTtsText). null when Lex was reasoning silently or
   * mid-tool-use with no TTS in flight. */
  intendedText: string | null;
  /** Wall-clock for the audit log entry. Defaults to Date.now in
   * production; tests inject a deterministic value. */
  now?: () => number;
}

export interface HoldUpResult {
  /** The recap sentence + question that was passed to speak(). Surfaced
   * for tests and observability. */
  recap: string;
  /** Wall-clock ms the hold-up was processed. */
  fired_at_ms: number;
}

/* Cap the recap's "what Lex was doing" phrase so a multi-sentence
 * intended-text doesn't bloat the spoken reply. The recap is meant to
 * be one sentence end-to-end. */
const RECAP_MAX_CHARS = 140;

function summariseIntent(intended: string | null): string {
  if (!intended) return 'thinking through your last request';
  const cleaned = intended
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return 'thinking through your last request';
  /* Take the first sentence-ish chunk (up to first . ! ?) so the recap
   * stays terse. Fall back to a character cap when no terminator
   * appears in the budget. */
  const cap = cleaned.slice(0, RECAP_MAX_CHARS);
  const term = cap.search(/[.!?](\s|$)/);
  const phrase = term >= 0 ? cap.slice(0, term).trim() : cap.trim();
  if (phrase.length === 0) return 'thinking through your last request';
  /* Prefix with "saying" because intendedText is what piper was about
   * to vocalise. "I was saying X. What is up?" reads naturally; "I was
   * X" does not. */
  return `saying ${JSON.stringify(phrase)}`;
}

export function buildHoldUpRecap(intended: string | null): string {
  return `Holding up. I was ${summariseIntent(intended)}. What is up?`;
}

export function runHoldUp(deps: HoldUpDeps): HoldUpResult {
  const now = (deps.now ?? Date.now)();
  /* Step 1 + 2: cancel TTS, drop Lex's pending tool sequence. Both
   * happen first so the user doesn't hear another syllable and Lex's
   * worker-bound POSTs cannot fire after this point. */
  try {
    deps.cancelTts();
  } catch {
    /* TTS cancel is best-effort */
  }
  try {
    deps.ctrlCLexPty();
  } catch {
    /* PTY write may fail if the handle just exited; tolerable */
  }
  /* Step 5 acknowledgement + mic rearm. The hold-up frame is the
   * audit signal for the dashboard's voice diagnostics panel. The
   * voice-listen frame matches the existing `listen` command's wire
   * shape so a soft standby state clears even if the user had paused
   * the mic moments before yelling hold-up. */
  deps.sendFrame({ t: 'voice-hold-up', reason: 'voice-command' });
  deps.sendFrame({ t: 'voice-listen', reason: 'hold-up' });
  /* Step 6: synthesise the recap. Hardcoded template, not an LLM
   * call, so the recap is instant and Lex cannot ramble during a
   * hold-up. */
  const recap = buildHoldUpRecap(deps.intendedText);
  try {
    deps.speak(recap);
  } catch {
    /* speak failure surfaces through the caller's existing piper logs */
  }
  return { recap, fired_at_ms: now };
}
