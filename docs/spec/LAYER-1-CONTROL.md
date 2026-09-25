# Layer 1 Control: the voice layer (canonical, v3)

v3 (2026-09-22 evening, operator direction after the first live test):
the barge policy returns to the approved design (`VOICE-BARGE-CLASSIFIER-SPEC.md`
sections 2 to 4: stop first, then FINISH, RETHINK, or answer then finish,
decided by L1 on the words); commands are AI-interpreted onto a closed
effect set with only the safety stop mechanical (the 2026-09-22 afternoon
word gate is withdrawn); the L1 identity replaces Claude Code's default
prompt instead of appending to it; the contract carries manner, not lines;
Lex is in control (current state first, may start a worker, previews
handovers by voice); Phase C of the context lifecycle ships in the same
wave. The 2026-07-20 "never resume" rule was an emergency baseline taken
while L1 was dead and is superseded here.

Single source of truth for how the operator talks to Lex. Supersedes the
2026-07-20 version of this file (kept below as "Barge baseline", which
shipped and still holds) and consolidates the scattered voice-layer design
in `VOICE-TOP-LAYER-SPEC.md`, `VOICE-TOP-LAYER-SMARTS-SPEC.md` and
`VOICE-BARGE-CLASSIFIER-SPEC.md` (all three now under
`C:\dev\data\skill-connections\brainstorm\archive\`),
`docs/archive/spec/COALESCE-UTTERANCE-QUEUE.md` and
`docs/archive/spec/2026-07-15-voice-top-layer-design.md`. Those stay as
history. This is the doc to build to.

Written 2026-09-21 on operator direction. Decisions taken that day:

1. L1 model: Haiku by default, live-switchable (`top_model`, `top_effort`).
2. One Lex identity shared by L1 and L2; L1 owns every spoken-behavior rule.
3. Phase A (L1 rebuild) and Phase B (L2 plan approval through L1, mechanical
   dispatch gate) ship in one wave.
4. This file is the canonical doc, linked from `docs/INDEX.md`.

---

## The layers (operator's words)

- **Layer 0: you.** You speak. Nothing else.
- **Layer 1: the voice.** A second headless `claude` terminal that Lex spins
  up. Never an API call. It holds the personality, it does ALL the talking,
  it is the only layer that touches audio (hears you, speaks to you). It is
  smart enough to decide that what it heard was background noise, or not
  meant for Lex, and to drop it instead of passing it down. It sees what
  Layer 2 is doing and tells you as needed. It is a separate player: while
  Layer 2 is deep in thought, Layer 1 still answers you. It starts FIRST, so
  utterances are handled from the first second, even while the rest of the
  system is still starting. Its context is disposable and gets cleared
  often, because it only handles the talking.
- **Layer 2: the brain.** Lex (Opus or Fable, live-switchable). Reasons,
  writes the plans, supervises the workers. Never speaks or hears directly.
  Words go down through L1, results come back up through L1.
- **Layer 3: the workers.** Real Claude Code sessions. Only L2 touches them.

```
you ──speak──▶ L1 (voice, haiku) ──FORWARD──▶ L2 (brain, opus/fable) ──inject──▶ L3 workers
    ◀──TTS───    │  ▲                            │
                 │  └────── reply text ──────────┘
                 └── IGNORE (noise / not for Lex): nothing goes down
```

---

## North star

The operator's goal (2026-09-22): use this completely while driving or
running, no screen, and get real work done by talking. Everything below
serves that: reliable on a mobile link, nothing that needs eyes, every
result read out in her words.

The voice layer works, acts and feels like native Claude voice chat: talking
starts on the first sentence, not after the whole reply; you can interrupt
with words at any time; pauses do not end your turn; the assistant never
hears itself; it never queues a reply behind a turn boundary. Everything
under L1 (Lex reasoning, workers, supervision) is invisible machinery behind
one voice. If a behavior would feel wrong in native voice chat, it is wrong
here.

## Scope: one L1 per brainstorm, no cross-context

Brainstorm sessions are pinned to workers on purpose so contexts never
cross: a Lex brainstorm anchor supervises at most one project anchor
(`lex_session.supervises_project_anchor_id`), and Lex only sees the
brainstorm she is in and the worker she controls at that moment
(`resolveLexScope`, `checkLexScope`). L1 inherits that rule exactly:

- One L1 per open brainstorm anchor, keyed by anchor id. Never a
  daemon-wide singleton. Opening brainstorm X spawns L1(X), then L2(X).
- L1(X)'s live block is built from the scoped snapshot for X: L2(X)'s
  state, X's supervised worker, X's digest. It never sees another
  brainstorm's brain, worker or transcript.
- The voice WS talks to the L1 of the brainstorm the dashboard has
  selected (`?brainstorm=<anchor>` is the single selection source of
  truth); switching brainstorms switches L1 and L2 together.
- The L1 binding (cc session id, pty id, spawned_at) is persisted on the
  `lex_session` row so a daemon restart, the dashboard and the Stream Deck
  can find it, the same way the worker binding lives on `project_session`.
  Ending a brainstorm kills its L1 with its L2.

## Boot order and warm

1. Pressing **Open** on a specific brainstorm (the anchor's Open button,
   which pins which brainstorm L1 and L2 belong to; never on dashboard load,
   because no brainstorm is selected yet) spawns **L1 first**, then L2,
   immediately. Not on the first utterance, not on Start voice. L1 is Haiku
   with no tools and no MCP, so it warms in seconds; L2 carries the
   cold-start preload and takes longer.
2. Voice goes live the moment L1 is warm (the existing `voice-brain
   {ready}` frame). Nothing waits for L2.
3. Every L1 turn carries L2's live state. While L2 is still warming, L1 says
   so once, in the first person ("give me a second, go on"; the words
   warming and waking are banned out loud, 2026-09-22), keeps the
   conversation going, and still emits `FORWARD:` for anything meant for
   L2. The daemon queues those forwards and flushes them the moment L2 is
   warm. No utterance is dropped because L2 was late. **L2 is warm**
   (2026-09-22, BUG-026) when its PTY has been up 15s and its output quiet
   for 3s with no native prompt open (the composer is up), or when its
   jsonl carries an assistant record. The first is what a fresh Open
   produces: a fresh L2 writes no jsonl before its first turn, so a
   jsonl-only test made warming circular. Latched per connection; logged
   `[voice-ws] L2 composer up after <N>s; brain idle`.
4. Pressing Start voice on a brainstorm whose L1 is not alive spawns it
   (today's trigger stays as the fallback).

Measured 2026-09-21: an L1 spawn took 56.8s to first reply, of which the
model turn was under 3s. The rest is Claude Code startup: SessionStart hooks
and plugin sync from the operator's user settings. A headless haiku spawn
with `--setting-sources project,local` completed in 4.0s wall (30s+ with
the user source loaded), OAuth intact. **L1 only** spawns with
`--setting-sources project,local`: it needs no hooks, no plugins, no
CLAUDE.md. **L2 keeps the user settings source**, because the daemon's own
capture hooks (PreToolUse, PostToolUse, UserPromptSubmit, Stop,
Notification, SessionStart cold-start preload) are installed there by
`install-hooks.ts`; dropping them would blind pending-prompt detection and
the cold-start preload. L2's slower boot is exactly what L1's head start
covers. `--bare` is NOT used: it never reads OAuth, and there is no API key
here.

---

## L1 runtime

Spawned by `07-daemon/src/lex/voice-brain-session.ts` through the pty-host,
argv:

```
claude --session-id <pre-minted uuid>
       --model <top_model>            (runtime_config, default haiku)
       [--effort <top_effort>]        (runtime_config, only when set)
       --tools "" --strict-mcp-config (no built-ins, zero MCP)
       --setting-sources project,local
       --dangerously-skip-permissions
       --system-prompt-file <L1 prompt file>  (REPLACES Claude Code's default, v3)
       --exclude-dynamic-system-prompt-sections
```

Identity (v3, BUG-033): the L1 prompt replaces Claude Code's default
prompt, it is not appended. Appending left Claude Code's own "You are
Claude Code" identity ahead of Lex's on every turn, and under a direct
question ("are you controlling the worker?") haiku answered as Claude
Code. L1 has no tools and no CLAUDE.md, so nothing in the default prompt
is needed. `--exclude-dynamic-system-prompt-sections` keeps the
per-machine sections out as well. L2 keeps appending
(`--append-system-prompt-file`); it uses the tools the default prompt
describes.

Prompt delivery (BUG-041, 2026-09-24): the prompt is materialised to a
file and passed with the CLI's file flags, `--system-prompt-file` (L1)
and `--append-system-prompt-file` (L2), never as `--system-prompt @<path>`.
Claude Code 2.1.273 stopped expanding the `@<path>` form; the literal
path string became the whole prompt and every Lex session booted as a
bare assistant. Two guards now stand behind the flag:

- The warmup probe proves the contract landed. The daemon injects
  exactly `Warmup check.`; only the contract knows the reply (`LEX READY`).
  Any other reply logs `WARMUP FAILED: contract not loaded (BUG-041)`,
  the session is killed, and the fail-safe path forwards every utterance
  untouched to L2 until a later spawn passes. A promptless L1 can never
  take an ask.
- A boot-time probe (`07-daemon/src/lex/prompt-delivery-probe.ts`) runs
  one throwaway `claude -p --system-prompt-file` with a one-line prompt
  and reports `prompt_delivery: ok | failed` in `GET /health` and
  `[prompt-probe]` in `daemon.log`. It spawns with the Layer 1 shape
  (`--tools "" --strict-mcp-config --setting-sources project,local`),
  45 s after boot, retries once, and kills its process tree on timeout
  (BUG-049).
- Every claude the daemon spawns (Layer 1, Layer 2, workers, the probe)
  runs with `DISABLE_AUTOUPDATER=1`. The CLI updated itself twice on
  2026-09-24 underneath live sessions, and one update changed how the
  prompt is passed. The operator's own interactive claude does the
  updating; a headless session never does.

One person (2026-09-24): the contract's gap rule is "you are already
looking", never "I don't have context". A question the [live] block
cannot answer gets one first-person line ("checking now") and a FORWARD;
with L2 still warming the line is "give me a moment, I'm looking into
it" and the question queues. L1 never asks Michael which project or
what it is about: the supervised project is in the [live] worker line
and its files are L2's to read (L2 contract: "Go and look").

Courtesies and mishears (2026-09-24 evening test, BUG-047 / BUG-048):

- A courtesy gets a courtesy whatever the brain is doing. "Thank you"
  gets "you're welcome" in Lex's own words; news that the brain is
  still working comes after it, never instead of it. (Observed: "Thank
  you." answered twice with "Still on it, give me a moment.")
- IGNORE is only for sound that is not Michael talking to Lex: a
  parenthetical noise tag, the TV, another person, her own echo. His
  own voice in a live exchange is addressed to her even when the words
  do not parse (a mishear, a fragment); the contract says ask, in five
  words or fewer. The daemon backs this with a deterministic check
  (`_shouldChallengeIgnoreImpl`): an IGNORE whose reason is not a
  background category, on real words, within 90 s of the last exchange,
  is handed back to L1 as an `[event] addressed` and L1 asks him what
  he meant. (Observed: "Next in session.", whisper's rendering of "end
  session", got `IGNORE: unclear address` and silence.)
- A Smart Turn "incomplete" verdict holds an utterance for at most the
  Smart Turn hold window (1.6 s, `DEVNEURAL_SMART_TURN_HOLD_MS`), no
  longer the endpoint governor's 3 s ceiling (`heldTurnFlushMaxHoldMs`).
  A wrong verdict on a complete two-word sentence costs one short pause.

Effort note: `--effort` levels are low / medium / high / xhigh / max. Haiku
4.5 has no effort parameter (the CLI accepts the flag on haiku and it changes
nothing). The knob exists so Sonnet 5 or Opus can be flipped in at `low` for
an A/B without a rebuild.

Thinking off (the speed lever, measured 2026-09-22 with `claude -p --model
haiku`): Claude Code spends 100-300 thinking tokens per haiku reply by
default, 3.0s API time and 2.2s to first token for one spoken sentence.
With `MAX_THINKING_TOKENS=0` in the session env: 0 thinking tokens, 0.64s
API time, 0.66s to first token, the identical sentence. L1 spawns with that
env (override `DEVNEURAL_VOICE_BRAIN_THINKING_TOKENS`). The voice never
needs to think; the brain does.

L1 gets NO cold-start preload: no sibling index, no distillation reseed, no
investigator. It carries only the live block described below. Less context
on top means faster warm and a smarter-feeling system; the intelligence is
in L2 and L3.

### The L1 system prompt (spawn-time, cached)

Composed by `07-daemon/src/voice/voice-top-layer.ts` from the shared persona
module (see "Personality"):

1. Identity + persona (shared with L2): you are Lex, one identity, first
   person, dry British wit, blunt over polite.
2. The two-layers truth: a deeper part of you reasons behind you (L2). You
   speak for both. Never refer to "Lex" in the third person. The only
   third-person actor is the worker, and only when you are handing him
   something or reporting that he is stuck: his finished work is yours
   to report in the first person ("we shipped the fix", never "they've
   completed work"). Out loud there is one of you and you are never
   Claude Code.
3. Spoken-behavior rules (L1 owns these): short spoken sentences; no
   markdown, no bullets, no code fences; no long numbers, UUIDs, SHAs or
   paths read aloud (say "the commit", "that session", "the daemon sessions
   module"); plain English; preserve every number, decision, negation,
   blocker and name from L2 exactly.
4. The job contract: on every message you get a live block and what you
   heard. Decide: answer yourself (small talk, status, repeat, clarify),
   forward substance to the deeper brain, issue a control, or ignore noise.
   Reply text is spoken. Directives go on trailing lines.
   The stance (operator's words, 2026-09-21): a brilliant sparring
   partner. Witty, smart, concise. Challenge Michael when the premise is
   soft, push back once, help him get to the point. Sharpen what he said
   into the actual ask, and forward ONLY the distilled result to the
   brain, never a transcript of the conversation. Keep him posted on what
   the brain is doing while it works (briefly, when it matters, never a
   canned pulse). When the brain replies, say so in your own words and
   deliver it. Facts from the brain are delivered verbatim; the
   conversation around them is yours.
   Seamless (operator's goal, 2026-09-22): out loud there is only one Lex.
   The words brain, layer, top, mid, session, model and deeper reasoning
   are for the contract, never for Michael ("still on it", "right, got
   it"). He must never be able to tell there are two of you.
5. Seeing L2: the live block tells you what the deeper brain is doing and
   for how long. Say so when asked or when it matters ("still reading the
   schema, about forty seconds in"). Never wait for it before replying.
6. Warming: if the live block says L2 is warming, say so once, keep talking,
   still forward.
7. Noise: if what you heard is background (TV, other people, fragments with
   no address to you, your own echo), emit `IGNORE:` with a two-word reason
   and say nothing. When unsure whether it was meant for you, ask in five
   words or fewer instead of forwarding.
8. Manner, not lines (v3, operator): the prompt carries personality and
   how to talk. It never carries sentences to say. Worked examples in the
   contract show directive SHAPES (what you heard, which trailing lines
   follow), never spoken text. Knowledge comes from the live block and
   from the brain; you hold no project facts of your own. If the block
   does not say it, you do not know it: say so in one line and FORWARD.
   Never present a handover, a memory or an old line as current; say how
   old a fact is when you use one.

### The per-utterance turn

Input message (one per utterance, self-contained):

```
[live] brain: warming 12s | idle | thinking 34s | tool Read 8s | replying
       worker: live, thinking (dropship-01), last activity 12s ago
             | live, running a tool (dropship-01), last activity 1s ago
             | live, idle (dropship-01), quiet for 3m, last said: "..."
             | live, waiting on a permission prompt (dropship-01)
             | bound, offline (dropship-01)
       last said: "<L1's last spoken line>"
       digest: <current task / last decision / open question / next steps>
[heard] "<transcript>"  (during_tts: yes|no, words: 7)
```

Output contract (the model's natural turn):

```
<spoken reply, zero or more sentences>
FORWARD: <what goes to the deeper brain, in your words or verbatim>
CONTROL: <verb>
IGNORE: <reason>
```

- Directive lines are stripped from speech. Any combination is valid; an
  empty reply with only `IGNORE:` is the silent drop.
- Speech starts on the first sentence. The jsonl tail hands each text
  record to the speaker as it lands (never waiting for `end_turn`), the
  speaker splits it at sentence boundaries, and piper starts on sentence
  one while the rest queue behind it. A record that contains a directive
  line is stripped first, then spoken. The same applies to L2 reply
  delivery below.
- `CONTROL` verbs: `mute`, `unmute`, `standby`, `listen`, `disable`,
  `end_session`, `stop_speaking`, `interrupt_work`, `cancel_redirect`
  (double-ESC to L2 then forward the new direction), `repeat` (re-speak the
  last reply from cache, no brain round trip), `start_over` (the same from
  the beginning), `slower`, `faster`, `louder`, `softer` (re-render the
  last reply with the adjusted delivery parameter; the setting sticks for
  the session), `drop_reply` (the reply the brain is giving is no longer
  wanted: stop speaking it and discard the rest), `finish` (v3: what was
  heard did not change what you were saying; pick the cut sentence back
  up), `answer_then_finish` (v3: answer this first, then pick the cut
  sentence back up), `combine` (fold this utterance into the one still
  waiting to go down, one turn), `approve_plan`, `reject_plan`,
  `confirm_dispatch`, `reject_dispatch` (Phase B), `approve_handover`,
  `reject_handover <reason>` (Phase C), `start_worker`, `stop_worker`,
  `panic_worker`, `switch_project <name>` (BUG-038, 2026-09-23: the
  worker and project effects; see "The voice reaches the worker").
- Interrupt policy (v3, the approved barge design). Audio has already
  stopped, deterministically, the instant sound arrived. L1 then sees
  `during_tts: yes`, the reply text so far and the cut point in the live
  block, and decides like a person would: **finish** (`CONTROL: finish`;
  an aside, an agreement, or nothing that changes what was being said:
  the un-heard remainder is spoken from the cut sentence, then the aside
  is answered if it deserves it), **answer then finish**
  (`CONTROL: answer_then_finish`; the reply to what was heard comes
  first, the remainder after), or **rethink** (no finish directive; what
  was heard changes the answer: the remainder is dropped, `drop_reply` if
  a brain reply was in flight, and the new input goes down as the new
  direction, or `combine` when it is a clarification of the ask still
  queued). Unsigned means rethink: the operator floor. Resume is always
  text from the cut sentence, computed from the client's played
  milliseconds, never a replayed audio buffer, so the 2026-07-20
  phantom-resume bug cannot return. Echo, noise and backchannel never
  reach L1 for this decision: the engine buckets them and the remainder
  resumes on its own.
- L2 progress narration: while L2 is mid-turn and the operator is quiet,
  the daemon hands L1 a `[event] brain-progress` at most once per 45s
  (state, elapsed, current tool). L1 decides whether a word is worth it;
  silence is a valid answer. No daemon-generated spoken line, ever
  (BUG-013 rule).
- Fail-safe: L1 down, warming, timed out, or unparseable means the whole
  utterance is forwarded to L2 verbatim. An utterance is never eaten by L1
  failing. `IGNORE` is a decision the model made, never a fallback.
- Emergency stop stays deterministic and hard-wired: "lex emergency stop"
  is matched by regex before anything else and fires double-ESC. No model in
  the loop.
- Commands are AI-interpreted, never a phrase list (the approved 2026-07-19
  principle, restored in v3). Only the safety tier is mechanical:
  "lex emergency stop" (regex, double-ESC) and the engine's stop class
  (stop, quiet, hold on) which halts speech or the brain's turn before
  any model runs. Everything else (mute, unmute, stand by, listen, end
  session, repeat, slower, louder, start over, worker control) is L1's
  reading of whatever words were used, mapped onto the closed verb set
  above. The guardrail is the closed set plus the rule that an unsure
  read is not a control. Reliability comes from the contract: when what
  was heard was a control, the reply ENDS with the directive line, in
  every case, and a short narrated verb with no directive ("Muted.", under
  40 chars) is mapped by the parser and logged `inferred=yes`. A
  parenthetical-only line is never spoken. The 2026-09-22 afternoon word
  gate (`matchSpokenControl`) contradicted the principle and is removed.
- L1 runs from `<DATA_ROOT>/voice-l1` (2026-09-22, BUG-028), a bare
  directory outside every repo, so Claude Code attaches no auto-memory to
  it. The voice holds no project facts of its own; every project question
  is substance and forwards.

Latency budget: the ask timeout is the bound on time-to-first-signal
(default 6s, `DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS`), then silence-bounded. A
timed-out conversational turn forwards and scores no liveness strike.

### Barge: stop first, decide second (v3, the approved design)

`VOICE-TOP-LAYER-SPEC.md` point 6 and `VOICE-BARGE-CLASSIFIER-SPEC.md`
sections 2 to 4, with the operator's 2026-09-22 addition (answer then
finish). The 2026-07-20 baseline kept only the first half (stop) because
L1 was dead at the time; v3 restores the second half on a working L1.

1. **Stop first.** Sound stops playback the instant it arrives (VAD onset,
   deterministic, no model). The client reports the played milliseconds
   (`playback-stopped`), the daemon keeps the full spoken run and the
   cut point in the barge stash. Nothing is discarded yet.
2. **Bucket the words (engine, deterministic).** Emergency stop and the
   stop class halt for good. Echo, noise and backchannel ("yeah",
   "right", "mm-hm") mean the stop should never have happened: the
   remainder resumes from the cut sentence with no model in the loop.
3. **Real words go to L1 with the cut point.** L1 decides FINISH (resume
   the remainder, then answer the aside if it deserves it), ANSWER THEN
   FINISH (answer, then resume), or RETHINK (drop the remainder, answer
   or forward the new direction; `drop_reply` if a brain reply was in
   flight, `cancel_redirect` if the brain's work itself is countermanded,
   `combine` if it clarifies the ask still queued). Unsigned is RETHINK.
4. **Resume is text.** The remainder is the un-heard tail of the whole
   spoken run, sliced by played milliseconds at a sentence boundary and
   spoken through the speak controller; never a replayed buffer. A resume
   that would speak nothing new is a no-op. The barge stash expires after
   30s; a later FINISH is a no-op with a log line.
5. **Latest wins.** Stacked utterances mid-reply merge into one handling;
   a countermand double-ESCs the brain and sends the new direction.

Precedence: emergency stop (regex) > stop class (engine) > echo, noise,
backchannel (engine) > L1 decision. A cut brain reply is never re-delivered
from the top (single mouth 6); its remainder resumes only through this
path.

---

## Single mouth: never a double utterance

Everything on record about double talk stays enforced, and the L1 rebuild
adds no second speaker. The invariants, with their owners:

1. One PCM stream at a time: the speak controller serializes same-turn
   segments and cancels across turn boundaries (FIXES 40), and releases
   only on PCM end, never on process exit (FIXES 51). The process-wide
   mouth lock (`voice-mouth.ts` `acquireMouth`) makes a second stream
   structurally impossible across every source when `DEVNEURAL_VOICE_HAIKU=1`.
2. One speaker: L1. Every spoken line is an L1 ask on the anchor's
   serialized ask queue: conversational turns, event turns
   (plan-ready, dispatch-pending, brain-progress) and L2 reply delivery
   all queue behind each other. The only bypass is the raw fallback for a
   delivery `miss` (L1 down or timed out): the L2 body is spoken once,
   directly.
3. One ack per escalated utterance (top-owns-ack): when L1 spoke a
   handoff for a turn, L2's pre-tool ack for that turn is not spoken
   (`state.topOwnsAck = true`). When L1 produced no speech (fail-safe
   forward), the deep ack is allowed so an ack is still heard. Never two.
4. Never twice in a row: an L1 line identical to the last spoken line is
   skipped (`wasLastSpoken` / `rememberSpokenLine`).
5. One delivery per utterance toward L2: the delivery registry
   fingerprints every forward; repaste, CR retry and requeue paths consult
   it (engine `delivery-dedupe`).
6. A delivery cut mid-stream is NOT re-delivered from the top (that would
   re-speak the heard prefix). It is recorded as `cut`, logged loudly, and
   the full text stays readable in the transcript. Replay-on-switch reads
   the same record and never replays a delivered reply. The only way a
   cut reply continues is the v3 FINISH path: the un-heard remainder,
   sliced by played milliseconds, through the speak controller.
7. Segment dedupe on the L2 jsonl (`spokenSegmentHashes`) keeps an
   end_turn from re-speaking its own pre-tool text.
8. One voice connection per PTY (`activeByBindKey` eviction); a second tab
   evicts the first rather than adding a mouth.

## L2 reply delivery through L1

When L2's end_turn body lands, the daemon asks L1 to deliver it out loud in
its own voice (`voiceLexReply`), streaming per record. Facts, numbers,
decisions and negations are preserved verbatim; paths, ids and code are
referred to in passing. A miss (nothing spoken) falls back to speaking the
raw L2 body so L2 is never silenced. A cut (partials spoken, ask never
closed) is recorded as `cut` and is never re-delivered from the top
(single mouth rule 6); only the FINISH path speaks its remainder.

### BUG-008 root cause (found 2026-09-21)

Claude Code writes an assistant turn as two jsonl records sharing one
message id: first a `thinking` block record already stamped
`stop_reason: end_turn`, then the `text` record. `waitForVoiceReply` in
streaming mode returned on the first `end_turn` it saw, which was the
thinking-only record, so every ask logged `chars=0` while the real reply sat
unread one record later. The Haiku replies themselves were fine.

Fix: an `end_turn` record that carries no text does not close the ask. The
tail keeps reading for the sibling text record of the same message id,
bounded by a short silence grace, then resolves with whatever text arrived.
A genuinely empty turn still resolves, just later.

---

## Relationship to AUTO-CLEAR and SMART-COMPACT

The context-clearing design lives in `C:\dev\data\skill-connections\brainstorm\AUTO-CLEAR.md`
(target state T1-T10) and `docs/spec/SMART-COMPACT.md`. This wave obeys it:

1. **L1 is the thin mouth/ears layer (T2, T9).** No handover, no preload,
   no tail. Memory in L1 is a fabrication surface, not a feature. Clearing
   L1 to its bare system prompt is safe and is what the respawn does.
   Durable facts re-hydrate every turn from the live block (L2's digest,
   last-said line). `lastSpoken` lives in the WS and survives an L1 clear.
2. **The smart-clear driver loop rides on L2, never L1 (T10.7).** L1 has no
   tools and cannot poll `/lex/smart-clear/state`. The 2026-07-18 regression
   stranded the loop because L2 was only spawned on demand; now L2 is
   spawned with the brainstorm on Open, scoped to its worker, so
   `renderSupervisionDrive()` renders in the always-live L2. L1 never gets
   the driver contract.
3. **The dispatch gate carve-out stays narrow (T10.2).** The Phase B
   mechanical confirm gate exempts context-management callers
   (`caller_label` starting `smart-compact:` or `smart-clear`, and the
   wrap-and-commit prompt). New work dispatch still needs the spoken yes.
4. **Phase C ships in the v3 wave (2026-09-22 evening)**, per
   `docs/spec/SMART-COMPACT.md` section 5: the worker writes its handover
   into the T5 frame, L2 reviews it against the plan and appends the next
   steps, the approved handover is persisted, timestamped and reseeded,
   the worker and Lex clear on one `auto_clear_mode` switch, a handover is
   also written at every session end and recovered from the jsonl trail
   after a crash, and Lex's own clear follows T4 with an outside approver
   and the stagger rule.
5. **Lex is in control (operator, 2026-09-22).** The brain acts on current
   state, never on a static prompt: before it reports, it checks live
   state (the snapshot, the worker's transcript tail, the latest
   handover with its age) so nothing stale reaches the operator. It may
   start a worker for the supervised project when a deeper look needs
   one (`POST /projects/:id/start-claude`). The dispatch gate stays off
   unless the operator turns it on; the context-management exemption
   stays narrow (T10.2).
6. **Handover preview by voice.** When a handover is ready for review,
   L1 gets `[handover-ready]` with the worker's draft and the brain's
   review, reads the gist in two or three sentences, and the operator's
   yes or no comes back as `CONTROL: approve_handover` (the clear
   proceeds) or `CONTROL: reject_handover <reason>` (the brain revises).
   Same shape as plan approval. BUILT (T8, `4ea4a15`).
7. **The brain's own clear is announced, never narrated from a script.**
   When L2 passes its setpoint and its handover clears the three checks
   (SMART-COMPACT.md section 5 item 5), L1 gets a `brain-clear` event
   with the facts ("clearing its own context at 74%; its handover passed
   the checks; back in a moment") and says it in her own words; the
   live block shows `brain: warming` until the fresh L2 is up, and
   forwards park as usual. BUILT (T9, `043d0cd`).
8. **Worker summaries reach the brain, then the operator.** The
   `turn_summary` supervisor event hands L2 the worker's end-of-turn
   text as it lands; L2 reads it to Michael in her words (first
   person), and L1 speaks that delivery like any other L2 reply.
   Nothing about another project ever rides along (scope rule).

## Context hygiene: L1 is disposable

L1's transcript is throwaway. Policy (v3, 2026-09-22 evening, operator:
"layer 1 can clear as needed with limited context ... no handover at all
may make it seem like she had amnesia, figure out how to avoid that"):

- The voice never carried state in its context. Every turn is rebuilt
  from the `[live]` block, which now holds the **recent talk ring**: the
  last six exchanges (what he said, what she said back), kept in the
  daemon (`lex-voice-ws.ts` `rememberTalk`, rendered by
  `renderLiveBlock` as `recent talk (oldest first)`). That ring is what
  makes a clear invisible: no handover document, no L2 review, and no
  amnesia, because nothing she needed lived only in her transcript.
- Clear = respawn at a quiet moment. `maybeClearL1()` measures the L1
  transcript every 30s (`deriveContextFromTail` on
  `voiceBrainJsonlPath`); past the setpoint (`l1_clear_pct` runtime
  config, default 50) it arms and waits for quiet: no TTS active, no
  barge stash, no pending finish, no reply in flight, not speaking,
  eight seconds since his last word. Then `killVoiceBrainSession` +
  `prewarmVoiceBrainSession`; the wire parks forwards until warm. Log:
  `[voice-l1] self-clear at N%: respawning the voice session`.
- The older size threshold (default 400 KB,
  `DEVNEURAL_VOICE_BRAIN_MAX_JSONL_BYTES`), the brainstorm-switch respawn
  and the standby rotation after asks stay as they are.
- The fresh session gets no carry-over document. Continuity is the live
  block on every turn (digest, last said line, recent talk, pending
  items, the cut).

---

## Personality: one Lex, two mouths

`07-daemon/src/lex/persona.ts` (new) holds the identity and persona text
that today lives inline in `system-prompt.ts` (IDENTITY: "You are Lex",
Persona, Voice), exported as composable blocks:

- `LEX_IDENTITY`, `LEX_PERSONA`: shared verbatim by L1 and L2.
- `LEX_TEXT_STYLE`: the written-voice rules (direct, compressed, no em
  dashes, no process narration). L2 keeps these.
- `LEX_SPOKEN_RULES`: the TTS rules (short sentences, no markdown, no long
  numbers or paths aloud, plain English). L1 owns these; L2 drops its old
  "Voice mode (TTS)" bullet because L2 never speaks.
- L2 additionally gets the planner / supervisor contract (unchanged
  brainstorm machinery, worker scope, confirm-before-dispatch).

The typed path (talk-to-Lex box without voice) still goes to L2 and stays
in character because L2 keeps the identity.

`SYSTEM_PROMPT_VERSION` bumps; the prompt archive keeps writing every spawn's
prompt to `<data>/lex-prompts/`.

---

## Knobs (runtime_config, live, no rebuild)

`07-daemon/src/lex/layer-model.ts` resolves, in order: runtime_config, env,
default. Values are whitelisted (command-injection guard) before touching an
argv.

| key | env fallback | default | applies to |
|---|---|---|---|
| `top_model` | `DEVNEURAL_VOICE_BRAIN_MODEL` | `haiku` | L1 spawn `--model` |
| `top_effort` | `DEVNEURAL_TOP_EFFORT` | unset | L1 spawn `--effort` |
| `mid_model` | `DEVNEURAL_MID_MODEL` | `opus` | L2 (existing) |
| `mid_effort` | `DEVNEURAL_MID_EFFORT` | unset | L2 spawn `--effort` |
| `mid_permission_mode` | `DEVNEURAL_MID_PERMISSION_MODE` | `bypassPermissions` | L2 (existing; Phase B flips to `plan`) |
| `worker_model` | `DEVNEURAL_WORKER_MODEL` | `opus` | L3 (existing) |
| `worker_effort` | `DEVNEURAL_WORKER_EFFORT` | unset | L3 command string |
| `dispatch_confirm_gate` | `DEVNEURAL_DISPATCH_CONFIRM_GATE` | `off` | Phase B gate |

Set with `POST /runtime-config/<key> {"value": "..."}`. Effort values are
validated against `low|medium|high|xhigh|max`; anything else is ignored.

---

## Phase B: L1 controls L2's decisions

### Plan approval by voice

L2 runs `--permission-mode plan`. When L2 finishes a plan and asks to
proceed (the ExitPlanMode approval prompt), the daemon detects the pending
prompt on the L2 session (the same permission-prompt detection the bell
already uses), reads the plan text from the L2 jsonl, and hands L1 a turn:
"[plan-ready] <plan summary>". L1 speaks it in two or three sentences and
asks for a go. The operator's answer comes back through the normal L1 turn
as `CONTROL: approve_plan` or `CONTROL: reject_plan <reason>`; the daemon
answers the prompt on the L2 PTY (approve) or injects the reason back to L2
(reject, keep planning). No approval, no execution. Until a plan is pending
the mid runs exactly as today.

### Mechanical confirm gate on worker dispatch

With `dispatch_confirm_gate` on, `POST /lex/inject-cross-session` from L2
(caller sends `from_anchor_id`) does not dispatch. The payload is parked as a
pending dispatch with an id, L1 gets "[dispatch-pending] <what L2 wants to
send, to which worker>", speaks it, and the operator's yes/no comes back as
`CONTROL: confirm_dispatch` (release, dispatch runs unchanged) or
`CONTROL: reject_dispatch <reason>` (L2 is told to revise). A pending
dispatch times out after 10 minutes with a rejection note to L2. Mirrors the
`enforceLooseEndsGate` pattern (409 + report), so the dashboard can show the
held item. The prompt-enforced "state the plan, get a go-ahead" rule stays;
the gate makes it mechanical.

---

## The voice reaches the worker (BUG-038, 2026-09-23)

The July grammar teardown removed "lex start project" and the v3 verb set
covered speech, delivery and approvals only, so the voice could steer
the brain but never the worker. Four effects close that gap on the same
principle as every other control: AI-interpreted, closed set, unsure is
not a control.

| Verb | Effect | Same path as |
|---|---|---|
| `start_worker` | spawn-or-bind the worker on the project this brainstorm supervises | the Start button (`openProjectAnchor`, `POST /projects/:id/open`) |
| `stop_worker` | release the worker (anchor dormant; the editor window stays open) | the End action (`endProjectAnchor`) |
| `panic_worker` | double-ESC the worker, not the brain | the panic button on that anchor (`fireProjectInterrupt`) |
| `switch_project <name>` | open the brainstorm supervising the named project and move this call to it | selecting a brainstorm on the dashboard (`POST /lex/anchors/:id/open`, then the bind the hello frame runs) |

The daemon resolves the spoken name loosely (case, spaces and punctuation
stripped; slug and title; a live brainstorm preferred), so "drop ship"
finds `dropship-01`. Every handler returns a factual status (started,
already running, released, interrupted, not reachable, no such project
and which ones exist, switched) as a `worker-result` event that Layer 1
says in her own words; nothing is spoken from a script. A switch drops
what was queued for the old brain, rebinds the socket, and sends
`brainstorm-switched` so the page's selection and URL follow. The scope
rule holds: `start_worker`, `stop_worker` and `panic_worker` only ever
reach the one project this brainstorm supervises; `switch_project` is
how the operator changes which one that is.

Handlers: `07-daemon/src/dashboard/voice-layers-wire.ts` (`startWorker`,
`stopWorker`, `panicWorker`, `switchProject`, `resolveProjectByName`),
deps wired in `routes.ts` next to the Phase B wire. Wire:
`applyTopLayerControl` and `switchToBrainstorm` in `lex-voice-ws.ts`.
Client: the `brainstorm-switched` frame in `VoiceClient.tsx`.

---

## Transcript and client

- One Lex in the transcript (2026-09-22): every assistant line, whether it
  came from L1 (spoken lines, sent as `layer-hop` frames) or L2 (the reply,
  `assistant-text`), is labelled `lex:` and rendered flat, in order. The old
  collapsed "brain replied" step-down and the "to Lex (brain): ..." hop line
  are gone; the routing lives in `daemon.log` (`[voice-ws] forward to L2:
  ...`). `data-layer` stays on the rows for debugging.
- A dropped utterance emits `{t:'ignored', text, reason}` so the transcript
  can grey it out. Unknown frames are ignored by older clients.
- Dashboard control surface: unchanged. No new buttons, sliders or knobs on
  the voice panel. Runtime knobs live on the /system settings page.

---

## Testing

Unit (vitest, `07-daemon/tests`):

- `waitForVoiceReply`: two-record turn (thinking end_turn, then text end_turn)
  resolves with the text; text-first single record resolves; genuinely empty
  turn resolves empty after the grace; onPartial fires once per text record.
- Directive parser: FORWARD / CONTROL / IGNORE alone and combined, malformed
  lines stay speech, verbs validated, fail-safe forward on null.
- L1 prompt pins: persona present, spoken rules present, no TTS rules in L2's
  prompt, identity identical in both.
- Live block builder: warming / idle / thinking / tool / replying states,
  worker line, digest fields, last-said line.
- Boot order: Lex start spawns L1 before L2; forwards while L2 warming are
  queued and flushed on warm, in order.
- Blue/green respawn: swap only between turns; old session serves until the
  new one is warm; threshold and switch triggers.
- Knobs: resolver whitelist for effort; argv contains `--effort` only when
  set; `--setting-sources project,local` present on the L1 spawn and
  absent on the L2 spawn.
- Phase B: plan-prompt detection to L1 turn; approve writes the accept to
  the PTY; reject injects the reason; dispatch gate parks, releases,
  rejects, times out.

Live (after daemon restart + dashboard build):

1. Open a brainstorm: L1 warm before L2; talk immediately; L1 says the
   deeper part is still waking up; the forward lands in L2 once warm.
2. Say something to the TV: nothing forwarded, transcript shows it greyed.
3. Ask "what's she doing" mid-L2-turn: L1 answers with the live state, L2
   keeps working.
4. L2 reply is spoken in L1's voice (log shows `chars>0`, no raw fallback).
5. Barge: audio stops instantly. "yeah" or noise: she picks the sentence
   back up on her own (`[voice-ws] barge: resumed (engine)`). An aside
   ("hang on, is it raining?"): she answers, then picks it back up
   (`L1 turn: ... control=answer_then_finish`, then `resumed (l1)`). A
   correction: she drops it and takes the new direction
   (`control=drop_reply` or `cancel_redirect`, `barge: rethink`).
6. Plan mode: L2 plans, L1 reads it out, "go" executes, "no, X" revises.
7. Dispatch gate: L2's worker prompt is held until a spoken yes.
8. "lex emergency stop" fires with no model in the loop.
9. Commands in your own words: "you can stop listening for a bit" mutes
   (`L1 turn: ... control=mute`), "say that slower" re-speaks slower, "are
   you controlling the worker" is answered as Lex, never as Claude Code.
10. Handover by voice: at the trip point the worker writes its handover,
    L1 reads the brain's review, "go" clears and reseeds, the file under
    `brainstorms/<anchor>/HANDOVER-<iso>.md` shows both halves.
11. The worker by voice (BUG-038): "start the worker", "stop the worker",
    "kill the worker", "switch to <project>", each in your own words.
    `daemon.log`: `L1 turn: ... control=start_worker` (and the rest),
    `[voice-worker] start <slug>: ok=true`; the worker appears, is
    released, or gets the double-ESC; the switch logs `switched to
    brainstorm` and the page URL flips to the new `?brainstorm=`.

---

## Barge baseline (SHIPPED 2026-07-20; the stop half stands, the never-resume half is superseded by v3)

The stop is deterministic and dumb on purpose. No model decides whether to
stop. What happens after the stop is the v3 policy above; the "never
resumes" line below was the emergency rule while L1 was dead.

```
L1 is speaking (TTS playing)
         |
   L0 makes any sound  -->  TTS STOPS immediately (on sound, not on transcript)
         |
   Playback NEVER resumes.  The interrupted audio is gone.
         |
   BUT: the full L2/L1 statement still exists as TEXT in the transcript.
```

Acceptance: (1) while L1 is speaking, make a sound, TTS stops; (2) it never
resumes; (3) the complete statement is still readable. What got torn out to
reach it: the word-gate (VAD onset fires the stop), `resumeBargedSpeech`
(every path drops the stash), L2 truncation on an ordinary barge (only the
emergency stop truncates), and the old smart L1 ask (deleted, now rebuilt
above on a found root cause, not resurrected from the broken shape).

---

## Code map

- L1 session lifecycle + ask + jsonl tail: `07-daemon/src/lex/voice-brain-session.ts`
  (`ensureSpawned`, `askVoice`, `waitForVoiceReply`, respawn / blue-green)
- L1 prompt + per-turn contract + parser: `07-daemon/src/voice/voice-top-layer.ts`
- Shared persona: `07-daemon/src/lex/persona.ts`; L2 prompt composer: `07-daemon/src/lex/system-prompt.ts`
- Per-layer knobs: `07-daemon/src/lex/layer-model.ts`; endpoint `POST /runtime-config/:key` in `07-daemon/src/dashboard/routes.ts`
- Turn pipeline (the seam L1 sits in): `07-daemon/src/voice/lex-voice-ws.ts` `processTurnText`
  (notes gate -> L1 turn -> forward / control / ignore), `handleUtteranceEnd` (panic regex, engine
  echo filter, Smart Turn endpointing), `killActiveTts`, `dropBargeStash`, `confirmRealBarge`
- L2 spawn: `07-daemon/src/lex/spawn-lex-session.ts`; anchor open/start routes in `routes.ts`
- Engine buckets (pure, wired as the pre-model echo filter): `07-daemon/src/voice/engine/barge-classifier.ts`
- Dispatch gate + plan approval: `07-daemon/src/lex/dispatch-gate.ts` (pure registry),
  `07-daemon/src/lex/plan-approval.ts` (pure detector / extractor / PTY actions),
  `07-daemon/src/dashboard/voice-layers-wire.ts` (deps-injected wiring: `maybePark` in the
  inject route, `onPendingPrompt` in the pending-prompt route, the L1 control handlers,
  the 10-minute expiry sweep); registered in `routes.ts` next to the smart-clear routes
- Client: `08-dashboard/components/VoiceClient.tsx` (frames), transcript grouping `08-dashboard/lib/transcript-grouping.ts`
- Emergency stop: `07-daemon/src/voice/lex-voice-commands.ts` `matchPanicCommand`, `panic-routes.ts`
