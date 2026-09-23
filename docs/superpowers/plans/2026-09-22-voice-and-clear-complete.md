# Voice v3 + Context Lifecycle Phase C Implementation Plan (one wave)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the operator asked for on 2026-09-22 in one wave: Lex speaks as herself (identity fix), the approved barge policy (stop first, then finish / rethink / answer then finish), AI-interpreted commands with the safety stop mechanical, a contract that carries manner not lines, Lex in control of current state and workers, Phase C of the context lifecycle (worker-authored handovers vetted visibly by Lex, session-end and crash handovers, browsable timestamped files, voice preview, one auto-clear switch, Lex self-clear), a context gauge with the trip marks on every session surface, and a continuous speech stream that adds no latency.

**Architecture:** Daemon (`07-daemon`) changes ride the existing seams: `voice-top-layer.ts` (contract, verbs, parser), `lex-voice-ws.ts` (barge decision wired onto the surviving `_resumeBargedSpeechImpl` and barge stash), `voice-brain-session.ts` + `pty-host.ts` (replace-mode system prompt), `voice-layers-wire.ts` (handover approval next to plan approval), `smart-clear-routes.ts` + `handover-writer.ts` (Phase C routes and the two-half handover file), `session-end-pipeline.ts` + `crash-recovery.ts` (end and crash handovers), `hook-runner.ts` (Lex clear branch), `anchor-tiles.ts` + `sessions.ts` (ctx fields), `system-prompt.ts` (L2 rules). Dashboard (`08-dashboard`): a `ContextGauge`, a handover list, the auto-clear switch label, and a new stream sink behind the existing playback interface. Pure functions carry every decision and every test.

**Tech Stack:** TypeScript (ESM, Node 24), vitest, Fastify, better-sqlite3, Next.js static export, Claude Code CLI 2.1.280 as the session runtime, piper TTS.

**Spec:** `docs/spec/LAYER-1-CONTROL.md` (v3), `docs/spec/SMART-COMPACT.md` (section 5, built), `C:\dev\data\skill-connections\brainstorm\VOICE-BARGE-CLASSIFIER-SPEC.md`, `AUTO-CLEAR.md` (T1 to T10), `SPEC-2026-07-25-brainstorm-scope-isolation.md`.

## Global Constraints

- **No Anthropic API. Subscription sessions only.** Every model call is a headless `claude` session (OAuth). No `anthropic` SDK, no API key, no `--bare`. BF-4's outbound guard stays. Pin: no source file under `07-daemon/src` imports `@anthropic-ai/sdk` or reads `ANTHROPIC_API_KEY` (Task 12).
- **Scope fail-closed.** Every new surface keys on `supervises_project_anchor_id`; a second live anchor never appears in another anchor's live block, gauge, handover list, preview or preload. Pin per surface.
- **Latency.** The stream sink starts on the first chunk (today it waits for a whole sentence), no fixed prebuffer, buffering grows only on a measured underrun. Time to first audio must not regress; pin the scheduler math.
- **Single mouth** invariants stay. A FINISH resumes only through the speak controller from played milliseconds.
- Additive-only; tests green before and after; commit bodies end `Rebuild: yes|no`; no AI attribution; no em dashes anywhere; one destructive op per Bash call; daemon restart authorised by the operator for this wave ("complete all").
- Tests: `cd C:\dev\Projects\DevNeural\07-daemon && npx vitest run tests/<file>.test.ts`; dashboard: `cd 08-dashboard && npx vitest run tests/<file>`. Known reds: `grooming-routes` (BUG-014), `sessions-anchor-liveness` (environmental), dashboard `voice-mic-init` (BUG-023) and the two Playwright collection errors.

---

## File Structure

| File | Responsibility |
|---|---|
| `07-daemon/src/dashboard/pty-host.ts` (modify) | `systemPromptMode: 'append' \| 'replace'` on `SpawnLexOptions`; replace emits `--system-prompt @file --exclude-dynamic-system-prompt-sections`. |
| `07-daemon/src/lex/voice-brain-session.ts` (modify) | L1 spawn passes `systemPromptMode: 'replace'`. |
| `07-daemon/src/voice/voice-top-layer.ts` (modify) | v3 contract text (manner not lines, first person, barge policy, AI commands, no facts), new verbs, `[handover-ready]` event kind, cut-point fields on `LiveBlock`. |
| `07-daemon/src/voice/lex-voice-commands.ts` (modify) | Remove `matchSpokenControl` (panic stays). |
| `07-daemon/src/voice/lex-voice-ws.ts` (modify) | Remove the word gate; `_bargeDecisionImpl`; `resumeBargedSpeech` caller restored; `finish` / `answer_then_finish` / delivery-param verbs; `[live]` carries the cut point. |
| `07-daemon/src/voice/lex-voice-speak-controller.ts` (modify) | `setLengthScale`, last-reply cache for `start_over` / `slower` / `faster`. |
| `07-daemon/src/lex/handover-frame.ts` (create) | T5 frame types, `renderHandoverFrame` (two halves), `parseHandoverFrame`, `vetHandoverFrame`. |
| `07-daemon/src/lex/handover-writer.ts` (modify) | `writeFrameHandover`, `listHandovers`, `readHandover`, `archiveOldHandovers`. |
| `07-daemon/src/dashboard/smart-clear-routes.ts` (modify) | `POST /lex/smart-clear/handover-request`, `POST /lex/smart-clear/review`, `GET /lex/anchors/:id/handovers`, `GET /lex/anchors/:id/handovers/:file`, `POST /lex/auto-clear/mode`, `GET /lex/auto-clear/mode`. |
| `07-daemon/src/dashboard/smart-compact-routes.ts` (modify) | `clear-and-paste` accepts `handover_id`. |
| `07-daemon/src/dashboard/routes.ts` (modify) | `/worker/clear-handoff` serves the approved handover when one is pending for the anchor; `POST /lex/clear-handoff`. |
| `07-daemon/src/lex/session-end-pipeline.ts` (modify) | `writeHandover` on every terminal end. |
| `07-daemon/src/lex/crash-recovery.ts` (modify) | Recovery writes an unvetted handover from the tail. |
| `07-daemon/src/capture/hooks/hook-runner.ts` (modify) | `postLexClearHandoff` on the `clear` / `compact` branch. |
| `07-daemon/src/dashboard/voice-layers-wire.ts` (modify) | Handover approval registry + handlers (`approve_handover`, `reject_handover`). |
| `07-daemon/src/lex/system-prompt.ts` (modify) | L2 rules: current state first, may start a worker, Phase C driver loop steps, handover authorship rule for the worker wrap prompt. |
| `07-daemon/src/lex/anchor-tiles.ts`, `07-daemon/src/dashboard/sessions.ts` (modify) | `worker_ctx_pct`, `lex_ctx_pct`, `ctx_threshold_pct`, `ctx_ceiling_pct`; `/sessions` row `ctx_pct`. (Agent A) |
| `08-dashboard/components/ContextGauge.tsx` (create), `StreamDeck.tsx`, `LexSessionList.tsx`, `app/sessions/page.tsx`, `SmartCompactPanel.tsx` (modify) | The gauge with both marks; the single auto-clear switch label. (Agent A) |
| `08-dashboard/components/HandoverList.tsx` (create), `BrainstormDetail.tsx` (modify) | Timestamped handover list, newest first, both halves visible. (Agent A) |
| `08-dashboard/lib/voice-engine/stream-sink.ts` (create), `audio-stream-sink.ts` (create), `VoiceClient.tsx` (modify) | Continuous stream sink behind the `PlaybackQueue` interface plus `setGain`. (Agent B) |

Agent A and Agent B run in isolated worktrees on their own branches and are merged into `voice-layers` in Task 12.

---

### Task 1: Identity (BUG-033): replace-mode system prompt for L1

**Files:** `pty-host.ts:212-243, 418-439`, `voice-brain-session.ts` (spawn args ~465-515), tests `pty-host-spawn-args.test.ts` (create), `voice-brain-session.test.ts` (extend).

**Interfaces:** `SpawnLexOptions.systemPromptMode?: 'append' | 'replace'` (default append). Exported pure helper `systemPromptArgs(mode, file): string[]` from `pty-host.ts`.

- [ ] Test (`tests/pty-host-spawn-args.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { systemPromptArgs } from '../src/dashboard/pty-host.js';

describe('systemPromptArgs (BUG-033)', () => {
  it('append keeps the old flag', () => {
    expect(systemPromptArgs('append', 'C:/t/p.txt')).toEqual(['--append-system-prompt', '@C:/t/p.txt']);
  });
  it('replace uses --system-prompt and drops the dynamic sections', () => {
    expect(systemPromptArgs('replace', 'C:/t/p.txt')).toEqual([
      '--system-prompt', '@C:/t/p.txt', '--exclude-dynamic-system-prompt-sections',
    ]);
  });
});
```

`voice-brain-session.test.ts`: in the existing spawn-args test (grep `--setting-sources`), add `expect(pty.spawnCalls[0]!.systemPromptMode).toBe('replace')`.

- [ ] Run, red. Implement: in `pty-host.ts` add `export function systemPromptArgs(mode: 'append' | 'replace', file: string): string[]` and use it at line ~437 (`args.push(...systemPromptArgs(opts.systemPromptMode ?? 'append', systemPromptFile))`). In `voice-brain-session.ts` spawn: `systemPromptMode: 'replace'` and the `VoiceBrainSessionDeps.spawnLex` opts type gains the field. Run, green, tsc. Commit `fix(voice): Layer 1 replaces Claude Code's default system prompt (BUG-033)`.

---

### Task 2: Contract v3 (manner not lines, first person, no facts, AI commands, barge policy) and the word gate withdrawn (BUG-030 reversal to spec)

**Files:** `voice-top-layer.ts` (CONTRACT ~173-260, `TopLayerControl` + `CONTROLS` ~33-72), `lex-voice-commands.ts` (delete `SpokenControl`, `SPOKEN_CONTROL_RES`, `matchSpokenControl`), `lex-voice-ws.ts` (delete the word-gate block after the panic check and the import), tests `voice-top-layer.test.ts`, `lex-voice-commands.test.ts`, `persona.test.ts`.

- [ ] Tests: in `voice-top-layer.test.ts` replace the VL-14 examples test with:

```ts
  it('v3: directive shapes only, no scripted sentences; first person; no facts; barge policy; AI commands', () => {
    const p = buildTopLayerSystemPrompt();
    expect(p).toMatch(/Shapes \(what you heard -> the trailing lines/);
    expect(p).not.toMatch(/I can't see that from here/);
    expect(p).not.toMatch(/One moment, checking/);
    expect(p).toMatch(/his finished work is yours to report in the first person/);
    expect(p).toMatch(/never Claude Code/);
    expect(p).toMatch(/CONTROL: finish/);
    expect(p).toMatch(/CONTROL: answer_then_finish/);
    expect(p).toMatch(/Unsigned means rethink/);
    expect(p).toMatch(/whatever words he used/);
    expect(p).toMatch(/say how old/);
    /* Operator, 2026-09-22 evening: human speech, no names or symbols read
     * aloud; longer when it helps; challenge him; say when a deeper look
     * will take a while and keep him company meanwhile. */
    expect(p).toMatch(/never read a file name, a path, a symbol or code aloud/i);
    expect(p).toMatch(/longer explanation/);
    expect(p).toMatch(/better way/);
    expect(p).toMatch(/take a while/);
    expect(MAX_SPEECH_CHARS).toBeGreaterThanOrEqual(2400);
    for (const v of ['finish', 'answer_then_finish', 'slower', 'faster', 'louder', 'softer', 'start_over', 'approve_handover', 'reject_handover']) {
      expect(CONTROLS.has(v as never)).toBe(true);
    }
  });
```

In `lex-voice-commands.test.ts` delete the `matchSpokenControl` describe and the import. Add: `it('exports no phrase matcher other than panic', () => { expect(Object.keys(mod).filter(k => /match/i.test(k))).toEqual(['matchPanicCommand']); })` with `import * as mod from '../src/voice/lex-voice-commands.js'`.

- [ ] Implement. `TopLayerControl` gains the nine verbs; `CONTROLS` too. CONTRACT: rewrite the examples block as

```
Shapes (what you heard -> the trailing lines that follow your own words):
- a status question the [live] block answers -> no directive
- a status question the block cannot answer, or anything about the
  project, its goals, branches, plans or the worker's work -> FORWARD: <the ask>
- a correction while a reply is being delivered (during_tts: yes) ->
  CONTROL: drop_reply then FORWARD: <the new direction>
- an aside or agreement while a reply is being delivered -> CONTROL: finish
  (or CONTROL: answer_then_finish when the aside deserves an answer first)
- a clarification of the ask still queued -> CONTROL: combine then FORWARD: <the clarified ask>
- a request to hear it again, slower, faster, louder, softer, from the
  start -> CONTROL: repeat | slower | faster | louder | softer | start_over
- mute, unmute, stand by, listen, end the session, in whatever words he
  used -> the matching CONTROL line, always, as the last line
- a plan or a handover pending and his yes or no -> CONTROL: approve_plan |
  reject_plan <why> | approve_handover | reject_handover <why>
- the TV, another person, your own echo -> IGNORE: <two words>, nothing spoken
```

Add a "How you talk" paragraph: "Like a person. Never read a file name, a path, a symbol or code aloud; say what it is ('the sessions module', 'that commit', 'the config'). Short by default; when a longer explanation helps him, give it, whole. When you see a better way or a soft premise, say so once, then help. When you hand something down and know it will take a while, say so in your own words and keep him company while the deeper part works; that is what you are for." Export `MAX_SPEECH_CHARS` and raise it to 2400. Replace the interrupt paragraph with the v3 policy (FINISH / ANSWER THEN FINISH / RETHINK, "Unsigned means rethink"). Add the identity lines ("his finished work is yours to report in the first person"; "You are never Claude Code; out loud there is one of you"). Add "say how old a fact is when you use one" to rule 8's text. Remove the mute word gate: delete the block in `lex-voice-ws.ts` after the panic check, the `matchSpokenControl` import, and the function + type + regex table in `lex-voice-commands.ts`. Keep the parser inference and `STAGE_DIRECTION_LINE`. Update `LEX_SPOKEN_RULES` only if a pin needs it (none). Run the three files + wire test, green, tsc. Commit `feat(voice): contract v3, AI-interpreted commands, word gate withdrawn`.

---

### Task 3: Barge v3: stop first, decide second, resume is text

**Files:** `lex-voice-ws.ts` (`dropBargeStash` ~4025, `confirmRealBarge` ~4038, echo-drop ~4868, the `layer` echo branch ~4740, `applyTopLayerControl` ~3321, `runTopLayerVoiceTurnOnce` ~4973, `buildLive` ~3248, `playback-stopped` ~5647), `voice-top-layer.ts` (`LiveBlock.cut`, `renderLiveBlock`), engine `barge-classifier.ts` (already has buckets), tests `lex-voice-ws-top-layer-wire.test.ts`, `voice-top-layer-live-block.test.ts`, `voice-barge-resume.test.ts` (extend).

**Interfaces:**
- `export type BargeDecision = 'resume' | 'resume_after_reply' | 'rethink' | 'none'`
- `export function _bargeDecisionImpl(i: { stashAlive: boolean; bucket: 'echo' | 'noise' | 'backchannel' | 'stop' | 'real'; control: TopLayerControl | null }): BargeDecision` (no stash: `none`; echo/noise/backchannel: `resume`; stop: `rethink`; real + `finish`: `resume`; real + `answer_then_finish`: `resume_after_reply`; real otherwise: `rethink`).
- `LiveBlock.cut: { heard: string; remainder: string } | null` rendered as `       cut: heard "...tail of what played" | remainder "first words of what did not..."` (each capped 160 chars).

- [ ] Tests:

```ts
describe('_bargeDecisionImpl (v3)', () => {
  const b = (o: Partial<Parameters<typeof _bargeDecisionImpl>[0]>) =>
    _bargeDecisionImpl({ stashAlive: true, bucket: 'real', control: null, ...o });
  it('engine buckets resume without the model', () => {
    for (const bucket of ['echo', 'noise', 'backchannel'] as const) expect(b({ bucket })).toBe('resume');
  });
  it('stop class and unsigned real words rethink; finish resumes; answer_then_finish resumes after the reply', () => {
    expect(b({ bucket: 'stop' })).toBe('rethink');
    expect(b({})).toBe('rethink');
    expect(b({ control: 'drop_reply' })).toBe('rethink');
    expect(b({ control: 'finish' })).toBe('resume');
    expect(b({ control: 'answer_then_finish' })).toBe('resume_after_reply');
  });
  it('no stash means nothing to decide', () => {
    expect(b({ stashAlive: false, control: 'finish' })).toBe('none');
  });
});
```

Live block: `renderLiveBlock({ ...BASE, cut: { heard: 'we shipped the fix', remainder: 'and the tests are green' } })` contains `cut: heard "we shipped the fix" | remainder "and the tests are green"`.

`voice-barge-resume.test.ts` (existing file pins `_resumeBargedSpeechImpl`): add a pin that `resumeBargedSpeechFromStash` slices at a sentence boundary: with `fullRunText = 'One two three. Four five six. Seven eight.'` and `playedMs` mapping into sentence two, the spoken remainder starts with `'Four five six.'` (re-speak the cut sentence whole, never mid-word). Implement via a new pure `sliceRemainderAtSentence(fullRun, heardChars): string` exported from `lex-voice-ws.ts` that backs up to the start of the sentence containing `heardChars`.

- [ ] Implement in `lex-voice-ws.ts`:
  1. `resumeBargedSpeech(reason)` closure: if `bargeStash` is null return false; compute via `_resumeBargedSpeechImpl({ stash, nowMs: Date.now(), ttsBusy: Boolean(state.ttsActive) || state.ttsQueueRunning || state.ttsQueue.length > 0, partialChain: state.partialChain, speak: (t) => speakCtrl.speak(t), reason, log: logFn })`, but with the remainder pre-sliced by `sliceRemainderAtSentence`; on true log `[voice-ws] barge: resumed (${reason})`; then `bargeStash = null`.
  2. Engine buckets: at echo-drop (~4868) call `resumeBargedSpeech('engine-echo')` instead of `dropBargeStash('echo-filter')`; at the blank-audio / noise drop and at a backchannel verdict (add `isBackchannelUtterance(trimmed)` check right after the echo branch: log `[voice-ws] backchannel during TTS; resuming`, resume, return). Keep `confirmRealBarge` for the stop class (rethink, Ctrl+C stays gated as today).
  3. L1 decision: in `runTopLayerVoiceTurnOnce`, after the turn, `const decision = _bargeDecisionImpl({ stashAlive: Boolean(bargeStash), bucket: 'real', control: turn.control })`; `resume` -> `resumeBargedSpeech('l1-finish')` after the speak actions; `resume_after_reply` -> set `pendingFinish = true` and resume on the next `playback-drained` frame (add `if (pendingFinish) { pendingFinish = false; resumeBargedSpeech('l1-answer-then-finish'); }` in the `playback-drained` case); `rethink` -> `dropBargeStash('rethink')` plus the existing `drop_reply` / `cancel_redirect` handling; log `[voice-ws] barge: ${decision}`.
  4. `buildLive`: when `bargeStash` is alive and `fullRunText` + `playedMs` known, set `cut` from `truncateToHeard` (heard tail 160 chars, remainder head 160 chars).
  5. `applyTopLayerControl`: `case 'finish': case 'answer_then_finish': return;` (the decision above owns the effect).
  Run the three test files + the full voice set (`npx vitest run tests/voice-*.test.ts tests/lex-voice-*.test.ts`), green, tsc. Commit `feat(voice): barge v3, stop first then finish, rethink or answer then finish; resume is text (spec restored)`.

---

### Task 4: Delivery-parameter verbs and the last-reply cache

**Files:** `lex-voice-speak-controller.ts` (cache + `setLengthScale`), `lex-voice-ws.ts` (`applyTopLayerControl` cases `repeat`, `start_over`, `slower`, `faster`, `louder`, `softer`), `piper.ts` (`synthesize(text, { lengthScale? })` if not already accepted; check `synthesize` signature first), client frame `{ t: 'tts-gain', gain }` (Agent B implements `setGain` on the sink; the WS just sends it), tests `lex-voice-ws-speak-queue.test.ts` (extend), `lex-voice-ws-top-layer-wire.test.ts`.

**Interfaces:** `SpeakController.lastReply(): string | null`, `SpeakController.setLengthScaleMultiplier(m: number)` (clamped 0.5 to 2.0, multiplies the persisted `length_scale` for this connection), `export function _deliveryParamStepImpl(current: number, verb: 'slower' | 'faster'): number` (slower x1.25, faster x0.8, clamped).

- [ ] Tests: `_deliveryParamStepImpl(1, 'slower')` is 1.25; `(2, 'slower')` stays 2; `(1, 'faster')` is 0.8; `(0.5, 'faster')` stays 0.5. Controller: after a natural end, `lastReply()` returns the full run text of the last turn (joined segments); `speak` after `setLengthScaleMultiplier(1.25)` calls `synthesize` with `{ lengthScale: base * 1.25 }` (fake synth records opts).
- [ ] Implement: the controller records segments of the current run into `runTexts` and exposes them on natural end as `lastReply`; `speakOne` passes `{ lengthScale }` to `deps.synthesize(text, opts)`; `applyTopLayerControl`: `repeat` and `start_over` speak `speakCtrl.lastReply()` (already partly there for `repeat`; unify); `slower` / `faster` step the multiplier then re-speak `lastReply()`; `louder` / `softer` send `{ t: 'tts-gain', gain }` stepping 1.0 by 0.2 within 0.2 to 1.0 and re-speak. Green, tsc. Commit `feat(voice): repeat, start over, slower, faster, louder, softer as re-rendered delivery, no brain hop`.

---

### Task 5: The handover frame (T5) with two visible halves

**Files:** create `07-daemon/src/lex/handover-frame.ts`, extend `handover-writer.ts`, test `handover-frame.test.ts` (create).

**Interfaces:**

```ts
export interface HandoverWorkerHalf {
  author: { role: 'worker' | 'daemon-trail'; sessionId: string | null; at: string };
  verifiedState: string; whatIWasDoing: string; decisionsInForce: string; stoppingPoint: string;
}
export interface HandoverLexHalf {
  author: { role: 'lex'; sessionId: string | null; at: string };
  corrections: string[]; nextSteps: string; planReference: string; verdict: 'approved' | 'revised' | 'rejected';
}
export interface HandoverFrame {
  anchorId: string; kind: 'auto-clear' | 'session-end' | 'crash-recovery' | 'lex-self-clear';
  createdAt: string; worker: HandoverWorkerHalf; lex: HandoverLexHalf | null; unvetted: boolean;
}
export function renderHandoverFrame(f: HandoverFrame): string;   // markdown, "## Worker draft" then "## Lex review"
export function parseHandoverFrame(md: string): HandoverFrame | null;
export function vetHandoverFrame(f: HandoverFrame): { ok: boolean; issues: string[] };  // slots non-empty, no transcript dump (>6000 chars or >40% lines starting with "user:"/"assistant:"), next steps present when lex half exists
export function reseedFromFrame(f: HandoverFrame): string;  // the text pasted after /clear: worker slots + Lex next steps, under 2400 chars, no headers
```

`handover-writer.ts`: `writeFrameHandover(f, opts)` (same dir, filename `HANDOVER-<iso>.md`, content `renderHandoverFrame`), `listHandovers(anchorId, opts): Array<{ file: string; createdAt: string; kind: string; unvetted: boolean; verdict: string | null }>` (parses the head of each file; newest first), `readHandover(anchorId, file)`, `archiveOldHandovers(anchorId, keep = 10)` (moves older files into `archive/` and rewrites `HANDOVER-INDEX.md` with one line per archived file: date, kind, first line of what-I-was-doing).

- [ ] Tests: round trip `parseHandoverFrame(renderHandoverFrame(f))` deep-equals `f`; render order and labels ("## Worker draft (worker session abcd1234, 2026-09-22T...)", "## Lex review (approved, 2026-09-22T...)", "### Corrections" one per line, "### Next steps"); an unvetted frame renders the banner `> Recovered from the jsonl trail after a crash. Unvetted.`; `vetHandoverFrame` rejects empty slots and a transcript dump; `reseedFromFrame` under 2400 chars with no `#` lines; `listHandovers` sorts newest first from an injected readdir; `archiveOldHandovers` keeps 10 and writes the index (injected fs).
- [ ] Implement, green, commit `feat(lex): T5 handover frame with visible worker and Lex halves; list, read, archive`.

---

### Task 6: Phase C routes: handover-request, review, clear-and-paste by handover id, clear-handoff serves the approved one, one auto-clear switch

**Files:** `smart-clear-routes.ts`, `smart-compact-routes.ts` (`ClearAndPasteOptions.handoverId?`, `clearAndPaste` reads the frame and pastes `reseedFromFrame`), `routes.ts` (`/worker/clear-handoff`: when an approved, unconsumed handover exists for the anchor within 15 minutes, return its reseed as `block` and mark consumed; `POST /lex/clear-handoff` for Lex's own), `smart-clear.ts` (`autoClearMode(db)` reading `auto_clear_mode` then falling back to the pair; `setAutoClearMode(db, mode)` writes all three keys), tests `smart-clear-routes.test.ts` (extend or create with Fastify inject).

**Routes:**
- `POST /lex/smart-clear/handover-request { anchor_id }`: injects the T5 wrap prompt into the supervised worker via the existing inject path with `caller_label: 'smart-clear'` (exempt from the gate), asking it to answer with the four worker slots under fixed headings and the word `ready`; logs `[smart-clear] handover requested anchor=<id8>`; returns `{ ok, request_id }`.
- `POST /lex/smart-clear/review { anchor_id, worker_draft: {...}, lex: { corrections, next_steps, plan_reference, verdict } }`: builds the frame (`kind: 'auto-clear'`), `vetHandoverFrame`, `writeFrameHandover`, registers `{ handover_id, file, reseed }` as pending-approved for the anchor, notifies L1 `[handover-ready]` through the voice-layers wire (Task 8), returns `{ ok, handover_id, file, vet, reseed }`.
- `POST /lex/smart-compact/clear-and-paste { anchor_id, handover_id }`: pastes `reseedFromFrame` of that file; audit row `caller: 'smart-clear'`, `reason: 'ctx-fill-clear'`, `payload_text: reseed`.
- `GET /lex/anchors/:id/handovers`, `GET /lex/anchors/:id/handovers/:file` (file must match `^HANDOVER-[0-9A-Za-z_-]+\.md$`; 404 otherwise; scoped to the anchor's own dir).
- `GET /lex/auto-clear/mode`, `POST /lex/auto-clear/mode { mode }`: one switch; writes `auto_clear_mode`, `smart_clear_mode`, `smart_compact_mode`.
- `POST /lex/clear-handoff { session_id, cwd }`: for a Lex (brainstorm cwd) session, serve `reseedFromFrame(findLatestHandover)` when it is a `lex-self-clear` frame under 30 minutes old.

- [ ] Tests (Fastify inject against a temp SQLite via the existing test store helpers; look at `tests/smart-compact-routes.test.ts` for the rig): review persists a file whose content has both halves; `handovers` lists it; a foreign anchor's list is empty (scope pin); `clear-and-paste` with `handover_id` pastes the reseed text (fake injector records it); `auto-clear/mode live` sets all three keys; `clear-handoff` for a worker cwd with a pending approved handover returns its reseed once, then the legacy block.
- [ ] Implement, green, commit `feat(lex): Phase C routes, handover review persisted, clear-and-paste by handover id, one auto-clear switch`.

---

### Task 7: Session-end and crash handovers

**Files:** `session-end-pipeline.ts` (in `runSessionEndPipeline`, after the distill flush: build a `session-end` frame with worker slots from `extractWorkerActivity(readWorkerTail(jsonl))` for the supervised worker when bound, or the brainstorm's own tail for Lex, `lex: null`, `unvetted: true`; `writeFrameHandover`; never throws), `crash-recovery.ts` (`defaultRecover` also writes a `crash-recovery` frame with the banner), tests `session-end-handover.test.ts` (create), `crash-recovery.test.ts` (extend).

- [ ] Tests: `runSessionEndPipeline` with an injected `writeHandover` dep records one call with `kind: 'session-end'`; a throwing writer does not fail the pipeline; the crash sweep's recover writes `kind: 'crash-recovery'`, `unvetted: true`.
- [ ] Implement (add `writeHandover?: (f: HandoverFrame) => void` to `SessionEndDeps` and `RecoverCrashedOptions`, default the real writer), green, commit `feat(lex): a handover at every session end and after a crash, from the trail`.

---

### Task 8: Handover approval by voice and the L2 rules

**Files:** `voice-layers-wire.ts` (a `HandoverApprovalRegistry` next to plans: `pending(anchorId)`, `approve`, `reject`; deps `clearAndPasteByHandover(anchorId, handoverId)`, `injectToLex(anchorId, text)`), `lex-voice-ws.ts` (`TopLayerControlHandlers.approveHandover / rejectHandover / pendingHandover`; `buildLive` adds `pendingHandover`), `voice-top-layer.ts` (`TopLayerEventKind` gains `'handover-ready' | 'handover-result'`; `LiveBlock.pendingHandover: string | null` rendered `       handover pending: <gist 400 chars>`), `system-prompt.ts` (L2: "Current state first" block; "You may start a worker: POST /projects/:id/start-claude for the supervised project when a deeper look needs one"; driver loop steps rewritten to handover-request -> review -> wait for the spoken approval (the daemon answers `held_for_approval`) -> clear-and-paste { handover_id } -> confirm; the worker wrap prompt text with the four headings), tests `voice-layers-wire.test.ts` (extend), `voice-top-layer-live-block.test.ts`, `system-prompt-scope.test.ts` or a new `system-prompt-lex-control.test.ts`.

- [ ] Tests: review registers a pending handover and `notify` receives `handover-ready` with the gist; `approve_handover` calls `clearAndPasteByHandover` once and clears the pending; `reject_handover 'missing the migration'` injects `[handover-rejected] missing the migration` to L2 and clears; live block renders `handover pending:`; the L2 prompt contains `Current state first`, `start-claude`, `handover-request`, `held_for_approval`.
- [ ] Implement, green, tsc, commit `feat(lex): handover approval by voice; Lex checks current state first and may start a worker`.

---

### Task 9: Lex self-clear (T4) with an outside approver and the stagger rule

**Files:** `routes.ts` (`POST /lex/self-clear { anchor_id }`: builds a `lex-self-clear` frame from the brainstorm tail plus the worker's latest handover, asks the judge session (`askText`, a headless claude on the subscription) to vet it against the plan reference with a yes/no and one line of issues, persists it, refuses with 409 when a worker clear is in flight for the anchor, then types `/clear` into the L2 PTY through the existing injector), `hook-runner.ts` (`clear` / `compact` branch: `postLexClearHandoff(sessionId, cwd)` before `postClearSupersede`, only when the cwd is the brainstorm dir), `system-prompt.ts` (L2: at its own setpoint, call `POST /lex/self-clear` and stop; never while a worker clear is in flight), tests `lex-self-clear.test.ts` (create).

- [ ] Tests: the route writes a `lex-self-clear` frame, calls the injected judge once, refuses with 409 while `workerClearInFlight(anchor)` is true, and types `/clear` only after the judge said yes; the hook posts to `/lex/clear-handoff` on `clear` for the brainstorm cwd and not for a project cwd.
- [ ] Implement, green, commit `feat(lex): Lex self-clear with an outside approver, staggered against the worker`.

---

### Task 10 (Agent A, worktree): context gauge on every session surface, handover list, one auto-clear switch label

Daemon: `anchor-tiles.ts` adds `worker_ctx_pct: number | null`, `lex_ctx_pct: number | null`, `ctx_threshold_pct`, `ctx_ceiling_pct` (worker: `deriveContextFromTail(transcriptPathFor(worker cwd, current_session_id))`; Lex: the anchor's current transcript; thresholds from `smartClearConfig`); `sessions.ts` `listSessions` rows add `ctx_pct` (already derived for live_state; expose it). Tests: `lex-anchor-tiles-supervised-slug.test.ts` extended with the four fields; a `/sessions` pin. Dashboard: `components/ContextGauge.tsx` (a bar with two marks; props `pct`, `thresholdPct`, `ceilingPct`, `label`; colour idle below the trip, warn between, alarm above; text `42% of context, clears at 40%`), used in `StreamDeck.tsx` (brainstorm tile: Lex gauge; nested worker tile: worker gauge), `LexSessionList.tsx` rows, `app/sessions/page.tsx` rows; `SmartCompactPanel.tsx` label `Auto-clear` and the toggle posts `POST /lex/auto-clear/mode` (fallback to the two old endpoints if 404). `components/HandoverList.tsx` in `BrainstormDetail.tsx`: fetch `GET /lex/anchors/:id/handovers`, newest first, each row date, kind, verdict, "unvetted" badge, expand to show the file. Tests: `ContextGauge.test.tsx` (marks positioned by pct, colour classes), `HandoverList.test.tsx` (renders rows, unvetted badge). Commit on the agent's branch, `Rebuild: yes`.

### Task 11 (Agent B, worktree): continuous stream sink, first chunk starts playback, no added latency

`08-dashboard/lib/voice-engine/stream-sink.ts`: pure scheduler over an injected `AudioContextLike` (`currentTime`, `createBuffer`, `createBufferSource`, `destination` as a `MediaStreamAudioDestinationNode`-like) implementing the `PlaybackQueue` interface plus `setGain(g: number)`: `beginSegment` opens a segment; `appendPcm` decodes int16 to float and schedules the chunk at `max(playhead, now + leadMs)` where `leadMs` starts at 60 and grows by 40 on each underrun (a chunk that arrives after its slot) up to 400; `endSegment` inserts `gapMs` (120) of silence padding before the next segment's first chunk so the element never stops between sentences; `cancelAll` stops every scheduled source, returns played ms (playhead consumed minus padding), bumps the generation; `onPlaybackStart` fires on the first scheduled chunk of a run; `onDrained` fires when the last scheduled source ends and no segment is open. `audio-stream-sink.ts`: browser binding: one `AudioContext`, `createMediaStreamDestination()`, `audio.srcObject = dest.stream`, `audio.play()` once on the start gesture, gain via a `GainNode` (`setGain`). `VoiceClient.tsx`: `ensureSink` creates the stream sink; the `tts-gain` frame calls `setGain`. Tests (`stream-sink.test.ts`): first chunk schedules at `now + 60ms` (no whole-segment wait); a late chunk grows the lead; padding between segments; `cancelAll` played ms equals the audio consumed at `now`; a three-segment reply produces exactly one `onPlaybackStart`; `onDrained` once at the end. Keep `playback-queue.ts` in the tree for the tests that pin it; nothing imports it from VoiceClient any more. Commit on the agent's branch, `Rebuild: yes`.

---

### Task 12: Merge, suite, build, trackers, restart, verify

- [ ] Merge Agent A and Agent B branches into `voice-layers` (resolve any conflict in `routes.ts` by keeping both); full daemon suite (only the known reds); dashboard suite (only the known reds); `npm run build` in both packages.
- [ ] Pin: no `@anthropic-ai/sdk` import and no `ANTHROPIC_API_KEY` read under `07-daemon/src` (a source test in `tests/no-anthropic-api.test.ts`).
- [ ] BUGS.md: BUG-032, BUG-033 -> SMOKE-TESTING; BUG-030 detail: word gate withdrawn per spec, parser inference kept; FIXES.md rows VL-17 onward; HANDOVER.md cursor; spec cross-links.
- [ ] Restart (operator-authorised), Open `4bbafb48`, verify: `--system-prompt` in the L1 argv (`/pty` command), warm line, no `anchor=default`, `[handover-ready]` path exercised with a synthetic review call, `auto-clear/mode` returns one value, tiles carry `worker_ctx_pct`.
- [ ] Hand the spoken items (LAYER-1-CONTROL.md live list 1 to 10) to the operator.
