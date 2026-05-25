# Cold-start preload pulls stale distillation despite recent ended sessions

**Status:** open
**Severity:** medium
**First seen:** 2026-05-24

## Symptoms

Fresh Lex brainstorm spawn at ~00:05 EDT 2026-05-24 (cc_session `145600c9...`). Cold-start preload preamble reported:

> Loaded 5 sibling sessions, last distilled 22:15 EDT, 32 recent turns appended.

User had ended multiple sibling brainstorm sessions on this anchor (`4bbafb48-bbfd-47e6-b076-e1a58a334303`, "DevNeural Testing") between 22:15 EDT and the new spawn. Expected the preload to reflect a newer `last_distilled_ms`. Instead the preload still pointed at the 22:15 stamp.

Confirmed via `GET /lex/cold-start-preload/events`:

```
last_distilled_ms: 1779588908205   # = 2026-05-23T22:15 EDT
preloaded_ids: []
already_present_ids: []
sibling_count: 5
```

`preloaded_ids` and `already_present_ids` both empty is suspicious. Either the preloader did not select the more-recent sibling rows, or those rows have `last_summary IS NULL` and the generator skipped them, or the post-session distillation pipeline did not run on end.

## Suspected root cause (user-flagged)

**User hypothesis (2026-05-24, voice):** Lex only distills his own chunks when no worker session is attached. Once a worker binds to the brainstorm, the Lex-side distillation path either short-circuits or never gets the Lex turns into `brainstorm_chunks`, so the post-session distillation has nothing to summarize and `last_summary` stays null. Sibling preload then falls back to the most recent pre-attach distillation (22:15 EDT), which is what showed up in the preamble.

Investigation should focus on:

- Brainstorm rows for the sessions ended between 22:15 EDT 2026-05-23 and ~00:05 EDT 2026-05-24 on anchor `4bbafb48-bbfd-47e6-b076-e1a58a334303`. Confirm `attached_worker_session_id` was set on those rows.
- Compare `brainstorm_chunks` count for an attached session vs. an unattached one. If attached rows have zero or near-zero Lex-role chunks, that confirms the gate.
- Inspect the chunk-write branches in `07-daemon/src/voice/lex-voice-ws.ts` (cc-pty vs direct-llm paths around line 823 and line 1169/1224) for any worker-attached guard.
- `brainstorm-jsonl-ingestor.ts` reads `row.claude_session_id`. If attached brainstorms re-point that field to the worker's CC session, the ingestor is tailing the wrong jsonl and Lex's own turns never land.

### Fix requirement (user, 2026-05-24)

Lex chunks must always land in Lex's restart distillation. Worker attached or not, the Lex-side chunk capture and post-session distillation are non-negotiable. Worker attachment is an addition, not a replacement, for Lex's own conversation record. Any gate that drops Lex chunks when a worker is bound is a bug, not a feature.

### Original triage hypotheses (kept for completeness)

1. **Distillation-on-end not firing.** Session-end pipeline (post split into `session-end-pipeline.ts` flush + end wrapper, commits `a751669`, `08c827c`) may not be invoking the distillation generator for sessions ended via the new path. Result: `brainstorm_sessions.last_summary` stays null, sibling preload has nothing to surface.
2. **Sibling preload label filter excludes ended sessions.** `preloadSiblingDistillations` filters by normalized `user_label`. If new ended sessions have a different (or null) label vs the spawning session's label, they fall out of the sibling set.
3. **Preload limit + ordering masks newer.** Default `limit: 2` on preload, but query pulls `listBrainstorms({limit: 200})` ordered by `started_ms DESC`. If newer sessions exist with null `last_summary`, they sit at the head of the sort, the generator runs and returns null, and the preamble reports the older row that already has a summary. `preloaded_ids: []` suggests the generator never produced anything new this spawn.

## Investigation pointers

- Code: `07-daemon/src/lex/sibling-distillation-preload.ts`, `07-daemon/src/lex/lex-cold-start-preamble.ts`, `07-daemon/src/lex/distillation-generator.ts`, `07-daemon/src/lex/sibling-distillation-backfill.ts`, `07-daemon/src/lex/session-end-pipeline.ts`.
- DB: `brainstorm_sessions` rows for anchor `4bbafb48-bbfd-47e6-b076-e1a58a334303` between 1779588908205 and 1779593144000. Check `last_summary`, `last_summary_ms`, `ended_ms`, `user_label`.
- Recent commits touching the area: `c9e3c49` (restore preload density), `d9b2e6b` (anchor transcript_refs cap 5), `694c0cc` (strict cold-restart compaction), `0a32429` (sibling distillation preloader top-2).

## Open items

- Get user's diagnosis and append.
- Reproduce: end a brainstorm session, confirm `last_summary_ms` updates within X seconds.
- Validate sibling preload selects the newest distilled sibling, not just the first 2 oldest with summaries.
- If session-end distillation is async/queued, surface failure in the preload event payload so this is debuggable from the dashboard.

## Stage 0 progress (2026-05-25)

Spec `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` breaks the fix into eight
stages. Stage 0 (substrate-only, three commits) shipped:

- `d9a9740` migration 036: `brainstorm_chunks.cc_session_id` (nullable) +
  composite index `(brainstorm_id, cc_session_id, turn_index)` for the
  Stage 2 per-session distillation read pattern.
- `80c9a03` migration 037: `lex_transcript_ref.ref_summary` +
  `ref_summary_ms` (both nullable) + index on
  `(lex_session_id, ref_summary_ms DESC)` for freshness lookups.
- `a0eb4c0` write-path: `brainstorm-jsonl-ingestor` lifts
  `entry.sessionId` per CC line; `lex-voice-ws.ts` assistant-text path
  resolves `handle.sessionId ?? state.watchSessionId`; direct-LLM path
  passes `cc_session_id: null` explicitly. `IndexDb.insertBrainstormChunk`
  + `BrainstormChunkRow` carry the column through.

No consumer reads `cc_session_id` yet. All 851 daemon tests still green.
Reversible by column drop. **Bug stays open**: Stage 0 only allocates
storage. The actual cure for the stale-distillation behavior is Stages
1-3 (capture-invariant test, per-session distillation writer, sync
barrier + freshness signaling). Stage 0 is a no-op user-visibly; the
22:15 EDT preamble will keep happening until Stage 2 lands.

External Codex peer review of the spec was attempted and blocked by a
401 invalid API key. Stage 0 commits are additive and reversible so
proceeding ahead of re-review is safe. Any irreversible step (data
migrations that drop or rewrite columns, deletion of helpers still on
read paths) MUST pause for the re-review before merge.

## Stage 1 progress (2026-05-25)

Capture invariant landed. Findings:

- Audit of `07-daemon/src/voice/lex-voice-ws.ts` and
  `07-daemon/src/lex/brainstorm-jsonl-ingestor.ts` found NO worker-
  attachment gates on the chunk-write path. The two
  `attached_worker_session_id` references in voice-ws (lines 771 and
  1315) are post-write lifecycle transitions (deciding whether the
  brainstorm row's `lifecycle_state` moves to `attached` or `idle`
  after Lex speaks); neither conditions the chunk insert.
- Original user hypothesis (lines 26-39 above) that "Lex only distills
  his own chunks when no worker session is attached" is therefore
  partially refuted at the write layer. The chunks DO write under
  attached sessions structurally. Two more candidates for the stale-
  preamble symptom remain:
  1. The post-session distillation pipeline does not fire on the
     attached path (Stage 2 territory).
  2. The brainstorm row's `claude_session_id` field gets re-pointed
     to the worker on attach and the ingestor then tails the wrong
     jsonl - Lex's turns are written under a different brainstorm
     row entirely. Worth verifying with a live repro: end an attached
     session, dump `brainstorm_chunks WHERE brainstorm_id = ...` and
     check whether Lex turns landed.
- Added a write-side regression guard:
  `tests/brainstorm-jsonl-ingestor.test.ts`
  "attaches a worker to the brainstorm and still ingests every Lex
  turn (capture invariant)". Sets `attached_worker_session_id` on the
  brainstorm row, walks a four-turn jsonl through the ingestor, and
  asserts: (a) all four chunks land, (b) the three Lex turns produce
  role='lex' rows with the expected ids, (c) cc_session_id from the
  jsonl line stamps onto every Lex chunk. A future regression that
  gates the chunk write on attachment turns this test red.
- No code changes to lex-voice-ws.ts or brainstorm-jsonl-ingestor.ts
  in this stage; the test is the deliverable. 852/852 daemon tests
  green.

Bug stays open. Stage 2 (per-session distillation writer) is the
next step toward the actual cure. Live attached-session repro still
TODO to disambiguate root cause between distillation-not-firing and
ingestor-tailing-wrong-jsonl.
