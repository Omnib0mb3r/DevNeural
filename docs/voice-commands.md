# Voice control

Rewritten 2026-07-15 for the spec-v2 voice top layer
(`docs/superpowers/specs/2026-07-15-voice-top-layer-design.md`). The
keyword grammar this file used to catalog is gone; this page now
documents the one surviving keyword and how everything else works.

## Talk naturally

There is no command vocabulary anymore. You talk to the voice top
layer (the dedicated persistent session in
`07-daemon/src/lex/voice-brain-session.ts`, driven by
`07-daemon/src/voice/voice-top-layer.ts`) the way you would talk to a
person. It answers conversational turns itself, hands substance to Lex
(the deep brain), and reads control intent from plain speech:

| You say (any phrasing)          | What happens                              |
|---------------------------------|-------------------------------------------|
| "be quiet" / "shut up"          | CONTROL stop_speaking or mute, model's read of your intent |
| "you can talk again"            | CONTROL unmute                             |
| "hold on, stop what you're doing" | CONTROL interrupt_work (old hold-up recap behavior) |
| "stop listening for a bit"      | CONTROL standby                            |
| "I'm back, listen"              | CONTROL listen                             |
| "turn voice off"                | CONTROL disable (one-way; recover via the dashboard start-voice button) |
| "we're done, end the session"   | CONTROL end_session                        |

The top layer errs toward NOT treating speech as a control; when it is
unsure, your words go to Lex instead. The dashboard buttons remain the
guaranteed path for every control.

## The one keyword: panic

Phrasing: `lex emergency stop`

The only mechanical phrase, matched by regex before any model runs, on
both paths:

- `07-daemon/src/voice/lex-voice-commands.ts` (`matchPanicCommand`,
  whisper transcript path)
- `08-dashboard/lib/voice-wake-word.ts` (Web Speech always-on path,
  works even while TTS is playing and the mic is gated)

Both matchers must stay in lockstep; if either changes phrasing, the
other follows in the same commit. The daemon's `wake-command` frame
accepts only `kind=panic` from the client.

## Failure behavior

If the voice-brain session is down or slow (timeout default 4s,
`DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS`), every utterance forwards to Lex
untouched. The top layer can never eat your words. Panic never depends
on any model.
