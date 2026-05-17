# CC end-of-session feedback dismiss keystrokes leak into Lex brainstorm chat

**Date observed:** 2026-05-17 (~21:20 EDT, during auto-advance smoke
on anchor 391b88f6).
**Severity:** medium (false user prompts can derail Lex)
**Suspect:** focus-routing in dashboard typed-textarea path, or
voice-STT artifact picking up the worker's terminal output and
re-injecting it.
**Status:** observation only; not fixed in this commit. Tracked so
the next voice-lifecycle / focus-routing audit can take it.

## Symptom

When a Claude Code worker session emits the end-of-session feedback
overlay ("Was this session helpful? 1=yes / 2=no / 3=skip / 0=dismiss"
or similar), the dismiss keystrokes (`1` / `2` / `3` / `0`) the
operator sends appear to land in the brainstorm Lex chat textarea
rather than the intended worker PTY. The single-digit chars flow as
user turns into the Lex transcript and Lex sees them as new prompts.

## Expected

A single keystroke targeted at the worker terminal stays in the
worker terminal. The brainstorm chat input only captures input when
it is the active focus target.

## Hypotheses

1. **Dashboard focus routing.** The brainstorm chat textarea has a
   broad-scope key listener (window-level or document-level) and
   captures digits the user thinks they're sending to the worker
   terminal mirror. The terminal mirror is read-only; any keystroke
   that lands inside its DOM bubble may default-handle through the
   parent layout.
2. **Voice-STT artifact.** Whisper transcribed the worker's terminal
   audio output (or a beep / system sound) as the digits and injected
   them as user turns into the brainstorm chat. Less likely since the
   user reports zero audio output during the leak window.
3. **Stream Deck / hotkey misroute.** If the user pressed a Stream
   Deck tile or hotkey that's bound to brainstorm-chat-inject, the
   digits would land there by design. Operator should rule out by
   checking which input device fired the keystrokes.

## Where to look

- `08-dashboard/app/lex/page.tsx` — the brainstorm chat textarea +
  the inject mutation. Confirm whether the form's `onKeyDown` or
  `onChange` handlers fire from anywhere outside the focused
  textarea.
- `08-dashboard/components/TerminalMirror.tsx` — confirm the mirror
  is fully `disableStdin: true` and that no parent listener catches
  the bubble.
- `07-daemon/src/voice/lex-voice-ws.ts` — confirm whisper transcripts
  drop turns under a word-count floor (already gates `<2 words` per
  the post-Whisper sanity drop at L878). Single-digit utterances
  should never reach the inject path.
- `09-bridge/src/extension.ts` — confirm the bridge does not echo
  worker stdout back into any inject path.

## Repro (operator-driven; cannot synthesise from Lex)

1. Open `/lex` brainstorm in conversation mode.
2. Trigger the CC end-of-session feedback overlay on a worker PTY
   the brainstorm has the project anchor bound to (or any worker
   that just `/clear`'d).
3. Press `0` (or any of `1` / `2` / `3`) intending to dismiss the
   overlay.
4. Observe: the digit appears as a new user turn in the brainstorm
   transcript and Lex sees it as a prompt. The CC overlay is NOT
   dismissed; the worker keeps waiting.

## Acceptance

Keystrokes targeted at a worker terminal stay in that terminal.
Brainstorm chat textarea only captures keystrokes when it is the
focus target. The post-Whisper sanity floor continues to drop
single-digit transcripts.

## Related

Pairs with the broader voice-lifecycle audit (OOM + commands-during-
TTS bug docs). Also adjacent to the feedback-overlay-auto-dismiss
bridge-session bug
(`2026-05-16-feedback-auto-dismiss-misses-bridge-sessions.md`); a
fixed auto-dismiss path on bridge sessions would remove the need
for the operator to type the digits at all, making this leak moot
for that specific overlay even if the focus-routing root cause
persists for other inputs.
