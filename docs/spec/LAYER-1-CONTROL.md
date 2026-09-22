# Layer 1 Control: the voice layer (canonical, v2)

Single source of truth for how the operator talks to Lex. Supersedes the
2026-07-20 version of this file (kept below as "Barge baseline", which
shipped and still holds) and consolidates the scattered voice-layer design
in `VOICE-TOP-LAYER-SPEC.md`, `VOICE-TOP-LAYER-SMARTS-SPEC.md`,
`VOICE-BARGE-CLASSIFIER-SPEC.md`, `COALESCE-UTTERANCE-QUEUE.md` and
`docs/superpowers/specs/2026-07-15-voice-top-layer-design.md`. Those stay as
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
   so once, in the first person ("the deeper part of me is still waking up,
   go on"), keeps the conversation going, and still emits `FORWARD:` for
   anything meant for L2. The daemon queues those forwards and flushes them
   the moment L2 is warm. No utterance is dropped because L2 was late.
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
       --append-system-prompt <L1 prompt>
```

Effort note: `--effort` levels are low / medium / high / xhigh / max. Haiku
4.5 has no effort parameter (it runs thinking-off and is already the floor;
the CLI accepts the flag on haiku and it changes nothing). The knob exists so
Sonnet 5 or Opus can be flipped in at `low` for an A/B without a rebuild.

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
   third-person actor is the worker.
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
5. Seeing L2: the live block tells you what the deeper brain is doing and
   for how long. Say so when asked or when it matters ("still reading the
   schema, about forty seconds in"). Never wait for it before replying.
6. Warming: if the live block says L2 is warming, say so once, keep talking,
   still forward.
7. Noise: if what you heard is background (TV, other people, fragments with
   no address to you, your own echo), emit `IGNORE:` with a two-word reason
   and say nothing. When unsure whether it was meant for you, ask in five
   words or fewer instead of forwarding.

### The per-utterance turn

Input message (one per utterance, self-contained):

```
[live] brain: warming 12s | idle | thinking 34s | tool Read 8s | replying
       worker: idle | running 3m (dropship-01)
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
  last L2 reply from cache, no brain round trip), `drop_reply` (the reply
  the brain is giving is no longer wanted: stop speaking it and discard
  the rest), `combine` (fold this utterance into the one still waiting to
  go down, one turn), `approve_plan`, `reject_plan`, `confirm_dispatch`,
  `reject_dispatch` (Phase B).
- Interrupt policy (the operator speaks while L2's reply is being
  delivered or is pending). Audio already stopped (baseline). L1 sees
  `during_tts: yes` plus the reply text so far in the live block and
  decides one of three: **drop** (`CONTROL: drop_reply`, the reply is moot,
  the new input goes down as the new direction), **additive** (no control;
  the new input forwards as a follow-up and the brain answers it after
  the current reply), or **combine** (`CONTROL: combine`; the new input
  merges with the utterance still queued so the brain gets one turn).
  Bias: a correction or a new direction drops; an addition is additive; a
  clarification of the same ask combines. Never resume cut audio.
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

Latency budget: the ask timeout is the bound on time-to-first-signal
(default 6s, `DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS`), then silence-bounded. A
timed-out conversational turn forwards and scores no liveness strike.

### Barge: the new-input policy (L1 magic, rebuilt)

The baseline below is unchanged: sound stops TTS, it never resumes, the full
text stays readable. What L1 now decides is what happens to the NEW input:

- **Combine / coalesce.** Stacked utterances mid-reply merge into one
  handling, no double answer.
- **Queue vs now.** L1 says whether the new input waits for L2's current
  turn or interrupts it (`CONTROL: interrupt_work` or `cancel_redirect`).
- **Cancel + redirect.** A countermand drops L2's in-flight work (double-ESC
  to the L2 PTY) and sends the new direction. Latest wins.
- **Classify.** Command, real words, noise, backchannel ("mm-hm", "right"),
  own echo. Precedence: emergency stop (regex) > echo filter (engine) > L1
  decision.

None of this resumes cut audio. Stop is always final.

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
   the same record and never replays a delivered reply.
7. Segment dedupe on the L2 jsonl (`spokenSegmentHashes`) keeps an
   end_turn from re-speaking its own pre-tool text.
8. One voice connection per PTY (`activeByBindKey` eviction); a second tab
   evicts the first rather than adding a mouth.

## L2 reply delivery through L1

When L2's end_turn body lands, the daemon asks L1 to deliver it out loud in
its own voice (`voiceLexReply`), streaming per record. Facts, numbers,
decisions and negations are preserved verbatim; paths, ids and code are
referred to in passing. A miss (nothing spoken) falls back to speaking the
raw L2 body so L2 is never silenced; a cut (partials spoken, ask never
closed) re-delivers when L1 is back.

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
4. **L2 self-clear (T4: Lex-authored handover, secondary approval, staggered
   with the worker) is a separate wave**, not this one. Nothing here blocks
   it: `writeHandover` / `findLatestHandover` and the `clear`-branch hook
   wiring remain the recipe.

## Context hygiene: L1 is disposable

L1's transcript is throwaway. Policy:

- Respawn when the L1 jsonl passes a size threshold (default 400 KB,
  `DEVNEURAL_VOICE_BRAIN_MAX_JSONL_BYTES`), on brainstorm switch, and on the
  L2 compaction restart (already wired).
- Respawn is blue/green: the replacement spawns and warms in the background
  while the old session keeps answering; the swap happens between turns
  (no ask in flight, no TTS active); the old PTY is then killed. A clear
  never drops an utterance and never leaves the operator waiting on a boot.
- The fresh session gets no carry-over. Continuity comes from the live
  block on every turn (digest, last said line).

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

## Transcript and client

- Transcript labels by layer stay as shipped (you / lex voice / lex deep).
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
5. Barge: audio stops, never resumes, text intact; a countermand cancels
   and redirects L2.
6. Plan mode: L2 plans, L1 reads it out, "go" executes, "no, X" revises.
7. Dispatch gate: L2's worker prompt is held until a spoken yes.
8. "lex emergency stop" fires with no model in the loop.

---

## Barge baseline (SHIPPED 2026-07-20, unchanged)

The rule is deterministic and dumb on purpose. No model decides whether to
stop.

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
- Dispatch gate + plan approval: `07-daemon/src/lex/cross-session-inject.ts`, `07-daemon/src/dashboard/pending-prompt*.ts`
- Client: `08-dashboard/components/VoiceClient.tsx` (frames), transcript grouping `08-dashboard/lib/transcript-grouping.ts`
- Emergency stop: `07-daemon/src/voice/lex-voice-commands.ts` `matchPanicCommand`, `panic-routes.ts`
