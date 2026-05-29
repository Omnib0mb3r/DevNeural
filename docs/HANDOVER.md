# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files
(archived under `docs/archive/`) and the per-cycle `SESSION-HANDOVER` /
`SMOKE-HANDOVER` / `SMOKE-PROGRESS` / `OVERNIGHT-*` notes. Update this
file in place every time the active cursor moves; do not add a new
dated file.

The rule: anyone reading this should be able to start cold and know
**where the code is**, **what is in flight**, **what is shippable
next**, and **what blockers exist**.

## Where we are

DevNeural v2 is a local-first second brain (capture, semantic RAG,
learning wiki, real-time recommendation, reinforcement, central
dashboard, voice/TTS, Lex CC supervisor). Phases 1 - 6 shipped.
Phase 7 (speaker diarization) deferred. Phase 8 reliability plan in
`docs/spec/PHASE-8-RELIABILITY-PLAN.md`.

LEX-AUTONOMY codex 1 - 12 sequence fully shipped as of 2026-05-29
(Fix 47 + Fix 48 + Fix 49 all flipped from partial to complete).
Code-truth specs: `docs/spec/FUNCTIONAL-SPEC.md` (architecture),
`docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` (codex 1-12 contract),
`docs/spec/LEX-STANDALONE-SUPERVISION.md` (idle watcher),
`docs/spec/COALESCE-UTTERANCE-QUEUE.md` (sealed Phase A; Phase B + C
deferred). All other waves and phase plans live in
`docs/archive/spec/`.

## Most-recent shipped (current cycle, oldest first)

Per `FIXES.md` row, in commit order. Every row marked ✅ is in the
running daemon after the operator restarts.

| Fix | Title | Commit(s) |
|-----|-------|-----------|
| 47  | loose-ends handoff gate (codex 10) | 3da61e1 + d9bc5d7 + a82451f + 40f4624 + 89de4d7 + 528c56e |
| 48  | grooming / escalation watch (codex 11) | b9e5757 + 598e58a + 190e565 + 77c703c + 6c43d32 |
| 49  | project_scope_id + sibling-index scope swap (codex 12) | 7df66e0 + 71729d3 + dc26f88 + b189956 + ecab2d8 + 20419a8 + 196a9b2 |
| 50  | PRELOAD-1 SessionStart hook stdout shape | b18ffaa + 20147a7 |
| 51  | cc-pty double-talk: pcm 'end' release, not proc.exit | e0978ee |

All daemon build + dist regen done. Dashboard prod build + dev server
both running. Daemon restart at the end of the cycle leaves Fix 51
live.

## In flight (open work)

- **None right now.** Codex 1-12 sequence complete. Smoke gate is the
  next operator action.

## Diagnosed but unshipped (waiting on operator green-light or scope)

- **Fix 24** mid-reply TTS truncation. Watchdog `ctx_state` gate.
- **Fix 25** mic input level + sensitivity scaling. vadThresholds
  mapping + GainNode before silero.
- **Fix 26** Lex hold-up kills mic permanently. Add `tts-cancel`
  frame to hold_up dispatch.
- **Voice PTY paste-no-commit regression**
  (`docs/bugs/2026-05-29-voice-pty-paste-no-commit-regression.md`).
  Investigation shipped 2026-05-29; ship deferred.

## Active smoke gate

Live punch list: `docs/SMOKE-TEST.md`. Cycle-specific cursor for the
current batch is at the top of that file. Operator-pending items:

- Voice mic-init on mobile Safari (needs hands).
- Fix 51 cc-pty double-talk verification: speak through a Lex CC
  brainstorm; confirm pre-tool ack + end_turn body no longer
  overlap.
- Fix 50 cold-start preload hook envelope: fresh SessionStart in a
  Lex brainstorm; verify the audit log row's block appears in the
  first user turn's `hook_additional_context`.

## Hard rules

- Workers spawn standard or `acceptEdits`. NEVER
  `--dangerously-skip-permissions`.
- Never push to remote. Never force-anything.
- Never auto-restart the daemon (operator-only).
- Never inject destructive ops to a worker. The worker handles its
  own commits.
- Two-spec policy: investigation doc first, ship second. Both
  commits are atomic and follow the two-commit pattern (code +
  FIXES row).
- Atomic commits. Every commit body carries `Rebuild: yes/no
  <reason>`.
- No em dashes anywhere. No AI co-author tags.

## Resume command

Pick a row from "diagnosed but unshipped" or "active smoke gate"; ship
per the two-commit pattern; update this file in place when the
cursor moves.
