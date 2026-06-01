# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files
(archived under `docs/archive/`) and the per-cycle `SESSION-HANDOVER` /
`SMOKE-HANDOVER` / `SMOKE-PROGRESS` / `OVERNIGHT-*` notes. Update this
file in place every time the active cursor moves; do not add a new
dated file.

The rule: anyone reading this should be able to start cold and know
**where the code is**, **what is in flight**, **what is shippable
next**, and **what blockers exist**.

Last touched: 2026-05-31 after Fix 52 (project anchors seeding + bridge-presence auto-create).

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

## Live state (2026-05-31 post Fix 52)

- Daemon was hung (pid 6492, 590MB) following Docker Desktop install on
  Windows; process alive but refusing connections on 3747 (Hyper-V /
  HNS network filter side effect, not a code issue). Killed, lazy-
  start hook rebound on a fresh pid. Operator restart still required
  for Fix 52 dist regen.
- Dashboard: prod static at port 3747 (Tailscale-exposed), dev
  hot-reload at port 3000.
- Tests: 1080/1080 daemon pass (was 1063; +17 from Fix 52 seed + auto-
  create pins). 138/138 dashboard unit pass.
- Active brainstorms in DB: 0 (all 91 rows `status='ended'`). Lex
  is idle. New work requires a fresh brainstorm spawn.
- Cold-start preload audit: panel reported `OK Loaded 5 sibling
  sessions, ... stale: 28, synced: 0, partial` on 2026-05-31 13:36 EDT
  against `4bbafb48`. Preload pipeline degraded silently (LIVE
  verdict hides partial state). Diagnosis tracked under SMOKE-TEST
  step 6.6 + bug doc; not closed in this cycle.
- Active brainstorms in DB: 0 (all 91 rows `status='ended'`). Lex
  is idle. New work requires a fresh brainstorm spawn.
- Cold-start preload mode: `live` (runtime override). 104 audit
  rows under `caller_label='cold-start-preload'`, latest 15:04Z.
- One scoped brainstorm: 4bbafb48 (DevNeural Testing) ->
  391b88f6 (DevNeural project anchor). Migration 044 backfill +
  codex 12c auto-inherit both correct on this row.

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
| 52  | project anchors seeded on boot + bridge-presence auto-create on unknown cwd (PROJECT-ANCHORS.md `## Seeding` line 57) | f758514 |
| 53  | cold-start distillation boot recovery sweep + partial verdict promoted from green OK | 9f754f4 |
| 54  | jsonl-fallback distillation closes the chunkless-skip gap | 1b5021b |
| 55  | context_verdict + last_child surface + Lex cold-start vetting protocol | a9779ed |
| 56  | per-preload catchup ceiling bump (3 -> 6 refs, 5s -> 8s budget) | (this commit) |
| 30  | voice "lex end session" = End button parity | (this commit) |

## Smoke status (per SMOKE-TEST.md, current cycle)

| Step | Status | Notes |
|------|--------|-------|
| 0.x prep | ✅ | Daemon + dashboard built, restart done, hard-reload done |
| 1.4 loose-ends gate detection | ✅ module probe | `evaluateLooseEnds(4bbafb48)`: 2 ends. Live auto-resolve audit row pending real spawn |
| 1.1 - 1.3 | ⏳ hardware | dashboard click + voice command + dirty-worktree gate fire |
| 2.1 grooming-watch boot | ✅ | Daemon log confirms |
| 2.2 /lex/grooming/recent | ✅ | 200 {rows:[]} |
| 2.3 runGroomingTick | ✅ module probe | evaluated=0; all anchors ended; correct skip |
| 2.4 | ⏳ hardware | parked_question push fire |
| 3.1 project_scope_id | ✅ | 4bbafb48 -> 391b88f6 |
| 3.2 PATCH scope route | ✅ | 200 round-trip, audit row |
| 3.3 | ⏳ hardware | scope-vs-label header on fresh fallback anchor |
| 4.0 Fix 50 dist | ✅ | `hookSpecificOutput` envelope present, 104 audit rows |
| 4.1 - 4.2 | ⏳ hardware | first-user-turn jsonl attachment readout |
| 5.0 Fix 51 dist + tests | ✅ | `handle.done.then` removed, 7/7 pins pass |
| 5.1 - 5.3 | ⏳ hardware | voice mode tool_use sequence + barge |

## In flight (open work)

- **None right now.** Codex 1-12 sequence complete. Smoke gate is
  the next operator action OR a pick from the "diagnosed but
  unshipped" list below.

## Diagnosed but unshipped (waiting on operator green-light or scope)

- **Voice PTY paste-no-commit regression**
  (`docs/bugs/2026-05-29-voice-pty-paste-no-commit-regression.md`).
  Investigation shipped 2026-05-29 (94ad63f); ship deferred. Scope:
  mirror Fix 32 850ms bare-CR follow-up into the direct-inject path
  at `lex-voice-ws.ts:2147`. Closes the "[Pasted text #N +5 lines]"
  stuck-paste failure mode in voice mode.
- **Fix 24** mid-reply TTS truncation. Watchdog `ctx_state` gate.
- **Fix 25** mic input level + sensitivity scaling. vadThresholds
  mapping + GainNode before silero + clearer toast.
- **Fix 26** Lex hold-up kills mic permanently. Asymmetric cancel
  path; `runHoldUp.cancelTts` does not send `tts-cancel` frame to
  client. Add the frame OR add client-side handler.

## Active smoke gate (operator hardware required)

Live punch list: `docs/SMOKE-TEST.md`. Cycle-specific cursor for the
current batch is at the top of that file. Operator-pending items:

- 1.1 dashboard click with dirty worktree -> 409 + LooseEndsBanner.
- 1.2 banner dismiss + 5-min localStorage mute round-trip.
- 1.3 voice `lex start project devneural` -> spoken confirm OR
  enumerated loose ends on 409.
- 2.4 parked_question_persistent push notification on subscribed
  device.
- 3.3 cold-start preload on a fresh anchor that uses the label-
  match fallback path: header reads `# Sibling sessions (same
  project scope <id>)` not `(same label "X")`.
- 4.1 fresh Lex CC SessionStart in 4bbafb48: read jsonl, confirm
  DevNeural cold-start block in first user turn's
  hook_additional_context attachments.
- 4.2 fresh worker CC SessionStart bound to a project anchor: same
  check against worker-handoff block.
- 5.1 voice mode: ask question that triggers tool_use; pre-tool ack
  finishes BEFORE end_turn body, zero audible overlap.
- 5.2 daemon log tail: `tts-start` frames not followed by a second
  `tts-start` inside the prior piper's lifetime.
- 5.3 barge mid pre-tool ack: `tts-cancel` frame + PTY Ctrl+C +
  partialChain captures cancelled segment.

## Hard rules

- Lex orchestrates commits. Worker executes per Lex instruction.
- Workers spawn standard or `acceptEdits`. NEVER
  `--dangerously-skip-permissions`.
- Never push to remote. Never force-anything.
- Never auto-restart the daemon (operator-only).
- Two-spec policy: investigation doc first, ship second. Both
  commits are atomic and follow the two-commit pattern (code +
  FIXES row). When a fix ships, the per-bug investigation doc
  status line MUST be flipped to CLOSED + SHA + FIXES pointer in
  the same cycle.
- Atomic commits. Every commit body carries `Rebuild: yes/no
  <reason>`.
- No em dashes anywhere. No AI co-author tags.

## Resume command

Pick a row from "diagnosed but unshipped" or "active smoke gate";
ship per the two-commit pattern; update this file in place when the
cursor moves.
