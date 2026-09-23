# DevNeural Smoke Test Checklist

Live punch list of things shipped in code but not yet verified end to
end on real hardware. Refresh as items get verified or new code lands.
Source of truth for the daily smoke gate; the rolling cursor for the
rest of the state lives in `docs/HANDOVER.md`.

Last refreshed: 2026-09-23. Earlier batches (2026-05-29 to 2026-07-19)
with their pass marks are in `docs/archive/SMOKE-TEST-2026-05-to-07.md`;
their open items are tracked in `BUGS.md`, not here. What is already
verified on the live daemon is recorded under the cursor in
`docs/HANDOVER.md`.

## Current gate

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
