# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files
(archived under `docs/archive/`) and the per-cycle `SESSION-HANDOVER`
/ `SMOKE-HANDOVER` / `OVERNIGHT-*` notes. Update this file in place
every time the active cursor moves; do not add a new dated file.

The rule: anyone reading this should be able to start cold and know
**where the code is**, **what is in flight**, **what is shippable
next**, and **what blockers exist**.

Last touched: 2026-06-01 after Fix 59 + Fix 60 ship (TTS sanitizer +
distillation dump helper). Tree clean. Daemon restarted onto the
latest dist.

## Where we are

DevNeural v2 is a local-first second brain (capture, semantic RAG,
learning wiki, real-time recommendation, reinforcement, central
dashboard, voice/TTS, Lex CC supervisor). Phases 1 - 6 shipped.
Phase 7 (speaker diarization) deferred. Phase 8 reliability plan in
`docs/spec/PHASE-8-RELIABILITY-PLAN.md`.

Major contract specs (all current, all shipped):

- `docs/spec/FUNCTIONAL-SPEC.md`: architecture.
- `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md`: codex 1-12 contract.
  Stages 5-12 all shipped (Fix 36 through Fix 49).
- `docs/spec/LEX-STANDALONE-SUPERVISION.md`: idle watcher.
- `docs/spec/COALESCE-UTTERANCE-QUEUE.md`: voice queue. Phase A
  shipped (Fix 35 + Fix 40). Phase B + C shipped 2026-06-01 (Fix 57:
  classifier, conflict push-back, AbortController, text-input WS
  frame).
- `docs/spec/PROJECT-ANCHORS.md` `## Seeding` section (line 57)
  shipped 2026-05-31 (Fix 52). Boot enumeration + fs.watch +
  bridge-presence inline auto-create.

All other waves and phase plans live in `docs/archive/spec/`.

## Live state (2026-06-01 post Fix 59 + Fix 60)

- Daemon: pid varies (lazy-restart on hook events). Running on the
  Fix 59 dist after the 2026-06-01 12:44 EDT restart. `GET /health`
  returns `ok:true` with `llm.name=ollama configured=true`.
- Dashboard: prod static on port 3747 (Tailscale-exposed), dev
  hot-reload on port 3000. Both 200.
- Dashboard supervisor (`dashboard-supervisor.ts`) wired into
  daemon.ts boot: daemon owns the `next dev -p 3000` lifecycle now.
  `runtime_config.dashboard_supervisor_enabled` gates; default on.
- Tests: 1123/1123 daemon pass. 138/138 dashboard unit pass. `tsc`
  clean both sides.
- Active brainstorms in DB: 0 (all `status='ended'`). Lex idle. New
  work requires a fresh brainstorm spawn.
- Cold-start preload audit: `POST /lex/cold-start-preload` returns
  blocks with the Fix 55 verdict envelope
  (`context_verdict=<verdict> last_child=<title>
  child_ended_ms=<n> distillation_gap_ms=<n>`). 5 sibling distilled
  summaries surface inline against `4bbafb48` (DevNeural Testing).
- Distillation worker: Fix 54 jsonl-fallback live in production.
  Boot recovery sweep capped at 20 rows fires at +5s of every
  daemon boot. The 11 historically un-recoverable rows are dead
  data (chunks=0 AND transcript_path missing on disk) per audit in
  `docs/bugs/2026-05-31-project-anchors-not-seeded-silent-drop.md`.
- One scoped brainstorm: 4bbafb48 (DevNeural Testing) ->
  391b88f6 (DevNeural project anchor). Migration 044 backfill +
  codex 12c auto-inherit both correct on this row.
- Project anchors: 7 dirs seeded into `project_session` on the
  first post-Fix-52 boot, idempotent thereafter.

## Most-recent shipped (current cycle, oldest first)

Every row marked ✅ is in the running daemon after the latest restart.

| Fix | Title | Commit |
|-----|-------|--------|
| 47 | loose-ends handoff gate (codex 10) | 3da61e1 + d9bc5d7 + a82451f + 40f4624 + 89de4d7 + 528c56e |
| 48 | grooming / escalation watch (codex 11) | b9e5757 + 598e58a + 190e565 + 77c703c + 6c43d32 |
| 49 | project_scope_id + sibling-index scope swap (codex 12) | 7df66e0 + 71729d3 + dc26f88 + b189956 + ecab2d8 + 20419a8 + 196a9b2 |
| 50 | PRELOAD-1 SessionStart hook stdout shape | b18ffaa + 20147a7 |
| 51 | cc-pty double-talk: pcm 'end' release, not proc.exit | e0978ee |
| 52 | project anchors seeded on boot + bridge-presence auto-create on unknown cwd | f758514 |
| 53 | cold-start distillation boot recovery sweep + partial verdict promoted from green OK | 9f754f4 |
| 54 | jsonl-fallback distillation closes the chunkless-skip gap | 1b5021b |
| 55 | context_verdict + last_child surface + Lex cold-start vetting protocol | a9779ed |
| 30 | voice "lex end session" = End button parity | 9c08e4f |
| 56 | per-preload catchup ceiling bump (3 -> 6 refs, 5s -> 8s budget) | 9c08e4f |
| 57 | COALESCE Phase B (classifier + conflict push-back + AbortController) + Phase C (text-input WS frame) | a24a83b |
| 59 | TTS sanitizer (server-side enforcement of voice-mode rules) | 7779af0 |
| 60 | distillation dump-to-markdown helper (`npm run dump-distillations`) | 7779af0 |

(Fix 58 was skipped; the dashboard rebuild supervisor it was reserved
for had already shipped pre-cycle. No row.)

## In flight (open work)

**None.** Every item the operator complained about during the
2026-05-31 to 2026-06-01 cycle is closed. The two larger spec
threads (LEX-AUTONOMY codex 1-12, COALESCE Phase A-C) are fully
shipped.

## Diagnosed but unshipped (waiting on hardware or scope)

These are real outstanding fixes. Each has a `docs/bugs/` file or a
TODO line; pick whichever matches the next operator priority.

- **Voice PTY paste-no-commit regression**
  (`docs/bugs/2026-05-29-voice-pty-paste-no-commit-regression.md`).
  Investigation shipped 2026-05-29 (`94ad63f`); ship deferred. Scope:
  mirror Fix 32 850ms bare-CR follow-up into the direct-inject path
  at `lex-voice-ws.ts:2147`. Closes the `[Pasted text #N +5 lines]`
  stuck-paste failure mode in voice mode.
- **Fix 24** mid-reply TTS truncation. Watchdog `ctx_state` gate.
- **Fix 25** mic input level + sensitivity scaling. vadThresholds
  mapping + GainNode before silero + clearer toast.
- **Fix 26** `Lex hold up` wake-phrase kills mic permanently.
  Asymmetric cancel path. `runHoldUp.cancelTts` does not send
  `tts-cancel` frame; add the frame OR add the client-side handler.
- **WASM/VAD OOM follow-ups** (open per `TODO.md` line 68):
  (b) COOP/COEP headers to unlock SharedArrayBuffer + bigger heap;
  (d) singleton ORT init so VAD remount reuses the existing WASM
  module. Hardware repro needed before tuning the fix.

## Active smoke gate (operator hardware required)

Live punch list source of truth: `docs/SMOKE-TEST.md`. Operator-
pending items as of 2026-06-01:

- 1.1 / 1.2 / 1.3: loose-ends gate live verification (dashboard
  click with dirty worktree, banner dismiss + mute, voice `lex
  start project` outcome).
- 2.4: parked_question_persistent push notification on subscribed
  device.
- 3.3: cold-start preload on a fresh label-match fallback anchor;
  header reads "same project scope <id>" not "same label X".
- 4.1 / 4.2: fresh Lex CC SessionStart + worker CC SessionStart
  read the DevNeural cold-start block out of jsonl attachments.
- 5.1 / 5.2 / 5.3: voice mode tool_use sequence + barge.
- 6.1 - 6.5: project anchor seeding live verification (count
  matches disk, idempotent, fs.watch picks up new dir, unseeded
  presence triggers auto-create, dashboard panel renders).
- 6.7: live brainstorm spawn + Lex first-reply vetting against the
  Fix 55 verdict envelope. The single most valuable smoke step
  right now because it closes the loop on the four-fix cycle (52
  through 55).

## Hard rules

- Lex orchestrates commits. Worker executes per Lex instruction.
- Workers spawn standard or `acceptEdits`. NEVER
  `--dangerously-skip-permissions`.
- Never push to remote. Never force-anything.
- Never auto-restart the daemon (operator-only) UNLESS the operator
  has explicitly authorized the restart in the same conversation.
- Two-spec policy: investigation doc first, ship second. Both
  commits are atomic and follow the two-commit pattern (code +
  FIXES row). When a fix ships, the per-bug investigation doc
  status line MUST be flipped to CLOSED + SHA + FIXES pointer in
  the same cycle.
- Atomic commits. Every commit body carries `Rebuild: yes/no
  <reason>`.
- No em dashes anywhere (output, code comments, test fixtures, docs,
  commit messages, PR bodies). Period or semicolon or hyphen.
- No AI co-author tags.

## Quick references (post-/clear future-me)

- Daemon entrypoint: `07-daemon/src/daemon.ts`.
- Project anchor seed: `07-daemon/src/dashboard/seed-project-anchors.ts`.
- Cold-start preload: `07-daemon/src/lex/lex-cold-start-preamble.ts`.
- Cold-start vetting prompt: `07-daemon/src/lex/system-prompt.ts`
  section `COLD_START_VETTING`.
- TTS sanitizer: `07-daemon/src/voice/tts-sanitize.ts`.
- Voice coalesce (classifier, push-back, drain v2):
  `07-daemon/src/voice/lex-voice-coalesce.ts`.
- Voice WS state machine: `07-daemon/src/voice/lex-voice-ws.ts`.
- Distillation generator (chunks + jsonl fallback):
  `07-daemon/src/lex/distillation-generator.ts`.
- Distillation backfill scheduler (boot recovery + steady-state
  tick): `07-daemon/src/lex/distillation-scheduler.ts`.
- Bridge presence + project-anchor inline auto-create:
  `07-daemon/src/dashboard/bridge-presence.ts`.
- Daemon log: `C:/dev/data/skill-connections/daemon.log` (treat as
  binary in grep with `-a`).
- Live index DB: `C:/dev/data/skill-connections/index.db`.
- Inline DB query: `cd 07-daemon && node -e "..."` with
  `better-sqlite3` (already a daemon dependency, no install
  needed).
- Distillation dump CLI: `cd 07-daemon && npm run dump-distillations
  -- --limit 20 --out C:/tmp/distillations-YYYY-MM-DD.md`.
- Daemon restart pattern (operator-only): find pid via
  `netstat -ano | grep ":3747 "`, `cmd //c "taskkill /F /PID <n>"`,
  lazy-start re-binds on the next hook event.

## Resume command

Pick a row from "diagnosed but unshipped" or "active smoke gate";
ship per the two-commit pattern; update this file in place when the
cursor moves. If the operator says "what's next" with no specific
ask, recommend smoke step 6.7 (live brainstorm spawn + Lex first-
reply vetting) because it closes the loop on the just-shipped Fix
52-55 cold-start cycle.
