# Smoke Progress — Live Cursor

Rolling handoff for the 2026-05-25 active smoke batch. Survives Lex restart, `/clear`, or accidental reset. The Lex session that owns this file MUST update it on every step completion so a fresh session can pick up exactly where we left off.

**Source of truth:** `docs/SMOKE-TEST.md` checkmarks. This file is the live cursor + context for what's currently happening.

---

## Current cursor

**Active step:** 3.1 — end brainstorm session. Pre-fix attempt revealed two real bugs:
  - Dashboard "End" button (`POST /lex/anchors/:id/end`) only ptyKill + status flip; never fired session-end pipeline. ref_summary stayed NULL.
  - Voice command "Lex end session" attempted on anchor-reopened session 5db6b4d3; zero `[voice-ws]` log entries — audio path silent. Root cause not yet pinned (anchor-reopen voice WS rebind suspect).

**Code fixes landed (uncommitted, unbuilt):**
  - 07-daemon/src/dashboard/routes.ts:1263 — `/lex/anchors/:id/end` now invokes `runSessionEndPipeline` on the active transcript before ptyKill. Dashboard End = voice "Lex end session" behaviorally.
  - 07-daemon/src/voice/lex-voice-ws.ts — diagnostic logs on matcher match (1507), pipeline entry (2094), and silent-return cause (2115). Makes the voice path failure observable on next attempt.

**Next:** rebuild daemon (`cd 07-daemon && npm run build`), restart daemon (kills active conversation). Then on fresh session: click dashboard End → distillation fires → 3.2/3.3 queries pass. Voice path: speak "Lex end session" on the next session; diagnostic logs will reveal where the audio path stalls if it stalls again.

**Last update:** 2026-05-25T22:58Z.

## Completed so far (this run)

- [x] Step 0 prep — daemon rebuild, restart, dashboard rebuild, browser reset.
- [x] Step 1 chunk-write invariant — PASS. 9 user + 18 lex stamped pre-detach; lex climbed 18 → 23 post-detach (worker 18bc5847 closed cleanly).
- [x] Step 2 cc_session_id stamping — PASS. Latest 10 rows all stamped current Lex session; 3465 legacy NULLs preserved.

## Up next (in order)

1. **3.1** End session via voice command (in progress).
2. **3.2** Query `lex_transcript_ref.ref_summary` for ended cc_session_id; expect non-null.
3. **3.3** Query `brainstorm_sessions.last_summary` on anchor; expect refreshed text.
4. **3.4** Cold-start fresh brainstorm same anchor; verify differentiated sibling summaries (not 5 identical boilerplate).
5. **4.x** Repoint fix via /clear on a worker.
6. **5.x** Mic-init vad-error ring buffer + retry verify.
7. **6.x** Final gate + FIXES.md flips + greenlight autonomy.

## Open observations during smoke

- **Double-talk persists.** Utterance-queue coalesce (per memory `project_devneural_utterance_queue_coalesce.md`) is NOT shipped yet. Confirmed via `git log --oneline -30` — no coalesce commit. Behavior expected to continue through smoke. **Queued for immediate work post-smoke, ahead of LEX-AUTONOMY Stages 5-12.**
- Static brainstorm-to-project anchor link works (supervises_project_anchor_id persisted). `attached_worker_session_id` stays NULL until inject-time resolve; that is by design, not a bug.

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
