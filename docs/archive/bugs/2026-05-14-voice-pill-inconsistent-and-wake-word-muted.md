# Voice client / pill behavior inconsistent, wake-word path shows muted

**Reported:** 2026-05-14 (brainstorm session "DevNeural Testing")
**Severity:** medium
**Component:** voice client (VoiceClient.tsx) + voice pill UI

## Symptoms

Two related issues, both pointing at the voice-client state machine:

1. **Inconsistent start/stop.** User sometimes has to click start and stop multiple times before the listener actually engages or releases. Behavior is non-deterministic from the user's perspective. The single-click contract is broken.
2. **Wake-word / secondary audio path appears muted.** The always-on wake-word listener path (commit b0820a4) is supposed to stay active and independent of the foreground mic mute so Lex voice commands work even while Lex is mid-TTS. Pill UI currently shows muted state for the secondary path, and Lex commands during TTS do not register.

## Reproduction

1. Open dashboard, enable audio.
2. Click start on the voice pill. Sometimes mic engages on first click, sometimes requires two or three click cycles.
3. Click stop. Sometimes listener releases, sometimes still capturing.
4. While Lex is speaking a reply, attempt a Lex command (e.g. "Lex shut up"). Observe: command does not register; pill icon for the wake-word/secondary path shows muted.

## Impact

- Breaks the hands-busy contract: user cannot reliably control Lex via voice.
- The whole point of AEC + always-on wake-word (b0820a4) was to keep the Lex command path open during TTS. If the pill is reporting muted there, either the UI state is wrong or the underlying secondary mic track really is disabled.
- Compounds with the no-TTS-on-first-prompt bug already logged: when TTS does not even play, the AEC fix cannot help and the wake-word channel still must work for commands typed via PTT to feel coherent.

## Suspected location

`08-dashboard/components/VoiceClient.tsx` and the voice pill component:

- Audit the mute state machine. Symmetric mic + speaker icons (commit 63ce9f4) probably collapsed two independent mute states into one, so toggling mic mute also gates the wake-word path.
- The wake-word track should have its own enabled flag and its own mute icon state, fully decoupled from the foreground mic mute.
- Start/stop logic: confirm there is exactly one source of truth for listener state. Look for races between React state and the underlying MediaStreamTrack.enabled / AudioContext suspend-resume calls. Multi-click symptoms usually mean the click handler short-circuits when state is mid-transition.
- Check whether the start handler is idempotent. If a second click during async init throws or no-ops silently, the UI will look broken.
- Inspect every event path that flips mute state: keyboard, pill click, voice command. Confirm they all funnel through one reducer/setter, not parallel writes.

## Status

Fixed (pending soak). Audit pass landed alongside bug 2026-05-14-enable-audio-double-permission-prompt in a single commit.

## State machine after audit

Source of truth, all live on VoiceClient.tsx top-level state or refs. One owner per flag, mirrored ref for non-React handlers:

| State | Source | Where it flips | What it gates |
|---|---|---|---|
| `enabled` | `useState` | `toggleEnabled` + `voice-disable` / `lex disable` / `session-end` | The WS connect effect (`[enabled, sessionId, mode]`). Drives every downstream tear-up / tear-down. |
| `muted` | `useState` + `mutedRef` | `setMicMuted` (pill mic tap, `lex mute` voice cmd, Ctrl+Alt+M hotkey route to setSoftMuted not setMicMuted) | Disables MediaStreamTrack.enabled on the parallel capture rig; sets aria-pressed on the mic icon; flips icon to MicOff. Does NOT gate the wake-word recognizer. |
| `softMuted` | `useState` + `softMutedRef` | `setSoftMuted` (pill speaker tap, `lex mute / unmute` voice cmds, `voice-mute / voice-unmute` WS frames) | Cancels in-flight TTS via resetTtsPlayback; gates the binary PCM scheduler so chunks are dropped; tags assistant turns silent=true; surfaces unread badge. |
| `micGated` | `useState` + `micGatedRef` | tts-start sets true, tts-end + finalizePlaybackEnd clear, resetTtsPlayback also clears | Hard-pauses silero VAD + drops parallel-capture frames so TTS doesn't bleed back through whisper. Does NOT mute the wake-word recognizer (which uses its own stream). |
| `wakeWordActive` | `useState` | Wake-word useEffect: true after `recognizer.start()`, false on teardown | Pill renders the small "wake" dot indicator. Read-only; purely visibility. |
| `micPermissionGranted` | `useState` | initParallelCapture sets true after getUserMedia resolves; enabled->disabled effect clears | Gates the wake-word useEffect so SpeechRecognition.start() does not race the VAD's getUserMedia for the permission prompt. |

## Root cause

Two independent regressions both surfacing as "voice pill state machine is wrong":

1. Commit 63ce9f4 (symmetric mic/speaker icons) collapsed the mic glyph onto `muted || micGated`, so during TTS playback the pill flipped to MicOff. The user read that as "wake-word path also muted" even though the always-on listener stayed live.
2. The toggleEnabled handler had no rapid-click guard. A second click landing during the async getUserMedia + MicVAD.new + WS connect window stacked a teardown onto an unfinished init, leaving the engine in a half-state that the user had to "mash through" with extra clicks.

## Fix

- `wakeWordActive` is now an independent boolean threaded through VoiceCtx + VoicePillView. The pill renders a small dot indicator anchored to the mic button: solid `bg-ok` when the wake-word recognizer is alive, brand-soft + animate-pulse while Lex is speaking. Independent of `muted` / `micGated` / `softMuted`.
- Mic icon decouples: MicOff renders ONLY on explicit `muted`. micGated keeps the Mic glyph with a dimmed tone so the user reads "STT paused for self-echo, wake-word still listening".
- `toggleEnabled` gains a 400ms idempotency window driven by `enableBusyUntilRef`. Rapid second clicks during async init no-op until the engine reaches a stable state. Single intentional clicks stay responsive.
- `micPermissionGranted` sequencing makes Enable Audio one permission prompt instead of two (companion bug doc).

## Verification

- `npm run typecheck` (08-dashboard) clean.
- VoicePillView unit suite (11/11) covers the new wake-word indicator presence/absence + the Mic-not-MicOff branch when only micGated is true.
- voice-wake-word matcher tests (12/12) stay green.
- Real-hardware soak: drive Lex into TTS, say "Lex shut up" mid-reply, confirm the command fires and the wake-word indicator never blanks out.

## Related

- Commit b0820a4 introduced the AEC + always-on wake-word path.
- Commit 63ce9f4 introduced the symmetric mic/speaker mute icons in the pill.
- Bug doc 2026-05-14-no-tts-on-first-prompt-after-restart.md sits adjacent to this in the same VoiceClient.
- Bug doc 2026-05-14-enable-audio-double-permission-prompt.md is in the same audio init code path; the audit may fix both.
