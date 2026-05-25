# No verbal reply on first prompt after restart

**Reported:** 2026-05-14 (brainstorm session "DevNeural Testing")
**Severity:** medium
**Component:** voice client (TTS on cold restart) / Lex cold-start path
**Status:** closed 2026-05-25 (original cold-restart variant + 2026-05-24 fresh-spawn recurrence both addressed; see Fix 31)

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

---

## Recurrence: fresh-session spawn (2026-05-24)

**Reported:** 2026-05-24 (brainstorm session, voice mode)
**Status:** closed 2026-05-25 (Fix 31)

### Symptom (recurrence)

On every freshly started Lex session (not a compaction restart, a brand-new spawn), the first user prompt produces a text reply in the mirror but no TTS. The second prompt onward speaks normally. Identical user-visible behavior to the original cold-restart bug, different trigger path.

### Difference from original

Original repro required driving Lex past the compaction threshold so the cold-restart compaction path ran. This recurrence happens on a clean fresh spawn with no prior session involved, so the spawnRestart closure fix (37165b8 successor) does not cover it. The WS/jsonl state on first spawn is already "fresh"; the missing piece is parallel to the rebind-on-cold-restart path.

### Root cause (verified 2026-05-25 via daemon.log probes)

Two-layer race. Cause and fix are structural, not field-symmetry as initially suspected.

**Layer 1 (client trigger).** `08-dashboard/components/VoiceClient.tsx:2671` declared the voice-engine effect with deps `[enabled, sessionId, mode]`. `sessionId` is Claude Code's cc-session-id, exposed via the 3-second `/pty-list` poll. At voice-engine startup on a fresh PTY, `lexPty.sessionId` is `null` (PTY exists but Claude Code has not yet emitted its SessionStart record). The effect runs with `sessionId=null`, opens WS #1, sends hello with `session_id=undefined`. The daemon's `bind()` falls back to PTY-cwd discovery, binds successfully (`bindKey = ptyId`). User speaks. `handleUtteranceEnd` injects into the PTY and stamps `state.awaitingResponseSince`. Claude Code processes the inject, emits SessionStart with its new cc-session-id, and begins writing the assistant turn into its jsonl. ~1.5-3 seconds later the dashboard's `/pty-list` poll returns the now-populated `sessionId`, React state updates, effect deps change, effect re-runs. Cleanup tears down WS #1. WS #2 opens with `session_id=<resolved>`. The fresh `ConnState` has `awaitingResponseSince=0` (default).

**Layer 2 (daemon gate).** WS #2's `bind()` resolves the jsonl via the session-id branch at `lex-voice-ws.ts:419` and stamps `jsonlOffset = fs.statSync(jsonl).size` (EOF at bind time). The assistant turn lands in the jsonl past that offset within ~2 seconds. `pollJsonl` reads the new bytes and calls `handleJsonlLine`. At line 762 the gate `if (!readOnly && !state.awaitingResponseSince) return;` drops the assistant record because WS #2 never saw an inject and therefore never stamped awaiting. Silent first turn.

Probe trace (`daemon.log` 21:43:37–21:44:01) confirmed the sequence verbatim: WS #1 hello with `session_id=undef`, fallback bind to `bindKey=ptyId`, inject + awaiting stamped, then WS #2 hello at 21:43:57 with the resolved cc-session-id, EOF offset stamped, and `handleJsonlLine GATE drop: type=assistant awaiting=0` at 21:44:01.

### Fix (commit pending)

Two layers, both committed atomically.

**Layer 1 — daemon, the structural invariant.** `bind()` in `07-daemon/src/voice/lex-voice-ws.ts` now migrates `awaitingResponseSince` from the brainstorm row. After the bind resolves a handle, look up the brainstorm via `handle.sessionId` or `handle.ptyId`. If `lifecycle_state === 'speaking'` there is a turn in flight that the previous WS owner left behind, so stamp `state.awaitingResponseSince = Date.now()` and ensure the jsonl watcher is running. The brainstorm row is the authoritative source for "is a turn in flight?" — set on every inject at `handleUtteranceEnd:1900-1910` and cleared at the matching end_turn in `handleJsonlLine:818-822`. Inheriting from that row makes the gate at line 762 correct for any WS replacement cause: sessionId resolve, smart-compact restart, daemon restart, multi-tab eviction.

**Layer 2 — client, identity correctness.** Change the voice-engine effect deps in `08-dashboard/components/VoiceClient.tsx:2671` from `[enabled, sessionId, mode]` to `[enabled, lexPty?.ptyId ?? null, mode]`. `ptyId` is the true PTY identity; it does not change when Claude Code resolves its cc-session-id. The dep tuple now only changes when the PTY itself changes (brainstorm switch, manual Lex restart) — events that genuinely justify a WS replacement. The smart-compact restart path swaps `bindKey` and `jsonlPath` in-daemon at `lex-voice-ws.ts:1053` without changing `ptyId` visible to the client (the daemon spawns a new PTY but the supervisor handles the swap), so this dep also avoids redundant churn on that path.

Together: Layer 2 prevents the spurious WS replacement on cold-spawn sessionId resolve; Layer 1 keeps the daemon correct for any future cause of WS replacement during an in-flight turn.

### Verification

Real-hardware test 2026-05-25 (post-rebuild, post-restart): fresh brainstorm spawn, voice toggled on, first utterance spoken, first reply spoken aloud. Daemon test suite 863/863 green. Probes stripped before commit.

