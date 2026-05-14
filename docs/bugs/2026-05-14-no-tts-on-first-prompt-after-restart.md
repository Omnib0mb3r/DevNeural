# No verbal reply on first prompt after restart

**Reported:** 2026-05-14 (brainstorm session "DevNeural Testing")
**Severity:** medium
**Component:** voice client (TTS on cold restart) / Lex cold-start path

## Symptom

After a Lex cold restart (strict cold-restart compaction, commit 694c0cc), the user's first prompt receives a reply that renders in the Claude mirror as text, but TTS does not speak it. The user must send a second prompt before voice replies resume; from prompt two onward, TTS works normally.

## Reproduction

1. Drive Lex context past the compaction threshold so the session restarts at the next natural break (cold-restart path).
2. Once the new session is live, send the first voice or text prompt.
3. Observe: reply text appears in the mirror, no audio is spoken.
4. Send a second prompt.
5. Observe: reply text appears in the mirror AND is spoken aloud as expected.

## Impact

- Breaks the hands-busy voice loop on every cold restart.
- Violates the "Lex always speaks responses aloud" rule (feedback memory).
- User has to visually confirm the restart and re-prompt, which defeats the point of seamless compaction.

## Suspected location

Voice WebSocket / TTS pipeline on the new session immediately after a cold-restart compaction. Candidates:

- TTS audio element not yet unlocked on the freshly mounted VoiceClient for the new session, so the first speak() call is silently dropped by the browser autoplay policy.
- The end-of-turn compaction supervisor (commit 37165b8) consumes the first turn's TTS event before the speak path is wired, causing the first reply to render text-only.
- The cold-start preamble path (commit d9b2e6b) fires before the TTS connection is established for the new session, dropping the first turn.
- Race between LexColdStartPreloadPanel mount and the WS handler that triggers speak() on the inbound assistant message.

## Status

Fixed (pending soak). Patched in commit pending push below.

## Root cause

Compaction supervisor in commit 37165b8 (07-daemon/src/voice/lex-voice-ws.ts spawnRestart closure) called spawnLexSession + killed the prior PTY but never rebound the WS state. The voice WS kept watching the old jsonl at the old offset and kept injecting into the dying PTY. The first reply on the fresh session landed in the new jsonl while pollJsonl was still pointed at the old file. By the time the client's 3s pty-list poll detected the new sessionId and the React WS effect tore down + reconnected, the user's first reply had already passed beyond the new bind's jsonlOffset (set to current file size on hello) so the speak path never saw it. From the second prompt onward the WS was bound to the new jsonl and the gate (state.awaitingResponseSince > 0 after the next utterance-end inject) admitted the reply, so TTS resumed.

## Fix

In the spawnRestart closure, repoint every per-session field on ConnState before killing the prior PTY:

- state.watchSessionId / state.jsonlPath / state.jsonlOffset move to the new transcript (jsonlOffset=0 since the file is fresh).
- state.bindKey moves to the new PTY id so handleUtteranceEnd's ptyInject targets the live session.
- state.awaitingResponseSince stamped to now so the handleJsonlLine gate admits the first end_turn that lands on the new session even when the user types the prompt in the brainstorm UI rather than speaking it.
- state.sessionEndFired / state.compaction.compactedAt reset so the new session can fire its own end-of-life pipeline and compact when it crosses the threshold.
- lastSpokenUuid closure variable cleared so the speak dedupe cannot accidentally suppress a reply whose uuid happens to match the prior session's last spoken record.
- activeByBindKey re-keyed on the new bindKey.
- startJsonlWatch is called explicitly so a clean rebind also covers the path where the prior WS had already torn its watcher down.

Daemon's pollJsonl reads state.jsonlPath on every 250ms tick so the existing watcher picks up the new file on the next tick without any restart. Old PTY is killed AFTER the internal rebind; pty-host's onExit fires the session-end pipeline a second time but runSessionEndPipeline's session-end lock + sessionEndFired guard turn the duplicate invocation into a no-op.

## Verification

- `npm run build:check` (07-daemon) clean.
- Compaction supervisor + cold-start preamble + compaction-trigger tests stay green: 28/28.
- Real-hardware soak: drive Lex over the 75% gate, send a prompt, confirm the first reply is spoken aloud without a second prompt.

## Open items

- Hold for one cold-restart smoke-pass before marking closed.
