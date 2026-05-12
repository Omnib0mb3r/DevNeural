# Spec: Project anchors — durable session model for Claude Code projects

**Created:** 2026-05-11 (brainstorm session "DevNeural Testing")
**Status:** Ready to plan/implement.
**Pattern source:** mirrors the just-shipped `lex_session` anchor model (commit `5af07d0`).

---

## Goal

Projects must:

1. Show up on the dashboard Sessions board.
2. Stay there across daemon restarts, weekends, and Claude Code process exits.
3. Be reachable by Lex via cross-session inject using a stable, well-known session ID surfaced in `<live_state>`.

The current path (Stream Deck identity files + jsonl mtime) is brittle: identity files go stale, mtime-based liveness misses a session whose conversation is idle, and history is lost when the daemon restarts before the deck tray re-registers.

---

## Model

### `project_session` anchor table

One row per project subdirectory under `C:\dev\Projects`. Stable identity that
outlives the underlying Claude Code session UUID.

| Column                | Type | Notes |
|-----------------------|------|-------|
| `id`                  | TEXT PK | Stable anchor id. UUID minted on first registration. |
| `project_slug`        | TEXT UNIQUE | Folder basename (`DevNeural`, `stream-deck`, ...). |
| `cwd`                 | TEXT | Full absolute path. Match key for bridge → anchor binding. |
| `title`               | TEXT | Display name. Defaults to `project_slug`, user-editable. |
| `status`              | TEXT CHECK(`live`/`dormant`) | Liveness from bridge connection. |
| `current_session_id`  | TEXT NULL | CC session UUID currently bound to this anchor. NULL when dormant. |
| `current_bridge_id`   | TEXT NULL | Bridge connection id while live. NULL when dormant. |
| `current_pty_id`      | TEXT NULL | Set when daemon-owned PTY; NULL for externally-launched. |
| `created_ms`          | INTEGER | First-seen timestamp. |
| `last_seen_ms`        | INTEGER | Most recent live→dormant transition. |

### `project_transcript_ref` table

Ordered pointer list of every CC jsonl that has ever belonged to an anchor.
Mirrors `lex_transcript_ref`. FK CASCADE on anchor delete.

| Column              | Type | Notes |
|---------------------|------|-------|
| `id`                | TEXT PK | UUID. |
| `anchor_id`         | TEXT FK → `project_session.id` | Cascade on delete. |
| `cc_session_id`     | TEXT UNIQUE | CC session UUID. |
| `jsonl_path`        | TEXT | Resolved at insert time. |
| `opened_ms`         | INTEGER | When session attached to anchor. |
| `closed_ms`         | INTEGER NULL | NULL while open. |

---

## Seeding

On daemon boot and on `C:\dev\Projects` filesystem-change events:

- Enumerate top-level subdirectories.
- Upsert one `project_session` row per subdirectory keyed by `cwd`.
- Folders removed from disk are NOT auto-deleted from the anchor table. They drop off the Sessions tab via a status filter (`exists_on_disk=false`), but the row stays. Explicit user delete is the only removal path.

The Projects root path (`C:\dev\Projects`) is configurable via env (`DEVNEURAL_PROJECTS_ROOT`).

---

## Liveness: bridge connection is the heartbeat

The VS Code bridge is the single source of truth for project liveness.

- Bridge connects to daemon, announces its `cwd` and (optionally) the CC session UUID. Daemon resolves the matching anchor by `cwd`, sets `status='live'`, fills `current_bridge_id` and `current_session_id`.
- Bridge disconnects cleanly, daemon flips `status='dormant'` and clears `current_*` fields.
- Bridge ping timeout (reuse existing heartbeat infra in `07-daemon/src`): if no ping for `BRIDGE_TIMEOUT_MS` (default 30s), treat as orphan, flip dormant.

No process scan, no jsonl mtime check, no Stream Deck identity files in the live path. The existing identity-file pipeline keeps working for backwards-compat but is no longer authoritative.

### Two windows on the same project

Daemon accepts multiple bridge connections per anchor. Dashboard / Stream Deck render exactly one tile per anchor with a connection count badge. `current_session_id` holds the most recently bound CC UUID (others reachable via `project_transcript_ref` lookup).

---

## Spawning: spawn-or-bind

Endpoint `POST /projects/:id/open` (or whatever the Sessions tile already calls):

1. Look up anchor by id.
2. If a live bridge already exists for that `cwd`, bind to it. No new spawn.
3. Otherwise spawn `claude.exe` in VS Code at that `cwd`. Bridge attaches, flip live, fill `current_*` fields.

Concurrent open clicks on the same anchor collapse to one spawn via per-anchor `Map<anchorId, Promise>` (same pattern as `openInFlight` from the lex rewrite).

---

## Surfacing in `<live_state>`

`buildVoiceSnapshot` includes live anchors under `open_projects`:

```
open_projects:
  - DevNeural (anchor 9d2a3f1c, session d8daa427, status=live, bridge=ok)
  - stream-deck (anchor 4e7b1a05, session 7f6c2911, status=live, bridge=ok)
```

Lex reads `current_session_id` from this block, uses it as `target_session` in `POST /lex/inject-cross-session`. No new auth surface — the existing HMAC token machinery covers project session IDs the same way it covers brainstorm session IDs today.

---

## Endpoints

- `GET /projects` — anchor list (live + dormant), seeded from disk on boot. Replaces the legacy `/sessions` list for project rendering.
- `GET /projects/:id` — single anchor, with `transcript_refs[]` and current bridge metadata.
- `POST /projects/:id/open` — spawn-or-bind. Per-anchor in-flight memoisation.
- `POST /projects/:id/end` — disconnect bridge, mark dormant. Does not delete the anchor.
- `PATCH /projects/:id` — rename (`title` only; `project_slug` and `cwd` are derived from disk).
- `DELETE /projects/:id` — explicit user delete. Cascades transcript refs.
- `GET /projects/anchor-tiles` — Stream Deck feed (phase derived from latest transcript tail, cross-checked against live bridge map). Same shape as `/lex/anchor-tiles`.

Legacy `/sessions` endpoints stay around for the Sessions UI write-through during the migration window; rip-out follows the same pattern as the lex rewrite step 6.

---

## Migration plan

1. **Migration 019:** create `project_session` + `project_transcript_ref` tables. Backfill from existing data:
   - Iterate `~/.claude/projects/<project-folder>/*.jsonl`, group by cwd, create one anchor per distinct cwd, populate transcript refs.
   - Seed any missing `C:\dev\Projects\*` subdirectories that don't yet have any jsonl as dormant anchors.
2. **Bridge wire-up:** extend bridge handshake to send cwd + CC session UUID. Daemon-side resolver in `07-daemon/src/dashboard/bridge.ts` (or sibling) updates anchor status + current_* fields.
3. **Spawn-or-bind endpoint:** `POST /projects/:id/open` with the openInFlight memoisation. Existing "Start Claude" and "Start skip permissions" Sessions buttons rewired to call it.
4. **Stream Deck:** dedupe rendering so each project shows exactly one tile keyed by anchor id, brainstorm tiles already on the new model stay as-is.
5. **live_state:** `buildVoiceSnapshot` reads `project_session WHERE status='live'`, emits the format above. Lex's system prompt updated to address projects via `current_session_id` from the anchor row.
6. **Rip-out:** remove deck-tray identity-file path from the authoritative liveness query in `sessions.ts`. Keep identity files for the editor-detection use case only (which VS Code window to focus on tile click).

---

## Already done — do NOT redo

- `lex_session` anchor model + migration 018 shipped in commit `5af07d0`. Mirror its patterns; do not re-derive.
- Cross-session inject shipped in commit `8f68121` (`POST /lex/inject-cross-session`, HMAC + allowlist + audit). Reuse for projects, no new auth surface needed.
- PTT mic-release fix shipped today in commit `e59b36e`. Don't reopen `2026-05-11-push-to-talk-not-releasing-mic.md`.
- State-tracker (deck identity stale) fix shipped: `IDENTITY_FRESH_MS` env-tunable. Don't reopen `2026-05-10-state-tracker-loses-live-sessions.md`.
- Brainstorm picker / transcript fix shipped: `2026-05-10-brainstorm-picker-and-transcripts.md` status fixed pending soak.

Verify against git log + bug-doc Status lines before opening any work item.

---

## Constraints / decisions

- `cwd` is the join key, not `project_slug`. Renaming a folder = new anchor (intentional — old one stays in history as dormant unless explicitly deleted).
- Anchor delete is user-only. No automatic decay.
- Bridge connection is authoritative for liveness. Process scan is NOT used.
- Two VS Code windows on the same cwd dedupe to one tile.
- Reactivating a dormant anchor reuses the same anchor id; new CC session UUID appended to transcript refs.
- This spec is the projects-side equivalent of the just-shipped lex_session rewrite. Keep the patterns symmetric so the catch-up protocol, retrieval helpers, and future thread-doc machinery can be shared.
