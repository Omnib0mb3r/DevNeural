# Voice top layer: native-voice-chat conversation, no command grammar

Date: 2026-07-15
Status: approved by operator (panic keyword survives; all other controls interpreted)

## Problem

The voice path between the microphone and Lex accreted an isolated
command layer: a "lex"-prefixed keyword grammar (panic, mute, unmute,
standby, listen, disable, hold-up, start-project), then a haiku "front
desk" that triages every utterance into control / fast / slow lanes
via a control-channel classifier, a deny-by-default whitelist matcher,
a digest-freshness gate, canned glue replies, and canned bridge lines.
The operator does not want to memorize commands or fight lane
misroutes. Target model: Anthropic native voice chat.

## Architecture (three layers, operator-specified)

1. Top layer (the one the operator talks to): a single persistent
   conversational voice session. Hears every final transcript
   verbatim. No keyword grammar, no lanes, no whitelist, no canned
   lines. It answers naturally when the turn is conversational, and
   hands substance to Lex.
2. Layer two: Lex the thinker. Substance reaches Lex verbatim through
   the existing inject path (cc-pty ptyInject with voice tag +
   snapshot, or the direct-llm brainstorm branch). Lex replies flow
   back through the existing jsonl tail and are spoken. Brainstorm
   functions and all Lex logic are untouched.
3. Layer three: workers. Only Lex controls them. Voice never touches
   workers directly.

## The one exception: panic

"lex emergency stop" stays a mechanical regex checked before anything
else (operator decision: emergency kill must not depend on a model).
Everything else that used to be a keyword (mute, unmute, standby,
listen, disable, end session, hold up) becomes interpreted intent: the
top-layer session returns a control verdict and the existing effects
fire. Dashboard buttons remain the guaranteed path.

## Verdict contract (top-layer session output)

For each utterance the session returns strict JSON:

- `{ "action": "reply", "speech": string }` - conversational turn;
  speak it, persist it as an absorbed aside (existing capture).
- `{ "action": "forward", "speech": string | null }` - substance for
  Lex; optionally speak the short handoff line, then run the existing
  inject path with the operator's words verbatim.
- `{ "action": "control", "control": "mute" | "unmute" | "standby" |
  "listen" | "disable" | "end_session" | "stop_speaking" |
  "interrupt_work", "speech": string | null }` - fire the existing
  control effect (client frames / killActiveTts / hold-up recap),
  optionally speak the ack.

Failure mode: session unavailable, timeout, or unparseable output =>
forward to Lex. An utterance is never dropped by the top layer.

Grounding: the session prompt keeps the existing persona and the live
digest (voice-digest pushDigest survives as context; its freshness
GATING role dies). Barge-in stays mechanical at the VAD layer.

## Dies

- Keyword grammar for everything except panic (lex-voice-commands.ts
  shrinks to the panic matcher; dispatchVoiceCommand stays for
  effects).
- voice-lane-router.ts, voice-control-channel.ts, voice-whitelist.ts,
  voice-frontdesk.ts (triage stack) and their tests.
- voice-haiku-glue.ts (already-dead metered glue) and its tests.
- Canned bridge/glue composition in voice-haiku-wiring.ts (replaced by
  the verdict function).
- Digest freshness gating.

## Stays untouched

Mic/VAD/push-to-talk, whisper STT, noise floor, audio-bundle persist,
notes/meeting name gate and capture, wake-during-TTS suppression,
direct-llm brainstorm branch, cc-pty inject (voice tag + snapshot),
jsonl tail to TTS, TTS queue + mouth lock + sanitizer + renderer,
Bluetooth routing, speed control, heartbeat pulse, panic plumbing
(panic-voice.ts), all brainstorm/Lex logic.

## Testing

- Unit: verdict parser (strict JSON, malformed => forward), panic
  matcher still fires, control verdict mapping to effects.
- Existing tests for deleted modules are deleted; wiring tests updated
  to the new single path.
- Live: daemon restart, speak small talk (expect top-layer reply, no
  Lex turn), speak substance (expect forward + Lex reply spoken),
  speak "be quiet" mid-TTS (expect interpreted mute), speak "lex
  emergency stop" (expect panic frame).
