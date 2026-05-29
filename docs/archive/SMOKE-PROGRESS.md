# Smoke Progress — Live Cursor

Rolling handoff for the 2026-05-25 active smoke batch. Survives Lex restart, `/clear`, or accidental reset. The Lex session that owns this file MUST update it on every step completion so a fresh session can pick up exactly where we left off.

**Source of truth:** `docs/SMOKE-TEST.md` checkmarks. This file is the live cursor + context for what's currently happening.

---

## Current cursor

**2026-05-29 09:45 EDT update.** Resumed after 3-day pause. Daemon current (pid 38840, uptime ~17h, restarted 2026-05-28 16:54 EDT). Fix 41 endpoints live. Scheduler dead. Mode=live. Worker bb73e5a4 (frozen at 85.9% since spam-stop) /clear+pasted at 13:44Z via Lex-authored six-section summary (audit 1f8de6c3). New worker session 88cc9485 booting.

**MORNING SMOKE PASS today 2026-05-29 13:35 EDT:** 41.1 PASS (mode=live, ctx_pct=85.9, shadow_count=287). 41.2 PASS (empty summary rejected). 41.3 PASS (empty prompt rejected). 41.4 PASS (/evaluate 404). 41.5 PASS (zero scheduler ticks). 41.6 PASS (smartCompactPolicyOwner defaults to 'lex' at routes.ts:266).

**OPEN smoke gates (operator-pending):** 40.1/40.2/40.3 cc-pty speak-queue probes (need voice mode + live brainstorm). 5.1-5.4 voice mic-init (needs mobile Safari + operator hands). 6.1-6.4 final gate flips.

**PRELOAD-1 diagnosed 2026-05-29 13:50 EDT:** cold-start preload route is wired AND fires on every SessionStart, BUT hook-runner.ts:196 writes plain markdown to stdout. CC requires JSON-shaped `{hookSpecificOutput:{hookEventName:'SessionStart',additionalContext}}` for context injection (proven by superpowers + capture-session-id both landing on this session, devneural block missing). Ship spec queued.

**PRIOR ACTIVE BLOCKER (resolved):** 2026-05-26 wrap-prompt spam. Daemon was running stale dist; restart-without-rebuild bit us. Resolved when operator restarted daemon Wed 2026-05-28 after rebuild.

**Why it happened:** Fix 41 Stage 3 (commit 6359fd2, 08:34Z) deleted the daemon-side scheduler in src/. Operator clicked restart-daemon ~10:15 EDT but `dist/` was NEVER rebuilt. Daemon (pid 76292) restarted against stale build artifacts (`dist/dashboard/smart-compact-scheduler.js` dated 04:22 EDT, pre-Fix-41-Stage3). Old scheduler kept ticking with no wrap-cooldown.

**Restart ≠ rebuild.** Overnight handover (OVERNIGHT-2026-05-26.md L152, L156) flagged that work was unrebuilt + unrestarted, but morning checklist only said "click restart-daemon button" — never "run `npm run build` first". That's the gap that bit us.

**Doc fix shipped 12:50 EDT:** new doc `docs/HOW-TO-dev-vs-prod-dashboard.md` covers three independent build steps (07-daemon, 08-dashboard, 09-bridge), port 3000 (dev hot-reload) vs 3747 (prod static), Tailscale dev/prod toggle. Linked from `docs/INDEX.md`, `docs/HOW-TO-dashboard-serving.md` updated to point at it, `TODO.md` got a top-level gotcha summary. Future Lex starting cold should hit this on the index injection.

**Recovery order:**
1. `cd C:/dev/Projects/DevNeural/07-daemon && npm run build` (also `08-dashboard` if dashboard changed).
2. Operator clicks restart-daemon. Wait ~5 min for `/health` new pid.
3. Verify scheduler gone: tail daemon log 60+s, ZERO `[smart-compact-tick]` lines (SMOKE-TEST 41.5).
4. Flip mode back to `live` via POST /lex/smart-compact/toggle once Fix 41 probes pass.
5. Worker recovery: `/clear` + Lex-authored six-section summary via POST /lex/smart-compact/clear-and-paste (Fix 41 path).
6. Resume MORNING SMOKE for Fix 40 + Fix 41 probes (SMOKE-TEST L100-138).

**Prior step:** Step 5 (voice mic-init) pending. Step 4 PASS 2026-05-26 03:23 EDT via natural Lex CC repoint churn on anchor 4bbafb48 (20 cc_session_ids stamped, clean splits per cc).

**3.7 status (2026-05-26 02:35 EDT):** REGRESSED (false pass).
- Original 02:09 EDT PASS was forensic-only: row landed in `cross_session_injection_log` with `caller_label='event-supervisor'` and `reject_reason='delivery_mode=lex-queue'`. Audit row said accepted; live behavior contradicts it.
- 02:30 EDT: operator caught supervisor-event payload landing in WORKER terminal queue (jsonl 94e85826, 2 queue-operation enqueue rows containing `[supervisor-event] worker=DevNeural event=idle…`), NOT in Lex CC (2a708d6d).
- Root cause confirmed: `queueSessionPrompt(ref.lex_session_id, text)` keyed on a brainstorm UUID. `writeBridgePrompt` dropped the `<lex_session_id>.in` marker into the bridge inbox; the 09-bridge VSIX with no matching session-id fell through and delivered to whichever VS Code terminal was in scope (= the worker). Audit row never knew.
- Architectural rule re-affirmed by operator 02:35 EDT: daemon NEVER injects directly to worker. Daemon notifies Lex; Lex decides. Only Lex's outputs reach worker.

**Prior 3.7 history (kept for forensics):**

1. **Fix 34b** (commit `bc9c621`, 12:50 AM EDT) — chokidar v4 glob support dropped; watch directory root + ignored predicate. Rebuilt + daemon restarted. Counter `chokidar.line` confirmed climbing post-restart.
2. **Fix 34c** (commit `b0e5c22`, 01:19 AM EDT) — resolver was picking ordering=0 (oldest ref, cc770032) because all refs have `ended_ms=null` and the find() walked ASC. Patched to reverse-walk so newest open wins. Daemon restarted, resolver now resolves to ordering=94, cc=`13754c72` (current Lex CC).
3. **Fix 34d** (commit `2e0d590`, 01:44 AM EDT) — REGRESSED. Introduced lex-queue branch keyed on lex_session.id. Audit-passed but live behavior misrouted to worker. Superseded by Fix 34d.1.
4. **Fix 34d.1** (this commit, 2026-05-26) — TWO bundled fixes in one rebuild. **(A) Routing:** replace lex-queue branch with `ptyInject(lexCcSessionId, text, true)`. ptyInject resolves via daemon-managed pty handle for Lex CC. Audit mode flips to `lex-pty`. Non-Lex targets are dropped with `rejected-not-lex` instead of falling through to bridge/pty; supervisor wire is Lex-only per architectural rule. **(B) Snippet picker:** new `07-daemon/src/dashboard/worker-event-snippet.ts` replaces the raw-bytes-tail snippet with per-event-type high-signal extraction (idle: stall + last user/assistant + last tool/result; permission_denied: denied_tool + denied_input + reason; commit: branch + subject + files_changed; expectation_drift: supervisor-provided drift summary). Meta / attachment / skill-catalog / hook_additional_context records are stripped. 600-char cap with middle truncation; empty case returns `(no recent activity)`. 12 new pins in `tests/worker-event-snippet.test.ts`. **Combined: 889/889 daemon tests pass; tsc clean.** Bug doc: `docs/bugs/2026-05-26-supervisor-wire-routes-to-worker.md`.

**Current state:** Fix 34d.1 patch applied to `worker-event-listener.ts`. **AWAITING daemon rebuild + restart**, then retest.

**Retest plan:** restart daemon; wait for any worker jsonl write to fire a supervisor event. Verify (a) `chokidar.line` increments, (b) new row in `cross_session_injection_log` with `caller_label='event-supervisor'` AND `reject_reason='delivery_mode=lex-pty'`, (c) supervisor payload appears in Lex CC jsonl (2a708d6d in `C:/Users/michael/.claude/projects/C--dev-data-skill-connections-brainstorm/`), (d) worker jsonl has NO new queue-operation rows containing `[supervisor-event]`, (e) the `Snippet:` block in Lex's payload contains structured `stall_seconds=…\nlast_user: …\nlast_assistant: …` (NOT raw jsonl bytes or skill catalog text).

**Steps 3.1-3.6 PASS evidence captured live in the Lex brainstorm 2026-05-25 evening session (see Completed list below).**

**Last update:** 2026-05-26 03:15 AM EDT.

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
- [x] Step 3.7 supervisor wire — PASS 2026-05-26 03:15 EDT. Live commit event landed in Lex CC 575f97ec with `delivery_mode=lex-pty` decision='accepted' and structured snippet (branch/subject/files_changed). No queue-operation row in worker jsonl. Fix 34d.1 verified end-to-end.

## Up next (in order)

1. **5.x** Mic-init vad-error ring buffer + retry verify (needs mobile Safari + operator hands).
2. **6.x** Final gate + FIXES.md flips for Fix 27/28/29/32/33/34 + greenlight autonomy.

Steps 3.1-3.7 and 4.1-4.4 closed PASS as of 2026-05-26 03:23 EDT.

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
