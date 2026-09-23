# Voice command matcher blocked during TTS playback

**Date observed:** 2026-05-16 (~21:05 EDT, brainstorm anchor 4bbafb48)
**Severity:** medium
**Suspect commit:** b0820a4 (AEC + always-on wake-word during TTS) and/or 63ce9f4 (collapsed pill mute states)
**Related smoke item:** smoke 5 in `project_active_smoke_test_2026-05-14.md`

## Symptom

User spoke "Lex disable" successfully when Lex was silent: pill flipped
off (matcher fired, voice-disable frame delivered). Repeating the same
command while Lex was mid-TTS produced no effect: matcher did not fire,
pill kept playing audio through completion.

## Expected (per spec)

Commit b0820a4 promised AEC + an always-on wake-word audio path so
"Lex shut up" / "Lex disable" / "Lex emergency stop" can interrupt
Lex during TTS playback. That is the entire point of the wake-word
track: the user gets an interrupt channel that survives `micGated`.

## Hypothesis

1. `micGated` still gates the wake-word track in
   `08-dashboard/components/VoiceClient.tsx`. The AEC-enabled
   `getUserMedia` constraint may be in place but the gating logic
   still routes wake-word audio through the same mute switch as the
   primary mic.
2. 63ce9f4 collapsed the mic/speaker mute icons into shared state. If
   the wake-word path reads the mic-icon mute state, that decoupling
   was lost.
3. AEC `echoCancellation: true` is set on the getUserMedia constraint
   but the browser's actual AEC implementation may not be cancelling
   speaker output (laptop speakers, room reflection); wake-word
   matcher needs the residual to be loud enough above the speaker
   bleed.

## Where to look

- `08-dashboard/components/VoiceClient.tsx` — `micGated` flag, wake-word
  audio track creation, mute-state subscription.
- `07-daemon/src/voice/lex-voice-ws.ts` — frame ingestion during a
  TTS stream; confirm wake-word frames are still being accepted.
- `07-daemon/src/voice/wake-word.ts` (if it exists; otherwise the
  matcher in `panic-voice.ts` + `lex-voice-commands.ts`) — verify the
  matcher runs against the wake-word track and not just the primary.

## Repro

1. Open `/lex` brainstorm in voice mode, hard refresh.
2. Confirm `window.crossOriginIsolated === true`.
3. Speak a prompt that elicits a multi-second response.
4. While Lex is speaking, say "Lex disable" or "Lex shut up".
5. Observe: TTS continues to completion; pill stays on.

## Acceptance

Saying any of the Lex-prefixed mute / disable commands during a live
TTS stream halts the stream within ~250ms. Verified on the same
laptop-mic + speaker setup that just smoke-tested 393d4f5.
