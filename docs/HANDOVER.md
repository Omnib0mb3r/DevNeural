# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update. Previous cursors (2026-07-18
to 2026-09-22) are in `docs/archive/HANDOVER-history-2026-07-to-09.md`;
this file holds the current cursor only.

## Cursor (2026-09-23 afternoon: docs are the single source of truth, Layer 1 worker verbs shipped, the hours-long session hangs root-caused and fixed; everything committed, daemon PID 54996 live)

Read first: `docs/spec/LAYER-1-CONTROL.md` (v3) and `docs/spec/SMART-COMPACT.md`
section 5 are the design of record; `BUGS.md` index block for what is
known broken; `FIXES.md` VL-17 to VL-29 for what shipped on 2026-09-22/23.
The executed plan lives at `docs/archive/plans/2026-09-22-voice-and-clear-complete.md`.

### Resume here (written 2026-09-23 for a fresh session)

State: branch `voice-layers`, tree clean, four commits today on top of
`2e05283`: `7be8ea0` docs reconcile, `c5ce453` Layer 1 worker verbs
(BUG-038, VL-28), `8f8a64d` tracker rows, `1c20bfd` the hook lazy-spawn
fix (BUG-039, VL-29). Daemon PID 54996 has run since 13:20:19Z on the
09:18 dist (it carries the worker verbs); the dist was rebuilt again at
about 11:50 local for VL-29, which only changes `lifecycle/spawn.ts`, a
module the hooks execute and the daemon never calls, so no restart is
owed. Dashboard export current (09:19). Nothing is half done.

What happened, in order: (1) every live doc audited against the code
and the ten archived voice docs diffed against what shipped; the live
folder is now the truth and history is under `docs/archive/`. (2) The
voice gained `start_worker`, `stop_worker`, `panic_worker`,
`switch_project <name>` (AI-interpreted like every control; handlers in
`07-daemon/src/dashboard/voice-layers-wire.ts` on the dashboard's own
functions; spec section "The voice reaches the worker"). (3) The
operator's "stuck thinking, Escape dead, for hours" was traced to the
hooks lazy-spawning the daemon as their own child (BUG-039 detail has
the whole evidence chain and the proof rig); fixed by launching through
the `DevNeural-Daemon` scheduled task. (4) BUG-040 logged: last night's
three-minute outage was a relaunch during an `npm install`.

Do not: restart the daemon from inside a Claude session while an
install is in flight (BUG-040); resume a multi-megabyte session in the
VS Code extension when a fresh one will do (its resume budget is 60s);
re-add `docs/superpowers/` (deleted, empty); reintroduce any phrase
matcher for voice controls (closed verb set, AI-interpreted, only the
safety floor is mechanical).

Task list at handover:
- [x] Phase A docs reconcile (12 items, commit `7be8ea0`)
- [x] Phase B worker verbs (B1 to B6, commits `c5ce453`, restart 13:20Z)
- [x] BUG-039 root cause, fix, proof, commit `1c20bfd`
- [ ] Operator: spoken items 1 to 11 (LAYER-1-CONTROL "Testing")
- [ ] BUG-039 live close: the next daemon death or restart during a live session stays responsive
- [ ] BUG-040: lazy import of the unused Anthropic provider so a missing SDK never stops boot
- [ ] Shim hardening (SetHandleInformation on its std handles), noted under BUG-039
- [ ] Merge `voice-layers` into master once the spoken items pass

### 2026-09-23 daytime: docs reconcile (operator: "get it done")

Audit of every live doc against the code, plus a diff of the ten
archived voice and plan docs against what shipped. Result: every item
in the September plans is built; the July specs are built or dismissed
on the record; six items were dropped with no record (start project by
voice, the worker "danger gate", one-voice-many-projects, the neutral
test harness, Lex calling panic herself, supervisor event batching).
Decisions and where they landed:

- Roll in: worker and project effects for Layer 1 (start, stop, panic
  the worker; switch project). Tracked as BUG-038; built in the wave
  that follows this reconcile.
- Keep: all 25 current verbs, the mechanical safety floor (emergency
  stop plus the stop class), the two design-of-record specs.
- Not doing, recorded: worker permission bypass
  (`docs/FUTURE-SECURITY-CONCERNS.md`), one-voice-many-projects, the
  test harness, event batching (`docs/FUTURE-FEATURES.md` "Decided not
  to do").
- Archived: the July to September cursors out of this file, the May to
  July smoke batches out of `docs/SMOKE-TEST.md`, two resolved bug
  write-ups (BUG-036, BUG-037), the empty `docs/superpowers/`.
- Fixed pointers: LAYER-1-CONTROL (cut-reply contradiction, archived
  spec paths), SMART-COMPACT (one switch), HOW-TO-voice-and-push
  (typed path rides the WS), FUTURE-FEATURES (shipped items to
  pointers), PHASE-8 and STREAMDECK status blocks, both README files,
  INDEX.

### 2026-09-23 daytime: the voice reaches the worker (BUG-038, VL-28)

Built right after the reconcile, TDD, tsc clean, daemon suite 2264/2266
(the known pair red), dashboard suite 334/338 (the known four). Four
verbs in the closed set: `start_worker`, `stop_worker`, `panic_worker`,
`switch_project <name>`; handlers in `voice-layers-wire.ts` on the
dashboard's own functions; `worker-result` event phrased by the voice;
`switch_project` rebinds the socket and sends `brainstorm-switched`.
Spec: `docs/spec/LAYER-1-CONTROL.md` "The voice reaches the worker";
user doc: `docs/voice-commands.md`. Both packages rebuilt (daemon dist
09:18 local, dashboard export 09:19). Restart DONE 2026-09-23T13:20:19Z:
PID 4952 -> 54996, `[shutdown] complete` to `listening` in 1.2s, boot log
clean apart from the pre-existing seed line (BUG-024); no brainstorm was
live at the time, so nothing was reopened.

### 2026-09-23 afternoon: the hours-long hangs, found and fixed (BUG-039, VL-29)

The restart above hung this session for 1h51m ("thinking", Escape
ignored) until the operator quit VS Code; the 2026-09-22 heap death had
done the same for 5h12m. Cause: every hook phase lazy-spawned the daemon
as a child of the hook when its pid was dead, the daemon inherited the
CLI's hook pipe handles (Windows inheritance through the silent shim),
and Claude Code waits for that pipe to close. Fix in
`07-daemon/src/lifecycle/spawn.ts`: the launch goes through
`schtasks /run /tn DevNeural-Daemon`, never a direct child; dist rebuilt
(hooks read it on their next call, no restart needed); proof rig passed
against the live daemon. Full detail with the evidence chain in BUGS.md
BUG-039. BUG-040 is separate: last night's relaunch at 02:10Z died on a
missing `@anthropic-ai/sdk` while an `npm install` was rewriting
`node_modules`, and the relauncher recovered at 02:13Z. The spoken
verify, item 11 of the LAYER-1-CONTROL "Testing" list, needs the
operator.

Overnight 2026-09-23 (operator asleep, "full authority, no gates"):
BUG-034 and BUG-035 fixed (`6e06fd0`: the supervisor detectors read Bash
tool_results only, latched per record, a later green run clears a red
one); the voice path reads no API key at all (VL-27); superseded plans,
specs, bug postmortems and brainstorm-folder design docs archived
(`docs/archive/plans/`, `docs/archive/spec/`, `docs/archive/bugs/`,
`<DATA_ROOT>/brainstorm/archive/`); every README rewritten to the
three-layer model; the stale agent worktrees removed. The daemon still
runs the 01:48Z dist until the closing restart recorded at the end of
this cursor.

### The wave as built (2026-09-22 evening)

Operator direction: "I need this all done", no phases, merge to master at
stable points, atomic commits, tree clean. Spec of record is
`docs/spec/LAYER-1-CONTROL.md` v3 + `docs/spec/SMART-COMPACT.md` section 5.
Everything the operator said on 2026-09-22 is in the plan's Global
Constraints and Task 2 (contract): no Anthropic API ever (subscription
sessions only), scope fail-closed, no added latency in the stream sink,
human speech (no names, symbols or code aloud; longer when it helps;
challenge him; say when a deeper look will take a while).

Task state (update this line as tasks land): T1 identity DONE (`64a8a9a`).
T2 contract v3 + word gate withdrawn DONE (`58fb3cd`). T3 barge v3 DONE
(`a62eabb`). T4 delivery verbs IN PROGRESS, decisions taken: piper
`synthesize(text, opts?)` gains `opts.lengthScaleMultiplier` (applied to
`getLengthScale()`, clamped to MIN/MAX); the speak controller holds a
per-connection multiplier (`setLengthScaleMultiplier`, stepped by the
pure `_deliveryParamStepImpl`: slower x1.25, faster x0.8, clamped 0.5 to
2.0) and passes it on every `deps.synthesize(text, opts)` call (the
fake synth in `tests/lex-voice-ws-speak-queue.test.ts` records opts); no
controller-level reply cache, the WS's `lastSpokenText` already serves
`repeat`, and `start_over` is the same; `slower` / `faster` step then
re-speak `lastSpokenText`; `louder` / `softer` step a per-connection
`ttsGain` (0.2 to 1.0 by 0.2), send `{t:'tts-gain', gain}` (Agent B's
sink applies it) and re-speak. T4 DONE (`7e8af1f`). T5 handover frame DONE (`83e3810`). T11 stream sink
MERGED (`f70cde4`, Agent B). T6 Phase C routes DONE: `handover-routes.ts`
(request, review, list, read, one auto-clear switch), `handover-approval.ts`
(registry shared with the voice wire through `handoverReviewedHook.fn` in
routes.ts, unset until T8), clear-and-paste by `handover_id` +
`brainstorm_id`, `/worker/clear-handoff` serves an approved reseed once.
T7 end/crash handovers DONE (`dce6834`). T8 voice approval + L2 rules +
`turn_summary` DONE (`4ea4a15`). T9 Lex self-clear (three checks, judge,
stagger, kick, trail-confirm) + L1 clear by respawn (recent-talk ring) +
the rich context pack DONE (`043d0cd`). T10 gauge + handover list MERGED
(`c7e2f7d`, Agent A). T12 closeout: daemon suite 2260/2262 (the two known
reds: grooming-routes, sessions-anchor-liveness), dashboard suite 332/336
(the known reds: voice-mic-init x4, plus the two Playwright specs vitest
cannot run), both packages built, `tests/no-anthropic-api.test.ts` pinned, BUGS.md
032/033 SMOKE-TESTING, FIXES.md VL-17 to VL-25, specs cross-linked;
restart DONE 2026-09-23T01:48:02Z (PID 24024, 3s), live verify DONE:
the reaped brainstorm `4bbafb48` reopened (L2 cc `747a13bf`), Layer 1
spawned in `voice-l1` and warm in 9.5s, its argv carries
`--system-prompt` + `--exclude-dynamic-system-prompt-sections` and no
`--append-system-prompt` (BUG-033 fix live), `/lex/auto-clear/mode` =
live, tiles carry `worker_ctx_pct` (37) + `lex_ctx_pct` + threshold +
ceiling, `/lex/self-clear/state` and `/lex/context-pack` answer (pack
13.3k chars, DevNeural only), a synthetic review answered
`decision: no_voice` and logged `[handover] announced ... voice=false`
(the T8 hook is wired; that smoke file `HANDOVER-2026-09-23_01-51-27-454Z.md`
is labelled and can be ignored). Spoken items still need the operator
(LAYER-1-CONTROL.md "Testing"). Boot-log notes: `[voice-haiku]
api_key=present` is a legacy feature flag only (the key is stripped from
every claude child by `SPAWN_STRIP_ENV`; the only SDK client is
`llm/anthropic.ts` and the provider is ollama); `project anchor seed
FAILED: UNIQUE constraint` is a pre-existing boot line (90 in the log). Operator additions folded in during T8/T9
(2026-09-22 late): the L3 flow as he described it matches the build;
L2's self-clear handover is self-reviewed after she reads current state,
then vetted, fact-checked and judged by the daemon; L1 clears with no
handover thanks to the recent-talk ring; Lex's cold start and reseed are
rich even if they fill her context. T10 (context gauge +
handover list UI) and T11 (continuous stream sink) ran in isolated
worktree agents branched off `voice-layers`; both merged in T12 and the
worktrees removed on 2026-09-23. Every task's commit body ends
`Rebuild: yes|no`.

## Next steps (refreshed 2026-09-23 afternoon)

1. Operator: the spoken items 1 to 11 in `docs/spec/LAYER-1-CONTROL.md`
   "Testing" on the live daemon (11 is the worker by voice: start, stop,
   kill, switch, in your own words), plus one car run for the stream
   (BUG-032) and one real auto-clear cycle in live mode.
2. Any failure: grep `daemon.log` first. Voice lines are `[voice-ws]`,
   `[voice-brain]`, `[voice-l1]`, `[voice-worker]`; the lifecycle lines
   are `[handover]`, `[self-clear]`, `[smart-compact]`,
   `[supervisor-event]`.
3. BUG-039 closes on the first daemon death or restart that leaves a
   live session responsive; `daemon.log` must show the task-launched
   boot (`already running` from the hook's attempt is fine, a
   hook-time `daemon starting` right after `[shutdown] complete` is
   the old bug).
4. Then arm the gates the wave staged: `POST /runtime-config/dispatch_confirm_gate
   {"value":"on"}` and `mid_permission_mode` `plan`, once items 1 to 5 pass.
5. Small fixes owed: BUG-040 (lazy import in `07-daemon/src/llm/anthropic.ts`
   so a missing SDK never stops boot), the shim hardening under BUG-039.
6. Open backlog after that: `<DATA_ROOT>/brainstorm/BACKLOG.md` P1 (the
   curator canary and the injection delivery gap) and P2 (the stale-reply
   guard on the reply-text surface); BUG-017 (daemon heap, the Phase 8
   headline and the usual trigger of BUG-039); BUG-024 (anchor seed
   aborts every boot); BUG-025 (wiki push dead since 2026-08-02).
7. The 13 BUGS.md rows from July still at SMOKE-TESTING (001, 003, 004,
   006, 009, 010, 011, 012, 013, 018, 019, 020, 021) have been deployed
   across many restarts and never verified. Walk them or flip them.
8. Merge `voice-layers` into master after the spoken items pass. Phase
   Two remains queued behind the P2-0 adversarial review of
   FUNCTIONAL-SPEC (standing project rule).

## Standing rules (unchanged)

- Daemon restart is OPERATOR-ONLY unless explicitly authorized in the
  moment. Builds are fine.
- Additive-only fixes; tests green before/after; commit bodies end
  with a Rebuild: yes/no line; FIXES.md row per fix.
- Regression-guard surfaces: terminal/PTY, bridge, cross-session
  inject.
