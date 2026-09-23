# LEX-AUTONOMY codex item 7: adaptive walk-back over session bundles

**Reported:** 2026-05-26 05:30 EDT by operator
**Severity:** medium (current preload picks last N blindly; quality of cold-start context is best-effort recency)
**Status:** CLOSED. Shipped as Fix 44 (`0a0d71f`, 2026-05-26). See FIXES.md row 44.
**Related:** `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` codex order item 7 (line 292); Q3 codex tightening (line 247); Stage 4 plan (line 180-181). Builds on Fix 42 (`latest_chunk_ms` + `isRefStale`) and Fix 43 (staleness surfacing + distillation_error_log). Codex 8 (deterministic worker-boot payload) consumes the same walk-back primitive; codex 7 ships first.

## Question 1: current walk-back behavior

### Anchor-refs primary path

`07-daemon/src/lex/lex-cold-start-preamble.ts:258-286` `summarizeFromAnchor`:

1. `db.listLexTranscriptRefs(anchorId)` returns refs ordered by `opened_ms ASC` (per `07-daemon/src/store/index-db.ts:2275 listProjectTranscriptRefs ... ORDER BY opened_ms ASC`).
2. Filter: `r.cc_session_id !== currentCcSessionId` (exclude the active session).
3. Re-sort: `b.ordering - a.ordering` (DESC by `ordering`).
4. Cap: `slice(0, refLimit)` where `refLimit = ANCHOR_REF_LIMIT_DEFAULT = 5` (`lex-cold-start-preamble.ts:112`).

The route passes `anchorRefLimit` undefined (`07-daemon/src/dashboard/routes.ts:4602-4610`), so refLimit defaults to 5. Same path used by `buildSiblingIndex` at `07-daemon/src/lex/sibling-index.ts:209-251`.

### Label-match fallback

`07-daemon/src/lex/sibling-distillation-preload.ts:60-112`:

1. `db.listBrainstorms({ limit: 200 })` (DESC by `started_ms` per `listBrainstorms`).
2. Filter by case-insensitive `user_label` equality + exclude current brainstorm id.
3. First N rows where `last_summary` is empty get force-distilled by the per-session generator (cap `limit=2`).
4. Sibling-index render uses up to `limit=5` (set at the route call in `07-daemon/src/dashboard/routes.ts:4633` `limit: 5`).

### Ordering signal weights used today

| Signal | Anchor-refs | Label-match |
|---|---|---|
| Recency (started_ms / ordering DESC) | yes, sole ranking | yes, sole ranking |
| Freshness (`ref_summary_ms` vs `latest_chunk_ms`) | no | no |
| Topic continuity | no | no |
| Pinned ref | no support | no support |
| Supersession (one ref's chunks subset of another) | no | no |
| User intent (`/lex pin/unpin`) | no surface exists | no surface exists |

Net: blunt recency. The youngest 5 refs win regardless of topic, freshness, or completeness. A 30-second test session that was abandoned ranks ahead of a 4-hour deep session from 2 hours ago.

### Deduplication today

Anchor-refs path: deduped only by `cc_session_id !== currentCcSessionId` (excludes the active session). No other dedup; the same ref cannot appear twice anyway (UNIQUE index `uq_lex_transcript_ref_cc` on `cc_session_id`).

Label-match path: deduped by `r.id !== excludeId` (current brainstorm row). No cross-anchor dedup; a label that maps to four brainstorm rows shows all four if they share the same user_label, even if they cover the same project arc.

There is NO supersession dedup. Two refs whose ref_summary text overlap completely both render. Two refs whose `source_session_ids` arrays are identical both render. The cold-start preamble duplicates information across sessions when the user resumed mid-stream and the new ref summarizes a superset of an older ref.

## Question 2: inputs available for the heuristic

### Per `lex_transcript_ref` row

| Field | Source | Always populated? | Notes |
|---|---|---|---|
| `id` (PK) | migration 018 | yes | row PK; not a heuristic input but a join key. |
| `lex_session_id` | migration 018 | yes | anchor id; the brainstorm. |
| `cc_session_id` (UNIQUE) | migration 018 | yes | scope key for per-session distill. |
| `transcript_path` | migration 018 | yes | jsonl on disk; cost-of-load proxy. |
| `started_ms` | migration 018 | yes | recency input. |
| `ended_ms` | migration 018 | sometimes (null while live) | session duration when set. |
| `ordering` | migration 018 | yes | monotone integer per anchor; recency. |
| `ref_summary` | migration 037 | NULL until session-end | distillation text. |
| `ref_summary_ms` | migration 037 | NULL until distilled | freshness numerator. |
| `source_chunk_count` | migration 038 | NULL when summary NULL | chunks fed to LLM. |
| `source_session_ids` | migration 038 | NULL when summary NULL | JSON array; supersession key. |
| `coverage_score` | migration 038 | NULL when summary NULL | fraction `[0,1]`; recommend min 0.3 for inclusion. |
| `latest_chunk_ms` | migration 041 (Fix 42) | NULL pre-migration | freshness denominator; backfilled. |

Per investigation 5 of codex 5, `chunks_at_distill_count` was PROPOSED but NOT shipped. Verified: `grep -r "chunks_at_distill_count" 07-daemon/src/store/index-db.ts` returns no matches. The current `source_chunk_count` (LLM-fed count) is the only count column. Codex 7 should NOT add `chunks_at_distill_count`; the proposed shape can derive what it needs from `source_chunk_count` + `coverage_score` (denominator implied by `source_chunk_count / coverage_score`).

### Per `brainstorm_sessions` row

| Field | Source | Used for |
|---|---|---|
| `id` | core | anchor join key |
| `user_label` | core | label-match grouping |
| `derived_label` | core | label-match grouping (fallback) |
| `started_ms`, `ended_ms` | core | row-level recency |
| `last_summary`, `last_summary_ms` | derived rolling | anchor-level health |
| `lifecycle_state` (`idle\|attached\|speaking\|ended`) | migration 033 | active/inactive gate |
| `status` (`active`/`ended`) | core | active/inactive gate |
| `supervises_project_anchor_id` | migration 025 | project-scope binding (project_scope_id stand-in until codex 12 ships) |
| `runtime_mode` (`cc-pty`/`direct-llm`/`detached`) | migration 033 | mode-specific weighting |
| `kind` (`brainstorm`/`meeting`) | core | meetings excluded by spec |
| `attached_worker_session_id` | migration 033 | "this anchor has live work" weight |
| `last_user_utterance_at` | migration 035 | per-turn activity proxy |

### Distillation error data

`distillation_error_log` (Fix 43, migration 042) provides per-ref failure history. Refs with recent `error_class IN ('provider_threw', 'empty_llm_reply')` are unreliable; the heuristic can use this as a negative weight or as an inclusion gate ("skip refs with > N failures in the last hour").

### Inputs NOT available today

- **Distillation embedding vector.** No table stores an embedding for `ref_summary`. `embedOne` (`07-daemon/src/embedder/index.ts`) can compute one, but no persistence layer carries it. Topic-continuity scoring would need either a new column on `lex_transcript_ref` (e.g. `ref_summary_embedding BLOB`) OR a derived computation at preload time (expensive: one embedder call per surfaced ref per cold-start).
- **`/lex pin/unpin` surface.** No route, no column, no UI. Pinning is a new affordance entirely; codex 7 ships the storage + scoring weight; UI follow-up deferred.
- **Active project anchor.** `supervises_project_anchor_id` provides a static binding; in-flight "what is the user working on right now" can be approximated from `lifecycle_state='attached'` + `last_user_utterance_at` recency.

## Question 3: bundle definition

### Spec passages

Line 247 (codex tightening of Q3): "Coverage gates per session bundle: tokens >= floor AND decisions >= floor AND open-items present AND last-directive present. If any gate fails, include previous bundle and re-check. Cap at N=6 sessions or token cap, whichever first."

The four gates ("decisions", "open-items", "last-directive", "tokens") map to the four bolded sections of the `PER_SESSION_SYSTEM_BLOCK` prompt at `07-daemon/src/lex/distillation-generator.ts:190-219`: "Decisions this session", "Planted markers" + "Open at session end", "Recent turns" (last directive proxy). Each ref_summary already contains these sections.

Line 64 (Q3 original): "Hard ceiling: 5 sessions OR 6000 tokens of structured signal." The number is per-session.

Line 65: "escalate depth if first session has < 8 turn pairs (likely interrupted/aborted)." Per-session signal.

### Candidate definitions evaluated

(a) **one CC session = one bundle** (= one `lex_transcript_ref` row). Codex's coverage gates apply per-row trivially: every section is a single ref's distillation. Cap N=6 ≈ 6 refs.

(b) **one user_label group = one bundle** (= N anchor rows under the same label). Doesn't fit: gates are per-session, not per-label.

(c) **one anchor + label = one bundle**. The anchor IS the label-binding today (one brainstorm row per anchor; the label is one of its fields). This collapses to (a) under most conditions because most anchors have 1-3 refs.

### Conclusion

**Bundle = one `lex_transcript_ref` row** (option a). This matches codex's coverage gates one-to-one, matches the existing per-session distillation contract (Fix 36), and aligns with the spec's "N=6 sessions" ceiling. The walk-back primitive returns an ORDERED LIST of refs; "session bundle" and "ref" are interchangeable in the implementation.

When the active anchor has fewer than the floor of refs (e.g. brand-new anchor, 1 prior ref), the walk-back can OPTIONALLY include refs from sibling anchors that share `user_label` OR `supervises_project_anchor_id`. This is the "walk back further" case the operator hinted at in line 124's "Stale context, twenty minutes old, want me to walk back further?" prompt. Out of scope for codex 7's first ship; deferred to codex 8+ where worker-boot needs cross-anchor history.

## Question 4: heuristic shape

### Proposed score function

```
score(ref) = w_recency * recency_decay(ref)
           + w_freshness * freshness_score(ref)
           + w_continuity * topic_continuity(ref, anchor)
           + w_pin * (1 if pinned else 0)
           - w_supersession * supersession_penalty(ref, all_refs)
           - w_failure * recent_failure_count(ref)
```

Default weights (proposed; tunable via runtime_config):

| Weight | Default | Range | Rationale |
|---|---|---|---|
| `w_recency` | 1.0 | base unit | anchor of every other normalisation |
| `w_freshness` | 0.6 | 0..1 | fresh refs trustworthy; stale refs partial |
| `w_continuity` | 0.5 | 0..1 | topic match boost; absent when no embeddings |
| `w_pin` | 10.0 | high | pinned ref always wins recency by a wide margin |
| `w_supersession` | 0.4 | 0..1 | duplicates penalised but not eliminated |
| `w_failure` | 0.3 | per-failure | discount per error_class row in last 1h |

### Term definitions (operational)

**`recency_decay(ref)`**:

```
age_ms = now - max(ref.ended_ms, ref.started_ms)  // ended_ms when set, else started_ms
recency_decay = exp(-age_ms / half_life_ms)
```

Default `half_life_ms = 24 * 3600 * 1000` (24 hours). One-day-old refs score 0.5; one-week-old refs score ~0.005. Tunable via runtime_config `walk_back_half_life_ms`.

**`freshness_score(ref)`**:

```
if ref.ref_summary is NULL: 0           // never distilled
if isRefStale(ref): 0.3                 // distilled but stale
if ref.coverage_score >= 0.8: 1.0       // distilled + fresh + comprehensive
if ref.coverage_score >= 0.3: 0.7       // distilled + fresh + partial
else: 0.5                                // distilled + fresh but tiny coverage
```

Uses Fix 42's `isRefStale` + Fix 43's freshness wiring directly.

**`topic_continuity(ref, anchor)`**:

```
if ref_embedding NULL OR anchor_topic_embedding NULL: 0  // signal absent
else: cosine_sim(ref.ref_summary_embedding, anchor.topic_embedding)
```

Optional. The ship spec defers embedding storage to codex 8 (which has the budget for a vector column migration); codex 7's first ship sets `w_continuity = 0` when embeddings absent so the score function still works.

**`pinned`**:

Boolean from a new `lex_transcript_ref.pinned_at` column (proposed; nullable integer ms). User pins via a new POST `/lex/transcript-ref/:id/pin` route. `pinned` = true iff `pinned_at IS NOT NULL`. When pinned, `score(ref) = +Infinity` and the ref is included unconditionally up to the N=6 ceiling.

Alternative: keep pin OUT of the score function and apply it as a pre-pass that forces inclusion before scoring runs. Cleaner semantics; this is the recommended path. Score function then becomes purely additive over unpinned refs.

**`supersession_penalty(ref, all_refs)`**:

```
penalty = 0
for newer in all_refs where newer.ordering > ref.ordering and newer.ref_summary is not NULL:
  if JSON.parse(newer.source_session_ids) includes ref.cc_session_id:
    penalty += 1
return penalty
```

A ref whose `cc_session_id` appears in a newer ref's `source_session_ids` is structurally redundant. The newer ref's distillation already covered it. Penalise once per superseding ref.

Edge case: `source_session_ids` only carries the CC session that produced the chunks fed to that ref's generator (per `07-daemon/src/lex/distillation-generator.ts:337` `JSON.stringify([input.cc_session_id])`). It's a single-element array today. Supersession only fires if codex 8+ ships cross-session distillations that bundle multiple cc_session_ids; for now `w_supersession * 0 = 0`. Wire the term anyway so it's ready when the upstream signal appears.

**`recent_failure_count(ref)`**:

```
count = db.distillation_error_log
  WHERE cc_session_id = ref.cc_session_id
  AND ts >= now() - 3600_000
```

Each failure inside the last hour discounts the ref. A ref with 3 failed distill attempts in the last hour scores `score - 0.9` (with default `w_failure=0.3`). Bounded by capping at N=5 failures to avoid runaway negatives.

### Coverage gate (post-score)

Per codex's tightening at line 247, scoring + ranking is NOT enough. After picking the top-N refs by score, walk the list applying coverage gates:

```
for each candidate in score-ranked refs:
  if cumulative_tokens >= TOKEN_FLOOR (default 1500)
   and has_decisions(candidate.ref_summary)
   and has_open_items(candidate.ref_summary)
   and has_last_directive(candidate.ref_summary):
    return candidates[0..i]  // floor met; stop
if no floor met AND len(candidates) >= 6:
  return candidates with insufficient_context=true
```

Token counting reads `ref.ref_summary.length / 4` as a rough char-to-token approximation. Section detection: regex against the prompt's bolded section names ("**Decisions this session**", "**Open at session end**", "**Recent turns**" markdown).

### Inclusion threshold

A scoring-only filter is risky because a single low-score ref might still be the only one with `has_last_directive`. Recommend:

1. Sort all refs by score DESC.
2. Apply pre-pass: pinned refs forced to top regardless of score.
3. Walk down the ranked list applying coverage gates until floor met OR N=6 reached.
4. Return the included list + an `insufficient_context: boolean` flag.

This is exactly codex's Q3 tightening, with the addition that the walk order is score-driven rather than recency-driven.

## Question 5: failure modes

### No refs exist

`listLexTranscriptRefs(anchorId)` returns `[]`. Walk-back returns `{ refs: [], insufficient_context: true, reason: 'no-refs' }`. Cold-start route falls through to the label-match fallback (existing behaviour, preserved).

### All refs are stale (Fix 42 territory)

Walk-back ranks normally (stale refs still get `freshness_score=0.3`, not zero, so they're included). The cold-start preload's existing sync-catchup (Fix 42) tries to refresh them inside the 5s budget; the walk-back uses whichever value `ref_summary_ms` carries at read time. The preamble carries `partial_sync=true` per Fix 42 contract; codex 7 surfaces this as `insufficient_context=false` (we have refs, they're just stale).

### Pinned ref read fails

The pinned ref's `transcript_path` jsonl might be missing or corrupt at render time. `extractLastTurnPairs` returns `[]` and `renderPriorRefSection` skips the section (`07-daemon/src/lex/sibling-index.ts:181-185`). The walk-back's pin pre-pass should NOT remove the pinned ref from the output array; the render handles missing transcripts gracefully. The audit log should record `pinned_ref_render_failed` so the operator can investigate.

### Topic embeddings missing

`w_continuity` term is 0 when embeddings aren't computed. Score function still produces a valid ranking from recency + freshness + supersession + pin alone. No-op. When codex 8 ships embedding storage, `w_continuity` can flip to 0.5 without touching the heuristic shape.

### Bundle definition disagreement (label changes)

A user renames a brainstorm mid-flight (e.g. user_label was "exploration" and they rename it to "feature X"). The anchor id is stable; refs under that anchor still resolve correctly through the anchor-refs primary path. The label-match fallback might miss this case (it filters by current user_label only). Codex 7 inherits this limitation; codex 12 (project_scope_id) is the proper fix.

### Insufficient context flag

When the walk-back walks all 6 refs and still misses the floor, return `insufficient_context=true`. Cold-start preamble surfaces this via a new line: `"Loaded 6 prior sessions but context floor not met. Want me to walk back further?"` matching the spec's line 124 voice script.

### Failure log false positives

A burst of `no_session_scoped_chunks` errors from a NULL-cc_session_id chunk batch would discount otherwise-fine refs. Mitigation: filter `recent_failure_count` to error_class ∈ `{'provider_threw', 'empty_llm_reply'}` only (the actual failure paths). Skip `no_provider`, `provider_not_configured`, `bf4_anthropic_blocked`, `empty_transcript`, `no_session_scoped_chunks` (operational/configuration skips, not ref-quality signals).

## Question 6: integration points

### Option A: pre-render in cold-start route

Walk-back runs inside `preloadColdStartSiblings` (`07-daemon/src/lex/lex-cold-start-preamble.ts:288`) BEFORE `buildSiblingIndex` is called. The output list of refs becomes the input to a new `buildSiblingIndexFromRefs(refs[])` variant that bypasses the recency-DESC pick in `buildAnchorTranscriptBlock`.

Pros: single integration point; existing `ColdStartPreloadSummary` shape extends naturally with new fields (`walk_back_kept: number[]`, `insufficient_context: boolean`).

Cons: walk-back becomes a hidden internal of the preload route; testing requires spinning up the whole preload pipeline.

### Option B: post-render filtering

Walk-back runs AFTER `buildSiblingIndex` and reorders/trims the rendered markdown. Brittle (regex-driven section extraction).

### Option C: new dedicated route `GET /lex/sibling-bundle?anchor_id=...`

Walk-back is a separate endpoint. Cold-start route calls it internally; future codex 8 worker-boot also calls it for its own preamble.

Pros: shared primitive across cold-start preload and worker-boot. Pure function over IndexDb. Cleanly testable.

Cons: extra HTTP hop inside the daemon (negligible perf cost since both routes share the process).

### Recommendation: hybrid A + C

Ship the walk-back logic as a pure module `07-daemon/src/lex/walk-back.ts` exporting `pickRefsForColdStart(db, anchorId, opts): WalkBackResult`. The cold-start route imports it directly (option A integration). Codex 8's worker-boot imports the same module without HTTP. A new route `GET /lex/sibling-bundle?anchor_id=...` is added later if a dashboard panel wants to surface the walk-back decision (codex 7 deliverable: just the module + cold-start integration; the route can wait).

`WalkBackResult` shape:

```typescript
interface WalkBackResult {
  refs: LexTranscriptRefRow[];        // ordered final list
  ranked_all: Array<{ ref_id: number; score: number; reasons: string[] }>;
  insufficient_context: boolean;
  reason?: 'no-refs' | 'floor-not-met' | 'ok';
  tokens_total: number;                // sum of ref_summary.length/4 estimates
  pinned_included: number[];           // ref ids that came in via the pin pre-pass
}
```

## Proposed ship-spec deliverables

1. **Migration 043: `lex_transcript_ref.pinned_at` INTEGER NULL** + index `(lex_session_id, pinned_at)`. Additive nullable.
2. **`07-daemon/src/lex/walk-back.ts`**: pure module exporting `pickRefsForColdStart` + `scoreRef` + `coverageGatesPassed`. Default weights + thresholds in module-level constants; runtime_config override hooks via the existing three-state pattern.
3. **Pin/unpin routes**: `POST /lex/transcript-ref/:id/pin` + `POST /lex/transcript-ref/:id/unpin`. Audit row to `cross_session_injection_log` with `caller_label='ref-pin'` (or new dedicated table; defer to ship spec).
4. **Cold-start route integration**: `preloadColdStartSiblings` calls `pickRefsForColdStart` for the anchor-refs path. The label-match fallback gets a parallel `pickRefsForColdStartByLabel` helper if scope permits; otherwise label-match retains today's blunt recency (codex 12 will kill the label-match path entirely so this is acceptable interim).
5. **`buildSiblingIndex` extension**: new variant `buildAnchorTranscriptBlockFromRefs(refs)` that bypasses the internal recency pick. Existing `buildSiblingIndex` keeps its current callers untouched.
6. **`ColdStartPreloadSummary` extension**: new fields `walk_back_kept: number`, `walk_back_total: number`, `insufficient_context: boolean`. Propagate through `PreloadEventLogRow` so the dashboard chip can render `[walk-back 4/12]`.
7. **Preamble line**: when `insufficient_context=true`, the preamble appends "Context floor not met across N sessions; ask 'walk back further' if needed."
8. **Tests**: pin every score term (recency_decay monotone, freshness predicate, supersession penalty, pin pre-pass), pin coverage gate behaviour (floor met/not met), pin ranking output for a synthetic 8-ref anchor, pin no-refs failure path, pin pinned-ref-read-failure graceful handling.

### Default constants (proposed)

```
WALK_BACK_HALF_LIFE_MS         = 24 * 3600 * 1000   // 24 hours
WALK_BACK_TOKEN_FLOOR          = 1500
WALK_BACK_TOKEN_CEILING        = 6000
WALK_BACK_MAX_REFS             = 6
WALK_BACK_W_RECENCY            = 1.0
WALK_BACK_W_FRESHNESS          = 0.6
WALK_BACK_W_CONTINUITY         = 0.0  // 0 until codex 8 ships embedding storage
WALK_BACK_W_PIN_FORCE          = +Infinity  // handled as pre-pass
WALK_BACK_W_SUPERSESSION       = 0.4
WALK_BACK_W_FAILURE            = 0.3
WALK_BACK_FAILURE_WINDOW_MS    = 3600 * 1000   // 1 hour
WALK_BACK_FAILURE_CAP          = 5
```

Tunable per anchor via runtime_config keys `walk_back_w_recency`, etc. Out of scope for first ship; ship the defaults and let codex 8+ wire the overrides.

### Out of scope for codex 7 (defer)

- Embedding storage on `lex_transcript_ref`. Codex 8 owns.
- Cross-anchor walk-back (label-match path with the heuristic). Codex 12 owns via project_scope_id.
- Dashboard panel showing the walk-back decision. Optional follow-up; the audit data lands in `ColdStartPreloadSummary` and the existing `LexColdStartPreloadPanel` event log so the operator can inspect it raw.
- Auto-pin heuristic ("if a ref is referenced N times in user prompts, auto-pin it"). Out of scope.

## Open questions for ship spec

1. Pin storage: column on `lex_transcript_ref` (proposed) vs separate `lex_transcript_ref_pin` table? Column is simpler; table allows pin history. Recommend column for first ship.
2. Coverage gate section detection: regex against bolded markdown headers vs structured JSON output from the per-session generator? Today's generator emits markdown. Codex 8+ might switch to structured. Recommend regex now, migrate later.
3. Should the walk-back module also write its decision to `worker_event_diagnostic_log` with `stage='walk-back.*'` so the dashboard panel can surface per-anchor walk-back history? Mirrors Fix 41 pattern. Recommend yes.
4. Pin pre-pass behavior when more than 6 refs are pinned: enforce the N=6 cap on pinned alone, or expand the cap? Recommend cap stays at 6; surplus pinned refs land in the `ranked_all` audit but not the rendered output.
5. Voice freshness disclosure (spec line 124) requires the walk-back result to be available to the voice-WS path. Wire via the same `ColdStartPreloadSummary` shape consumed by snapshot-context.ts? Yes - that path already reads brainstorm freshness in Fix 43.

## Cross-references

- Spec: `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md:58-66` Q3 original; `247` codex tightening; `180-181` Stage 4 plan; `292` codex order item.
- Fix 42 (codex 5): commit ec0d98a; `latest_chunk_ms` + `isRefStale`.
- Fix 43 (codex 6): commit 71a4ebc; staleness UI + reminder + `distillation_error_log`.
- Walk-back will live at: `07-daemon/src/lex/walk-back.ts` (new module).
- Cold-start route integration: `07-daemon/src/lex/lex-cold-start-preamble.ts:288 preloadColdStartSiblings`.
- Existing helpers reused: `isRefStale` from `07-daemon/src/lex/lex-transcript-ref.ts:31`; `listLexTranscriptRefs` from `07-daemon/src/store/index-db.ts:2268`.
