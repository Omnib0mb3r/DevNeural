# CC end-of-session feedback prompt keystrokes leak into brainstorm chat input

**Date observed:** 2026-05-16 (~21:18 EDT onward)
**Severity:** medium (creates phantom user turns in brainstorm, pollutes transcript, triggers needless Lex responses)
**Reporter context:** brainstorm anchor 4bbafb48 (DevNeural Testing), worker session bca9e393 (DevNeural)
**Screenshot:** `C:/dev/data/skill-connections/uploads/screenshots/6c235ec6-ebbe-43c6-b987-9ffd3d0c00e9.jpeg`

## Symptom

Claude Code's end-of-session feedback prompt rendered in the worker
terminal (`How is Claude doing this session? (optional) 1: Bad 2:
Fine 3: Good 0: Dismiss`). User pressed `0` repeatedly to dismiss the
prompt. Instead of landing on the worker terminal, each `0` was
ingested as a new user turn on the brainstorm side (DevNeural
Testing anchor 4bbafb48). Lex received roughly a dozen `0` messages
across ~15 minutes and had to respond to every one.

The user confirmed verbatim: "I'm not pressing any buttons. That's
likely you trying to clear the Claude pop up."

## Expected

Keystrokes targeted at the worker terminal mirror (or at the
underlying CC PTY via bridge inject) should reach the worker, not
the brainstorm chat input. The brainstorm chat input should be the
exclusive target only when the user has explicitly focused it.

## Root cause (revised 2026-05-16 after operator pushback)

Original hypotheses (focus routing, STT misfire, bridge inject) were
all wrong. The actual cause is a feedback loop in the existing
auto-dismiss code itself (commits f3c5099 + 7a70bcc).

Mechanism: when the operator (or Lex) Read a screenshot of the CC
feedback overlay during a brainstorm session, the screenshot's text
content (containing `How is Claude doing this session?` and
`0: Dismiss` plus box-drawing characters from the rendered terminal
capture) flowed into the brainstorm Lex's daemon-owned PTY's stdout
ring. `CC_SYSTEM_PROMPT_RE` + `CC_BOX_CHARS_RE` in `pty-host.ts`
matched. The auto-dismiss path then wrote `0\r` into the Lex PTY.
`\r` submitted it as a user turn on the brainstorm side, which Lex
received as the message `0`.

Cooldown failed to suppress repeats because each fresh Read-of-image
re-emitted the matching text after the cooldown window expired, and
later screenshots compounded the loop.

The auto-dismiss code has no guard preventing it from firing inside
a daemon-owned brainstorm Lex session. The CC feedback overlay
should only ever appear inside a CC worker session, not inside a
Lex brainstorm session, so the auto-dismiss should be gated to
PtyHandle rows whose `kind` (or analogous tag) is `worker` /
`cc-session`, not `lex` / `brainstorm`.

## Repro

1. Open brainstorm in voice or text mode on phone (DevNeural
   Testing).
2. Trigger the CC end-of-session feedback prompt in the bound
   worker (end a CC session via `/end` or similar).
3. Without explicitly focusing the brainstorm input, press `0` to
   dismiss the prompt.
4. Observe: `0` posts as a user turn on the brainstorm transcript
   instead of dismissing the worker prompt.

## Where to look

- `08-dashboard/components/VoiceClient.tsx` and the brainstorm chat
  textarea component: focus management, blur handlers, did-mount
  focus-grab.
- `08-dashboard/components/TerminalMirror.tsx`: focus capture on
  mount, focus retention on tab switch.
- `07-daemon/src/voice/lex-voice-ws.ts`: STT path, confirm no `0`
  is being injected from the daemon side.
- `07-daemon/src/store/index-db.ts` `injection_log`: scan for any
  daemon-side `0` injects in the leak window.

## Acceptance

After ten consecutive `0` presses while the worker feedback prompt
is on screen, the prompt is dismissed and the brainstorm transcript
has zero new turns.
