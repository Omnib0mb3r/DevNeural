# Enable-audio triggers browser permission prompt twice

**Reported:** 2026-05-14 (brainstorm session "DevNeural Testing")
**Severity:** medium
**Component:** voice client (audio enable / TTS unlock)

## Symptom

When the user clicks Enable Audio in the dashboard, the browser shows the microphone (or notification) permission prompt twice in a row. Expected behavior: one prompt, one grant, done.

## Reproduction

1. Cold-load the dashboard in a browser that has not previously granted audio permission for this origin (or after clearing the site permission).
2. Click the Enable Audio control on the voice pill.
3. Observe: browser shows the permission prompt, the user accepts.
4. Observe: a second permission prompt appears immediately after.

## Impact

- Confusing UX, looks broken.
- Users may deny the second prompt thinking the first one didn't register, leaving the voice client in a half-granted state.
- Risk of a race where one permission code path fires before the other has resolved.

## Suspected location

Voice client audio-init path in `08-dashboard/src/voice/` and/or `08-dashboard/components/VoiceClient.tsx`. Likely two separate `getUserMedia` (or `Notification.requestPermission` / TTS unlock) calls firing on the same enable click. Candidates:

- The mic-capture init and the TTS audio-element unlock both calling `getUserMedia` independently.
- The wake-word path (always-on listener) initializing in parallel with the foreground voice capture.
- A useEffect re-running on the same click and re-issuing the permission request.

Check the Enable Audio handler for multiple async permission requests and consolidate into a single gated call that resolves once and is shared.

## Status

Fixed (pending soak). Patched in the same VoiceClient audit commit as bug 2026-05-14-voice-pill-inconsistent-and-wake-word-muted.

## Root cause

Commit b0820a4 (AEC + always-on wake-word) added a Web Speech API recognizer that calls SpeechRecognition.start() on every enable cycle. Chromium routes that through a distinct mic permission path from plain getUserMedia. The wake-word useEffect fired in parallel with the parallel-capture rig's getUserMedia, so on the first Enable Audio click Chromium queued one prompt for the VAD's stream and a second for the recognizer; the user saw two prompts in a row.

## Fix

Sequence the two permission requests:

- New `micPermissionGranted` state flips true the moment initParallelCapture's getUserMedia resolves.
- Wake-word useEffect now depends on `[enabled, micPermissionGranted]` and early-returns until the foreground capture's permission lands. With the VAD's grant already in hand, Chromium reuses the permission for the recognizer call and surfaces a single prompt.
- The permission flag resets on every enabled->disabled cycle so a fresh start re-confirms the grant rather than trusting a stale flag.

## Verification

- `npm run typecheck` (08-dashboard) clean.
- VoicePillView + voice-wake-word unit tests: 23/23 green.
- Real-hardware soak: clear site permissions, click Enable Audio, confirm exactly one prompt.
