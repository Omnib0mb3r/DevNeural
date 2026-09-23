# Voice commands

Rewritten 2026-09-23 for the Layer 1 contract v3 (`docs/spec/LAYER-1-CONTROL.md`)
and the worker effects (BUG-038). The voice understands what you mean;
there is no fixed phrase list. Layer 1 (the voice) reads every utterance,
decides whether it is speech for the brain, a control, or background
noise, and answers in its own words. Two tiers are mechanical and never
need the model.

## Mechanical, no model in the loop

- **"Lex, emergency stop"** (`matchPanicCommand`): stops the sound, drops
  the reply, double-ESCs the brain. The dashboard's global panic button
  (`Ctrl+Alt+.`, double Escape) does the same from the keyboard.
- **The stop class** (`classifyStopUtterance` in
  `07-daemon/src/voice/engine/interrupt-arbiter.ts`): an utterance that
  starts with shut up, be quiet, quiet, shush, stop talking or stop
  speaking cuts the sound; one that starts with stop, hold on, hold up,
  wait, cancel that, never mind, forget it, stand down, abort or hold
  everything also interrupts the brain's turn. This runs on your words
  before any model, as the safety floor. Any other phrasing of the same
  intent still works; it goes through the voice.

## Controls the voice interprets (say them however you like)

Layer 1 maps your words to one of these verbs and appends a
`CONTROL: <verb>` line to its reply; the daemon acts on the verb. A short
narrated verb with no line ("Muted.") is mapped by the parser too.

| You want | Verb | What happens |
|---|---|---|
| Stop listening | `mute` | Mic stays open but nothing is transcribed until you unmute |
| Listen again | `unmute` | |
| Wait, do not act | `standby` | Everything heard is parked, nothing forwarded |
| Go ahead | `listen` | Leaves standby |
| Stop talking | `stop_speaking` | Cuts the sound; the reply text survives on screen |
| Turn the voice off for now | `disable` | |
| End the session | `end_session` | Runs the session-end pipeline (handover, distillation) |
| Stop what the brain is doing | `interrupt_work` | Ctrl-C to the brain, a recap, mic open |
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
| Start the worker | `start_worker` | Starts Claude on the project this brainstorm supervises (the Start button's path) |
| Stop the worker | `stop_worker` | Releases the worker; its editor window stays open |
| Kill the worker, interrupt him | `panic_worker` | Double-ESC to the worker, not the brain |
| Switch to <project> | `switch_project <name>` | Opens that project's brainstorm and moves the call to it; the page follows |

After a worker or project verb the daemon hands the voice a factual
result (started, already running, released, interrupted, not reachable,
no such project and which ones exist, switched) and she says it in her
own words. The project name is matched loosely: "drop ship" finds
`dropship-01`.

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
- Verb handling: `07-daemon/src/voice/lex-voice-ws.ts` (`applyTopLayerControl`, `switchToBrainstorm`).
- Worker and project handlers: `07-daemon/src/dashboard/voice-layers-wire.ts` (`resolveProjectByName`).
- The mechanical tier: `07-daemon/src/voice/lex-voice-commands.ts` (panic) and `07-daemon/src/voice/engine/interrupt-arbiter.ts` (the stop class).
