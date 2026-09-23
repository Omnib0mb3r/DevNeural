# Push-to-talk mode does not release mic on key/button release

**Reported:** 2026-05-11 (brainstorm session "Dev brainstorm season")
**Severity:** medium
**Component:** voice client (push-to-talk mode)

## Symptom

In push-to-talk mode, after the user releases the PTT key/button, the microphone continues to capture audio. Expected behavior: release = stop listening immediately.

## Reproduction

1. Enter push-to-talk mode in voice client
2. Hold PTT, speak
3. Release PTT
4. Observe: mic icon stays active and audio continues to stream

## Impact

- Captures audio user did not intend to send (privacy concern)
- Pollutes brainstorm transcript with post-utterance noise
- Defeats the explicit boundary that PTT is supposed to enforce

## Suspected location

Voice client PTT handler in `08-dashboard/src/voice/` (likely the keyup / button-up event handler). Check for missing stop-recording call or async race between release and the audio capture loop.

## Status

Fixed (pending soak) — 2026-05-11, Wave 3 fixup sprint.

## Fixes shipped

- `08-dashboard/components/VoiceClient.tsx`: PTT mode now disables the
  mic tracks (`track.enabled = false`) at init and on every release;
  `__pttStart` re-enables them on press. The OS mic indicator goes
  dark between presses, the AudioContext processor stops receiving
  audio (its `pttCapturing` gate already discarded buffered frames,
  but the underlying media flow now stops at the browser layer),
  and the next press has zero re-grant latency because the stream +
  context stay alive.

## Verification

Manual:
1. Switch voice mode to "push-to-talk".
2. Press start voice (mic indicator turns on briefly while granting).
3. Observe: indicator goes dark immediately (init sets enabled=false).
4. Hold the talk button: indicator turns back on, audio captures.
5. Release: indicator goes dark again, no further frames reach the server.

`tsc --noEmit` clean on `08-dashboard`.
