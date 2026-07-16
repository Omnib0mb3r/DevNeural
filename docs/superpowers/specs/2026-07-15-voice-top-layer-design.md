# Voice top layer v2: native-voice-chat feel, speech-first brain, no command grammar

Date: 2026-07-15 (v2, supersedes v1 same day)
Status: approved by operator (phase 1 + phase 2 together; panic keyword survives; dashboard controls byte-identical)

## Research basis (deep-research 2026-07-15, 24/25 claims verified 3-0)

Native Claude voice mode is a cascaded streaming pipeline (streaming STT
-> Claude -> ElevenLabs streaming TTS), not speech-to-speech. The feel
comes from: overlapping all stages (sub-1s time-to-first-audio; ~400ms
STT + ~300ms LLM first sentence + ~200ms TTS start), sentence-boundary
incremental TTS (producer-consumer), semantic turn detection modulating
the VAD silence timeout (Smart Turn v3: 8MB ONNX, ~10-100ms CPU), and
barge-in gated on recognized speech with platform echo cancellation.
Refuted 0-3: token-streaming into a prosody-context TTS socket; sentence
buffering is the confirmed pattern.

Local feasibility (35-agent verified sweep):
- piper.ts synthesize() is one-shot per call (stdin closed immediately),
  fresh piper.exe per call, first PCM ~150ms, PCM streams to the browser
  as binary WS frames played chunk-by-chunk. Streaming EXISTS within a
  segment.
- Client cross-segment playback is broken: every tts-start resets the
  playhead without stopping the prior tail (VoiceClient.tsx:2224) - gap
  or overlap between segments, never gapless.
- Lex's jsonl has NO token deltas: complete content-block records only;
  the speak path gets a pre-tool ack + the whole end_turn body as one
  string. The only finer source is ANSI PTY scraping (rejected).
- renderReplyForSpeech's live-haiku restyle inserts a full LLM round
  trip before Lex's body reaches piper (verified latency dominator).
  It dies.
- judge-session.ts is a single shared ask queue; a voice turn would
  block judges. The voice brain gets its OWN dedicated persistent
  session (same spawnLex + jsonl-tail machinery, own session id).
  Per-record partial delivery is feasible via an onPartial hook.
- Endpointing today is fixed 768ms silence (vad-web redemption
  default); barge-in fires on first positive VAD frame (~96ms) with a
  250ms self-echo cooldown. Browser AEC may not cancel our hand-decoded
  PCM playback path (known edge case, matches AEC-residual history).

## Architecture (operator's three layers)

1. TOP - the voice you talk to: one DEDICATED persistent Claude session
   (voice-brain-session), speech-first. Its reply text IS what gets
   spoken, flowing to piper immediately. No JSON verdicts, no lanes, no
   whitelist, no keyword grammar. Machine-readable exceptions are
   trailing lines it emits as part of its natural turn (single brain +
   tools pattern):
     FORWARD: <what goes to the deep brain>
     CONTROL: <mute|unmute|standby|listen|disable|end_session|
               stop_speaking|interrupt_work>
   Lines are stripped from speech; FORWARD goes through the existing
   Lex inject path (snapshot, voice tag, absorbed-asides ring);
   CONTROL fires the existing dispatchVoiceCommand effects. While Lex's
   turn runs, the top layer keeps answering; follow-ups meant for Lex
   append to the existing pending-utterance flush. Fail-safe: session
   down/timeout/unparseable => FORWARD everything; an utterance is
   never eaten.
2. MID - Lex the thinker: brainstorm machinery, inject path, jsonl tail
   all untouched. Her body text speaks immediately (restyle removed),
   sentence-serialized through the fixed gapless client.
3. BOTTOM - workers: only Lex touches them.

The ONE mechanical exception: "lex emergency stop" panic regex, checked
before anything else, plus the client wake path shrunk to panic only.

## Phase 1 scope

- Teardown: matchVoiceCommand grammar (all but panic), voice-lane-router,
  voice-control-channel, voice-whitelist, voice-frontdesk,
  voice-haiku-glue metered remnants, digest-FRESHNESS gating (digest
  itself stays as grounding), canned glue/bridge lines, and their tests.
- voice-brain-session.ts: dedicated persistent session (spawn, respawn,
  cooldown, askVoice with timeout; onPartial hook for phase 2).
- voice-top-layer.ts: speech-first contract + FORWARD/CONTROL trailing-
  line parser + persona/digest grounding + never-twice ring; fail-safe
  forward.
- lex-voice-ws.ts rewiring: panic-only matcher; top-layer call replaces
  the haiku block; mid-turn utterances go to the top layer instead of
  silent queueing; live restyle removed from the body speak path;
  continuation-aware tts-start frames.
- Client: continuation tts-start joins the existing playhead (gapless
  across segments; generation/cancel semantics preserved); VAD
  redemption default 768 -> 450ms (slider range and behavior unchanged).
- Dashboard controls: byte-identical surface. Buttons, frames, sliders,
  Bluetooth picker, speed control untouched.

## Phase 2 scope (same wave, approved)

- Semantic endpointing: Smart Turn v3 ONNX daemon-side on the buffered
  utterance PCM at VAD pause time; modulates end-of-turn instead of a
  fixed timeout. runtime_config kill switch, default on.
- Echo-reference playback: route TTS through a playback path the
  browser AEC treats as far-end IF compatible with the Bluetooth sink
  picker; if incompatible, flagged to the operator, never silently
  dropped.
- Voice-brain streaming partials: speak per assistant record as it
  lands; records beginning with FORWARD:/CONTROL: are held, never
  spoken.

## Testing

- Unit: FORWARD/CONTROL parser (incl. multi-line, malformed => forward),
  panic matcher, continuation frame scheduling, redemption default,
  session lifecycle (respawn/cooldown), smart-turn gate.
- Full daemon + dashboard suites green (pre-existing grooming failure
  excepted).
- Live: restart daemon (sub-10s since 4c8498a); small talk answered by
  top layer with no Lex turn; substance forwarded with natural handoff
  speech; "be quiet" interpreted as CONTROL while TTS active; panic
  phrase fires mechanically; ack+body plays gaplessly; dashboard
  buttons/BT/speed unchanged.
