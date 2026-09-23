# Brainstorm jsonl repoint can drop trailing turns of old CC session

**Status:** shipped (2026-05-25)
**Severity:** medium (data loss window narrow but real)
**First seen:** Discovered during Stage 2 spec review on 2026-05-25, not a field-observed incident yet.

## Summary

`brainstorm-jsonl-ingestor.ts` picks which CC jsonl to tail by reading `row.claude_session_id` at each tick (line 117 in `defaultResolveJsonlPath`). The brainstorm row's `claude_session_id` is a mutable pointer at the underlying jsonl. `bindBrainstormSessionId` (`brainstorm-store.ts:234`) repoints it whenever a CC session id is freshly written to the PTY, called from `pty-host.ts:305`. Triggers: `/clear`, `--resume` rejected by the CLI, fresh spawn under an existing brainstorm row.

When the pointer flips:

1. Any turns appended to the OLD jsonl AFTER the ingestor's last tick but BEFORE the repoint are never seen by the ingestor and never land in `brainstorm_chunks`.
2. The ingestor's `offsets` map is keyed by `row.id` alone. After a repoint, the new jsonl is read starting at the stale offset of the old session. If the new jsonl is shorter than the old offset, the slice returns empty (handled). If it is longer, the ingestor skips into the middle of the new session's content.

## Affected paths

- Only brainstorm rows that OWN a PTY (cc-pty brainstorms). Pure Lex voice brainstorms ingest via `lex-voice-ws.ts` direct chunk writes, not the jsonl tail.
- Worker attach via `lex_transcript_ref` does NOT repoint the anchor row's `claude_session_id`, so anchored Lex brainstorms with a worker reference are not exposed via THIS bug.

## Probability

Low per session-end, non-zero. Each `/clear` or `--resume` reject on a cc-pty brainstorm is a roll of the dice. Loss size = trailing turns written in the gap between last ingest tick (cron cadence) and the repoint.

## Fix

Two changes in the bind path, smallest viable patch, one commit.

### Change 1: Final drain tick on the old session before repoint

`brainstorm-store.ts:bindBrainstormSessionId` (line 234): before calling `updateBrainstorm` with the new `claude_session_id`, run one synchronous `runBrainstormJsonlIngestTick` against the row in its current state. That drains any unread turns from the old jsonl into `brainstorm_chunks` with the correct OLD `cc_session_id` stamped per line.

### Change 2: Key offsets by (row_id, claude_session_id)

`brainstorm-jsonl-ingestor.ts`: change `offsets` from `Map<row_id, number>` to `Map<row_id + ':' + claude_session_id, number>`. On read, look up by the composite key. On a repoint, the new key starts at offset 0 cleanly; the old key remains but is no longer referenced (cleanup deferrable). Side benefit: the test reset helper `_resetBrainstormOffsetsForTests` still works because Map.clear is composite-key agnostic.

### Contract tests

1. Repoint scenario: write old jsonl with 3 turns, run 1 tick, flip `claude_session_id` to a new id pointing at a new jsonl with 2 turns, run another tick. Assert 5 brainstorm_chunks rows total, 3 with old `cc_session_id`, 2 with new.
2. Stale-offset scenario: write old jsonl with 10 turns, run 1 tick (all 10 ingested, offset = file size), flip `claude_session_id` to a new id pointing at a fresh jsonl with 4 turns, run another tick. Assert all 4 new turns ingested under the new `cc_session_id`. Without the fix, this would skip past the new turns because the stale offset for `row.id` is larger than the new file.
3. Drain-on-repoint scenario: append a turn to the old jsonl, do not run an ingest tick, call `bindBrainstormSessionId`. Assert the trailing turn lands in `brainstorm_chunks` with the OLD `cc_session_id`.

## Queue position

Queued behind Stage 2 (now complete) and the voice mic-init fix (commit f237673, complete). Land as a standalone commit, then enter smoke test.

## Resolution (2026-05-25)

Shipped per the Fix section as a single commit. Both changes
landed:

- `brainstorm-store.bindBrainstormSessionId` runs one synchronous
  `runBrainstormJsonlIngestTick` against the row in its CURRENT
  state before the `updateBrainstorm` flips `claude_session_id`.
  Guarded with try/catch so an ingestor throw never blocks the
  bind (PTY discovery is the higher-priority signal).
- `brainstorm-jsonl-ingestor` offsets map keyed by
  `${rowId}:${claude_session_id}` via a private `offsetKey`
  helper. New `ccKey` lookup inside `runBrainstormJsonlIngestTick`
  composites the key from the row's CURRENT claude_session_id at
  tick time, so a post-repoint tick starts at offset 0 on the new
  jsonl. Old key remains in the map but is no longer referenced
  (cleanup deferred; cost-free in-process map).

Three contract tests in
`07-daemon/tests/jsonl-repoint-drain-loss.test.ts` pin the bug-doc
"Contract tests" scenarios: repoint, stale-offset, and drain-on-
repoint. The drain-on-repoint test confirms the trailing turn
lands in `brainstorm_chunks` with the OLD `cc_session_id` even
when no cron-cadence ingest tick fires between the append and the
bind. 861/861 daemon tests green (+3 over Stage 2's 858).

Existing regression test
`tests/brainstorm-jsonl-ingestor.test.ts` "resumes from the per-
session byte offset on the next tick" updated to the new composite
key shape (`${BS_ID}:${CC_SESSION}` instead of `BS_ID`); no
production behavior change.

Bug doc closed in this commit. Live smoke test runs as part of
the broader Stage 0-2 + voice-fix + repoint-fix smoke batch the
operator is staging.
