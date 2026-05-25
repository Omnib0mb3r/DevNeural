# Smoke Test Handover — Paste-Ready Resume

If Lex resets mid-smoke, paste this into a fresh Lex session to restore full context in one shot.

---

**RESUME PROMPT (copy verbatim to fresh Lex):**

> We are mid-smoke on the 2026-05-25 active batch (Stage 0/1/2 of LEX-AUTONOMY-PAYLOAD-SPEC + repoint fix + voice mic-init fix). Active step is 3.1. The prior Lex session landed two uncommitted code fixes for bugs uncovered during 3.1 and the daemon was just rebuilt + restarted, which is why you are cold. Read `docs/SMOKE-PROGRESS.md` for the live cursor and "Code fixes landed" block. Read `docs/SMOKE-TEST.md` "ACTIVE BATCH (2026-05-25)" section for the full checklist. Rebuild the task panel from the checkmarks — every `[ ]` becomes a pending task, every `[x]` is completed. Mark 3.1 as in_progress. Cold-start sibling preload is unreliable right now; the handover doc + progress doc are the canonical source, not the preload. Announce the next pending step out loud and wait for me to act. Do not skip ahead. Do not re-run completed steps.

## Bounce-state context (2026-05-25T22:58Z)

Two real bugs surfaced trying to close step 3.1:

1. **Dashboard "End" button skipped the pipeline.** `POST /lex/anchors/:id/end` at `07-daemon/src/dashboard/routes.ts:1263` only ptyKilled + flipped status dormant. No distillation, no `ref_summary` write, no `last_summary` refresh, no RAG embed. That is why session 180 (`e33ad1d4-a8c3-465d-af6b-2f9ab4babd4b`) ended with `ref_summary=NULL`.

2. **Voice "Lex end session" path silently inert on anchor-reopened sessions.** Spoken command on session 181 (`5db6b4d3`) produced zero `[voice-ws]` log entries in `daemon.log` (no transcript, no matcher hit, no suppression). Audio path stalled. Suspected: voice WS rebind not happening cleanly on the anchor-reopen path (vs the smart-compact restart path which does rebind at `lex-voice-ws.ts:1077-1089`). Root cause not yet pinned — diagnostic logs were added so the next attempt leaves fingerprints.

**Code fixes landed (already committed + built + daemon restarted by the time you read this):**

- `07-daemon/src/dashboard/routes.ts:1263` — `/lex/anchors/:id/end` now invokes `runSessionEndPipeline` on the active transcript before ptyKill. Dashboard End is now behaviorally identical to spoken "Lex end session" per user requirement.
- `07-daemon/src/voice/lex-voice-ws.ts:1507` — logs on `end_session` matcher match with `bindKey`, `watchSessionId`, `brainstormId` state.
- `07-daemon/src/voice/lex-voice-ws.ts:2094` — logs pipeline entry with the same state plus reason.
- `07-daemon/src/voice/lex-voice-ws.ts:2115` — logs the brainstorm-not-resolved silent-return branch (was the worst silent-failure mode).

**Resume action for step 3.1:**

1. Click dashboard End on the live anchor `4bbafb48-bbfd-47e6-b076-e1a58a334303`. With Fix 1 in place this fires the full pipeline. Tail `C:/dev/data/skill-connections/daemon.log` for `[session-end] brainstorm=4bbafb48 ...` lines.
2. Run 3.2: `SELECT ref_summary, ref_summary_ms FROM lex_transcript_ref WHERE cc_session_id='<the cc id of the session you just ended>';` Expect non-null `ref_summary`, `ref_summary_ms > 0`.
3. Run 3.3: `SELECT last_summary FROM brainstorm_sessions WHERE id='4bbafb48-bbfd-47e6-b076-e1a58a334303';` Expect refreshed text reflecting the just-ended session.
4. Run 3.4 cold-start verification — start a fresh brainstorm on the same anchor and check that the preload header shows differentiated sibling summaries (not 5 identical boilerplate blocks).

**Voice path follow-up (separate from 3.1 closure):**

Voice command "Lex end session" should reproduce on the next session. Watch `daemon.log` for any of the new diagnostic lines. If zero `[voice-ws]` activity again after speaking, the audio path itself is the gap (client mic / WS rebind on anchor-reopen). That's a follow-up fix, not a 3.1 blocker now that the dashboard surface works.

**Backfill note:** session 180 (`e33ad1d4`) still has `ref_summary=NULL` because it was ended pre-fix via the broken dashboard route. Acceptable to leave NULL OR run a one-shot pipeline call with `brainstormId=4bbafb48..., claudeSessionId=e33ad1d4..., reason='backfill-pre-fix'` to populate it. Not required to close 3.1.

---

## What the smoke is verifying

- **Stage 0:** `cc_session_id` stamps on new brainstorm_chunks rows; legacy NULLs preserved.
- **Stage 1:** Lex assistant turns write chunks regardless of worker attachment.
- **Stage 2:** Per-session distillation writes `lex_transcript_ref.ref_summary` + refreshes anchor `last_summary`; cold-start shows differentiated sibling summaries.
- **Repoint fix (Fix 28, e16fe0e):** Old jsonl drained on `/clear`; new session starts fresh.
- **Voice mic-init fix (f237673):** vad-error lands in diagnostics ring buffer, not just UI toast.

## Gate

All Steps 1-5 green → flip FIXES.md rows 27 + 28 to smoke-verified → greenlight LEX-AUTONOMY Stages 5-12.

## Known carry-overs (do not block smoke)

- Double-talk on stacked utterances. Coalesce fix queued post-smoke, ahead of autonomy.

## Files in the smoke loop

- `docs/SMOKE-TEST.md` — full checklist, source of truth for which steps are done (`[x]` vs `[ ]`).
- `docs/SMOKE-PROGRESS.md` — rolling cursor with last completed step + active step + evidence.
- `docs/SMOKE-HANDOVER.md` — this file. Paste-ready resume prompt.
- `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` — the spec being smoke-gated.
- `TODO.md` — post-smoke queue (coalesce first, then autonomy stages).
