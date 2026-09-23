# 2026-05-22 TTS does not stop when user speaks (barge-in regression)

**Status:** open

## Symptom

User starts speaking while Lex TTS is playing. Lex does not stop. STT picks up tail of Lex's audio plus the user's first words, fires a partial utterance, Lex responds to half a sentence. User has to repeat the second half. Pattern repeated multiple times in 2026-05-22 brainstorm session.

## What we know

- Wave 2 voice work + the 03:40 inject earlier today (`Two urgent bugs`, BUG 2) was supposed to deliver Alexa-style barge-in: VAD-detected user voice cuts Lex's TTS within ~200ms.
- Current behavior: Lex audio keeps playing through user speech.
- No "mic gated" state expected anywhere in the pipeline.

## Action

Find where barge-in regressed since the BUG 2 spec landed. Likely culprits: VAD client not wired to TTS playback channel, TTS player ignoring stop signal, STT swallowing both streams instead of muting on TTS-playing.

Acceptance: user mid-Lex-utterance interruption stops TTS inside 200ms, user's full new utterance arrives intact, Lex's old response is dropped not queued.

## Root cause (diagnosis, 2026-05-22)

Regression introduced by commit `c2335c5` (2026-05-19 dashboard-side voice-output watchdog with self-heal + telemetry). The watchdog added two new refs in the TTS-start handler at `08-dashboard/components/VoiceClient.tsx:1944-1972`:

- `ttsActiveRef.current = true` (:1952)
- `lastBufferProgressTsMsRef.current = Date.now()` (:1953)

These are read on the 10s watchdog poll loop and used by `08-dashboard/lib/voice-watchdog.ts` to decide whether to fire heal steps (cf. heal sequence at `VoiceClient.tsx:1194-1297`, including `resetVoiceAudio` at :1217 which closes and recreates the AudioContext).

The barge-in path lives in `resetTtsPlayback` (`VoiceClient.tsx:862-888`), invoked from the VAD `onSpeechStart` handler at :2203-2230 when the user speaks mid-TTS. `resetTtsPlayback` bumps `ttsGenRef`, stops active source nodes, clears `activeSourcesRef`, flips `speakingRef=false`, drops `micGatedRef` and `streamFinishedRef`. It does NOT clear `ttsActiveRef`. The watchdog wire-up shipped without a matching teardown on the barge-in path.

Consequence: when the user barges in, source nodes are stopped, BUT `ttsActiveRef` stays `true` while `activeSourcesRef` is now empty and `lastBufferProgressTsMsRef` is stale (no new frames coming for the cancelled reply). The next watchdog tick sees `ttsActive=true && activeBufferCount=0 && timestamp stale`, classifies that as `buffer_stuck`/`frame_timeout`, and fires the heal sequence, including `resetVoiceAudio` mid-barge-in. That tears down the AudioContext while VAD is mid-utterance, races against incoming user PCM, mangles capture, and lets Lex's interrupted audio bleed through the now-inconsistent mic-gate state.

Net: barge-in IS firing in the VAD layer; the wire from VAD to TTS-stop exists at :2229. The regression is that the post-c2335c5 watchdog reads a stale `ttsActiveRef` after barge-in and tears down the audio path mid-utterance under the guise of self-heal. Fix shape (do not apply yet): clear `ttsActiveRef` and bump `lastBufferProgressTsMsRef` inside `resetTtsPlayback` so the watchdog sees barge-in as a clean transition, not a stuck-buffer failure. Anything that touches the watchdog itself instead of the barge-in teardown is a parallel system, not a fix.

## Recurrence 2026-05-26 (Barge-in cooldown not gating phone-audio bleed)

Reported live during smoke testing 2026-05-26 ~12:47 AM EDT (screenshot `596e2ce4-3962-4dea-8c09-015e5fafc963.jpeg`).

User settings at time of report:
- Mic input level: 0.40x (attenuated well below passthrough)
- Mic sensitivity: 5 (well below the "20-30 in noisy environments" guidance)
- Barge-in cooldown: 900 ms (over 3x the 250 ms default)

Symptom: user turns up phone playback volume while Lex is speaking. Lex's own TTS bleeds into the mic, triggers VAD, Lex stops talking mid-stream and switches to listening. With a 900 ms cooldown the self-echo guard should be ignoring mic-driven interrupts for nearly a second after Lex starts speaking. It is not.

Implication: the 900 ms barge-in cooldown slider is either not being read by the gate, or the gate is sampling at the wrong layer (raw mic, before the cooldown window is applied). Pair this with the existing Fix 25 thread (mic input + sensitivity sliders not applying) reported on the same screenshot: at 0.40x mic input and sensitivity 5 the mic should be nearly mute, yet pickup is unchanged. Suggests the slider DOM values are not propagating to the silero VAD or the GainNode, OR the values are being applied after a stale capture path that bypasses both. The watchdog path described above is the likely confound — if barge-in fires under self-echo, the watchdog tears down and recreates the audio path with default values regardless of slider state.

Action: extend the fix-shape to also clear `selfEchoCooldownActiveRef` (or equivalent) and verify the barge-in cooldown slider value is read fresh on every VAD `onSpeechStart` (do not cache at TTS-start). Verify mic-input and mic-sensitivity sliders are wired upstream of silero (memory-locked Fix 25 root cause), not downstream where silero has already decided.
