# cc-pty Voice Double-Talk Regression — Investigation

**Reported:** 2026-05-26 03:28 EDT by operator (live, this Lex CC session).
**Status:** CLOSED 2026-05-29. See Closure section at end of doc.
**Scope:** `07-daemon/src/voice/lex-voice-ws.ts` cc-pty path. Direct-llm
already coalesced in Fix 35 (commit `2718b85`).

User rule (hard, all paths): never play two TTS streams at the same time.

## Closure (2026-05-29)

Two fixes ship together as the cc-pty double-talk closure:

- **Fix 40** (`be14396`, 2026-05-26): introduced the speak-queue
  controller (`07-daemon/src/voice/lex-voice-speak-controller.ts`)
  with SERIALIZE semantics for same-turn `speak()` calls. Candidate 1
  in this doc named the right surface (`speak()` at line 1288) but
  recommended cancel-on-replace. Operator clarified the contract
  during ship to SERIALIZE within a logical turn instead. Fix 40
  shipped that contract with six test pins.

- **Fix 51** (`e0978ee`, 2026-05-29): root cause. Fix 40's SERIALIZE
  was correctly drafted but released its `await` Promise on the wrong
  signal. `speakOne` had THREE release paths — `pcm 'end'`,
  `pcm 'error'`, AND `void handle.done.then(...)`. `handle.done`
  resolves in `piper.synthesize` on `proc.on('exit')`, which fires
  BEFORE the kernel drains piper's stdout pipe. The Readable `pcm`
  stream's `data` handler kept flushing buffered chunks via
  `sendBinary` AFTER `speakOne` returned and `runQueue` spawned the
  next segment. Two PCM streams to the client = audible overlap.
  Fix: drop the `handle.done.then(...)` branch. Wait for `pcm 'end'`
  or `pcm 'error'` only. New test pin (5) in
  `tests/lex-voice-ws-speak-queue.test.ts` resolves `done` while pcm
  'end' is pending and asserts the queue does NOT advance until pcm
  ends.

The investigation's "Recommended next-spec scope" section (lines
216-232) is now obsolete. It recommended cancel-on-replace
(`killActiveTts('replace')`); the operator-clarified SERIALIZE
contract from Fix 40 ship superseded that recommendation. Retained
below for historical context only.

Live smoke pending: SMOKE-TEST.md Step 5.1-5.3.

## Reproduction context

This Lex CC session (cc `2a708d6d`, brainstorm `4bbafb48`, voice mode
on, cc-pty runtime). Operator reports double-talk after Fix 35
coalesce shipped. Fix 35 explicitly deferred the cc-pty path because
the existing `pendingUserUtterances` + `flushPendingUtterances`
machinery (Fix 20, commit `a00cea6`) was assumed to be enough.

## Path map (cc-pty, current code)

### handleUtteranceEnd cc-pty branch (`lex-voice-ws.ts:1753-2042`)

Three dispatch outcomes for each transcribed utterance:

1. **Mid-turn-no-tts queue (`:2071-2098`)** — fires when
   `state.awaitingResponseSince > 0 && !state.ttsActive`. Utterance is
   pushed onto `state.pendingUserUtterances`; client gets
   `t:'queued-mid-turn'`. Drained later by `flushPendingUtterances`.
2. **Direct inject (`:2107-2120`)** — the fall-through path. Calls
   `ptyInject(state.bindKey, snapshotBlock + gateNote +
   partialChainBlock + voiceTag + result.text, true)`, then
   `state.awaitingResponseSince = Date.now()` (`:2121`).
3. **AEC-residual / wake-during-TTS drop (`:1972-1977`)** — utterance
   started while TTS was streaming AND did not match a voice command.
   Dropped silently from the inject path; not a double-talk source.

### killActiveTts (`:1554-1597`)

Fires on every `utterance-start` WS frame (line 2216) before the
mic buffer fills. Cancels piper child, sets `state.ttsActive = null`,
sends `t:'tts-cancel'`, appends to `state.partialChain`. PTY Ctrl+C
fires ONLY when `ttsActive` was non-null at entry.

### speak (`:1266-1336`)

Spawns a piper child via `synthesize(clean)`. Critical line:

```ts
const ttsCtx = { cancel: handle.cancel, cancelled: false };
state.ttsActive = ttsCtx;                       // :1288 — OVERWRITES
state.currentTtsText = clean;                   // :1292
```

**No cancellation of any prior `state.ttsActive` before assignment.**
If a prior piper child is still streaming PCM when `speak()` is called
again, the prior ttsCtx is orphaned — the assignment just changes the
reference. The orphaned child keeps emitting PCM via its `.on('data')`
handler (line 1295-1303) because `ttsCtx.cancelled` was never set.

The `.on('end')` handler at `:1304-1323` guards
`if (state.ttsActive === ttsCtx) state.ttsActive = null` — the
orphaned end fails this identity check and leaves the new ctx alone,
but the orphan still emitted every chunk that arrived before its
piper finished.

### handleJsonlLine TTS dispatch (`:875-1046`)

Speak fires at `:1044` (`speak(text)`) inside the `if (text)` block
at `:1002`. Critical sequence for a Lex turn that emits a pre-tool ack:

| Record | stop_reason | new_text after dedupe | speak() called |
|---|---|---|---|
| Pre-tool ack jsonl | `tool_use` | `"On it..."` | yes — ctxA |
| Tool result | (user record, dropped at `:876`) | — | no |
| End-turn jsonl | `end_turn` | full text minus pre-tool ack | yes — ctxB |

ctxA and ctxB both call `speak()`, both hit line 1288, ctxB replaces
ctxA as the `state.ttsActive` reference. ctxA's piper child is NOT
cancelled. Two PCM streams to the client = audible double-talk.

The `spokenSegmentHashes` dedupe (line 911) prevents the *text* of the
pre-tool ack from being repeated in the end-turn `speak()`, but does
nothing to cancel the in-flight audio stream that is still emitting
that exact text. `selectTtsContent` is a pure helper; it has no view
of `state.ttsActive`.

### flushPendingUtterances (`_flushPendingUtterancesImpl`, `:437-490`)

Combines all queued utterances into one preamble + numbered list
inject and stamps `state.awaitingResponseSince = Date.now()`. After
flush the queue is empty. Lex replies; `handleJsonlLine` runs the
same speak path above. Same multi-segment double-talk risk applies
to the flushed turn.

## Candidate root causes (ranked)

### Candidate 1 — speak() does not cancel a still-active ttsActive (HIGH)

**Location:** `lex-voice-ws.ts:1288`.

**Mechanism:** any sequence where `handleJsonlLine` runs `speak()` twice
without `ttsActive` reaching `null` between calls produces two
concurrent piper children sending PCM to the same WS. The orphaned
piper continues until its own `.on('end')` fires naturally; the
client mixes both streams in `schedulePcmChunk` and the user hears
overlapping speech.

**Common trigger:** Lex turn with a pre-tool ack. Real volume on this
brainstorm (probe via daemon log grep `\[voice-ws\] transcript
received` followed by `[voice-ws]` artifacts emit shows pre-tool acks
land frequently). Any pre-tool ack short enough that piper finishes
before the end_turn record lands skips the issue; any ack long enough
to still be streaming when the end_turn record arrives produces the
overlap.

**Conditions:**
- Lex emits `stop_reason='tool_use'` with non-empty text content.
- End_turn record lands while pre-tool-ack PCM is still draining.
- `selectTtsContent` extracts non-empty `new_text` from the end_turn
  (i.e. the end_turn body has fresh content beyond what the pre-tool
  ack already spoke).

**Evidence to confirm post-restart:** check
`07-daemon` daemon log for the `[voice-ws] tts-start` frames; if two
land within the duration of one piper synth window (rough estimate
~1 s per ~100 chars at en_GB-alan-medium) without an intervening
`tts-cancel` / natural `tts-end`, this candidate is confirmed.

### Candidate 2 — Cross-turn coalesce gap; utterance arriving after end_turn but before TTS drain (MEDIUM)

**Location:** `lex-voice-ws.ts:1980` (mid-turn-no-tts gate) +
`:912` (end_turn clears `awaitingResponseSince`).

**Mechanism:** the gate at `:1980` requires
`awaitingResponseSince > 0 && !ttsActive`. The end_turn jsonl record
clears `awaitingResponseSince` at `:912` *before* TTS finishes
streaming (TTS draining is async + separate from the jsonl tail
read). Window:

```
t=0   end_turn jsonl lands → awaitingResponseSince=0
t=0   speak(text) starts → ttsActive=ctxNew, piper streaming
t=+200ms user speaks → utterance-start → killActiveTts cancels ctxNew
t=+1500ms utterance-end → gate sees awaiting=0, ttsActive=null
        → falls through to direct inject → Lex starts a fresh turn.
```

This is the *intended* barge-in flow (Fix 20 explicitly designed
this way). It only becomes a double-talk source IF Candidate 1 left
an orphan PCM stream behind — `killActiveTts` only cancels the
`state.ttsActive` reference, not the orphaned ctxA from a multi-
segment turn. Then user barges, ctxB cancels, ctxA keeps streaming,
new turn's speak() lands a ctxC on top of still-streaming ctxA.

**Subordinate to Candidate 1.** Fix Candidate 1 and this gap stops
producing audible double-talk; the gap stays as a designed barge-in
boundary.

### Candidate 3 — Lex assistant-text segmentation across multiple jsonl records (MEDIUM)

**Location:** `lex-voice-ws.ts:875-1050` + `selectTtsContent`.

**Mechanism:** if Lex's harness ever emits multiple `assistant`
records inside one logical turn (e.g. compaction restart streaming
the system-prompt back, or a long tool sequence with several
mid-turn assistant text chunks), each record calls `speak()`. Same
orphaned-piper mechanism as Candidate 1; just a different shape of
trigger.

**Likelihood:** lower than 1. Pre-tool ack is the only common
multi-record path documented. Other shapes (mid-tool-use streaming
assistant text) are theoretical absent a probe of the actual jsonl
sequence on this brainstorm.

### Candidate 4 — partialChain content-level double-reply (LOW for audio; CONFOUNDING for content)

**Location:** `lex-voice-ws.ts:1571-1577` + `:2069` (chain rendered
ahead of next inject).

**Mechanism:** after `killActiveTts` records the intended-text into
`partialChain`, the next user inject prepends a `[voice-context:
interrupted reply was X]` block. Lex sees the prior partial AND the
new user utterance and may compose a reply that addresses both: the
finish-up of the interrupted thread plus the answer to the new
question. Lex speaks one continuous reply — single `speak()`, single
PCM stream — but the *content* covers two turns of thought.

This is **not double-talk in the audio sense** (one TTS stream) and
does not match the symptom shape. Worth listing for completeness so
the followup spec can rule it out as the operator's complaint, OR
identify if the complaint is content-level rather than audio-stream
level.

### Candidate 5 — Cross-tab / multi-WS race on activeByBindKey eviction (LOW)

**Location:** `lex-voice-ws.ts:259` (`activeByBindKey`) +
`:2289-2291` (eviction in teardown).

**Mechanism:** if two voice WS sockets briefly bind to the same Lex
CC (tab reload, voice off/on, mobile/desktop concurrent), both
`handleJsonlLine` watchers tail the same jsonl and both `speak()`
each assistant record. Independent piper children on each WS.
Client side: only one client per WS hears each stream, so this is
double-talk only if the same browser/audio context is bound to both
sockets, which Fix 31's `ptyId`-keyed effect deps largely closed.

**Likelihood:** low post-Fix-31, but still possible during tab
reload or rapid voice toggling.

## Things I deliberately did NOT propose

- Code changes. Spec'd in the next round.
- A queue redesign for cc-pty. Existing Fix 20 mid-turn-no-tts queue
  is structurally fine; the regression is in the speak() lifecycle,
  not the queue.

## Recommended next-spec scope

1. Pin Candidate 1 with a code-side cancel: every call into `speak()`
   should `killActiveTts('replace')` (or equivalent) before assigning
   `state.ttsActive`. The replace reason can be its own enum value
   so the partialChain heuristic does not push an entry for the
   replaced ctx (the user did not barge; Lex is just continuing).
2. Add a test pin in the spirit of `tests/lex-voice-ws-flush-cr.test.ts`
   that drives two back-to-back `speak()` calls and asserts the first
   ctx's `cancelled` flag flipped before the second piper was
   spawned.
3. Probe whether Candidate 3 occurs in practice — read a recent
   `2a708d6d.jsonl` and count how many turns emitted 2+ assistant
   records.
4. Treat Candidate 4 as a content-side question for the operator: is
   the double-talk audio overlap (Candidate 1) or content overlap
   (Candidate 4)?

## Verification checklist for the fix round

- [ ] Two consecutive `speak()` calls in a unit test: first ctx
      reports `cancelled=true` before second piper spawn returns.
- [ ] Live: Lex emits a pre-tool ack followed by an end_turn body;
      tail daemon log for `tts-start` frames without a paired
      `tts-cancel` or `tts-end` between them.
- [ ] Live: barge-in mid pre-tool-ack drops the orphaned stream too
      (the kill should cancel whatever is currently in
      `state.ttsActive`, but if Candidate 1 already orphaned a prior
      ctx, the orphan still streams).
- [ ] Audit row in `cross_session_injection_log` or a new
      voice-debug log that counts overlapping TTS windows; surface in
      `/dashboard/voice-stats` so the regression cannot silently
      return.
