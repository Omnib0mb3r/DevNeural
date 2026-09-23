# LEX-AUTONOMY codex item 5: sync barrier + freshness metadata in cold-start preload

**Reported:** 2026-05-26 04:35 EDT by operator
**Severity:** medium (correctness risk on cold-start handoff under ingestion lag; no live bug yet observed)
**Status:** CLOSED. Shipped as Fix 42 (`ec0d98a`, 2026-05-26). See FIXES.md row 42.
**Related:** `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` (codex order line 290); Stage 1 written-path invariant; Stage 2 cc_session_id schema; Stage 3 per-session distillation; codex item 4 distillation query scope fix. FIXES rows for Stages 1-4 already shipped. This investigation maps codex item 5 only; items 6-9 deliberately deferred per codex warning at spec line 299 ("do not ship 5-9 before 1-4").

## Question 1: where is cold-start preload assembled today?

### Entry point

`POST /lex/cold-start-preload` is the SessionStart-hook-driven route. Handler at `07-daemon/src/dashboard/routes.ts:4503`.

Request body: `{ session_id: string; cwd?: string }`. The hook fires once per fresh Lex brainstorm session boot; CC injects the response `block` as additionalContext on the first turn.

### Resolution pipeline

1. Mode gate: `coldStartPreloadMode(store.db)` returns `off | shadow | live`. Off short-circuits before any work (`07-daemon/src/dashboard/routes.ts:4541-4545`). Audit row written via `insertCrossSessionLog` with `caller_label='cold-start-preload'`.
2. Brainstorm row lookup: `getBrainstormByClaudeSessionId(sessionId)` (`07-daemon/src/dashboard/routes.ts:4550`). Audits `no-brainstorm-bound` on miss.
3. Label resolution: `bs.user_label ?? bs.derived_label`. Audits `no-label` on miss (`07-daemon/src/dashboard/routes.ts:4561-4570`).
4. Force-distill pass: `preloadColdStartSiblings` synchronously distills the top-N (default 2) siblings with NULL `last_summary` (`07-daemon/src/dashboard/routes.ts:4602-4610`).
5. Block render: `buildSiblingIndex` reads the now-updated rows and renders the markdown listing (`07-daemon/src/dashboard/routes.ts:4627-4635`).
6. Preamble + header pill: `formatColdStartPreamble` + `formatHeaderStatus` shape the first-turn one-liner and the brainstorm UI status pill (`07-daemon/src/dashboard/routes.ts:4611-4680`).
7. Audit row + return shape: `decision='accepted'` when live, `'shadow'` when shadow. Returns `{ block, preamble, header_status, preload_summary }`.

### Components pulled

| Surface | Source | File:line |
|---|---|---|
| Sibling rows (label-match path) | `listBrainstorms({ limit: 200 })` filtered by `user_label` (case-insensitive) | `07-daemon/src/lex/sibling-distillation-preload.ts:76-81` |
| Sibling rows (anchor-refs path) | `listLexTranscriptRefs(anchorId)` filtered by `cc_session_id !== current` | `07-daemon/src/lex/lex-cold-start-preamble.ts:133-143` |
| Per-sibling distillation | `brainstorm_sessions.last_summary` column | read via `BrainstormSessionRow.last_summary` |
| Distillation timestamp | `brainstorm_sessions.last_summary_ms` column | read via `BrainstormSessionRow.last_summary_ms` |
| Per-session distillations (rolling aggregate input) | `lex_transcript_ref.ref_summary` rows for the anchor | `07-daemon/src/store/index-db.ts:2090-2093` (`listRecentRefSummariesForLexSession`) |
| Per-session distillation timestamp | `lex_transcript_ref.ref_summary_ms` column | `07-daemon/src/store/index-db.ts:360` |
| Per-session provenance | `lex_transcript_ref.source_chunk_count`, `.source_session_ids`, `.coverage_score` | `07-daemon/src/store/index-db.ts:364-366` |
| Recent verbatim turns count | jsonl read of each prior ref's `transcript_path` -> `extractLastTurnPairs` | `07-daemon/src/lex/lex-cold-start-preamble.ts:144-150` |
| HANDOVER doc freshness override | `findLatestHandover(brainstormId)` + `fs.statSync(filePath).mtimeMs` | `07-daemon/src/lex/lex-cold-start-preamble.ts:239-253`, `271-282` |

### Read-side freshness ordering

Three layers stack, in order from least-fresh to most-fresh:

1. `brainstorm_sessions.last_summary` (set by `recomputeRollingAggregate` at session-end OR by anchor-flat fallback in `runBrainstormChunksFallback`). Timestamp lives on `.last_summary_ms`.
2. `lex_transcript_ref.ref_summary` for each prior CC session under the anchor, ordered by `ref_summary_ms DESC` and capped at N=3 (`07-daemon/src/lex/rolling-aggregate.ts:56`). The aggregate stitches the newest N with session separators.
3. HANDOVER-*.md docs on disk. Mtime beats `last_summary_ms` when newer: `effectiveMs = max(last_summary_ms, handover_mtime_ms)` per `07-daemon/src/lex/lex-cold-start-preamble.ts:241-249`.

The anchor-refs primary path (`summarizeFromAnchor`) bypasses layers 2 + 3 entirely and uses the anchor's own `last_summary_ms` plus a turn-pair count extracted from each prior ref's jsonl on disk (`07-daemon/src/lex/lex-cold-start-preamble.ts:155-156`). Note: this path does NOT consult `ref_summary_ms` directly; the timestamp returned is the *anchor's* `last_summary_ms`, which lags every individual `ref_summary_ms` whenever the rolling aggregate has not run since the most-recent per-session distillation.

## Question 2: sync barrier definition + race window inventory

### Sync barrier (precise statement)

A cold-start preload SHALL not return a block until BOTH conditions hold:

(a) every chunk produced by every prior CC session under the anchor up to the boundary (where "boundary" = the moment the new CC session's first turn is about to fire) has been persisted to `brainstorm_chunks`, AND

(b) every `lex_transcript_ref` row for prior CC sessions on this anchor has a `ref_summary` that was written AFTER its last contributing chunk landed, OR an explicit "stale" flag on that row when the distillation could not catch up before the boundary.

The current pipeline guarantees neither condition. The visible failure mode is: cold-start preload renders an aggregate over `ref_summary_ms` rows that were written before the latest turns landed in `brainstorm_chunks`, so the rendered preamble says "last distilled 14:32" while the most recent five turns from a session that ended at 14:33:50 are silent.

### Race window 1: brainstorm-jsonl-ingestor tick gap

Source: `07-daemon/src/lex/brainstorm-jsonl-ingestor.ts:293` (`DEFAULT_INGESTOR_INTERVAL_MS = 5_000`).

Symptom: CC writes turn N to its jsonl at time T. The ingestor tick is on a 5s interval; the chunk lands in `brainstorm_chunks` at T + (up to 5s). If the new session boots between T and T+5, the cold-start preload reads `brainstorm_chunks` and gets N-1 rows.

Aggravating factor: composite offset key `${rowId}:${claude_session_id}` (`07-daemon/src/lex/brainstorm-jsonl-ingestor.ts:95-97`) means a repointed brainstorm starts at offset 0 on the new session, so the ingestor must walk that new jsonl before fresh chunks land. The bounded read (`cap = 4 MB`, `07-daemon/src/lex/brainstorm-jsonl-ingestor.ts:157`) caps a single tick. A large prior session's catchup walk can stretch across several ticks.

### Race window 2: distillation-write-vs-aggregate-read

Source: `07-daemon/src/lex/session-end-pipeline.ts:514-582` (Step 7a) and `07-daemon/src/lex/rolling-aggregate.ts:69` (`listRecentRefSummariesForLexSession`).

Symptom: Step 7a runs `createPerSessionDistillationGenerator` against `listBrainstormChunksForSession` (`07-daemon/src/lex/distillation-generator.ts:273-278`). The generator reads the chunks table at distillation-time T_dis; if the ingestor's most-recent tick was at T_dis - 5s, any turn that landed between (T_dis - 5s) and T_dis is missing from the prompt input. The resulting `ref_summary` is *materially incomplete* and stamped `ref_summary_ms = Date.now()` (`07-daemon/src/lex/session-end-pipeline.ts:546`). Downstream readers cannot tell this row is stale.

Compounding: the session-end pipeline does NOT call the ingestor synchronously before reading. `runOrderedPipeline` (`07-daemon/src/lex/session-end-pipeline.ts:236`) holds the session-end lock (`07-daemon/src/lex/session-end-lock.ts:21`) but the lock is per-`sessionId`, not per-ingestor. Concurrent ingestor ticks can race the distillation read.

### Race window 3: aggregate-write-vs-preload-read

Source: `07-daemon/src/lex/session-end-pipeline.ts:556-570` (`recomputeRollingAggregate` writes `brainstorm_sessions.last_summary`).

Symptom: aggregate writes `brainstorm_sessions.last_summary` after the per-session ref write. If a *new* session on the same anchor boots between the per-session write and the aggregate write, `listRecentRefSummariesForLexSession` will return the freshly-written ref row but the anchor's `last_summary_ms` will still point at the previous aggregate. The anchor-refs path (`summarizeFromAnchor`) returns the stale `last_summary_ms` and reports "last distilled HH:MM" off by one full aggregate cycle.

### Race window 4: jsonl write order vs jsonl ingest order

CC's jsonl writer is the source of truth for turn ordering; the ingestor processes in jsonl write order (`for (let i = 0; i < text.length; i++)` newline-walk at `07-daemon/src/lex/brainstorm-jsonl-ingestor.ts:223`). When the same brainstorm spans MULTIPLE CC sessions (anchor re-attachment after /clear), the ingestor walks each session's jsonl on its own composite offset key. Two CC sessions writing concurrently (e.g. supervisor terminal + worker terminal both bound to the same anchor) appear interleaved by *which-ingestor-tick-fired-first*, not by wall-clock. The aggregate's "newest N by `ref_summary_ms`" ordering can therefore present an *older real-time* session ahead of a *newer real-time* one if the older session's distillation happened to land first.

### Race window 5: session-end-lock per-key scope

The session-end lock (`07-daemon/src/lex/session-end-lock.ts:19`) is keyed by `claudeSessionId ?? brainstorm:${brainstormId}`. Different CC sessions on the same anchor take different keys; two concurrent session-end pipelines on the same anchor can each write to `lex_transcript_ref` AND each call `recomputeRollingAggregate` simultaneously. The aggregate read is read-only on the same schema so it is safe at the DB level, but the LAST writer's `last_summary` wins, and the loser's per-session write may not be in the aggregate it just produced if the read happened before the loser's per-session write committed.

## Question 3: freshness metadata in the preload payload

### What the payload exposes today

The route returns (`07-daemon/src/dashboard/routes.ts:4696-4707`):

```
{
  ok: true,
  block: string,                  // markdown listing of siblings
  reason: 'live' | 'shadow' | ...,
  sibling_count: number,
  brainstorm_id: string,
  label: string,
  mode: 'live' | 'shadow' | 'off',
  preamble: string,               // first-turn one-liner
  header_status: { tone, text },  // brainstorm UI pill
  preload_summary: {
    preload: { preloaded, skipped, already_present },
    sibling_count: number,
    last_distilled_ms: number | null,    // max ref_summary_ms surfaced
    recent_turns_appended: number,
    failure_reason: string | null,
    handover_sourced_count?: number,
  }
}
```

The freshness-meaningful fields are `last_distilled_ms` (`07-daemon/src/lex/lex-cold-start-preamble.ts:265`) and the implicit `handover_sourced_count` flag. Per-row freshness data on `lex_transcript_ref` exists in the DB (`source_chunk_count`, `coverage_score`) but is NOT surfaced to Lex through the payload.

### Gaps that block staleness detection

| Gap | Current state | What Lex can't tell |
|---|---|---|
| Per-ref `latest_chunk_ms` (last contributing chunk ts) | absent | "this ref was distilled, but 4 chunks landed AFTER `ref_summary_ms`" |
| Per-ref `chunks_at_distill_count` denominator | `source_chunk_count` exists but is the count shipped to the LLM, not the total at distill time | "this ref covered 30 of 200 chunks (coverage 0.15) but I can't see 200 vs the 250 chunks live now" |
| Per-ref `latest_chunk_at_distill_ms` (timestamp of newest chunk that fed the prompt) | absent | "did the distillation see turn N before or after I started?" |
| Per-anchor `ingestor_high_water_ms` (last brainstorm-jsonl-ingestor tick on this anchor's active jsonl) | absent (the offset map is in-memory only) | "did the ingestor finish catching up to the on-disk jsonl before the preload fired?" |
| Per-anchor `last_chunk_ms` (newest `brainstorm_chunks.timestamp_ms` for this anchor) | derivable from `listBrainstormChunks(anchor_id, 1, {order:'desc'})` but not exposed in payload | "is the rolling aggregate based on the same chunks I'm about to see, or older ones?" |
| Per-ref `staleness_ms = latest_chunk_ms - ref_summary_ms` | derivable from two missing fields | unreachable today |
| Per-ref `barrier_passed` flag | absent | "did this ref's distillation observe ALL chunks committed before the new session boot?" |

### Proposed new fields

On `lex_transcript_ref`:
- `latest_chunk_ms` INTEGER NULL: max(`brainstorm_chunks.timestamp_ms`) across the chunks that fed this ref's distillation prompt. Set in Step 7a alongside `ref_summary_ms` (`07-daemon/src/lex/session-end-pipeline.ts:546`).
- `latest_chunk_id` TEXT NULL: uuid of that newest chunk. Useful for grep + debugging "ref summary missed turn X".
- `chunks_at_distill_count` INTEGER NULL: total chunks scoped to (brainstorm, cc_session) at the moment the per-session generator queried. Distinct from `source_chunk_count` (LLM-fed count); this is the denominator for coverage independent of the `min(chunkLimit, total)` cap.
- `staleness_state` TEXT NULL CHECK in (`fresh`, `stale_writer_caught_up`, `partial_writer_in_flight`, `unknown`): explicit marker. Stage 6's failure surfacing reads this; until Stage 6 it stays advisory.

On `brainstorm_sessions`:
- `last_chunk_ms` INTEGER NULL: max(`brainstorm_chunks.timestamp_ms`) across all chunks under this anchor. Cheap to recompute; useful as the staleness denominator.

In the preload payload, expose under `preload_summary`:
- `last_chunk_ms`: anchor-wide newest chunk timestamp.
- `refs`: array of `{ ref_id, cc_session_id, ref_summary_ms, latest_chunk_ms, staleness_ms, staleness_state, coverage_score }` so Lex can render per-session freshness in the system prompt and decide whether to ask "should I re-read session X?".

### Staleness derivation Lex can run

Given the new fields:
- `staleness_ms = max(last_chunk_ms - ref_summary_ms, 0)` per ref.
- A ref is fresh when `staleness_ms < TICK_INTERVAL_MS` (5000) AND `staleness_state === 'fresh'`.
- The whole anchor is fresh when every surfaced ref is fresh AND `last_chunk_ms - max(ref_summary_ms across refs) < TICK_INTERVAL_MS`.

If the anchor is not fresh, Lex's autonomy surface can either (a) print a soft preamble line "context may be missing 3 recent turns (ingestor lag)" or (b) request a synchronous re-distillation before the cold-start block ships. Stage 6 wires the action; Stage 5 ships the data + the freshness derivation primitive.

## Question 4: failure modes (informs codex 6)

### Generator crash mid-run

`createPerSessionDistillationGenerator` returns null on every error path:
- no provider (`07-daemon/src/lex/distillation-generator.ts:252-254`)
- provider not configured (`07-daemon/src/lex/distillation-generator.ts:256-260`)
- BF-4 anthropic block (`07-daemon/src/lex/distillation-generator.ts:262-268`)
- no session-scoped chunks (`07-daemon/src/lex/distillation-generator.ts:279-289`)
- empty transcript (`07-daemon/src/lex/distillation-generator.ts:299-302`)
- provider call throw (`07-daemon/src/lex/distillation-generator.ts:316-321`)
- empty LLM reply (`07-daemon/src/lex/distillation-generator.ts:322-325`)

When null is returned, Step 7a logs the structured skip reason (`07-daemon/src/lex/session-end-pipeline.ts:571-574`) and leaves `lex_transcript_ref.ref_summary` NULL. No partial write, no half-summary. This is correct.

### Aggregate computation failure

`recomputeRollingAggregate` returns null when zero `ref_summary` rows exist on the anchor (`07-daemon/src/lex/rolling-aggregate.ts:69-71`). The caller logs and leaves the prior `last_summary` in place (`07-daemon/src/lex/session-end-pipeline.ts:568-570`). Failure mode here: stale `last_summary` survives indefinitely if no ref ever distills successfully. Lex cannot tell from the payload whether the aggregate is current or frozen.

### Distillation generator crash mid-await

`await perSessionGen` is wrapped in try/catch at the outer Step 7a (`07-daemon/src/lex/session-end-pipeline.ts:514-582`). Any throw (DB connection drop, OOM in provider client, fs failure) logs and bails out of Step 7a entirely. `ref_summary` stays at its previous value (NULL on first attempt, prior content on retry); the aggregate is NOT recomputed; the anchor's `last_summary` is NOT touched. From the cold-start preload's POV: `last_distilled_ms` is whatever the previous successful distillation produced. No signal of in-flight failure.

### Ingestor crash inside `runBrainstormJsonlIngestTick`

The tick wrapper at `07-daemon/src/lex/brainstorm-jsonl-ingestor.ts:310-323` swallows the throw, logs, and sets `inFlight = false`. The next tick re-walks from the last committed offset; the partial line at end-of-tick is preserved via `lastComplete` rewind (`07-daemon/src/lex/brainstorm-jsonl-ingestor.ts:222-269`). No data loss, but the failed tick's offset advancement is lost so the next tick re-reads the same range. Repeat failures stall ingestion indefinitely without surfacing past the daemon log.

### Anchor row vs ref row write ordering

Step 7a writes `lex_transcript_ref.ref_summary` first (`07-daemon/src/lex/session-end-pipeline.ts:544-550`), THEN computes the aggregate, THEN writes `brainstorm_sessions.last_summary` (`07-daemon/src/lex/session-end-pipeline.ts:561-564`). Between the two writes, a cold-start preload firing on the same anchor will see:
- new `ref_summary` rows
- stale `last_summary` (one aggregate-cycle behind)
- stale `last_summary_ms`

The anchor-refs path (`summarizeFromAnchor`) uses `last_summary_ms`, so it under-reports freshness during this window. The label-match path uses the per-row `last_summary_ms` for each surfaced sibling so it is closer to truth, but still shows the previous aggregate's data for the active anchor.

### Worker-detach / direct-llm fallback

`runBrainstormChunksFallback` runs when `claudeSessionId` is null OR no `project_session` row exists (`07-daemon/src/lex/session-end-pipeline.ts:266-279`). The fallback writes `last_summary` via the legacy anchor-flat generator (`07-daemon/src/lex/session-end-pipeline.ts:740-757`) AND attempts the per-session write when a `cc_session_id` is present (`07-daemon/src/lex/session-end-pipeline.ts:773-840`). Two writers can land on the same anchor: the anchor-flat LLM summary at line 749, then the rolling aggregate at line 815-819. Last writer wins; the LLM result is silently overwritten by the deterministic aggregate when the ref machinery succeeds. Failure mode: if the ref write succeeds but the aggregate computation throws between line 815 and line 819, the anchor's `last_summary` is the LLM result (correct content but a one-cycle-stale timestamp on `last_summary_ms`).

## Question 5: per-anchor vs per-session ordering + boundary handling

### Sibling source selection

Two paths:

1. **Anchor-refs primary path** (`summarizeFromAnchor` at `07-daemon/src/lex/lex-cold-start-preamble.ts:129-157`): runs when `anchorId` is supplied. Reads `listLexTranscriptRefs(anchorId)` and filters to refs where `cc_session_id !== currentCcSessionId`. The active session is excluded by this filter. Returns the top-N (default 5) by `ordering DESC`.

2. **Label-match fallback** (`07-daemon/src/lex/sibling-distillation-preload.ts:60-112`): runs when anchor-refs is null. Reads `listBrainstorms({ limit: 200 })`, filters by case-insensitive `user_label` equality, excludes the current brainstorm id.

The route at `07-daemon/src/dashboard/routes.ts:4602-4610` passes both `anchorId: bs.id` AND `excludeId: bs.id`, so the anchor-refs path runs first and the label-match force-distill only fires when anchor-refs is empty (e.g. a brand-new anchor with no prior CC sessions).

### Does the active session appear in its own sibling list?

No. The route excludes by either `currentCcSessionId` (anchor-refs path filter at `07-daemon/src/lex/lex-cold-start-preamble.ts:140`) or `excludeId` (label-match filter at `07-daemon/src/lex/sibling-distillation-preload.ts:78-80`).

This matters for the sync barrier: chunks landed on the active session BEFORE the cold-start boot are real context (the worker may have written code, committed, then /clear'd). Today they are deliberately excluded. Lex sees nothing from her own pre-clear self in the cold-start block, which is the original design intent (the active session has access to its own jsonl via standard CC tooling). For Stage 5 the question is whether the active session's most-recent `ref_summary` should be promoted into the cold-start preamble as a "you just came from this" hint. Recommendation: leave the exclusion as-is for Stage 5, revisit for Stages 6-7 when the failure-surfacing + adaptive walk-back features ship.

### Across-session vs within-session boundary

The "boundary" in codex item 5 vocabulary is the moment a new CC session attaches to the anchor (SessionStart hook fires, route is hit). At that moment:
- `lex_transcript_ref` has a new row whose `cc_session_id = sessionId` and `ref_summary = NULL`. The prior session(s) have rows whose `ref_summary` should be populated.
- `brainstorm_chunks` may still be catching up on the prior session's tail (ingestor tick gap, race window 1).
- `brainstorm_sessions.last_summary` reflects the rolling aggregate as of the prior session-end (race window 3 if the new session boots before the aggregate write completes).

The sync barrier must straddle "across-session" (waits for the prior CC session's `ref_summary` to be written) AND "within-session" (waits for the ingestor to drain the prior session's jsonl tail before the per-session distillation runs).

### Per-session ordering for the aggregate

`listRecentRefSummariesForLexSession` orders by `ref_summary_ms DESC` then renders newest-first (`07-daemon/src/lex/rolling-aggregate.ts:85-87`). This is *write-order*, not *session-end-order*. Two prior sessions A (ended T1) and B (ended T2 > T1) where A's distillation crashed mid-run and was retried at T3 > T2 will render A on top, B below, even though B is conceptually newer. The rolling-aggregate.ts file header explicitly notes "newest-first order in the rendered text" (`07-daemon/src/lex/rolling-aggregate.ts:14-16`) but does not call out that this is write-order, not session-order. Stage 5 should expose both fields to Lex so she can decide which ordering matches her need.

## Proposed sync barrier mechanism (shape only; ship spec details next round)

Three-part barrier:

### Part A: synchronous ingestor catchup before per-session distillation

At the top of Step 7a (`07-daemon/src/lex/session-end-pipeline.ts:514`), call `runBrainstormJsonlIngestTick` synchronously against the closing brainstorm before reading scoped chunks. This collapses race window 1 + 2 into a single window where the ingestor + distillation generator + aggregate all run under the session-end lock. The lock currently funnels per-`sessionId` calls but does not prevent the ingestor's setInterval from firing in parallel; this Part A makes the session-end runner drive the ingestor explicitly rather than waiting on the cron.

Cost: one ingestor tick worst-case 4MB read; bounded.

### Part B: stamp `latest_chunk_ms` + `chunks_at_distill_count` on each `lex_transcript_ref` write

Extend the per-session generator's return type to include the newest chunk's timestamp from the scoped chunk fetch (`07-daemon/src/lex/distillation-generator.ts:273-278`). Step 7a writes these alongside `ref_summary_ms`. The DB schema gains two nullable columns on `lex_transcript_ref` (migration 041 candidate; numbering subject to operator confirmation).

### Part C: cold-start preload surfaces per-ref staleness in the payload

`preloadColdStartSiblings` returns a new `refs: PerRefFreshness[]` field carrying `{ ref_id, cc_session_id, ref_summary_ms, latest_chunk_ms, staleness_ms, staleness_state, coverage_score }` for each surfaced ref. The route returns this in `preload_summary.refs`. The first-turn preamble + header pill stay unchanged shape-wise but their content reflects the new freshness data.

A "barrier-passed" guarantee is the conjunction:
- Part A ran for the prior session at session-end time, AND
- Part B's `latest_chunk_ms` equals `db.maxChunkMsForSession(brainstorm, cc_session)` at preload-read time, AND
- The anchor's `last_chunk_ms` equals the max across all refs' `latest_chunk_ms`.

When all three hold, every ref's distillation observed every chunk that the new session can possibly know about. The preload returns `barrier_passed: true`. When any fails, the preload returns `barrier_passed: false` with the specific failing condition; Stage 6 wires this into a soft-warning preamble.

## Open questions for ship-spec round

1. Do we ship Part A (synchronous ingestor tick at session-end) as part of Stage 5, or defer to Stage 6 where it pairs with explicit failure surfacing? Operator should decide; Part A is cheap but adds a strict ordering constraint that has not been live-soaked.
2. New `lex_transcript_ref` columns: nullable additive migration (safe, reversible) vs CHECK-extending rebuild (consistent with migration 040 pattern). Recommendation: additive nullable for Stage 5.
3. `staleness_state` enum values: keep the four proposed (fresh, stale_writer_caught_up, partial_writer_in_flight, unknown) or simplify to two (fresh, stale)? Stage 6 needs the finer-grained values for explicit surfacing; Stage 5 may not.
4. Should the preload payload's `refs` array include the active session's own ref row (NULL `ref_summary` at boot time) so Lex sees the "you, mid-distill" state? Current exclusion in `summarizeFromAnchor` says no; codex item 5 might say yes.
5. Order-of-operations: ship the schema migration first (no-op until readers care) or bundle migration + readers in one commit? Migration-first lets Stage 5b read the new columns without a rebuild dependency.

## Out of scope (this round)

- Code changes. Two-spec policy applies; investigation only.
- Codex items 6-9 (failure surfacing UI, adaptive walk-back, worker boot payload, first-attach path). Codex's "do not ship 5-9 before 1-4" warning is satisfied (1-4 are shipped); items 6+ are deliberately deferred to a separate cycle.
- Dashboard surface for the new freshness fields. The `LexColdStartPreloadPanel` may want a per-ref freshness column once the payload exposes it; that is a follow-up.
- Killing the label-match fallback path (codex item 12). Independent concern; leave alone until project_scope_id ships.

## Cross-references for ship spec

- Stage 1 (write-path invariant): commit a0eb4c0 era
- Stage 2 (cc_session_id schema): commit a0eb4c0 + migration 037
- Stage 3 (per-session distillation): `07-daemon/src/lex/distillation-generator.ts:242` `createPerSessionDistillationGenerator`
- Stage 4 (query scope fix): `07-daemon/src/lex/distillation-generator.ts:94-105` (DESC + reverse + tail-byte cap)
- Stage 5 (THIS): sync barrier + freshness metadata
- Stage 6 (deferred): stale/failure surfacing in UI + payload + reminder
- Stage 7 (deferred): adaptive walk-back
- Stages 8-12 (deferred): worker boot payload, first-attach path, loose-ends gate, grooming, project_scope_id
