# Overnight Run Plan — 2026-05-26 (Lex autonomous)

User went to sleep ~03:50 EDT. Asked Lex to push through as much as possible without breaking anything. Resume action items at user wake.

## Hard rules (do not violate)

- Never push to remote. Never force-anything.
- Never auto-restart the daemon. Daemon restart is an operator-only button click.
- Never bypass permissions on the worker. Worker runs standard / acceptEdits per durable rule.
- Never inject destructive ops. Worker handles its own commits with the safety it already has.
- Never speak aloud overnight (user asleep). Voice is off as a side effect of him leaving.
- Stop at 7:00 AM EDT. Final handover written before stop.
- Two-spec policy on any new fix. Investigation first, fix second.
- Vet git HEAD vs worker narration. Never trust "shipped" without HEAD advance.

## Active queue (rough priority order)

1. **cc-pty double-talk fix (Fix 38? — spec already injected)** — investigation doc shipped commit `f47ddca` (or current head), fix spec injected via lex-supervisor-cc-pty-coalesce-fix at 03:42 EDT. Watch for the fix commit. When it lands, vet (a) speak() introduces a serialize queue (b) killActiveTts clears queue + cancels in-flight (c) tests pinning four scenarios all green. Surface via supervisor wire.
2. **LEX-AUTONOMY Stages 6-12** — Stage 5 (Fix 36) already shipped. Stages 6-12 are the codex-ordered post-distillation items in `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md`. Inject them one at a time, vet each commit, move on.
3. **Step 6 gate doc work** — FIXES.md row flips for Fix 27, 28, 29, 32, 33, 34 from shipped to smoke-verified with timestamps. Self-service, no worker needed.
4. **New project + brainstorm isolation test** — handover-listed but unscoped. Defer until user awake; needs a destination project name.

## Off-limits overnight

- Step 5 voice mic-init smoke (needs mobile Safari + operator hands).
- Step 6.4 final greenlight (operator action).
- Daemon rebuild + restart for the cc-pty fix (operator action).
- Curator/reinforcement debug (out of scope; flagged in handover as separate item).

## Supervision rhythm

- Self-cron (Claude job 445dccb7) ticks every 10 minutes off the :00 mark.
- Daemon-side cron 5c231dd7 ticks every 2 min until 7am EDT, supervisor-event wire to Lex.
- Every tick: read git HEAD on DevNeural, read worker jsonl tail (94e85826), update this file's "tick log" section, decide next inject or no-op.

## Tick log (most recent at bottom)

- 2026-05-26 03:50 EDT: plan written. Worker idle after fix-spec inject. Awaiting commit.
- 2026-05-26 03:51 EDT: Fix 40 landed (be14396 + a3e7c5e). Spec sanity PASS: speak-queue + cancel-clears-queue both present. Worker claimed daemon dist rebuilt; not git-verifiable.
- 2026-05-26 03:55 EDT: narrated_success_no_commit detector fired on post-commit "Fix 40 landed" status narration. Worker session 94e85826 jsonl shows post-commit idle. Both commits real, HEAD at a3e7c5e. Detector false positive (retrospective claim, not forward prediction). NO-OP.
- 2026-05-26 03:55:39Z tick (d0267065): HEAD a3e7c5e unchanged. Worker idle 8min post Fix 40 (last assistant turn was status report). Operator interactive (asking smart-compact questions). Deferring next-queue inject until operator goes silent. NO-OP.
- 2026-05-26 04:00:55Z tick: operator cleared worker manually. New session bb73e5a4 detected (delta from snapshot). Fired refactor spec inject (lex-supervisor-policy-refactor-spec, 3851 bytes) + bare CR via bridge. Both accepted. Worker initializing.
- 2026-05-26 04:01:23Z supervisor-event: idle on new session bb73e5a4. Expected. Fresh session, inject just landed in last-prompt slot. NO-OP, monitoring next tick.
- 2026-05-26 08:04Z: Fix 41 investigation doc shipped (`docs/bugs/2026-05-26-smart-compact-policy-refactor.md`). Four sections per spec: per-function mechanical-vs-policy audit across the 4 daemon files, proposed new endpoints (`/state`, `/clear-and-paste`, `/wrap-paste`), Lex-side ownership (threshold/window/stop-classification/wrap-authorship), three-stage cutover with rollback toggle. NO CODE this round. Awaiting ship spec.
- 2026-05-26 08:05:18Z tick: HEAD 8c2519f (Fix 41 investigation). Worker bb73e5a4 end_turn idle 20s post-commit. Investigation alignment verified Sections 1 + 2: per-function audit lines correct, new endpoint shapes match the policy-out / mechanical-in split. Sections 3 + 4 not yet read. NO inject pending operator sign-off on investigation.
- 2026-05-26 08:08Z: operator approved investigation. Fired Fix 41 Stage 1 ship spec (2249 bytes) to bb73e5a4. Cron job rebuilt as 01d5966f (no 7am stop, runs until done).
- 2026-05-26 08:12:16Z tick: HEAD 8c2519f unchanged. Worker mid-tool on Stage 1 implementation, pre-tool ack "Now register the three new routes inside registerSmartCompactRoutes". Cache usage ~134k tokens (~67% of 200k ceiling). Healthy mid-turn. NO-OP.
- 2026-05-26 08:17Z: Fix 41 Stage 1 shipped (e936908). Three new endpoints (GET /state, POST /clear-and-paste, POST /wrap-paste) + migration 040 (action CHECK extended). 27 new test pins, 936/936 daemon tests pass (was 909), tsc clean. Existing /evaluate + /fire untouched. Awaiting supervisor wire vet + Stage 2 greenlight.

## Morning handover (filled at 7am or first user prompt)

Pending.
