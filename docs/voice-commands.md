# Voice commands

Rewritten 2026-09-23 for the Layer 1 contract v3 (`docs/spec/LAYER-1-CONTROL.md`).
The voice understands what you mean; there is no fixed phrase list any
more. Layer 1 (the voice) reads every utterance, decides whether it is
speech for the brain, a control, or background noise, and answers in
its own words. One phrase is mechanical and never needs the model.

## The one mechanical phrase

- **"Lex, emergency stop"** (`matchPanicCommand`): stops the sound, drops
  the reply, mutes. Deterministic, before any model sees the words. The
  dashboard's global panic button (`Ctrl+Alt+.`, double Escape) does the
  same from the keyboard.

## Controls the voice interprets (say them however you like)

Layer 1 maps your words to one of these verbs and appends a
`CONTROL: <verb>` line to its reply; the daemon acts on the verb.

| You want | Verb | What happens |
|---|---|---|
| Stop listening | `mute` | Mic stays open but nothing is transcribed until you unmute |
| Listen again | `unmute` | |
| Wait, do not act | `standby` | Everything heard is parked, nothing forwarded |
| Go ahead | `listen` | Leaves standby |
| Stop talking | `stop_speaking` | Cuts the sound; the reply text survives on screen |
| Turn the voice off for now | `disable` | |
| End the session | `end_session` | Runs the session-end pipeline (handover, distillation) |
| Stop what the brain is doing | `interrupt_work` | |
| Never mind that, do this instead | `cancel_redirect` | Drops the in-flight brain turn and forwards the new one |
| Drop that reply | `drop_reply` | |
| Add this to what I said | `combine` | Merges the interruption into the previous utterance |
| Say that again | `repeat` / `start_over` | Re-speaks the last spoken text |
| Slower / faster | `slower` / `faster` | Steps the speech rate (x1.25 / x0.8, clamped) |
| Louder / quieter | `louder` / `softer` | Steps the output gain (0.2 to 1.0) |
| Yes, do the plan | `approve_plan` | Presses Enter on the brain's ExitPlanMode prompt |
| No, change the plan | `reject_plan <reason>` | Escape plus your reason as the next prompt |
| Yes, send that to the worker | `confirm_dispatch` | Releases a dispatch the confirm gate parked |
| No, do not send that | `reject_dispatch <reason>` | |
| Yes, that handover is good | `approve_handover` | The worker clears and boots on the vetted handover |
| No, fix the handover | `reject_handover <reason>` | Goes back to the brain with your reason |
| Finish what you were saying | `finish` | After a barge: resumes the cut sentence |
| Answer me, then finish | `answer_then_finish` | After a barge: answers first, then resumes |

Everything else is a conversation: Layer 1 answers from the `[live]`
block when it can (brain state, worker phase, last said, pending plan,
dispatch or handover, the recent talk) and forwards the rest to the
brain with a short spoken ack. Background talk gets `IGNORE:` and a
greyed "(not for Lex)" line in the transcript.

## Barge (talking over the voice)

The sound stops at once when you start speaking. Then: echo, noise and a
backchannel ("mm-hm", "right") resume the sentence without the model;
real words go to Layer 1 with the cut point, and it decides `finish`,
`answer_then_finish`, or rethinks the reply. Unsigned means rethink.

## Modes

Conversation (default), notes (silent, auto-summarises on stop),
push-to-talk. Mode switches are dashboard controls, not voice commands.

## Where the words live

- Contract text: `07-daemon/src/voice/voice-top-layer.ts` (`CONTRACT`, `TopLayerControl`).
- Verb handling: `07-daemon/src/voice/lex-voice-ws.ts` (`applyTopLayerControl`).
- The mechanical phrase: `07-daemon/src/voice/lex-voice-commands.ts`.
