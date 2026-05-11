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

Open. Not yet triaged for fix.
