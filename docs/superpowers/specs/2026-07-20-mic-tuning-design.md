# Mic tuning + sensitivity rescale — design

**Date:** 2026-07-20
**Area:** `08-dashboard/components/VoiceSettingsPanel.tsx`, `08-dashboard/lib/voice-vad-options.ts`, `08-dashboard/components/VoiceClient.tsx`, `07-daemon/src/dashboard/routes.ts`
**Approved:** operator, 2026-07-20 (mock + two decisions: probability+threshold meter; remove the cooldown).

## Problem

The voice settings panel has three issues the operator hit while tuning in a loud room:

1. **No way to see what the mic is picking up.** You adjust the sensitivity slider blind, toggle voice on/off, and guess.
2. **The mic-sensitivity scale is too weak.** `vadThresholds(s)` maps the 0-100 knob linearly to silero's speech-probability threshold `0.7 - 0.4*s`, so the WHOLE knob only spans 0.30-0.70. At the operator's "5" the threshold is 0.68 - silero clears that on almost any sound. Low values are not meaningfully deaf.
3. **The barge-in cooldown slider is dead.** `bargeCooldownRef.current` is assigned but read nowhere; `onSpeechStart` emits `vad-onset` with no cooldown gate (`VoiceClient.tsx` comment: "The barge cooldown knob is gone with the raw-VAD trigger it papered over"). It stores/persists/POSTs a value that does nothing, and after the 2026-07-20 barge baseline (VAD-onset fires the stop) a cooldown would fight the intended behavior.

## Design

### 1. Rescale mic sensitivity (`voice-vad-options.ts`)

Replace the linear `vadThresholds`:

```
positive = 0.97 - 0.67 * s^0.8      // s = sensitivity 0..1
negative = positive - 0.1
```

- knob 0 -> 0.97 (near deaf), knob 5 -> ~0.91, knob 18 -> ~0.80, knob 50 -> ~0.585, knob 100 -> 0.30.
- The `^0.8` curve gives the useful band (0.4-0.7) more travel in the upper-middle of the knob, and pushes the low end near-deaf so "5 barely works" as the operator expects.
- Stored value stays 0-1; display stays `round(s*100)`. Negative-threshold delta unchanged (0.1).
- Update `tests/` pins for `vadThresholds`.

### 2. "Tune mic" live meter — new `MicTuner` component

A self-contained component rendered in the Voice panel between the sensitivity slider and the (removed) cooldown spot.

- **Button** toggles the tuner. Start -> `getUserMedia({audio})` + a `MicVAD` instance built from `buildVadOptionSet(currentSensitivity, redemption)`. Its own stream, independent of any running voice session (browsers allow concurrent captures); Stop tears down VAD + stream + AudioContext.
- **Meter:** one horizontal bar = live silero `isSpeech` probability (0-1), read from the VAD's `onFrameProcessed({isSpeech})` - the SAME signal that actually fires a turn. A vertical **threshold line** at `vadThresholds(sensitivity).positive`. Because it reads the live slider, dragging sensitivity moves the line in real time.
- **Trigger indicator:** a dot + text that flips to "TRIGGER" whenever probability >= threshold. This is the "sensitivity test": speak, watch it cross; stay quiet, watch background sit left of the line.
- **Operator flow:** keep quiet -> background should stay left of the line (if not, lower sensitivity); talk -> voice should cross it. One control tunes both the background-noise floor and the trigger test.
- Reduced-motion + cleanup on unmount (stop tracks, close context) so a left-open tuner never holds the mic.

### 3. Remove the dead barge-cooldown

- `VoiceSettingsPanel.tsx`: delete the slider, `bargeCooldownMs` state, `BARGE_*` consts, storage key, hydrate block, `changeBargeCooldown`, the POST.
- `VoiceClient.tsx`: delete the dead `bargeCooldownMs`/`bargeCooldownRef` state, its hydrate + `barge_cooldown_ms` subscribe case (it is never read).
- `voice-settings-bus.ts`: drop the `"barge_cooldown_ms"` key from the union.
- `07-daemon/src/dashboard/routes.ts`: remove the `POST /voice/set-barge-cooldown` route.
- Leave the persisted `barge_cooldown_ms` field in `piper.ts`/prefs alone (harmless, now unread) to avoid churning the prefs-file shape; it simply stops being written or read.

### 4. Help text rewrite

- **Mic input level (gain):** unchanged behavior; keep concise.
- **Mic sensitivity:** describe the new scale ("low is nearly deaf; 20-35 for a loud room; 50+ picks up soft speech and more ambient") and point at the tuner.

## Testing

- `vadThresholds` rescale: unit pins at knob 0/5/50/100 for the new curve (monotonic decreasing, bounded 0.30-0.97, negative = positive-0.1).
- `MicTuner` is a browser-only React component (getUserMedia/AudioContext); no unit harness in the dashboard. Verified by build + live use.
- Full daemon voice suite stays green (only the route removal touches the daemon; no test references `/voice/set-barge-cooldown`).

## Out of scope

- No change to `mic_gain` behavior or range.
- No new dependency (reuses `@ricky0123/vad-web`, already installed).
- No auto-set of sensitivity from the meter; the operator tunes by eye (can add later).
