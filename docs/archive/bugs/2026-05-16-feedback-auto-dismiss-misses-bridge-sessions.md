# CC feedback prompt auto-dismiss does not fire on bridge-attached sessions

**Date observed:** 2026-05-16 (~21:25 EDT)
**Severity:** high (blocks headless / phone-only operators; queued `0`s leak into worker prompts)
**Related shipped commits:** f3c5099 (auto-dismiss new variant), 7a70bcc (block voice inject during system prompt)
**Related bug:** docs/bugs/2026-05-10-cc-feedback-prompt-unanswerable.md

## Symptom

The CC feedback overlay ("How is Claude doing this session?
1: Bad 2: Fine 3: Good 0: Dismiss") rendered on worker session
bca9e393 (DevNeural) while the user was on his phone via the
dashboard. The user has no physical terminal access to that
session: the worker is bridge-attached (VS Code) on the desktop,
the user sees only the dashboard's read-only TerminalMirror.

The keystrokes he attempted from the phone landed in either the
brainstorm chat input (leak, separate bug
`2026-05-16-cc-feedback-prompt-keystrokes-leak-to-brainstorm.md`)
or the CC message queue ("Press up to edit queued messages")
where they sit as future user prompts that will fire after the
overlay clears, derailing the worker's `/gsd:update` task.

The existing auto-dismiss in `07-daemon/src/dashboard/pty-host.ts`
correctly detects the overlay via the `CC_SYSTEM_PROMPT_RE` +
`CC_BOX_CHARS_RE` pair and writes `0\r` to the PTY with a cooldown.
It never fires here because the worker PTY is owned by VS Code (via
the 09-bridge extension), not by the daemon. The auto-dismiss
write path only targets daemon-owned PtyHandle rows.

## Expected

Auto-dismiss should fire regardless of who owns the worker PTY, so
phone-only operators are never stranded with an undismissable
overlay. The dismiss `0\r` should reach the worker via whichever
inject path is bound to the session.

## Where to look

- `07-daemon/src/dashboard/pty-host.ts` — current detect + write
  logic. Path is gated to PtyHandle entries.
- `07-daemon/src/dashboard/terminal-stream.ts` — daemon does see the
  worker's stdout for bridge-attached sessions via the bridge's
  capture mirror; the overlay text is observable.
- `09-bridge/src/extension.ts` — paste path the bridge already uses
  to inject text into the VS Code terminal. crossSessionInject in
  `07-daemon/src/lex/cross-session-inject.ts` is the proven
  precedent for the daemon writing into a bridge-attached worker.
- `07-daemon/src/lex/cross-session-inject.ts` — reuse the
  bridge-inject seam for the `0\r` dismiss.

## Proposed fix

1. Move overlay detection out of `pty-host.ts` so it runs against
   the terminal-stream ring regardless of who owns the PTY.
2. When the overlay matches and the session is bridge-attached,
   fire a bridge inject with payload `0` + carriage-return (same
   trailing-CR pattern the inject pipeline already uses per the
   memory rule "Always fire bare CR after every inject").
3. Keep the existing cooldown (per session) so a redraw storm only
   triggers one dismiss.
4. When the session is daemon-owned, keep the existing direct
   PTY write path.

## Bracketed-paste blocker (2026-05-17 update)

Routing the dismiss through the existing bridge inject path WILL
NOT WORK. The bridge's paste channel wraps payloads in bracketed-
paste mode (ESC[200~ ... ESC[201~), and Claude Code routes
bracketed pastes to its message queue, not to the overlay's
single-key number handler. The user has confirmed `0\r` sent as a
paste lands in the "Press up to edit queued messages" queue
instead of dismissing the overlay.

Implication: the bridge needs a raw-keystroke channel that
bypasses bracketed-paste mode. The VS Code terminal API exposes
`terminal.sendText(text, addNewLine)` which still paste-wraps on
most shells; raw input requires a custom Pseudoterminal write or
a dedicated key-injection IPC. Both are heavier than the existing
paste path.

Alternatives to evaluate before building the raw-keystroke
channel:

a. Have the daemon write directly to the worker's stdin via a
   separate fd opened against the underlying PTY. Bridge owns the
   PTY today; daemon can't reach it without bridge cooperation.
b. Use the OS-level focus + simulated keystroke path the
   stream-deck tray app uses for the worker session. Heavy.
c. Suppress the feedback overlay upstream via a CC config /
   `--no-feedback` flag if one exists; check CC release notes.

This task is deferred until path (a)/(b)/(c) is picked. The
gating fix for the keystroke-leak bug
(`2026-05-16-cc-feedback-prompt-keystrokes-leak-to-brainstorm.md`)
shipped first since it was actively breaking the brainstorm
session; this bridge fix waits.

## Alternative (worse)

Add a CC config / env flag that suppresses the feedback overlay
entirely on bridge-attached sessions. Not within our control
(upstream CC behavior); rejected.

## Acceptance

User on phone, worker on bridge-attached session, CC feedback
overlay appears. Within ~2 seconds the dashboard mirror shows the
overlay clear without any user input. CC message queue stays
empty (no leaked `0`s queued as prompts).
