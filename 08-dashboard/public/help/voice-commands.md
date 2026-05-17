# Voice commands

Canonical reference for every wake-word DevNeural's voice loop
recognizes. Generated from the matcher source at:

- `07-daemon/src/voice/lex-voice-commands.ts` (daemon-side, whisper
  transcript path).
- `08-dashboard/lib/voice-wake-word.ts` (client-side, Web Speech
  always-on path).

Both matchers agree on phrasing and precedence by design; if either
loosens or tightens, the other must follow in the same commit.

## Semantic axes

The voice state machine has three independent axes:

| Axis           | Commands           | Effect                              |
|----------------|--------------------|-------------------------------------|
| TTS playback   | `mute` / `unmute`  | Halt or resume Lex's spoken reply.  |
| STT capture    | `standby` / `listen` | Pause or rearm microphone capture. |
| Session life   | `disable`, `end_session`, `panic` | Terminal commands (see below). |

The axes do not interact. Muting TTS does not affect the mic; putting
the mic on standby does not affect TTS. The wake-word recognizer runs
on its own Web Speech stream and stays armed across mute and standby
so the operator can always rearm with a voice command. Disable is
the only command that tears down the recognizers; once it fires the
only recovery is clicking `start voice` in the dashboard.

## Command catalog

Every command requires the literal prefix `lex `. The matcher
normalizes input (lowercase, strip punctuation, collapse whitespace)
before matching, so casing and punctuation do not affect recognition.

### panic

Phrasings: `lex emergency stop`

Effect: fires the panic pipeline (`firePanic`). Halts the worker
session, lands a panic-log audit row, and surfaces the event on the
dashboard. Pre-empts every other command.

Inverse: none. Panic is terminal.

### end_session

Phrasings: `lex end session`

Effect: ends the current Lex brainstorm session. Runs the session-end
pipeline (force-ingest, summary, RAG embed). The brainstorm row
archives; the dashboard panel flips off.

Inverse: none. Start a new session from the dashboard to resume.

### mute

Phrasings: `lex mute`, `lex shut up`, `lex be quiet`, `lex stop talking`

Effect: soft mute. Cancels in-flight TTS playback, drops queued
audio chunks, and flips `softMutedRef` so future tts-start frames
do not play audibly. Mic capture is NOT touched: the user can keep
talking and the wake-word recognizer can still hear the unmute
command.

Inverse: `unmute` family below.

State transition: `softMuted=false -> true`. Logged to the voice ring
buffer with kind=`mute`.

### unmute

Phrasings: `lex unmute`, `lex resume`, `lex come back`, `lex you can
talk`, `lex start talking again`

Effect: lifts the soft mute. Future TTS plays normally. Messages
received during the mute window are NOT auto-replayed (they were
already rendered as silent in the transcript surface).

Inverse: `mute` family above.

Disambiguation: `lex resume` is the unmute synonym (TTS axis). The
qualified `lex resume listening` is the STT-axis `listen` command.
The matcher uses a negative lookahead on UNMUTE_RE and evaluates
LISTEN before UNMUTE so the qualified phrase always wins.

State transition: `softMuted=true -> false`. Logged with kind=`unmute`.

### standby

Phrasings: `lex stand by`, `lex pause listening`, `lex hold on`

Effect: soft mic pause. Halts STT capture (`setMicMuted(true)`). TTS
state and the always-on wake-word recognizer are untouched, so the
operator can still rearm with `lex listen`. Use this when stepping
into a background conversation that should not be transcribed into
the brainstorm.

Inverse: `listen` family below.

State transition: `muted=false -> true`. Logged with kind=`standby`.

### listen

Phrasings: `lex listen`, `lex resume listening`, `lex i'm back`

Effect: rearms STT capture after a `standby` (`setMicMuted(false)`).
Wake recognizer is already on; TTS state is independent and is not
touched by this command.

Inverse: `standby` family above.

State transition: `muted=true -> false`. Logged with kind=`listen`.

### disable

Phrasings: `lex disable`

Effect: ONE-WAY teardown. Cancels in-flight TTS, drops the WebSocket,
shuts the mic + AudioContext down, clears the voice-enabled local
storage flag. Equivalent to clicking the dashboard's stop button.

Inverse: NONE. Once mic + WS are torn down, no voice path can rearm
them; the recognizers are gone. The only recovery is clicking
`start voice` in the dashboard.

Lex's thinking and worker actions continue running on the daemon
side; this command stops the VOICE surface only.

## Precedence

The matcher evaluates patterns in a fixed priority order so
overlapping phrasings resolve deterministically:

```
1. panic         (lex emergency stop)
2. end_session   (lex end session)
3. mute          (lex mute / shut up / be quiet / stop talking)
4. standby       (lex stand by / pause listening / hold on)
5. listen        (lex listen / resume listening / i'm back)
6. unmute        (lex unmute / resume / come back / ...)
7. disable       (lex disable)
```

Notes:
- `mute` before `disable` so `lex stop talking` lands on mute rather
  than tripping a substring of `lex stop`.
- `standby` and `listen` before `unmute` so the qualified
  `lex resume listening` lands on listen and bare `lex resume` lands
  on unmute.

## Observability

Every wake-word fire writes a row to the in-browser voice ring buffer
(`window.__lexVoiceLog`) with kind=`wake-fire`, the matched command
kind, and the pre-state / post-state of the relevant axis. Surfaces
through the `/system` Voice diagnostics panel. Use this when a
command appears to misfire instead of guessing at intent.

The daemon-side dispatch (`dispatchVoiceCommand` in
`07-daemon/src/voice/lex-voice-ws.ts`) also logs every fire with the
matched kind and the source (`transcript` for the whisper path,
`wake` for the always-on Web Speech path).
