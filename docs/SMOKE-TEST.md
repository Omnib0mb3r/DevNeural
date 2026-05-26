# DevNeural Smoke Test Checklist

Live punch list of things shipped in code but not yet verified end-to-end on real hardware / real users / real PWAs. Refresh as items get verified or new code lands.

Last updated: 2026-05-25.

## Recovering this checklist in a fresh Lex session

If this CC Lex session ends mid-smoke (crash, /clear, restart), the task panel disappears. To rebuild it:

> Tell Lex: **"rebuild smoke task list from SMOKE-TEST.md"**

Lex reads this file, recreates every `[ ]` item as a task in the panel, preserves your `[x]` marks as completed, and resumes from wherever you left off. The Markdown file is the source of truth; the task panel is just the live view.

## ACTIVE BATCH (2026-05-25) — run in order, do not skip

Batch contents: Stage 0 + Stage 1 + Stage 2 of LEX-AUTONOMY-PAYLOAD-SPEC, voice mic-init fix (`f237673`), brainstorm jsonl repoint fix (`e16fe0e`).
Gate: all green required before starting Stages 5-12 of LEX-AUTONOMY-PAYLOAD-SPEC.

### Step 0 — Prep (one-time, before any test below)

- [x] **0.1** Daemon rebuild. `cd C:/dev/Projects/DevNeural/07-daemon && npm run build`. Required because Stage 0/1/2 + repoint fix all live in daemon code.
- [x] **0.2** Daemon restart. Dashboard → restart-daemon button OR kill + relaunch. Confirm `/health` returns ok=true and new commit SHA in version field if exposed.
- [x] **0.3** Dashboard rebuild. `cd C:/dev/Projects/DevNeural/08-dashboard && npm run build`. Required for voice mic-init fix (VoiceClient.tsx).
- [x] **0.4** Browser hard-reload (Settings → reset) to pick up new dashboard bundle. Voice client re-mounts on fresh JS.

### Step 1 — Stage 1 (Lex chunk-write invariant under attached worker)

Goal: Lex assistant turns land in `brainstorm_chunks` regardless of whether a worker is attached.

- [x] **1.1** Spawn worker against an existing brainstorm anchor (any DevNeural-bound CC session works).
- [x] **1.2** Open brainstorm in voice mode. Speak one short prompt. Wait for Lex spoken reply.
- [x] **1.3** Query DB: `SELECT count(*), role FROM brainstorm_chunks WHERE brainstorm_id = '<anchor_id>' AND cc_session_id = '<lex_session_id>' GROUP BY role;`. Expect: at least 1 `role='user'` AND 1 `role='lex'` row from this turn. **PASS 2026-05-25**: 9 user + 18 lex stamped under session e33ad1d4 on anchor 4bbafb48.
- [x] **1.4** Detach worker (or end worker session). Speak second prompt. Expect: new `role='lex'` row STILL lands. Confirms attachment is not a gate. **PASS 2026-05-25**: worker 18bc5847 closed (sessions=[]), lex rows climbed 18 → 23 post-detach.

### Step 2 — Stage 0 (cc_session_id stamping)

Goal: every new chunk row carries originating `cc_session_id`, never NULL on fresh inserts.

- [x] **2.1** Using same rows from Step 1: `SELECT cc_session_id FROM brainstorm_chunks WHERE brainstorm_id = '<anchor_id>' ORDER BY id DESC LIMIT 5;`. Expect: all 5 NOT NULL, matching the CC session that produced them. **PASS 2026-05-25**: latest 10 by created_at all stamped e33ad1d4, no NULLs. NOTE: order by id DESC is lexical UUID sort, not chronological; use created_at DESC.
- [x] **2.2** Confirm historical rows still NULL (no destructive backfill): `SELECT count(*) FROM brainstorm_chunks WHERE cc_session_id IS NULL;` non-zero is acceptable (legacy data). **PASS 2026-05-25**: anchor 4bbafb48 has 3465 NULL legacy + 296 stamped.

### Step 3 — Stage 2 (per-session distillation + rolling aggregate)

Goal: end-session writes `lex_transcript_ref.ref_summary` scoped to that CC session; `brainstorm_sessions.last_summary` regenerates from recent ref_summaries.

- [ ] **3.1** End the brainstorm session ("Lex end session"). Watch dashboard for session-end pipeline to finish (no error toast, voice tears down clean).
- [ ] **3.2** Query: `SELECT ref_summary, ref_summary_ms FROM lex_transcript_ref WHERE cc_session_id = '<ended_session_id>';`. Expect: non-null `ref_summary`, `ref_summary_ms` > 0.
- [ ] **3.3** Query: `SELECT last_summary FROM brainstorm_sessions WHERE id = '<anchor_id>';`. Expect: refreshed text that reflects this just-ended session, not stale boilerplate.
- [ ] **3.4** Start a fresh brainstorm on same anchor. Cold-start preload header should now show DIFFERENTIATED sibling summaries (not 5 identical boilerplate blocks per Lex's 2026-05-25 preload observation). If still identical, Stage 2 has a regression.
- [ ] **3.5** Fix 32 mid-turn CR (`6e37c07`). In an active voice brainstorm, speak a second utterance while Lex is still mid-reply (forces the mid-turn queue). When Lex finishes the in-flight reply, the queued utterance MUST auto-submit at the next turn boundary — no manual Enter from the user. If the cursor sits after `[voice mode]` without submitting, the fix regressed.
- [ ] **3.6** Fix 33 cancelled-tool-recovery (`b3b30f4`). Force a tool-result reject in Lex's session (send a chat message while Lex is mid-tool to trigger the "Request interrupted by user" envelope). Within ~5 s a row must land in `cross_session_injection_log` with `caller_label='lex-cancelled-tool-recovery'`, and Lex's next assistant turn should resume on its own without further user input. Two consecutive cancellations within 30 s should produce a `decision='shadow'` row with `reject_reason='recovery_exhausted: ...'` and a dashboard banner via the `t:'recovery-exhausted'` WS frame.
- [x] **3.7** Fix 34 supervisor wire (`9b2bebf` + `226fe67`). **PASS 2026-05-26 03:15 EDT** (via Fix 34d.1): live commit event landed in Lex CC 575f97ec with `delivery_mode=lex-pty`, structured snippet payload, worker jsonl clean. After daemon restart, `curl http://localhost:3747/dashboard/health-supervisor` should return `health:'ok'` once the worker emits any watched event (commit, idle past threshold, permission denial). The same event should produce a new row in `cross_session_injection_log` with `caller_label='event-supervisor'`. Pre-fix the supervisor wrote zero rows even with `supervision_mode='event'` set, so any single supervisor-emitted row counts as the wire delivering.

### Step 4 — Repoint fix (Fix 28, `e16fe0e`)

Goal: turns appended to OLD jsonl between last ingest tick and a repoint event are drained; new jsonl reads from offset 0.

- [ ] **4.1** In active brainstorm with worker attached, send 2-3 prompts to build up jsonl content.
- [ ] **4.2** Trigger a repoint: easiest is `/clear` on the worker (or end + auto-respawn fresh session against same brainstorm row).
- [ ] **4.3** Immediately query: `SELECT count(*), cc_session_id FROM brainstorm_chunks WHERE brainstorm_id = '<anchor_id>' GROUP BY cc_session_id ORDER BY count(*) DESC;`. Expect: OLD cc_session_id has full chunk count (no missing trailing turns); NEW cc_session_id starts fresh.
- [ ] **4.4** Send a prompt on the NEW session. Confirm chunk lands under NEW cc_session_id, not under OLD or with stale offset skip.

### Step 5 — Voice mic-init fix (`f237673`)

Goal: VAD/PTT mic-init failures reset the ORT cache AND emit `vad-error` to the ring buffer (was UI-toast-only).

- [ ] **5.1** Mobile Safari preferred (the OOM-recurrence target). If unavailable, desktop Chrome works for the ring-buffer check.
- [ ] **5.2** Force a mic-init failure: deny mic permission once, click Retry, allow it. OR open voice on a tab that's been backgrounded long enough to lose audio context.
- [ ] **5.3** Open Voice diagnostics panel. Expect: `vad-error` log entry visible with error message, not silent.
- [ ] **5.4** Click Retry. Expect: VAD boots clean, no "previous call to initWasm() failed" cascade. If cascade reappears, fix has regressed.

### Step 6 — Final gate before LEX-AUTONOMY Stages 5-12

- [ ] **6.1** All Steps 1-5 green. No ❌ marks. If any failed, do NOT proceed; log regression on the relevant FIXES.md row and re-open the bug doc.
- [ ] **6.2** `git status` clean OR only untracked spec docs + this checklist.
- [ ] **6.3** Update FIXES.md status rows for Fix 27, Fix 28, Fix 29, Fix 32, Fix 33, Fix 34 from ✅ to ✅ smoke-verified with timestamp.
- [ ] **6.4** Greenlight Stages 5-12. Lex inject worker with first stage (distillation query scope fix per codex order line 285).

---

## EXTENDED SYSTEMS CHECK — run after ACTIVE BATCH passes

Full-systems sweep. Tiered by priority. Do Tier 2 next (highest user-facing risk), then Tier 3, then Tier 4 as hardware allows. Tier 5 is reference only (diagnosed-not-shipped, NOT smoke targets).

### Tier 2 — High priority shipped, unverified live (do after Step 6)

- [ ] **7.1 First voice-mode reply silent regression** (d977816, 2026-05-16). AudioContext warmed inside enable-voice click handler to defeat autoplay-policy freeze.
  - **Setup:** Hard reload browser. Open a fresh Lex brainstorm (new anchor, no prior voice session this tab-life).
  - **Action:** Click `enable voice`. Wait for pill green. Speak one short prompt or type and submit.
  - **Verify:** First Lex reply is audibly spoken (not just rendered as text). Also check console for any "AudioContext was not allowed to start" warning.
  - **Fail:** silent first reply OR autoplay-policy warning. Treat as regression of d977816.

- [ ] **7.2 Lex voice-command suite** (2026-05-14). All commands require `Lex` prefix. Each command is a sub-test:
  - **7.2a `Lex disable`** — Speak it mid-Lex-reply.
    - Verify: voice pill flips to `off`. In-flight TTS cuts within ~500ms. Transcript continues to fill (thinking proceeds). No automatic voice resume. Click `start voice` to recover.
  - **7.2b `Lex mute`** (variants: `Lex shut up` / `Lex be quiet` / `Lex stop talking`) — Speak any one.
    - Verify: TTS halts mid-sentence. Pill shows `muted (voice)` with attn tone. Send another prompt; reply arrives silently. Pill badge counter increments per silent reply.
  - **7.2c `Lex unmute`** — Speak after 7.2b.
    - Verify: badge clears to 0. Next reply (not the muted ones) is spoken. Missed messages are NOT replayed.
  - **7.2d `Lex emergency stop`** — Speak on a live brainstorm with active worker.
    - Verify: panic fires (audible/visual confirmation). Query: `SELECT caller, result FROM panic_audit ORDER BY id DESC LIMIT 1;` → `caller='lex-voice'`, `result='accepted'`.
    - Negative: speak bare `emergency stop` (no prefix). Should NOT fire. Confirm no new audit row.
  - **7.2e `Lex end session`** — Speak it.
    - Verify: end-session pipeline runs (ingest + summary + RAG embed). WS tears down. Session row in DB flipped finalized. Auto-spawned fresh panel appears below.
    - Negative: bare `end session` / `stop voice` / `goodbye lex` (no prefix). Should NOT fire.

- [ ] **7.3 Cross-session inject end-to-end** (Fix 15a/15b/15c).
  - **7.3a session_id dispatch (Fix 15a, 6c2f8c2)**: `curl -X POST http://localhost:3747/lex/inject-cross-session -H 'Content-Type: application/json' --data-binary @body.json` where body has `session_id` + valid HMAC token. Body JSON written via node writeFileSync per Windows-no-jq convention.
    - Verify: HTTP 200. Worker terminal receives the payload (visible in VS Code terminal). Query: `SELECT result FROM cross_session_inject_audit ORDER BY id DESC LIMIT 1;` → `accepted`.
  - **7.3b signed_anchor_id dispatch (Fix 15b, aef80dc)**: Same endpoint, body uses `signed_anchor_id` (token issued by `/auth/cross-session-token` with `anchor_id` mode).
    - Verify: HTTP 200, worker receives, audit row `accepted`, `caller_subject` reflects anchor.
  - **7.3c smart-compact replay (Fix 15c, 57c5304)**: Trigger inject WHILE worker is mid-smart-compact. Query: `SELECT count(*) FROM inject_park WHERE anchor_id='<x>' AND replayed_at IS NULL;` → row parked.
    - Resume worker. Verify: parked inject replays BEFORE the summary text. Cap = max 3 replays. Query: `SELECT replayed_at FROM inject_park WHERE anchor_id='<x>';` → non-null.

- [ ] **7.4 Anchor-binding regression** (0119710 daemon + 0e1d496 bridge). VSIX rebuilt and installed.
  - **Action:** Reload one VS Code window (Cmd/Ctrl+R or "Reload Window" command). Wait ~30s for next cron tick.
  - **Verify:** `curl http://localhost:3747/lex/voice-snapshot` → `anchor` field populated for that workspace. Bridge presence file present at `%LOCALAPPDATA%\stream-deck\bridge-presence\<sessionId>.json`.

- [ ] **7.5 External CC session hook via bridge presence**. Memory-locked: NEVER fall back to "must start through dashboard".
  - **Action:** Open a separate VS Code window. Run `claude` from terminal (NOT via dashboard launcher).
  - **Verify:** Bridge presence file appears at `%LOCALAPPDATA%\stream-deck\bridge-presence\<new-session-uuid>.json` within 5s. Reconcile loop picks up: `curl http://localhost:3747/sessions` shows the new session. Dashboard supervision list renders it. Stream Deck shows tile.

- [ ] **7.6 Brainstorm threading Phase 1 sibling index** (cca1353). Requires ≥2 sessions sharing `user_label`.
  - **Setup:** Confirm at least 2 sessions exist with same label. Query: `SELECT id, user_label FROM brainstorm_sessions WHERE user_label='<label>';`.
  - **Action:** Start fresh brainstorm cold (new SessionStart against that label).
  - **Verify:** Preload payload includes a sibling index header listing the prior sessions. Read tail of SessionStart hook stdout in `C:\Users\michael\.claude\projects\<proj>\<session>\tool-results\hook-*-stdout.txt`.

- [ ] **7.7 Brainstorm threading Phase 2 preload + backfill** (0a32429 preloader + 32d711c backfill N=5 cap).
  - **Verify preload order:** Cold-start payload contains, in this exact order: (1) sibling index, (2) last-2 sibling distillations, (3) recent turns appended.
  - **Verify backfill scheduler inert without provider:** Check daemon logs for `backfill: no provider, skipping` (or equivalent). No exception traces.

- [ ] **7.8 Lex cold-start preload mode toggle**. Dashboard exposes off / shadow / live.
  - **off:** SessionStart hook produces no preload payload. Hook stdout empty or minimal.
  - **shadow:** Preload assembled (visible in daemon log) but NOT injected into hook stdout. Lex cold-start sees nothing.
  - **live:** Preload assembled AND delivered to SessionStart hook stdout. Lex first turn references prior context.
  - **Verify each:** flip mode, start fresh session, read hook stdout file. Confirm shape matches mode.

- [ ] **7.9 Session-end pipeline full chain**. End a session via `Lex end session`.
  - **Verify in order (query each):**
    1. Voice WS teardown clean: dashboard voice pill flips to off, no error toast.
    2. Brainstorm row finalized: `SELECT status FROM brainstorm_sessions WHERE id='<x>';` → `finalized`.
    3. jsonl drained: `SELECT count(*) FROM brainstorm_chunks WHERE brainstorm_id='<x>';` matches jsonl turn count.
    4. Per-session distillation: covered by Step 3 above. Confirm `lex_transcript_ref.ref_summary` non-null.
    5. RAG embed: `SELECT count(*) FROM rag_chunks WHERE source_session_id='<x>';` > 0.
    6. Sessions list UI shows the row with summary text visible.

### Tier 3 — Medium priority shipped, lower urgency

- [ ] **8.1 Reinforcement event chain** (curator + reinforcement + panel).
  - **Action:** Open dashboard ReinforcementPanel side-by-side with a live CC worker. Send the worker a prompt where you know the wiki should match (mention a documented concept).
  - **Verify:** Panel shows an `injected` row within ~5s. After worker reply lands, panel shows a `hit` or `raw-hit` row tagged to the same chunk. No `injected` without follow-up = curator wired but reinforcement chain broken.

- [ ] **8.2 Wiki off-site git remote scheduled push** (`wiki/push.ts`, 5-min cadence).
  - **Action:** Edit a wiki page via dashboard. Note current time.
  - **Verify within 6 min:** `cd C:/dev/Projects/DevNeural/<wiki-dir> && git log --oneline -1` shows new commit. Then `git ls-remote Omnib0mb3r/devneural-wiki HEAD` shows the same SHA pushed.

- [ ] **8.3 Lex session rewrite** (5af07d0).
  - **Action:** Open a past brainstorm anchor from /lex sessions list. Click into it.
  - **Verify:** spawn-or-bind works (no double-spawn, no orphan). Brainstorms group appears in Stream Deck tile list. End the session via `Lex end session`; no 500 in daemon log.

- [ ] **8.4 Stream-deck deck-hook race-safety** (Fix 16a/16b/16c).
  - **Action:** Open two CC sessions in different VS Code windows simultaneously. Both should trigger deck-hook stop events on idle.
  - **Verify no flood:** `tail -50 <deck-hook log>` shows zero `mv: cannot stat` errors.
  - **Verify TMP naming:** `ls %LOCALAPPDATA%\stream-deck\tmp\` (or equivalent) shows distinct `<pid>-<nanos>` suffixed files, no collision.
  - **Verify anchor endpoint:** `curl http://localhost:3747/projects/anchors/by-session/<session1>` and `<session2>` both return distinct anchor metadata.

- [ ] **8.5 Smart-compact wait for new SessionStart** (Fix 3).
  - **Action:** Trigger smart-compact on a worker (or smart-clear). Watch daemon log for `waiting for SessionStart` line.
  - **Verify:** daemon does NOT re-inject context until new SessionStart hook fires from the post-/clear session. Old session's terminal must not receive the resume payload.

- [ ] **8.6 Voice settings auto-resync on daemon WS reconnect** (Fix 1).
  - **Action:** Start voice. Note current slider positions. Kill daemon process. Restart daemon.
  - **Verify:** Voice client re-syncs within ~5s of WS reconnect. Sliders snap back to daemon-side values, not stale local. Check VoiceClient.tsx console log for `settings-sync` event.

- [ ] **8.7 Notifications classifier + bell filter** (Fix 9).
  - **Action:** Trigger one of each: info (any successful action), warn (e.g., low-confidence wake-word), error (e.g., fail an API call).
  - **Verify:** Bell shows badge count of 3. Click bell, filter chips for each category, count matches when filtered. Read classification field on each entry, no `unknown`.

- [ ] **8.8 Wake-word audit + standby/listen** (Fix 10).
  - **Action:** Put voice in standby. Speak wake-phrase ("Lex").
  - **Verify:** Listen state activates within ~500ms (pill flips). Query: `SELECT * FROM wake_word_audit ORDER BY id DESC LIMIT 1;` → row captured with confidence + timestamp.

- [ ] **8.9 Help page** (Fix 11, commits 927b88b/bfa0d1b/488e5f6).
  - **Action:** Navigate to `/help`.
  - **Verify:** Page renders. Sections populated (not empty scaffold). Search box works if present. No 404 on sub-links.

- [ ] **8.10 Six-section resume builder** (Fix 7, 8d34148).
  - **Action:** On a live brainstorm with ≥10 turns, click "generate resume" (or equivalent).
  - **Verify:** Output has all six sections populated. None blank, none duplicate-content. Save and reload; resume persists.

- [ ] **8.11 Responsive top-bar <480px voice-pill** (Fix 6, open follow-up).
  - **Action:** Resize browser to width < 480px (DevTools device mode iPhone SE width works).
  - **Verify:** Voice pill restructures to icon-only (no text label). Supervision chips still readable. No horizontal scroll. No overlapping elements.

- [ ] **8.12 Brainstorm rename** (PATCH /lex/sessions/:id).
  - **Action:** `curl http://localhost:3747/lex/sessions` → grab live_state prefix → resolve full UUID. `curl -X PATCH http://localhost:3747/lex/sessions/<uuid> -H 'Content-Type: application/json' -d '{"user_label":"new name"}'`.
  - **Verify:** HTTP 200. Reload /orb and /lex sessions list. New label shows in both. Sibling-preload grouping respects new label on next cold-start.

- [ ] **8.13 Brainstorm orb unified graph**.
  - **Action:** Open /orb.
  - **Verify:** Single graph rendered (NOT separate panels). Filter chips: brainstorms / wiki / projects. Toggle each off and on; corresponding nodes hide/show without re-render flash. Memory-locked: unified graph + filter chips, NOT a toggle.

- [ ] **8.14 /panic global keybind + double-ESC** (dry-run, no actual fire).
  - **Action:** On dashboard, press Ctrl+Alt+`.` — confirm panic modal/state surfaces (without confirming the fire). Press ESC twice rapidly — same modal.
  - **Verify:** both keybinds bring up panic prompt. Cancel out. Cooldown state visible if a panic fired previously today.

### Tier 4 — Hardware-blocked or environment-gated

- [ ] **9.1 iOS PWA push end-to-end** (reminder-push.ts + daemon.ts).
  - **Setup:** iOS device, dashboard installed as PWA (Add to Home Screen).
  - **Action:** Tap "Subscribe to push" on dashboard. Grant permission. Create a test reminder with trigger time +1 min.
  - **Verify:** Device buzzes / notification appears at trigger time. Query `SELECT delivery_status FROM reminder_push_audit ORDER BY id DESC LIMIT 1;` → `delivered`.

- [ ] **9.2 PANIC-BUTTON live press**. Deferred until throwaway coding session is live.
  - **Setup:** Throwaway worker session (NOT real work). Confirm with user before pressing.
  - **Action:** Press the panic button OR Ctrl+Alt+`.` to actually fire.
  - **Verify:** Single-target resolver hits the active session. Audit panel shows the fire. Worker terminal receives interrupt signal. Cooldown engages.

- [ ] **9.3 VAD stuck-open fix**. NOT YET SHIPPED. Smoke when atomic commit lands.
  - **Will verify (when shipped):** (1) Speak softly for 1.5s; VAD closes due to rolling probability floor. (2) Trigger empty-audio capture; Whisper output `[BLANK_AUDIO]` discarded, no spurious transcript chunk. (3) Long real utterance (>30s) NOT cut.

- [ ] **9.4 Mobile Safari OOM repeat-hit observation** (Fix 27, `f237673`).
  - **Window:** 24h from 2026-05-25.
  - **Action:** Use mobile Safari voice across day, intentionally backgrounding and resuming tab.
  - **Verify:** No repeat of OOM crash. If it happens: open Voice diagnostics panel → ring buffer shows `vad-error` entries (was UI-toast-only pre-fix). Append to bug doc 2026-05-16-voice-restart-oom-regression.md.

### Tier 5 — Diagnosed-only, NOT smoke targets

These are open investigations in FIXES.md; fixes not yet written. Listed so they don't get confused with shipped items.

- **Fix 25** — Mic input level + sensitivity sliders not applying / scaled wrong. Three root causes documented (silero needs voice off/on, mapping curve too permissive at sensitivity=0, mic_gain applied AFTER silero). Fix pending mapping curve change + GainNode upstream of silero + clearer toast.
- **Fix 26** — `Lex hold up` wake-phrase kills mic permanently. Asymmetric cancel path; hold_up's cancelTts closure doesn't send `{t:'tts-cancel'}` frame to client. Fix pending: add the frame, or add client-side `voice-hold-up` handler calling resetTtsPlayback.

### Not-built / future

- [ ] Auto-discover projects under `C:/dev/Projects` filtered by project-marker files.
- [ ] Event-driven supervision router (debouncer dedup by tail signature, kill-switch >20 events / 10min, dashboard supervision_mode toggle).
- [ ] Phase 7 speaker diarization (pyannote).
- [ ] Phase 6 live_state Curator alert payload extension.
- [ ] Dashboard restart-daemon button timing copy fix (says "few seconds", actually takes minutes).
- [ ] Smart-clear rename (current `smart-compact` name misleads).

## Stop conditions

Item moves out of this doc when verified on real hardware and noted in HOW-TOs or HANDOVER. Item moves to deferred only if blocking conditions (real iOS device, real third-party session, throwaway worker) aren't present.
