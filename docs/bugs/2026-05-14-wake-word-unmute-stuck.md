# 2026-05-14 wake-word stuck after "Lex shut up", "Lex unmute" never fires

**Status:** fixed (pending soak) in c1e3bd3 with telemetry prelude in 73fc697. Root cause turned out to be on the suspect list as "matchWakeWord ate Lex unmute but the dispatch was deduped". Specifically: in Chromium's continuous-mode SpeechRecognition, `event.results` is never trimmed — the wake-word onresult handler iterated from index 0 on every event and kept re-matching the original `"lex shut up"` final indefinitely. The 1500 ms per-kind dedupe blocked the first burst but wore off after the window, so the mute command re-fired every ~1.5 s forever and any later `"lex unmute"` got immediately re-muted. Fix per the Web Speech spec: walk from `event.resultIndex` (falling back to 0 for older builds that omit it). The telemetry log lands in `window.__lexWakeLog` and a dev badge gated on `NEXT_PUBLIC_LEX_DEBUG_VOICE=1`.


## Symptom
After saying "Lex shut up" mid-TTS (which correctly halts TTS, smoke 5 partial pass), the always-on wake-word listener no longer responds to "Lex unmute". User had to stop the voice panel and start it again manually to recover.

## Expected
Per a3053ad and b0820a4, the wake-word recognizer is supposed to run in parallel with the silero VAD path and remain live through soft-mute. Soft-mute only suppresses TTS output, not the mic input or the wake-word recognizer. "Lex unmute" should match the wake-word pattern and dispatch the unmute command.

## What we know
- `dispatchWakeCommand("unmute")` exists at VoiceClient.tsx and calls `setSoftMuted(false)`. Branch verified present.
- `UNMUTE_RE` exists in voice-wake-word.ts and matches `lex unmute`. Pattern verified present.
- Wake-word `useEffect` gates on `enabled` and `micPermissionGranted`, NOT on softMuted. So in principle the recognizer should still run.
- Chromium SpeechRecognition pauses every ~30s of silence and the code restarts on `onend`. Start path swallows exceptions on Ctor() throws and retries after 1000ms.

## Suspect causes (unranked)
1. Chromium SpeechRecognition session got into a state where `onend` fired but `restartTimer` never re-armed (timer cleared by an unrelated cleanup path).
2. matchWakeWord ate "Lex unmute" but the dispatch was deduped or hit an error case before reaching setSoftMuted.
3. `r.start()` threw silently during a restart cycle and the 1000ms backoff fired but a later state change cancelled before it could re-arm.
4. Mic stream was actually paused by the TTS playback path despite parallel-capture wiring.

## Why we cannot easily diagnose in-browser
- User cannot reproduce on demand without console interaction that competes with their working context.
- Smart-quote/clipboard paste issues prevented running console probes from the chat-driven debug flow.

## Action
Inject worker to add wake-word lifecycle observability to VoiceClient.tsx (see inject token 6e385c3c... at 2026-05-14 15:37 UTC). Adds:
- `[wake]` prefixed console logs on every recognizer start/end/error/restart/abort.
- `[wake] heard: {transcript, matched, softMuted, enabled, micPermissionGranted}` on every result.
- `[wake] dispatch: {kind, willDedupe}` on every dispatchWakeCommand.
- `window.__lexWakeLog` ring buffer (last 20 lines) for post-hoc inspection.
- Optional debug badge gated on `NEXT_PUBLIC_LEX_DEBUG_VOICE=1`.

After telemetry lands, ask user to reproduce while DevTools is open (or just read `window.__lexWakeLog` after the fact). Then we can pin the exact failure mode and ship a targeted fix.

## Related
- a3053ad (voice pill state-machine audit) — landed last night, supposedly decoupled wake-word from foreground mute. This bug surfaces despite that fix, so the decoupling is incomplete or the recognizer dies for a different reason.
- b0820a4 (AEC + always-on wake-word path) — original feature commit. Same author of the restart loop logic.
