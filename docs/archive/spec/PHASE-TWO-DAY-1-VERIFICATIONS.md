# Phase Two day-1 verifications

> Captured 2026-05-10 by the Wave 1 executor (Claude Code session `868e8145`) immediately before Wave 1 day 1 step 1. Answers Q-1 through Q-20 from `docs/spec/PHASE-TWO-IMPLEMENTATION.md` section 15 by inspecting the codebase at commit `7444f25` on branch `phase-two`.
>
> Each answer carries file:line evidence so future sessions can re-derive without repeating the investigation. Where a thing does not exist yet, "NOT FOUND" is recorded with what was searched.

## Q-1: Highest existing migration number in `07-daemon/scripts/migrations/`

**Answer:** Directory does not exist. No existing numeric scheme.

**Decision:** Use plain `NNN-` numeric prefix starting at `001`. Wave 1 day 1 takes `001` through `009`; Wave 2 day 1 takes `010` through `013` plus `013a`; Wave 3 day 1 takes `014`.

**Mechanical pass applied:** the `P2-W1-D1-`, `P2-W2-D1-`, `P2-W3-D1-` placeholder prefixes in `PHASE-TWO-IMPLEMENTATION.md` were replaced with the empty string in a single sweep on `phase-two` branch immediately before any migration file was created. The replacement happened on this branch only; `master` keeps the original placeholder spec for traceability.

## Q-2: PK type for tables

**Answer:** TEXT UUIDs throughout.

**Evidence:** `07-daemon/src/store/index-db.ts:84` and lines 98, 125, 132, 148 (all existing tables use `id TEXT PRIMARY KEY`). Matches spec mandate (Appendix C portability).

## Q-3: Auth header / cookie name for dashboard endpoints

**Answer:** Cookie name `dn_session`. HTTP-only, `secure=false` (Tailscale perimeter only), `sameSite=lax`. 12-hour max-age. Signed with HMAC-SHA256, expiry checked on verify.

**Evidence:** `07-daemon/src/dashboard/auth.ts:18-19`. `COOKIE_NAME = 'dn_session'`, `COOKIE_MAX_AGE_S = 12 * 60 * 60`.

**Action for new Phase Two endpoints:** reuse this cookie scheme. Do not introduce a parallel auth path.

## Q-4: Project metadata schema and tags for domain-distance

**Answer:** No tags field exists.

**Evidence:** `07-daemon/src/types.ts:31-38` (`ProjectRegistryEntry` has only `id`, `name`, `root`, `remote`, `first_seen`, `last_seen`). `07-daemon/src/identity/registry.ts:32-60` confirms registration only writes those five.

**Action:** Wave 1 day 2 step 16 implements CP-1 cross-project promotion. Per spec, fall back to "different `project_slug` = different domain" until tags are added. Adding the 5-axis taxonomy from Appendix G is a follow-up commit (not a day-1 blocker).

## Q-5: Session-end pipeline file path

**Answer:** `07-daemon/src/lex/session-end-pipeline.ts`.

**Evidence:** File exists. Handles brainstorm session end, forces final ingest, updates summary, embeds summary chunk. Called from voice WS close, PTY exit, and voice command paths.

**Action for Wave 1 day 2 step 20:** edit this file to add the 8-step atomic flush ordering with session-level lock; add `wiki_drafts` write step.

## Q-6: SW caching strategy for audio

**Answer:** No caching logic at all in the service worker.

**Evidence:** `08-dashboard/public/sw.js` (54 lines) contains only `install`, `activate`, `push`, `notification` handlers. Zero `caches.*` API calls.

**Action:** No change needed in Wave 1. Audio range-request endpoint added in Wave 2 will work uncached by default. If a caching layer is added later, audio must bypass it.

## Q-7 + Q-14: Existing scheduler mechanism for nightly jobs

**Answer:** No dedicated `scheduler.ts`. In-process scheduling exists as scattered `setInterval` calls.

**Evidence:** `07-daemon/src/daemon.ts:626` (`startAutoIngestInterval`, 5 min), `:639` (`startWikiPushInterval`, 5 min), `:659` (decay, 24 h). Outside the daemon: PowerShell-installed Windows scheduled tasks for backup (`07-daemon/scripts/install-backup-task.ps1`).

**Action for Wave 1 day 2:** new `07-daemon/src/scheduler.ts` consolidates new Phase Two periodic jobs (canary, schema regression, lint nightly, etc.). Existing `setInterval` callers are NOT migrated in Wave 1 (out of scope; would risk regression). Spec section 15 Q-14 endorses single in-process scheduler over multiplying Windows tasks.

## Q-8: Wiki frontmatter parser tolerates unknown fields

**Answer:** Yes. Unknown fields silently pass through.

**Evidence:** `07-daemon/src/wiki/schema.ts:199` (`parseFrontmatter` -> `parseSimpleYaml` at `:217-292` -> `normalizeFrontmatter` at `:308-331`). Unknown YAML keys are parsed into a `RawObj` but never fail validation; only known fields are extracted.

**Action:** Wave 1 day 1 step 11 (frontmatter sweep migration) is safe to add `schema_version`, `last_verified`, `frozen`, `source_brainstorms`, `source_meetings`, `derived_from_brainstorm`, `derived_from_meeting` without breaking the loader.

## Q-9: Legacy brainstorm transcripts on-disk location

**Answer:** Brainstorm sessions live under `<DATA_ROOT>/brainstorm/`. Artifacts (research-notes, wiki-drafts, etc.) live under `<DATA_ROOT>/lex/artifacts/<kind>/<id>.json`. No per-brainstorm audio file storage exists yet.

**Evidence:** `07-daemon/src/lex/brainstorm-store.ts:80` for the brainstorm path. `07-daemon/src/lex/artifact-parser.ts:108` for artifact path.

**Action for Wave 2 day 2 step 11:** new `data/brainstorms/<id>/audio/<id>.opus` plus sibling `<id>.cues.json` per spec. Backfill script (Wave 2 day 3) walks `data/brainstorms/`.

## Q-10: Domain-distance taxonomy

**Answer:** Depends on Q-4. Since no tags exist, the spec's 5-axis taxonomy in Appendix G is the proposal. Wave 1 day 2 step 16 ships with the "different `project_slug` = different domain" fallback per Q-4 action; the full taxonomy is a follow-up commit (not Wave 1 blocker).

## Q-11: Existing draft / reminder schema patterns

**Answer:** Reminders exist; wiki_drafts do not.

**Evidence:** `07-daemon/src/dashboard/reminders.ts:15-24`. Append-only JSONL with ops replay. Fields: `id`, `title`, `due_at?`, `project_id?`, `tags[]`, `created_at`, `completed_at?`, `archived`.

**Action:** `wiki_drafts` is a new SQLite table (section 3.4); reminders pattern (JSONL) is not adopted for it because drafts need joinable status filters and indexed retrieval. Reminder pattern stays untouched in Wave 1.

## Q-12: Confidence formula for `wiki_drafts.confidence`

**Answer:** Spec-defined (Appendix H). No existing code.

**Action for Wave 1 day 2 step 20:** implement the heuristic in the session-end pipeline draft creation step. Refinement is Wave 3.

## Q-13: Dashboard stack confirmation

**Confirmed exactly:** Next.js `^15.0.4`, React `^19.0.0`, Tailwind `^4.0.0`, Tanstack Query `^5.62.0`, Tremor `^3.18.7`. Vitest `^2.1.0` for daemon tests. Fastify `^5.0.0`, better-sqlite3 `^12.9.0`, node-pty `^1.1.0`. `08-dashboard/package.json`.

## Q-14: Scheduler shape

See Q-7. Wave 1 ships a new `07-daemon/src/scheduler.ts` for new Phase Two periodic jobs.

## Q-15: Audio bundle format on disk today

**Answer:** Not yet stored on disk.

**Evidence:** `07-daemon/src/voice/lex-voice-ws.ts` runs the WS audio loop. `07-daemon/src/voice/whisper.ts:13` documents 16kHz mono WAV input to whisper but the PCM is never persisted.

**Action for Wave 2 day 2 step 11:** introduce the `<session_id>.opus` plus `.cues.json` write at session end. Backfill script in Wave 2 day 3 needs no per-utterance consolidator because there are no per-utterance files to consolidate; legacy sessions just lack audio.

## Q-16: SQLite WAL mode

**Answer:** ON.

**Evidence:** `07-daemon/src/store/index-db.ts:75`: `this.db.pragma('journal_mode = WAL')`. `synchronous = NORMAL`, `foreign_keys = ON`. Reference store sets the same pragmas.

## Q-17: Dashboard auth scheme

See Q-3. PIN-cookie scheme; reuse for all new endpoints. No parallel auth path.

## Q-18: Existing migration runner

**Answer:** No runner exists. The closest analogue is `07-daemon/src/store/index-db.ts:81` (`migrate()`), which is an inline `db.exec` of CREATE TABLE statements at boot, not a versioned runner.

**Action for Wave 1 day 1 step 2:** build minimal runner at `07-daemon/src/db/migrate.ts` per spec section 3 protocol path 1c. Read `07-daemon/scripts/migrations/*.sql` in lex order, run each inside a transaction, record applied filenames in a new `_migrations` table. The migrate function runs at daemon boot after env load and before HTTP bind. The existing inline `migrate()` in `index-db.ts` is left in place for now (creates the legacy tables; the new runner only handles new SQL files); a future cleanup pass can fold them together.

## Q-19: Rate-limiting on PIN auth

**Answer:** Yes.

**Evidence:** `07-daemon/src/dashboard/auth.ts:20-22`. `LOCKOUT_THRESHOLD = 5`, `LOCKOUT_WINDOW_MS = 60 * 1000`, `LOCKOUT_DURATION_MS = 5 * 60 * 1000`. Returns HTTP 429 on lockout (`:274`).

**Action:** None. Spec acceptance criterion satisfied.

## Q-20: NVIDIA-SMI availability

**Answer:** On PATH. Returns `/c/Windows/system32/nvidia-smi`. Host has an RTX 5080 per `07-daemon/src/voice/whisper.ts` comments.

**Action:** Wave 2 day 1 step 4 VRAM monitor can use `nvidia-smi`. No fallback needed.

---

## Summary for Wave 1 day 1 execution

**Critical blockers:** None.

**Pre-existing strengths:**

- TEXT UUID PKs (matches Appendix C portability mandate).
- WAL mode on (read concurrency during backups + dashboard reads).
- Auth cookie + rate-limiting in place; reusable.
- Wiki frontmatter parser tolerates unknown fields; sweep migration is safe.
- Session-end pipeline file exists; ready to be edited for the 8-step ordered flush.

**Things Wave 1 must build:**

1. Migration runner (`07-daemon/src/db/migrate.ts`).
2. Migrations directory (`07-daemon/scripts/migrations/`) and the 9 SQL files (001 through 009).
3. Frontmatter sweep TS migration (009).
4. New scheduler (`07-daemon/src/scheduler.ts`) for new periodic jobs only.
5. Code wiring per Wave 1 day 2 (recall reweight, decay scope, outbound rule, cross-project threshold, Pass 2 schema-as-living-config, frozen flag honour, pause mode, session-end pipeline auto-distillation).
6. Day 3 observability (curator instrumentation, Curator Health card, Brainstorm KPI tiles, Outbound card, canary, schema regression suite, README + outbound.md, integration test scaffolding).

**Things Wave 1 explicitly does NOT touch (per spec):**

- Meeting code paths (Wave 2 day 5).
- Awareness broadcaster, `recent_context()` tool (Wave 2 day 5 / Wave 3 day 3).
- Backfill, audio retention, GPU queue, heartbeat (Wave 2).
- Unified orb, cross-brainstorm linking, P2-2 broadcaster (Wave 3).

End of day-1 verifications.
