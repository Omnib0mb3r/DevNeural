# DevNeural Smoke Test Checklist

Live punch list of things shipped in code but not yet verified end to
end on real hardware. Refresh as items get verified or new code lands.
Source of truth for the daily smoke gate; the rolling cursor for the
rest of the state lives in `docs/HANDOVER.md`.

Last refreshed: 2026-10-03. Earlier batches (2026-05-29 to 2026-07-19)
with their pass marks are in `docs/archive/SMOKE-TEST-2026-05-to-07.md`;
their open items are tracked in `BUGS.md`, not here. What is already
verified on the live daemon is recorded under the cursor in
`docs/HANDOVER.md`.

## Current gate

### 2026-09-28 to 10-03 wave (Claude Code 2.1.285, projects, names)

- [ ] **Spoken request acted on (BUG-065, BUG-066).** Voice on, say a
  real ask ("go read the docs and get caught up"). Lex does it, says
  nothing about "pasted". Her transcript shows your `[voice mode]`
  words BEFORE the `<pasted_content>` block. `daemon.log` FORWARD line
  carries your words with no folder you did not say.
- [ ] **Typed message submits (BUG-059).** Voice off, type to Lex in the
  Talk to Lex box. She answers with no manual Enter.
- [ ] **Probes green after a restart.** `/health` shows
  `prompt_delivery.status = ok` and `inject_delivery.status = ok`
  about 2 to 3 minutes after boot; `daemon.log` has `[inject-probe] ok`.
- [ ] **Lex owns the worker (BUG-067).** When the worker reports a
  checkpoint, Lex verifies and commits / clears herself and reports what
  she did; she asks you only for files, product calls or destructive steps.
- [ ] **Typed brainstorm name used (BUG-055, BUG-060).** New session named
  with an unusual spelling; ask Lex to create a project for it. The
  folder uses your typed spelling. Rename it in Past Sessions; the new
  name shows on the Stream Deck tile and in Lex's live_state.
- [ ] **New project by Lex (BUG-056, BUG-057).** Ask Lex for a new
  project. She calls `POST /projects/new`: private repo from
  dev-template, metadata committed and pushed, project bound to her
  brainstorm, path and repo URL reported. No `rm -rf`, no shell clone.
- [ ] **Deleted folder leaves the dashboard (BUG-058, BUG-061).** Delete
  a scratch project folder; within one seed pass its anchor is gone from
  the supervises picker. No `UNIQUE constraint failed` lines in
  `daemon.log`.
- [ ] **Add existing picker.** Projects > add existing: count of folders
  not on the dashboard, `on dashboard` rows with remove, NEW rows with
  add. Add one, it flips; remove one, it flips back and stays off after
  you touch a file in it; add it back.
- [ ] **Worktree root (BUG-069).** After an agent works in a
  `.claude/worktrees/<agent>` folder, the project's tile and the picker
  still show the main project folder.
- [ ] **Car binds the newest Lex (BUG-068).** Two brainstorms live; the
  LEX-CAR screen answers as the one started or reopened last.

### Earlier gate (2026-09-23)

- [ ] The spoken list, items 1 to 10, in `docs/spec/LAYER-1-CONTROL.md`
  "Testing", on the live daemon. Item 9 covers BUG-030 (mute, stand by,
  slower, louder, in your own words).
- [ ] One car run for the continuous stream (BUG-032): no gap between
  sentences, no clipped onsets on Bluetooth.
- [ ] One real auto-clear cycle in live mode
  (`docs/spec/SMART-COMPACT.md` section 6): the worker's handover, the
  brain's review, the spoken yes, the clear, the reseed.
- [ ] Worker effects by voice (BUG-038): "start the worker", "stop the
  worker", "kill the worker", "switch to <project>", each in your own
  words, each acted on, each logged `[voice-ws] L1 turn: ... control=`
  with the verb.

## Hardware-gated, never walked

- [ ] **9.1 iOS PWA push end to end** (`reminder-push.ts` + `daemon.ts`).
  Setup: iOS device, dashboard installed as PWA. Action: subscribe to
  push, create a reminder with trigger +1 min. Verify: device buzzes;
  `reminder_push_audit.delivery_status = 'delivered'`. Recipe:
  `docs/HOW-TO-voice-and-push.md` section 5.
- [ ] **9.2 Panic button live press.** Deferred until a throwaway worker
  is live. Confirm with the operator before pressing.
- [ ] **9.4 Mobile Safari OOM repeat-hit observation.** Window: 24h from
  any restart. If it reproduces, open Voice diagnostics, copy the ring
  buffer, append to `docs/bugs/2026-05-16-voice-restart-oom-regression.md`.

## Recovering this checklist in a fresh Lex session

If the active CC Lex session ends mid-smoke (crash, /clear, restart),
the task panel disappears. To rebuild:

> Tell Lex: **"rebuild smoke task list from SMOKE-TEST.md"**

Lex reads this file, recreates every `[ ]` item as a task, preserves
`[x]` marks, and resumes from wherever it was. The Markdown file is
the source of truth; the task panel is just the live view.

## Stop conditions

An item moves out of this doc when verified on real hardware and folded
into a HOW-TO or recorded under `FIXES.md`. An item stays under
"Hardware-gated" only while a blocking condition (real iOS device, real
third-party session, throwaway worker) is absent.
