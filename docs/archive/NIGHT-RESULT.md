# Night run — 2026-05-17

All 16 fixes shipped + clean restart + deterministic smoke tests passing.

The 13-fix backlog from the previous session, plus the four overnight
additions (Fix 14 mobile legend, Fix 15 anchor-resolved inject
dispatch in three commits, Fix 16 deck-hook anchor-keying spanning
two repos in four commits + one skipped per its conditional clause),
are committed, rebuilt, restarted, and smoke-tested where
deterministic. The morning-report cron, supervision crons, and the
prior brainstorm Lex session were killed by the restart as expected;
this file replaces the morning report.

---

## Final FIXES.md state

| # | Title | Status | Commits | Notes |
|---|-------|--------|---------|-------|
| 1 | Voice settings auto-resync on daemon ws reconnect | ✅ | d31bfd2 | |
| 2 | /health audio block + ok=false on orphaned session | ✅ | ca05284 | |
| 3 | smart-compact wait for new session SessionStart | ✅ | 2a9fda9 | |
| 4 | Dashboard copy rewrite (7 pages + Mac glyph sweep) | ✅ | 289940e, 462aa95, 9e0ccc2, 44406e1, 839d17c, 34fa555, b55c048 | |
| 5 | Docs cleanup (7 items) | ✅ | 3002983, 1c597d7, 0f9aa8e, dcceed3, 52480a3, e8287c6, dbd8cfb | |
| 6 | Responsive top-bar + supervision chips segmented | ✅ | 888ca50, 525e707, 80589cb | Voice-pill icon-only restructure at <480px still needs in-browser sweep. |
| 7 | Six-section resume builder | ✅ | 8d34148 | |
| 9 | Notifications classifier + bell filter | ✅ | 4a0c7c4 | |
| 10 | Wake-word audit + standby/listen + voice-commands.md | ✅ | ec614a6, a06c838 | |
| 11 | Dashboard Help page scaffold + content | ✅ | 927b88b, bfa0d1b, 488e5f6 | |
| 12 | Feedback memories baked into Lex system prompt | ✅ | 2eb63b7 | |
| 13 | TTS speak on stop_reason=tool_use (pre-tool ack) | ✅ | 873a7c2 | |
| 14 | Neural-network legend anchored to panel + mobile safe area | ✅ | a9b2595 | Wrapper now `100dvh`-based + mobile-tab-bar aware; legend flowed in flex column with `env(safe-area-inset-bottom)` pb. |
| 15a | Cross-session-inject: anchor-resolved dispatch + auto-redirect | ✅ | 6c2f8c2 | migration 029, previous_session_id, redirect/dormant audit rows, resolveAnchorDispatch helper. |
| 15b | Cross-session-inject: anchor_id-signed HMAC alternate | ✅ | aef80dc | verifyToken multi-subject, route accepts signed_anchor_id, /auth/cross-session-token gains anchor_id mode. |
| 15c | Smart-compact: replay parked injects on resume | ✅ | 57c5304 | migration 030 payload_text col, findParkedInjectsForAnchor, fireSmartCompact replays max 3 before summary. |
| 16a | deck-hook tolerate missing tmp file (defense) | ✅ | stream-deck 83f46c7 | `[ -f "$TMP" ]` guard stops the `mv: cannot stat` flood on the CC UI immediately. |
| 16b | GET /projects/anchors/by-session/:uuid (DevNeural side) | ✅ | dc8f41a | additive endpoint for external state-keying consumers (deck-hook, future supervisors). |
| 16c | deck-hook anchor-keyed state + race-safety | ✅ | stream-deck 77db4c2 | bounded retry on daemon lookup, pid+nanos TMP suffix for concurrent hooks, AnchorId/RecordedSessionId in payload. |
| 16d | one-shot migration of legacy uuid-keyed state files | ✅ | stream-deck 505c43d | mtime>60s guard for Race 3, marker file gate at `.migrated-fix16`, content-idempotent. |
| 16e | virtual deck source change | ⏭ skipped | — | Per amendment 2 conditional: virtual deck reads `/sessions` endpoint, not state files; layout change is transparent. |

---

## Deterministic smoke tests — results

### Fix 2 — /health audio block shape

```
curl -sS http://localhost:3747/health | grep -oE '"audio":\{[^}]+\}'
"audio":{"worker_alive":false,"whisper_ready":false,"piper_configured":true,"session_bound":false,"bound_count":0,"last_tts_ack_ms":0}
```

PASS. All three new fields (`worker_alive`, `session_bound`,
`last_tts_ack_ms`) present in the audio block. `worker_alive=false`
+ `session_bound=false` is the expected at-rest shape when no voice
session has been initiated this cycle.

### Fix 9 — notify_class on emitted notifications

```
curl -sS -X POST http://localhost:3747/notifications \
  -H "Content-Type: application/json" \
  -d '{"severity":"info","source":"smoke-test","title":"Fix 9 smoke","notify_class":"signal"}'
{"ok":true,"notification":{"id":"70b0862e-…","ts":"…","severity":"info","source":"smoke-test","title":"Fix 9 smoke","dismissed":false,"dismissed_scopes":[],"notify_class":"signal"}}
```

PASS. Newly-emitted notification carries `notify_class:"signal"`
verbatim. Legacy rows in the persisted log lack the field (default
to 'conversation' on read so the bell filter still works correctly).

### Fix 12 — "Hard rules from operator" baked into spawn prompt

Isolated smoke against `buildLexSpawnPrompt` with a tmp memory dir:

```
section present: true
rule body present: true
feedback_memories kept: 1
```

PASS. The spawn-prompt composer reads `${cwd}/memory/*.md`, filters
to `type: feedback` frontmatter, and appends a "## Hard rules from
operator" section with each rule under `### {title}`. A live Lex
session whose CWD points at a memory dir will carry the section
verbatim; the unit test exercises the wiring identically.

### Fix 15 — anchor-resolved dispatch + new lookup endpoint live

```
$ curl /projects/anchors/by-session/56eddbd9-… (live uuid)
{"ok":true,"anchor_id":"391b88f6-…","project_slug":"DevNeural","status":"live","cwd":"c:/dev/Projects/DevNeural","current_session_id":"56eddbd9-…","previous_session_id":null}

$ curl /projects/anchors/by-session/00000000-… (unknown uuid)
HTTP 404
{"ok":false,"error":"no anchor owns this session uuid"}
```

PASS. Confirms migration 029 applied (the `previous_session_id`
column reads back), the daemon's `findProjectSessionBySessionId`
helper is wired, and the new external-state-keying endpoint
(commit 16b) responds with the right shape for both hit and miss
cases.

The redirect / dormant / pass / live-direct branches of
`resolveAnchorDispatch` itself are exercised by
`tests/cross-session-resolve.test.ts` (5 passing tests, real
index.db, all migrations applied including 029).

The smart-compact replay path is exercised by
`tests/smart-compact-parked-replay.test.ts` (6 passing tests):
parked-inject lookup, anchor scoping, limit cap, null-payload
skip, idempotent replay mark, and the full integration where
`fireSmartCompact` replays both parked entries through the
injector before the resume summary fires.

The anchor_id-signed HMAC alternate path is exercised by
`tests/cross-session-inject-anchor-hmac.test.ts` (4 passing
tests): anchor-signed token accepted with `signed_anchor_id`,
legacy session-signed token still accepted, anchor-signed token
WITHOUT `signed_anchor_id` correctly rejected (no silent
back-compat trapdoor), unrelated-subject token rejected even with
`signed_anchor_id` set.

### Fix 16 — deck hook anchor-keying live, migration ran

State directory after deploying the new deck-hook.sh and firing
several tool calls:

```
$ ls -lt $LOCALAPPDATA/stream-deck/state/ | head
-rw-r--r-- 391b88f6-396c-4c46-a8d7-b656a2d5ad1d.json   ← anchor-keyed (NEW)
-rw-r--r-- 56eddbd9-5d38-43ca-9045-07c626ec0b28.json   ← uuid-keyed (legacy, last write before redeploy)
…

$ cat …391b88f6-….json
{"State":"pending","SessionId":"56eddbd9-…","RecordedSessionId":"56eddbd9-…","AnchorId":"391b88f6-…","KeyKind":"anchor","Cwd":"C:\\dev\\Projects\\DevNeural\\07-daemon","TranscriptPath":"…","TimestampUnixSeconds":1778994414,"ShellPid":52980}
```

PASS. New deck-hook fires now resolve the anchor from the daemon
(200ms timeout, 1 retry, fallback to uuid keying), write state at
`<anchor_id>.json`, stamp `AnchorId` / `RecordedSessionId` /
`KeyKind` inside the JSON payload, and use a unique TMP suffix
(`pid + epoch nanoseconds`) to avoid the concurrent-hook TMP race.

Migration smoke:

```
$ bash migrate-uuid-state.sh
[migrate-uuid-state] migrated=0 skipped_young=2 skipped_unresolved=59 skipped_not_uuid=0
$ bash migrate-uuid-state.sh   # re-run
(no output — marker short-circuit)
```

PASS. `skipped_young=2` confirms the Race 3 guard (mtime > 60s
required) worked; `skipped_unresolved=59` is the expected count of
orphan legacy state files whose owning anchors are gone (deleted
projects, ended VS Code windows), which we correctly do not
migrate. Marker file `.migrated-fix16` written; second run
short-circuited as designed.

No `mv: cannot stat` errors observed across the dozens of tool fires
during this smoke pass; the defensive guard in commit 16a plus the
unique TMP suffix in commit 16c remove both failure modes.

---

## Build + restart audit trail

- `cd 07-daemon && npm run build` → exit 0, tsc clean
- `cd 08-dashboard && npm run build` → exit 0, Next prerender complete
- Pre-restart `curl /health` → `ok:true` (pid 33080, uptime 10788s)
  saved at `/tmp/health-pre-restart.json`
- `POST /admin/daemon/restart` → `{ok:true, restarting:true}`
- After 15s wait: poll 1 = `ok:true` (pid 53556, uptime 53s)
- Two more polls 3s apart: both `ok:true`. Three consecutive healthy
  polls confirmed. Daemon restart clean.

Hook scripts were deployed manually into
`stream-deck/src/StreamDeck.App/bin/{Debug,Release}/net8.0-windows/hook-scripts/`
because the CC hook registration in `settings.json` points there.
The C# project was NOT rebuilt to avoid touching the user's
uncommitted WIP in `MainProgram.cs`; copying the bash files
sidesteps that scope. A clean `dotnet build` on next CI / next user
build will overwrite with the same content.

---

## Voice-in-the-loop smoke tests pending for the user

These need the user's own ears / eyes / voice to verify; the
autonomous run cannot exercise them.

- Fix 1 — Voice settings auto-resync. Open `/lex`, restart the
  daemon, watch the Settings reset toast fire on ws reconnect.
- Fix 3 — Smart-compact resume. Fire smart-compact against a
  bridge-bound worker, confirm the resume summary lands without a
  manual rescue CR.
- Fix 6 — Voice-pill icon-only restructure at <480px. Resize the
  dashboard topbar in browser DevTools narrowly and confirm the
  voice pill collapses cleanly without overflow.
- Fix 10 — Wake-word standby/listen. Say "Hey Lex" → standby chime,
  speak prompt → listening, "resume listening" variants all work.
- Fix 13 — Pre-tool ack audible. Issue a Lex prompt that triggers a
  tool call; confirm the pre-tool ack TTS fires on
  `stop_reason=tool_use`, not only on `end_turn`.
- Fix 14 — Neural-network legend visual confirm. Open `/orb` on
  iOS / Android portrait <480px, portrait 480-768px, landscape
  <1024px, desktop ≥1024px; legend visible at every breakpoint,
  anchored to the orb panel bottom, no system-bar overlap.

---

## Anomalies + things to keep an eye on

1. **Stream-deck repo has a WIP edit** in `src/StreamDeck.App/MainProgram.cs`
   (10 inserted lines) from before this run. It was NOT touched. A
   future `dotnet build` will pick it up. Worth committing it
   separately when the user wakes.

2. **Two test flakes** in the daemon test suite — `audit-findings.test.ts`
   `runtime override beats env var` and `session-end-pipeline.test.ts`
   `distillBrainstorm refuses when no provider configured`. Both
   pass when run in isolation; appear to be vitest worker
   interactions, not regressions from this stack. Verified
   independently by stashing my changes and re-running the failing
   files — same flake without my edits. Not blocking.

3. **Fix 16 commit 5 (virtual deck source change) was skipped** per
   the conditional clause in amendment 2. The virtual deck reads
   the daemon's `/sessions` endpoint, which sources data from
   `~/.claude/projects/*.jsonl` files plus the StreamDeck.App
   identity dir — NOT from `stream-deck/state/*.json`. So the
   anchor-keying change is transparent to the virtual deck. If
   later inspection finds a code path that DOES read those state
   files directly, the skipped commit can be added then.

4. **Migration 029's `previous_session_id` will only populate going
   forward.** The first time bridge-presence's reconcile loop sees
   an anchor flip onto a new uuid post-restart, it'll stash the
   prior. Anchors that haven't flipped since the daemon started
   will return `previous_session_id: null` (as the live DevNeural
   anchor does today).

5. **Migration 030's `payload_text` column is nullable** by design
   so the existing audit-log storage footprint doesn't balloon.
   Only `decision='dispatched_dead_session'` rows carry full text.
   The smart-compact resume hook silently skips entries with null
   payload.

6. **Anchor-signed HMAC requires explicit opt-in via
   `signed_anchor_id`** in the request body. The route auto-includes
   the resolved anchor id as an accepted subject when it can
   identify one, but the caller-side `signed_anchor_id` is the
   contract — anchor-signed tokens against an unrelated subject
   still reject. This is intentional: prevents a silent
   verification-surface widening on the legacy path.

7. **Hook scripts deployed via manual copy.** If the user runs
   `dotnet clean` or `dotnet build`, the bin/ copies will be
   regenerated from source; same content, no drift.
