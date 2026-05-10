# Handover: Phase Two Wave 2 complete (2026-05-10)

> **RESUME POINTER (2026-05-10 late evening, post-Wave-2):**
> Active branch: `phase-two`. Worktree: `C:\dev\Projects\DevNeural-phase-two`.
>
> **Stop snapshot:**
> - Last commit: `32fe1bb feat(lex): wave 2 day 5 lex track B + meeting routes`
> - Wave 2 fully shipped: days 1-5 all on `phase-two`. Spec section 11 Wave 2 closed.
> - Tests + typecheck state: **142/142 green**; `tsc --noEmit` clean across both daemon and dashboard.
>
> **Resume target on next session:** decide whether to (a) merge `phase-two` to `master`, or (b) start Wave 3. Wave 3 is **NOT yet specced in section 11** of `docs/spec/PHASE-TWO-IMPLEMENTATION.md` beyond the reference at line 1497 (`Day 2 commit: feat(dashboard): wave 3 day 2 unified orb`). Read the orb sketch in `docs/spec/phase-4-orb.md` and check whether Wave 3 prerequisites need spec work first.
>
> **Open bug docs not yet fixed (do NOT interrupt Wave 3 for these):**
> - `docs/bugs/2026-05-10-state-tracker-loses-live-sessions.md`
> - `docs/bugs/2026-05-10-cc-feedback-prompt-unanswerable.md`
> - `docs/bugs/2026-05-10-brainstorm-picker-and-transcripts.md`
>
> One-line resume prompt:
> `read docs/HANDOVER-2026-05-10-phase-two-wave-2-complete.md, then decide between Wave 2 merge or Wave 3 start`

---

## Wave 2 commits (most recent last)

```
8bb07e9 chore(db): wave 2 day 1 prerequisite migrations 010-013 + 013a
34553ac feat(gpu): OP-3 priority queue + OP-3 step 4 VRAM monitor
607afdd feat(heartbeat): OP-1 external heartbeat poster
2b26a4d feat(notifications): OP-2 native OS toast fallback via BurntToast
f812da9 feat(reinforcement): OP-4 raw chunks cull rule
b44a07a docs(handover): stop snapshot at f812da9
c7cd721 feat(dashboard,brainstorm): wave 2 day 2 routes + audio
6d03e5d feat(brainstorm): wave 2 day 3 lineage + backfill
ab238d5 feat(wiki,curator): wave 2 day 4 integrity + ui polish
32fe1bb feat(lex): wave 2 day 5 lex track B + meeting routes
```

---

## What landed by day

### Day 1 (`b44a07a` and prior)
Wave 2 prerequisites: migrations 010-013 + 013a, GPU priority queue, VRAM monitor, external heartbeat poster, native OS toast fallback (BurntToast), raw chunks cull rule. See `docs/HANDOVER-2026-05-10-phase-two-wave-1-day-1.md` for the full Wave 1 + Wave 2 day 1 record.

### Day 2 (`c7cd721`) — `/brainstorms` + `/drafts` + audio retention
- **Daemon routes:** `GET /brainstorms` (filtered by kind / project / mode / date), `GET /brainstorms/:id`, Range-supporting `GET /brainstorms/:id/audio`, `GET /brainstorms/:id/cues`. `GET/PATCH /drafts`, `GET /drafts/:id`, `POST /drafts/:id/promote` (with all four spec conflict cases: slug_collision, frozen_target, superseded, target_drift), `POST /drafts/:id/discard`.
- **Audio bundle:** `07-daemon/src/voice/audio-bundle.ts` accumulates per-utterance PCM into a tmp file during the session; `finalize()` prepends a WAV header, atomically writes `<id>.wav` + `<id>.cues.json`. Wired into the voice WS (consent-gated for meetings) and into the session-end pipeline as new step 3a. Meeting sessions without `consent_acked` discard PCM (BF-17 / spec line 281).
- **Dashboard:** new components `BrainstormList`, `BrainstormDetail`, `AudioPlayer` (iOS gesture rules, default rate 0.9), `DraftEditor` (modal with conflict prompts). Pages at `/brainstorms`, `/brainstorms/[id]`, `/drafts`. TopBar gains Brainstorms + Drafts entries.
- **Docs:** audio retention + ACL note appended to `docs/install/AUDIO-VIDEO.md`.

### Day 3 (`6d03e5d`) — lineage + backfill + audit-doc ingest
- **Step 12 lineage panel:** `GET /wiki/page/:id` returns Phase Two frontmatter (`source_brainstorms`, `source_meetings`, `derived_from_brainstorm`, `derived_from_meeting`, `last_verified`, `frozen`, `schema_version`). `WikiPageModal` renders new "Source brainstorms" / "Source meetings" sections with deep-links to `/brainstorms/<id>`.
- **Step 13 backfill:** `npm run backfill-brainstorms` walks every `brainstorm_sessions` row missing `brainstorm_chunks`, kind-classifies by mode (BF-14: `notes` → meeting; `conversation`/`push-to-talk` → brainstorm), embeds the session summary, computes cosine vs every wiki page, routes by band (high ≥ 0.85 auto-link with primary heuristic cosine ≥ 0.90 OR body-overlap ≥ 30%; borderline 0.65-0.85 → `backfill_review_queue`; low → `crossproject_fallback_log`). Meetings skip lineage entirely. Dashboard route `/brainstorms/backfill-review` + `POST /admin/backfill/brainstorms` trigger.
- **Step 14 audit-doc auto-ingest:** `npm run audit-doc-ingest` walks `voice-review.md` + `docs/audit/*.md`, writes synthetic `brainstorm_sessions` rows (mode=`notes` but kind=`brainstorm` per the BF-14 audit-doc override; `provenance='audit-document'`; `consent_acked=0`), chunks into `brainstorm_chunks`. Idempotent via stable sha1-derived ids.
- **DB plumbing:** `insertBrainstormChunk`, `listBackfillReview`, `setBrainstormPhaseTwo` (direct UPDATE — `INSERT OR REPLACE` via `insertBrainstorm/updateBrainstorm` resets Phase Two columns to defaults; this was caught + fixed during testing and is the standard pattern for any future Phase Two column writes).

### Day 4 (`ab238d5`) — wiki integrity + curator polish
- **Step 15 lint nightly:** `runLint(opts.db)` mirrors actionable flags into `audit_findings` (source=`lint`, severity by action kind, content-hash idempotent). Daemon timer at +5min boot then daily (`DEVNEURAL_LINT_NIGHTLY_INTERVAL_MS`). `POST /admin/lint/run`.
- **Step 16 LLM self-audit:** `07-daemon/src/wiki/self-audit.ts` picks N random canonical pages, calls the configured LLM with a JSON-array verdict prompt, writes `audit_findings` (source=`self-audit`) for each non-OK verdict. Daemon timer at +15min boot then weekly. Skipped when `DEVNEURAL_LLM_PROVIDER=none`. `POST /admin/self-audit/run`.
- **Step 17 "this looks wrong":** `POST /curator/wrong` reuses `correctWikiPageById` for the weight-drop work AND opens a `user-flag` audit_finding so the next self-audit picks the page up. New `InjectionRow` component (confidence pill, 0.8/0.5/0.3 colour thresholds, wrong button). `LintFindingsPanel` on `/system` lists open findings sorted by severity with ack/resolve/dismiss + manual triggers.
- **Step 18 last_verified:** Lint flags canonical pages — `last_verified=null` → low; `>= 90d` → medium.
- **Step 19 pause mode:** new `runtime_config` table; `isPauseModeActive()` reads runtime first, env second, default last. `GET/POST /runtime-config`. `PauseModeToggle` on `/system` flips the override without daemon restart.

### Day 5 (`32fe1bb`) — Lex track B + meeting routes UI
- **Step 20 prompt versioning:** `<DATA_ROOT>/lex-prompts/<iso>__<hash>.md` archive; `buildLexSystemPrompt(opts)` returns `{prompt, version, mode}`; identical-body dedupe via sha8 hash. `GET /lex/prompts/versions`, `GET /lex/prompts/:version`.
- **Step 21 A/B replay:** `npm run lex-replay -- --input <fixture> --version-a vA --version-b vB` runs both versions through the configured LLM provider and writes `<DATA_ROOT>/lex-replay-output/<ts>/diff.md`. `POST /admin/lex-replay`. Note: spec calls for hermetic Claude Code PTY spawn; day 5 uses the in-process LLM provider (same path as self-audit). Full PTY-based variant is a Wave 3 follow-up.
- **Step 22 per-mode few-shot:** `prompt-blocks` module loads `few-shot/{conversation|push-to-talk|notes}.md`; defaults seed on first read so a fresh install never throws. `buildLexSystemPrompt` concatenates the few-shot for the active mode.
- **Step 23 refusal contract:** `refusal-contract.md` always loaded; meeting mode also pulls `refusal-contract-meeting.md` (no interject, no opine, addressed-tag).
- **Step 24a meetings UI:** `/meetings` + `/meetings/[id]` pages with `MeetingList`, `MeetingDetail`, `ConsentGate`, `AttendeeChips`, `ActionItemList`. Daemon: `GET /meetings`, `GET /meetings/:id` (with `audio_purges_at` countdown — `DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS` default 30), `POST /:id/consent-ack`, `POST /:id/keep-audio`, `POST/PATCH /:id/action-items`, `POST /:id/promote-to-wiki` (BF-15 explicit — meetings never auto-distill). TopBar gains Meetings entry.
- **Step 24b awareness scaffolding:** `07-daemon/src/lex/awareness.ts`. L1 broadcaster with idle-duplicate suppression, per-minute token budget gate (default 400 tokens/min ≈ 16 events/min via `DEVNEURAL_AWARENESS_BUDGET_PER_MIN`), meeting-mode disable for every emit except `'manual'`. L2 `recentContext()` exposes the last N events with optional detail. `GET /lex/awareness/recent`, `POST /lex/awareness/emit`, `POST /lex/awareness/mode`. **No producer hooks wired yet** — the actual emit calls from audit-finding / reminder-due / draft-auto-dropped / canary-fail land in their respective modules in follow-ups.
- **Step 24 thumbs:** `POST /lex/feedback` writes `lex_feedback` rows (id is composite `lf-<turn>-<vote>` so a re-click is a no-op). `GET /lex/feedback`, `GET /lex/feedback/up-rate/:version`. New `LexThumbs` component renders ▲/▼ + the prompt version tail; **not yet rendered in any production surface** — wiring into the Lex chat UI is the next dashboard pickup.

---

## Carry-overs and gaps

These are deliberately scoped out of Wave 2; pick up at Wave 3 or earlier if priority shifts.

1. **LexThumbs not wired into a render surface yet.** The component + endpoint exist; the existing `/lex` chat panel + `/orb` voice panel still need the per-turn render hook. Each turn needs a stable `turn_id` (use the assistant message uuid that the artifact-parser already dedupes on) and the `prompt_version` from `buildLexSystemPromptVersioned()` returned at spawn time.
2. **Awareness producers not wired.** `emitAwarenessEvent()` is callable but no module calls it yet. The cheapest first hook is `audit_findings.insert` → `emitAwarenessEvent({kind: 'audit-finding', label: <severity>:<page>})`. Reminder-due hook lands inside the reminders fire path.
3. **A/B replay uses in-process LLM, not PTY spawn.** Spec section 11 day 5 step 21 calls for hermetic Claude Code PTY spawn. Day 5 ships the simpler provider call. The diff format + output dir layout match the spec so a swap is drop-in.
4. **Meeting audio purge job not wired.** `audio_purges_at` is computed at read time but no cron job actually deletes the file when the timestamp passes. Add to `daemon.ts` alongside the raw chunks cull (same setInterval pattern, runs daily, `keep_audio=1` skips).
5. **Heartbeat watcher service not built.** `docs/install/HEARTBEAT.md` covers the watcher options A/B; the standalone Windows Service script in `07-daemon/heartbeat-watcher/` is still empty.
6. **Backfill review queue is per-borderline-only.** Low band rows go to `crossproject_fallback_log` for audit; the dashboard does not surface that table yet. If the user wants to review low-band rejections, add a `/admin/crossproject-fallback` GET + a small panel.
7. **`raw_chunks_archived` table.** Created inline by the cull module on first archive. Currently has no list / restore endpoint. If a user wants to recover something, the SQL is `INSERT INTO raw_chunks_meta SELECT ... FROM raw_chunks_archived WHERE id = ?`.
8. **Open bug docs in `docs/bugs/`** (state tracker, cc feedback prompt, brainstorm picker) untouched.

---

## Operational notes for the next session

- **Phase Two columns: NEVER use `updateBrainstorm({...phaseTwoCol})`.** It round-trips through `INSERT OR REPLACE` on the legacy 15-column shape and silently resets Phase Two columns to defaults. Use `setBrainstormPhaseTwo()` for kind / provenance / consent / project_slug / audio_path / keep_audio / attendees / meeting_topic. Audit-doc ingest + backfill already do this; any new caller must too.
- **`DATA_ROOT` is captured at paths.ts module load.** Tests that override `DEVNEURAL_DATA_ROOT` after import do NOT see the change unless they `vi.resetModules()` in `beforeEach` and dynamic-import everything that touches `paths.ts`. The Wave 2 day 3 backfill tests show the working pattern (`07-daemon/tests/backfill-brainstorms.test.ts`).
- **Test count baseline.** Wave 2 entry: 113. Wave 2 exit: 142. Net +29 tests. If the next session sees a count drop, something silently disabled.
- **Migrations applied at next daemon boot.** `runMigrations()` runs in `daemon.ts` startup. The live daemon on `master` will pick up Wave 2 schema (010-013 + 013a) on first boot from this branch; nothing else to do.
- **Live daemon on `master` is unaffected by Wave 2 work** until `phase-two` merges. Pre-merge: nothing to do. Post-merge: restart the daemon once so migrations apply and the new endpoints register.
- **Dashboard auth.** Every new endpoint registered in this Wave inherits the `authMiddleware` preHandler from `07-daemon/src/dashboard/routes.ts:149`. No special-casing needed.

---

## Verification commands

```powershell
cd C:\dev\Projects\DevNeural-phase-two\07-daemon; npx vitest run
cd C:\dev\Projects\DevNeural-phase-two\07-daemon; npx tsc --noEmit
cd C:\dev\Projects\DevNeural-phase-two\08-dashboard; npx tsc --noEmit
```

Expected: 142 passed; `tsc` exit 0 on both.
