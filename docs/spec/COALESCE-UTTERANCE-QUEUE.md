# Coalesce Utterance Queue — Spec

Sealed 2026-05-25 by operator. Phase A implementation 2026-05-26 (Fix 35).

## Contract

1. **Single output stream invariant.** Never begin response B while response A
   (text or TTS) is still in flight. Hard rule.
2. **Queue ALL inputs that arrive while Lex is mid-work.** Voice utterances
   AND text messages. Same queue.
3. **Drain on ready-to-respond trigger.** Drain the full queue, not just the
   head.
4. **Classify each queued item:** relevant to in-flight work, follow-up to
   earlier queue item, new unrelated topic, or noise (background mic, drop).
5. **Compose ONE response with internal structure:**
   - Same-topic items merged into one coherent answer.
   - Mixed / unrelated items sequenced with brief ack each ("got your
     second question about X, here is both"). Order: original target first,
     follow-ups after.
   - **Contradiction case** (user countermands original instruction): latest
     wins. Stop work, ack the cancel, drop the original, do not double-reply.
   - **Conflict case** (user request conflicts with prior rule or memory):
     push back out loud; do not silently accommodate.
6. **Scope universal.** Voice mode AND typed text both follow this loop.

## Current implementation status

| Contract point | cc-pty | direct-llm | text input |
|---|---|---|---|
| 1 single output stream | partial via PTY end_turn | **Phase A** (Fix 35) | n/a (no UI yet) |
| 2 queue all inputs | mid-turn-no-tts only | **Phase A** (Fix 35) | Phase C (deferred) |
| 3 drain on ready | end_turn drain (existing) | **Phase A** (Fix 35) | Phase C |
| 4 classify items | not done | not done | not done |
| 5 compose one response | header + numbered list | **Phase A** (Fix 35) | Phase C |
| 5 contradiction case | hold-up wake-cmd only | **Phase A** (Fix 35) | Phase C |
| 5 conflict push-back | not done | not done | not done |
| 6 universal voice + text | voice only | voice only | Phase C |

## Phase A (Fix 35, shipped 2026-05-26)

Minimum-viable slice that closes the most acute contract violations on the
direct-llm path. The cc-pty path keeps its existing mid-turn queue (which
already satisfies the basic single-output-stream invariant via `awaiting
ResponseSince` + `pendingUserUtterances`).

### What landed

- New pure module `07-daemon/src/voice/lex-voice-coalesce.ts`:
  - `formatQueueDrain(queue)` — wraps multi-utterance batches in a
    `[voice-context: queued-utterances (N)] …\n1. …\n2. …` preamble that
    instructs Lex to compose ONE reply addressing all of them, and to
    treat a latest-utterance contradiction as the cancellation. Single-item
    batches pass through unchanged.
  - `detectContradiction(text)` — word-bounded, case-insensitive regex
    lexicon for `cancel` / `never mind` / `forget it` / `stop / halt /
    abort` / `drop it` / `hold up|on`. Used as a gate, not as a hard
    veto: a contradiction phrase only triggers cancel semantics when
    Lex is actually mid-reply.
- `lex-voice-ws.ts` direct-llm branch (handleUtteranceEnd):
  - Adds `state.inFlightDirectLlmReply: boolean` to `ConnState`.
  - When a reply is in flight AND the incoming utterance is a
    contradiction, drop the queue, emit a `t:'contradiction-cancel'`
    frame, and return without injecting.
  - When a reply is in flight AND the incoming utterance is not a
    contradiction, push onto `pendingUserUtterances`, emit
    `t:'queued-mid-turn'` (mirrors the existing cc-pty queue frame).
  - When no reply is in flight, dispatch through
    `runDirectLlmCoalesceLoop`, which sequences
    `handleDirectLlmUtterance` calls and drains the queue between
    iterations via `formatQueueDrain`.
- Tests: `07-daemon/tests/lex-voice-coalesce.test.ts` pins the formatter
  (empty, single-item passthrough, multi-item preamble, order
  preservation) and the contradiction detector (canonical phrasings,
  case-insensitive, word-boundary false-fire prevention).

### What did NOT land in Phase A

- **Classifier (contract point 4).** The combined drain payload tells
  Lex to merge or sequence as appropriate via the system-prompt rule;
  code-side classification (relevance / follow-up / new / noise) is
  deferred.
- **Conflict push-back (contract point 5).** No memory/rule lookup
  hook yet. Deferred to Phase B.
- **Text input scope (contract point 6).** The dashboard chat surface
  does not exist; there is no WS frame to route. Deferred to Phase C.
- **In-flight ollama abort on contradiction.** `handleDirectLlmUtterance`
  does not thread an AbortSignal; the in-flight call still finishes
  and lands as an assistant chunk. The queue is empty so no follow-on
  inject replays the cancelled instruction.

## Phase B (deferred)

- Code-side classifier: relevance / follow-up / new / noise tags on
  each queued item, fed into the drain preamble as structured metadata
  (`{kind: 'follow-up', text: '...'}`) so Lex can compose deterministically.
- Conflict push-back: lookup against memory + the active system-prompt
  rule set; emit a `[voice-context: conflict] …` block when an incoming
  utterance contradicts a durable rule.
- AbortController plumbing into `callVoiceChat` so contradiction cancels
  the in-flight ollama generation immediately rather than letting it
  finish.

## Phase C (deferred — depends on dashboard chat UI)

- New `t:'text-input'` WS frame handled by `lex-voice-ws.ts` that flows
  through the SAME `runDirectLlmCoalesceLoop` / `pendingUserUtterances`
  state machine voice utterances use. Per the sealed contract point 6,
  there is one queue, not two.
- Server-side persistence: text-input lines insert into
  `brainstorm_chunks` with role='user' source='text-input' so the
  transcript stream remains a single coherent artifact.
- cc-pty equivalent: text-input frames targeting a cc-pty brainstorm
  route through `ptyInject` keyed on `state.bindKey`, sharing the
  existing `pendingUserUtterances` + `flushPendingUtterances` plumbing.
