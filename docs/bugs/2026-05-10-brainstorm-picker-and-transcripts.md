# Bug: brainstorm-picker-and-transcripts

**Status:** Deferred to Wave 4 (transcript endpoint + BrainstormTranscript component)

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

## Deferred

**Wave 4 carry-over.** Both fixes require dashboard component changes.
Issue 1 is trivial (staleTime change). Issue 2 requires a new API endpoint plus
a new component; the component belongs in `08-dashboard/src/system/` per the
Lane B conflict-avoidance rule (not in `components/` which may conflict with
Lane A if Lane A touches BrainstormDetail.tsx).

Interim workaround for issue 1: the user can force-refresh the browser tab to
bust the cache. For issue 2: the database is correct; the transcript can be
queried directly via SQLite as a workaround until the component ships.

---

## Verification plan

1. Ship `GET /brainstorms/:id/chunks` returning `{ok, chunks: BrainstormChunkRow[]}`.
2. Add `BrainstormTranscript` component, render in `BrainstormDetail.tsx` below audio.
3. Reduce `BrainstormList` staleTime to 10s.
4. Verify: fresh daemon restart, brainstorm list shows within 10s; session detail shows transcript.
