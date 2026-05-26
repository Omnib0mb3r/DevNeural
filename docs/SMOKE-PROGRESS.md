# Smoke Progress — Live Cursor

Rolling handoff for the 2026-05-25 active smoke batch. Survives Lex restart, `/clear`, or accidental reset. The Lex session that owns this file MUST update it on every step completion so a fresh session can pick up exactly where we left off.

**Source of truth:** `docs/SMOKE-TEST.md` checkmarks. This file is the live cursor + context for what's currently happening.

---

## Current cursor

**Active step:** 3.7 — supervisor wire probe (`curl /dashboard/health-supervisor` returns `health:'ok'` after one worker event; new `caller_label='event-supervisor'` row in `cross_session_injection_log`).

**Steps 3.1-3.6 PASS evidence captured live in the Lex brainstorm 2026-05-25 evening session (see Completed list below).**

**Last update:** 2026-05-26T04:42Z.

## Completed so far (this run)

- [x] Step 0 prep — daemon rebuild, restart, dashboard rebuild, browser reset.
- [x] Step 1 chunk-write invariant — PASS. 9 user + 18 lex stamped pre-detach; lex climbed 18 -> 23 post-detach (worker 18bc5847 closed cleanly).
- [x] Step 2 cc_session_id stamping — PASS. Latest 10 rows all stamped current Lex session; 3465 legacy NULLs preserved.
- [x] Step 3.1 end-brainstorm pipeline — PASS. Brainstorm 4bbafb48 status='ended', distilled_at set 12:08 EDT, last_summary populated.
- [x] Step 3.2 ref_summary on ended cc — PASS. better-sqlite3 query confirmed ref_summary populated on cc cbb015e5 (773 chars) and prior session (924 chars).
- [x] Step 3.3 anchor rolling aggregate — PASS. anchor last_summary rolling aggregate contains current + prior session blocks (verified via direct DB read).
- [x] Step 3.4 cold-start sibling differentiation — PASS. This session's cold-start preload showed differentiated sibling summaries (no boilerplate duplication).
- [x] Step 3.5 mid-turn CR auto-submit (Fix 32) — PASS. Queued mid-turn utterances auto-submitted at turn boundary; verified live multiple times.
- [x] Step 3.6 cancelled-tool-recovery (Fix 33) — PASS. Daemon log shows cancelled-tool-recovery armed at 12:04 EDT on cc cbb015e5, cleared 5s later when assistant follow-up landed (self-heal path exercised).

## Up next (in order)

1. **3.7** Fix 34 supervisor wire probe (CURRENT) — `curl /dashboard/health-supervisor` returns `health:'ok'` after one worker event; new `caller_label='event-supervisor'` row in `cross_session_injection_log`.
2. **4.x** Repoint fix via /clear on a worker.
3. **5.x** Mic-init vad-error ring buffer + retry verify.
4. **6.x** Final gate + FIXES.md flips + greenlight autonomy.

## Open observations during smoke

- **Carry-over row:** existing `4bbafb48` anchor is already status='ended' with NULL ref_summary from the prior broken-path attempt. Acceptable to leave that one NULL and validate against a freshly-ended session. OR run a one-shot pipeline call to backfill; not required to close 3.1.
- **Double-talk persists.** Utterance-queue coalesce (per memory `project_devneural_utterance_queue_coalesce.md`) NOT shipped yet. Behavior expected to continue through smoke. Queued post-smoke ahead of LEX-AUTONOMY Stages 5-12.
- Static brainstorm-to-project anchor link works (supervises_project_anchor_id persisted). `attached_worker_session_id` stays NULL until inject-time resolve; by design.

## Post-smoke queue (locked order)

1. Coalesce utterance queue (relevance-aware single structured reply).
2. LEX-AUTONOMY-PAYLOAD-SPEC Stages 5-12 (codex order, line 285 distillation query scope first).
3. LEX-STANDALONE-SUPERVISION idle-watcher full day-cycle verify.

## Recovery instructions for a fresh Lex session

If this Lex session resets:

1. Read this file. Cursor + last completed step is at the top.
2. Tell Lex: **"rebuild smoke task list from SMOKE-TEST.md"** to repopulate the task panel from the checkmarks.
3. Cross-reference against `SMOKE-PROGRESS.md` for the "Up next" pointer.
4. Resume from the next pending checkmark.
