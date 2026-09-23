# 2026-05-14 cross-session inject lands in worker input field but never auto-submits

**Status:** fixed (pending soak). Root cause: the bridge used two separate `terminal.sendText` calls to ship `body` and then `\r`, with an 80ms `setTimeout` between them. On a busy VS Code render frame the second call raced ahead of the first call's PTY-write flush, so the trailing `\r` occasionally landed inside the bracketed-paste envelope (`\x1b[200~ ... \x1b[201~`) and CC's TUI treated it as part of the pasted text instead of as Enter. Fix: assemble `body + '\r'` in a single string and hand it to `terminal.sendText` in ONE call; the integrated terminal commits the underlying PTY write atomically, so by the time `\r` arrives at the TUI the `\x1b[201~` terminator has already closed the envelope. Same atomic write applied to the workspace-inject path (`runWorkspaceInject`). Pure helper extracted to `09-bridge/src/bridge-payload.ts` with regression tests in `09-bridge/tests/bridge-payload.test.ts` so the two-call shape cannot return without a test failure.


## Symptom
Lex sent a cross-session inject via `POST /lex/inject-cross-session` (token minted, decision=accepted, transport=bridge). The bridge wrote the inject text into the worker session's PTY stdin, but did NOT send the Enter keystroke needed to submit the prompt. Worker session 9c4f80a8 sat with the text visible in its input field for ~52 minutes until the user manually pressed Enter; only then did the worker process the inject and commit (commit 44baeac at 15:46 EDT).

## What we know
- Earlier injects today (resultIndex fix at 14:42 EDT, telemetry at 11:37 EDT) DID auto-submit and the worker processed them within a minute. Identical inject path, identical caller (Lex brainstorm session via /lex/inject-cross-session), identical worker session.
- CREDITS inject at 14:57 EDT was the first to stall in this way.
- Bridge heartbeat file was fresh at every probe. `.in` queue had the CREDITS entry written at the tail with the right structure.
- Worker's last jsonl `turn_duration` system event was at 14:46 EDT, ~10 minutes before the CREDITS inject queued. Worker was idle, not paused on a permission prompt (user confirmed visually).
- User confirmed: text was sitting in the prompt buffer, not yet submitted, when they looked at the VS Code terminal.

## Hypothesis
The bridge's writePtyStdin path either:
1. Did not append the Enter (`\r` or `\n`) terminator to the typed text, OR
2. Appended it but typed it too fast such that the worker's input handler swallowed/lost it before processing the line, OR
3. Sent it as a key event of a kind the worker's terminal does not interpret as a submit (e.g. printable U+000A instead of an actual VK_RETURN keypress).

The fact that earlier injects worked rules out a static config error. Suspect a timing or buffer-flush gap that fires intermittently. Worth checking against payload size: today's CREDITS inject text was 642 chars (similar to resultIndex 1186 chars), so not obviously a length issue. Could be a flush-on-newline bug where if the previous typed character was just a newline embedded in the inject body, the bridge collapsed it with the trailing submit Enter.

## Action
Investigate `07-daemon/src/bridge/` (or wherever bridge typing logic lives — check the bridge process in the dev-template/Stream Deck repo too if applicable). Specifically:
- Confirm the bridge appends a terminating Enter (`\r` on Windows PTY) after the inject body.
- Confirm the Enter is delivered as a distinct write call AFTER the body, not coalesced with body content that already contains \n.
- Add an integration test that injects multi-line text containing embedded `\n` characters and asserts the worker's prompt actually submits.

## Workaround (until fix)
Lex supervisor should poll worker jsonl after every inject; if no new turn within ~2 minutes despite bridge heartbeat being alive, surface to user with a "press Enter on the worker terminal" message instead of waiting silently.

## Related
- /lex/inject-cross-session contract in docs (cross-session inject HMAC + token).
- 07-daemon/src/dashboard/bridge-presence.ts and surrounding bridge plumbing.
