# Bug: brainstorm-picker-and-transcripts

**Status:** Fixed (pending soak) — 2026-05-11, Wave 3 fixup sprint.

**Date opened:** 2026-05-10

---

## Symptoms

Two related issues observed together:

1. **Brainstorm picker shows empty list or stale sessions.** The `/brainstorms`
   dashboard page occasionally renders an empty list or a list missing recent
   sessions, even after refreshing. Navigating away and back sometimes fixes it.

2. **Transcript content missing from BrainstormDetail.** When viewing a session
   at `/brainstorms/[id]`, the transcript section is blank even when
   `brainstorm_chunks` rows exist for that session in the database. The audio
   player may render (audio file exists) but the transcript/chunks panel shows
   nothing.

---

## Root cause

### Issue 1 (picker empty list)

The `/lex/sessions` endpoint and the `/brainstorms` route both call
`listBrainstorms()` from `brainstorm-store.ts`. This delegates to
`store.db.listBrainstorms()`. After Wave 2 day 3 (backfill), the `brainstorm_chunks`
embedding step runs async; if a daemon restart occurs mid-backfill, the
`brainstorm_sessions` rows exist but `brainstorm_chunks` are partially inserted.
The `BrainstormList` component does not render partially-indexed sessions
differently, so they appear blank until the embedder finishes.

Separately: `BrainstormList` in the dashboard uses a `useQuery` hook with a 60s
`staleTime`. On first mount it fetches from `GET /brainstorms`, then serves from
cache for 60s. If the daemon restarts (with reaper running) between two mounts,
the cache contains stale "ended" sessions while the new daemon has no active
sessions. The list appears empty until the cache expires.

### Issue 2 (transcript missing)

`BrainstormDetail` loads the brainstorm row from `GET /brainstorms/:id` which
includes the `artifacts_json` manifest but does NOT include the `brainstorm_chunks`
rows. The chunk transcript requires a separate call that the current `BrainstormDetail`
component does not make. The `GET /lex/sessions/:id/artifacts` route loads artifact
files (research notes, wiki drafts, etc.) but not transcript chunks.

The transcript display in `BrainstormDetail.tsx` currently shows audio and cues
from the WAV file, but there is no component or API endpoint for rendering the
text transcript from `brainstorm_chunks` rows. The voice WS pipeline writes chunks
during session, but the display surface was not implemented.

---

## Fixes required

### Issue 1 fix (staleTime)

Reduce `staleTime` in `BrainstormList` from 60s to 10s, or add a `refetchInterval`
of 30s so the list stays fresh after daemon restarts. This is a one-line
dashboard change.

### Issue 2 fix (transcript API + component)

Add a daemon route `GET /brainstorms/:id/chunks?limit=200` that returns
`brainstorm_chunks` rows for the session (text fields only, no embeddings).
Add a `BrainstormTranscript` component in `BrainstormDetail` that renders the
chunks as a conversation transcript (user/lex turns, timestamps, mode badges).

---

## Fixes shipped

- Issue 1 (picker stale list): no fix required at code-review time.
  `BrainstormList` already uses `refetchInterval: 5_000` with no
  explicit `staleTime`, so the list refreshes every 5s automatically.
  The 60s staleTime claim in the original root-cause analysis was
  stale; the code path it described no longer exists. Verified by
  re-reading `08-dashboard/components/BrainstormList.tsx`.
- Issue 2 (transcript missing): shipped.
  - Daemon: new `GET /brainstorms/:id/chunks?limit=N` (cap 1000,
    default 200) in `07-daemon/src/dashboard/routes.ts`. Returns
    `{ok, chunks: BrainstormChunkRow[]}` sourced from
    `store.db.listBrainstormChunks`; embeddings stay server-side.
  - Daemon: regression tests in
    `07-daemon/tests/brainstorm-chunks.test.ts` cover ordering by
    turn_index, the limit argument, and brainstorm_id isolation.
  - Dashboard: `getBrainstormChunksApi` helper +
    `BrainstormChunkRow` type added to `daemon-client.ts`.
  - Dashboard: new `BrainstormTranscript` subcomponent inside
    `BrainstormDetail.tsx` (kept in `components/` since the file was
    already there; the Lane B conflict-avoidance rule expired with
    Wave 3 lane merge). Renders chunks as a role-tagged list with
    turn index, mode, and timestamp.

## Verification

1. `tsc --noEmit` clean on both projects.
2. `npx vitest run tests/brainstorm-chunks.test.ts`: 3/3 pass.
3. Manual: load `/brainstorms/<id>` for a session that has chunks;
   the new Transcript section renders user/lex turns under the audio
   player.
