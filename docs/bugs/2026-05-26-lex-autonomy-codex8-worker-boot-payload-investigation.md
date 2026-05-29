# LEX-AUTONOMY codex item 8: deterministic worker boot payload from the same source graph

**Reported:** 2026-05-26 05:48 EDT by operator
**Severity:** medium (worker boot payload exists but does NOT project from the brainstorm corpus the way the spec mandates)
**Status:** CLOSED. Shipped as Fix 45 (`2463a5f` + `d9370d2` + `23c0eab` + `e51dec6` + `e435a88`, 2026-05-26). See FIXES.md row 45.
**Related:** `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` codex order item 8 (line 293); spec line 213 ("worker boot payload as 'best-effort summary from spec/git/jsonl tail.' Wrong source of truth. The brainstorm corpus IS the source. Worker must be projected FROM brainstorm corpus, not reconstructed FROM artifacts"); codex Q5 7-layer payload (line 249-254). Builds on Fixes 36 (Lex-authored resume), 42 (`isRefStale`), 43 (staleness surfacing + error log), 44 (adaptive walk-back). Codex 9 (first-attach path) consumes the same builder.

## Question 1: current worker boot payload

### Entry point

`POST /worker/clear-handoff` at `07-daemon/src/dashboard/routes.ts:4506`. Body `{ session_id, cwd }`. Calls `buildWorkerHandoff` (`07-daemon/src/lex/worker-handoff.ts:380`) and returns the rendered block. The Claude Code SessionStart hook prints the block to stdout so CC injects it as additionalContext on the first turn.

Hook wiring lives in `07-daemon/src/capture/hooks/hook-runner.ts:165 postColdStartPreload` for the Lex side; the worker-clear-handoff hook is parallel (route comment at `routes.ts:4493` says "parallel to /lex/cold-start-preload for Lex brainstorms"). Both run at SessionStart.

### Render path

`buildWorkerHandoff(opts)`:

1. `opts.db.getProjectSessionByCwd(cwd)` gates the render to known project anchors (`worker-handoff.ts:408`). Non-anchors return `{ok: true, block: '', reason: 'not-a-project-anchor'}` so the hook no-ops.
2. `buildGitState(cwd, runGit, inFlightLimit)` (`worker-handoff.ts:186`): four `git` subprocess calls (`rev-parse --abbrev-ref HEAD`, `log -1 --pretty=%s`, `log -1 --pretty=%h`, `status --short`). Times out at 1500ms.
3. `parseBacklog(readBacklog(backlogPath))` (`worker-handoff.ts:175`): reads `c:/tmp/lex-backlog-queue.json` (env `DEVNEURAL_BACKLOG_QUEUE_PATH`).
4. `selectActiveTask` / `selectNextUp` (`worker-handoff.ts:210-233`): finds `status==='in-flight'` + queued entries.
5. `selectBlockers(db, blockerLimit)` (`worker-handoff.ts:235`): `db.listAuditFindings({status:'open', severity:'high', limit})`.
6. `loadIndexBullets(docsIndexPath)` reads `docs/INDEX.md` table-of-contents bullets.
7. Brainstorm context (`worker-handoff.ts:432-453`): when `opts.workerSessionId` is supplied AND `db.getBrainstormByAttachedWorker(workerSessionId)` returns a brainstorm row, fetches `bs.last_summary` + last 6 `brainstorm_chunks` via `listBrainstormChunks(bs.id, 6, {order:'desc'})`.
8. `renderBlock(sections)` (`worker-handoff.ts:257-378`) emits markdown with five fixed-order sections plus the `WORKER_STATUS_FOOTER_TEMPLATE` reminder.

### Four (now five) sections of rendered output

| Section | Header | Source |
|---|---|---|
| 1 | `## Where you left off` | git (branch, last commit subj+sha, `git status --short`) |
| 2 | `## Active task` | `c:/tmp/lex-backlog-queue.json` entry where `status==='in-flight'` |
| 3 | `## Next up` | same JSON, next 2-3 queued entries (default `nextUpLimit=3`) |
| 4 | `## Open blockers` | `audit_findings` rows with `status='open' AND severity='high'` (cap 5) |
| 5 | `## Brainstorm context` | `brainstorm_sessions.last_summary` + last 6 chunks (only when `attached_worker_session_id` matches the worker's cc) |
| 6 | `## Docs index` | `docs/INDEX.md` bullets |

The block ends with `WORKER_STATUS_FOOTER_TEMPLATE` (worker-status-footer protocol reminder).

### Where the smart-compact resume path overlaps

`POST /lex/smart-compact/fire` (now `/clear-and-paste` post Fix 41) takes a Lex-authored `summary` string and injects it into the freshly-cleared worker after the SessionStart hook fires. The SessionStart hook still calls `/worker/clear-handoff` so both blocks land:

1. SessionStart hook output (`/worker/clear-handoff` response, prepended as additionalContext).
2. Lex-authored resume summary (injected via `clearAndPaste` after readiness gate).

These are two separate texts. Codex 8's intent: collapse the brainstorm-corpus projection into a single source so both paths render from the same graph.

## Question 2: current source mix vs codex-mandated source

### Sources actually consulted today

| Source | Used by section | Code path |
|---|---|---|
| `git rev-parse --abbrev-ref HEAD` | where_left_off.branch | `worker-handoff.ts:191` |
| `git log -1 --pretty=%s` | where_left_off.last_commit_subject | `worker-handoff.ts:193` |
| `git log -1 --pretty=%h` | where_left_off.last_commit_sha | `worker-handoff.ts:195` |
| `git status --short` | where_left_off.in_flight_files | `worker-handoff.ts:197` |
| `c:/tmp/lex-backlog-queue.json` | active_task + next_up | `worker-handoff.ts:148-149` |
| `audit_findings` table | open_blockers | `worker-handoff.ts:241` |
| `docs/INDEX.md` | docs_index | `worker-handoff.ts:427` |
| `brainstorm_sessions.last_summary` | brainstorm_context.last_summary | `worker-handoff.ts:443` |
| `brainstorm_chunks` (last 6 anchor-flat) | brainstorm_context.recent_chunks | `worker-handoff.ts:437` |

### Brainstorm corpus access TODAY — present but shallow

The brainstorm-context block DOES read from the corpus but ONLY through two surfaces:
- `bs.last_summary` (one rolling aggregate; **no per-ref freshness check**, no `isRefStale` consultation).
- `listBrainstormChunks(bs.id, 6, {order:'desc'})` (last 6 chunks across the whole anchor; **no per-session scoping**, no walk-back).

This is structurally the anchor-flat reading codex 5 (Fix 42) called out as wrong. Symptoms in the worker boot context:
- If `last_summary` is stale (Fix 43 surfaces this to dashboards + Lex but not to worker), the worker boots with stale context and gets no indication.
- If multiple CC sessions exist under the anchor with topic shifts, the last-6-chunks pull mixes them; the worker sees a turn from session A then a turn from session B with no boundary.
- The pinned-ref signal (Fix 44) is unused. Worker boot ignores operator pins.
- The adaptive walk-back scorer (Fix 44) is unused. Worker boot does not pick the best refs by score; it just dumps `bs.last_summary` verbatim.

### Codex-mandated source: the brainstorm corpus

Per spec line 213 + codex 8 line 293, the worker must be projected FROM the corpus through the same primitive the cold-start preload uses. Cold-start preload's stack as of Fix 44:

```
preloadColdStartSiblings(anchorId)
  -> summarizeFromAnchor(anchorId, currentCc)
    -> listLexTranscriptRefs(anchorId)
    -> pickBundles(eligible, opts)        // codex 7
        -> scoreRef(ref, ctx, allRefs)    // codex 7
        -> applies pin pre-pass + coverage floor + recency/freshness/supersession/failure
    -> extractLastTurnPairs(jsonl, pairs)  // sibling-index.ts
    -> anchor.last_summary_ms              // freshness anchor
```

Worker boot needs the SAME walk through `listLexTranscriptRefs + pickBundles + extractLastTurnPairs` and should render the result as a worker-shaped block.

### The gap

Today's `worker-handoff.ts:432-453` `brainstorm_context` block uses `listBrainstormChunks(bs.id, 6)` (anchor-flat, no scoring). Codex 8 replaces it with `pickBundles` + per-ref `extractLastTurnPairs`. The other sections (where_left_off, active_task, next_up, open_blockers, docs_index) stay; the corpus-projected section becomes the load-bearing one.

Beyond data sourcing, the spec at line 249-254 prescribes a 7-layer payload that does NOT match today's 6-section block. Codex 8 should reshape into that layered form:

| Codex 7-layer (spec 249-254) | Today's equivalent |
|---|---|
| 1. `project_state_header` (goal, current phase, blockers) | partial: `where_left_off` + `open_blockers` |
| 2. `execution_contract` (acceptance criteria, constraints) | partial: `active_task` carries acceptance criteria in title |
| 3. `open_arcs` (prioritized) | partial: `next_up` |
| 4. `decision_log` (final + parked decisions) | MISSING |
| 5. `handoff_context` (Lex last directive + last worker activity) | partial: `brainstorm_context.recent_chunks` |
| 6. `recent_brainstorm_excerpts` (selective) | partial: anchor-flat chunks (not selective) |
| 7. `transcript_pointers` (jsonl paths + slug) | MISSING |

Codex 8 ships the BUILDER. The 7-layer reshape can land in the same commit OR follow as codex 8b; defer to ship spec.

## Question 3: source graph builder reuse

### Proposed shared primitive

`07-daemon/src/lex/source-graph-payload.ts` (new module) exports:

```typescript
export interface SourcePayloadInput {
  db: IndexDb;
  anchorId: string;
  /** Active session to exclude from the bundle list. For worker boot
   * this is the worker's brand-new cc_session_id; for cold-start
   * preload this is the freshly-bound Lex CC. */
  currentCcSessionId?: string | null;
  /** Cap on refs to surface. Cold-start uses 5; worker boot
   * recommend 3 (terser shape). */
  refLimit?: number;
  /** Cap on turn-pairs extracted per ref. Cold-start uses 5; worker
   * boot recommend 3. */
  pairsPerRef?: number;
  /** Clock; defaults to Date.now. Frozen in tests for determinism. */
  now?: () => number;
  /** Test seam: filesystem read for transcript_path jsonls. */
  readTranscript?: (path: string) => string | null;
}

export interface SourcePayload {
  anchor: {
    id: string;
    user_label: string | null;
    last_summary: string | null;
    last_summary_ms: number | null;
  };
  refs: Array<{
    ref_id: number;
    cc_session_id: string;
    ordering: number;
    started_ms: number;
    ended_ms: number | null;
    ref_summary: string | null;
    ref_summary_ms: number | null;
    coverage_score: number | null;
    is_stale: boolean;        // via isRefStale (Fix 42)
    pinned: boolean;
    score: ScoreBreakdown;    // codex 7 breakdown
    reason: 'pinned' | 'scored';
    turn_pairs: Array<{ role: 'user' | 'assistant'; text: string }>;
  }>;
  freshness: {
    total: number;
    fresh: number;
    stale: number;
    oldest_stale_ms: number | null;
  };
  staleness_state: 'all_fresh' | 'partial_stale' | 'all_stale' | 'no_refs';
  recent_errors: Array<{
    cc_session_id: string | null;
    error_class: string;
    ts: string;
  }>;
}

export function buildSourceGraphPayload(
  input: SourcePayloadInput,
): SourcePayload;
```

### Two consumers, one primitive

**Cold-start preload** (Lex side, `lex-cold-start-preamble.ts`): keep existing `summarizeFromAnchor` shape; have it call `buildSourceGraphPayload` and project the return value into the existing `ColdStartPreloadSummary` fields. Output stays markdown for Lex via `buildSiblingIndex`.

**Worker boot** (`worker-handoff.ts`): replace the in-place `brainstorm_context` block (lines 432-453) with a call to `buildSourceGraphPayload`. Render through a new `renderWorkerBoot(payload, options)` that emits the terse action-oriented shape (Q4 below).

Both consumers see identical scoring + ordering + freshness data. Determinism guaranteed when `now` is fixed.

### Where the primitive lives

New file `07-daemon/src/lex/source-graph-payload.ts`. Imports:
- `pickBundles`, `buildRecentErrorMap` from `adaptive-walk-back.ts` (Fix 44).
- `isRefStale` from `lex-transcript-ref.ts` (Fix 42).
- `extractLastTurnPairs` from `sibling-index.ts`.
- `IndexDb`, `LexTranscriptRefRow`, `BrainstormSessionRow` from `store/index-db.ts`.

No new schema. Pure function over DB + fs (jsonl reads).

## Question 4: output shape for worker boot

### Today's render (anchor-flat, 6 sections)

```
# Worker handoff
## Where you left off
- Branch: ...
- Last commit: ...
- In-flight edits: ...
## Active task
- ID
  title
## Next up
- list
## Open blockers
- list
## Brainstorm context
- brainstorm_id: ...
- label: ...
### Last summary
{anchor.last_summary}
### Recent turns (oldest first)
- Lex: ...
- User: ...
## Docs index
{bullets}
{WORKER_STATUS_FOOTER_TEMPLATE}
```

### Proposed render (corpus-projected, action-oriented)

```
# Worker handoff
{anchor.user_label or anchor.id}; active spec: {primary_doc_path or "none"}

## Lex last directive
{last_lex_directive_or_FIRST_ATTACH}

## Bundles (from brainstorm corpus, codex-8 source graph)
- ref #1 (cc:abcdef12, ordering 7, fresh [or STALE 14h]) coverage 0.85 [pinned]
  {ref_summary first 200 chars}
  Last 3 turns:
    - user: ...
    - lex: ...
    - user: ...
- ref #2 (cc:..., ordering 6, fresh) coverage 0.72
  ...
- ref #3 (cc:..., ordering 5, fresh) coverage 0.61
  ...

## Where you left off (git)
- Branch: ...
- Last commit: ...
- In-flight edits: ...

## Active task + next up
- in-flight: ID title
- next: ID title
- next: ID title

## Open blockers ({N})
- ID: finding

## Recent distillation errors ({N})
- {error_class} on cc:abcdef12 at {ts}

## Docs index
{bullets}

## Your next action
{lex_next_action_line_or_"awaiting directive"}

{WORKER_STATUS_FOOTER_TEMPLATE}
```

### Output ordering: action first, then context

The proposed render leads with `Lex last directive` because the worker should read what to do first, then the bundles for context, then the system state (git/tasks/blockers/docs). Today's render leads with git state, which is the wrong priority for a fresh boot: the worker doesn't need to learn about the branch before learning about the directive.

### Stalemarkers

Each rendered ref carries one of three freshness tags:
- `[fresh]` (default; omitted from header for visual minimalism on the happy path)
- `[STALE Nh]` when `isRefStale(ref) === true` and beyond Fix 43's 10-min threshold
- `[pinned]` when `ref.pinned === 1`

Multiple tags possible: `[STALE 14h, pinned]`.

### Lex next-action line

Codex 8 spec says the next-action line is "authored by Lex." Implementation: the smart-compact-fire path (Fix 41) already takes a `summary` field from Lex. Extend the body shape to also accept `next_action: string` which lands as the bottom of the worker boot block when the smart-clear path fires. First-attach path (codex 9) substitutes "FIRST-ATTACH" or operator-supplied bootstrap text.

## Question 5: first-attach vs smart-clear paths

### Smart-clear path (Fix 41)

1. Smart-compact policy decides /clear fires (Lex evaluates `evaluateTriggerForAnchor`).
2. Lex composes a resume summary in conversation context.
3. POST `/lex/smart-compact/clear-and-paste { anchor_id, summary, reason }`.
4. Daemon: `/clear` -> readiness gate -> paste `summary`.
5. Meanwhile: CC's SessionStart hook fires -> `POST /worker/clear-handoff { session_id, cwd }` -> daemon returns the worker handoff block -> hook prints to stdout -> CC injects as additionalContext.
6. Worker sees BOTH the SessionStart handoff additionalContext AND the smart-compact paste as separate texts on the first turn.

### First-attach path (codex 9, NOT yet shipped)

1. Worker spawns fresh on an anchor that has no prior CC session. No /clear, no smart-compact trigger.
2. SessionStart hook fires -> `POST /worker/clear-handoff { session_id, cwd }` -> daemon needs to detect "no prior CC session under this anchor" and substitute the first-attach context.
3. The same handoff block lands as additionalContext; no smart-compact paste because there's nothing to resume.
4. Lex needs to push a first-attach directive at some point — either via cross-session inject the moment the worker registers, or via a synthetic "FIRST-ATTACH" placeholder rendered by the builder.

### Where codex 8 ships the builder + codex 9 wires it

**Codex 8** (this round of ship spec):
- Ships `source-graph-payload.ts` + `renderWorkerBoot` + integrates into `buildWorkerHandoff` so `/worker/clear-handoff` returns the new shape.
- Extends `/lex/smart-compact/clear-and-paste` body to accept optional `next_action: string` (Lex-authored) that the daemon can pass through to the worker boot render IF the next /worker/clear-handoff call fires from the same anchor inside a short coordination window.
  - Alternative: don't try to coordinate; the SessionStart hook block carries no next_action when smart-clear is the trigger because Lex's `summary` paste already includes the directive verbatim.
  - Recommend the alternative. Don't try to synchronize two text channels; the resume summary inject IS the directive on the smart-clear path. Worker boot block carries `## Your next action` only on the first-attach path.

**Codex 9** (next round): wires the first-attach detection inside `buildWorkerHandoff`. When the new cc_session_id has no prior `lex_transcript_ref` row on the anchor, the render fills `next_action` with "FIRST-ATTACH" or with an operator-supplied bootstrap directive from a new `project_session.bootstrap_directive` column (or runtime_config).

### Both paths call the same builder

```typescript
const sourcePayload = buildSourceGraphPayload({
  db: store.db,
  anchorId,
  currentCcSessionId,
});
const block = renderWorkerBoot(sourcePayload, {
  mode: 'smart-clear' | 'first-attach',
  next_action: optional,
  git: gitState,
  backlog: backlogState,
  blockers: blockerList,
  docs_index: docsBullets,
});
```

Same `sourcePayload` shape; different `mode` + per-mode opts. Tests pin both paths against the same fixture anchor.

## Question 6: determinism

### Non-deterministic surfaces today

| Source | Why non-deterministic | Fix |
|---|---|---|
| `now()` recency_decay (Fix 44) | every call uses a fresh clock | freeze via `payload.now = anchor.last_summary_ms` or `payload.now = max(ref.latest_chunk_ms)` |
| `git status --short` | working-tree state | output is a function of the tree at render time; not a determinism gap, but tests should mock `runGit` |
| `git log -1` | depends on HEAD | same; mock in tests |
| `audit_findings` ordering | `db.listAuditFindings({...})` returns whatever ORDER BY is defined | verify the SQL has a stable `ORDER BY id` or `ORDER BY ts, id` |
| `c:/tmp/lex-backlog-queue.json` | JSON file mtime not used; entries ordered as written | parseBacklog returns array as-is; ordering is stable if the file is. Worker boot should NOT re-sort on render |
| `loadIndexBullets` | reads docs/INDEX.md; depends on doc content | stable for the same input |
| `extractLastTurnPairs(jsonl, pairs)` | jsonl line order is stable | OK |
| `pickBundles` (Fix 44) | uses `now` arg | freeze via the same anchor source |
| `listLexTranscriptRefs` ORDER BY | `opened_ms ASC` per `index-db.ts:2275` | stable |
| `listBrainstormChunks` ORDER BY | `turn_index DESC` per `index-db.ts:986` | stable |

### Audit_findings ordering check

`07-daemon/src/store/index-db.ts:listAuditFindings` should sort deterministically. Quick check needed; if it sorts by `created_at DESC` without a secondary tiebreaker, two findings with the same created_at could swap on rebuild. Recommend `ORDER BY created_at DESC, id ASC`.

### Recommended determinism rules

1. **Single clock anchor.** The render uses ONE clock value, passed in by the caller, applied to every time-dependent computation. For the smart-clear path, the clock = `Date.now()` at handoff dispatch. For tests, the clock is a fixture.
2. **Stable tiebreakers everywhere.** Every `ORDER BY` in the SQL surface used by the builder gains a secondary tiebreaker (`id ASC` is the safe default). Where unsorted arrays are returned (e.g. `selectBlockers`), the render sorts by `id ASC` before formatting.
3. **No timestamps in rendered output.** The current `### Last summary` block doesn't carry a timestamp; preserve that. The new worker boot render should NOT emit `Generated at HH:MM` lines. Freshness is signaled by the `[STALE Nh]` tag — relative, not absolute — and even that uses the frozen clock for the `Nh` math.
4. **Pin tiebreak.** When two refs are both pinned, the secondary sort is `ordering DESC` (newest first), then `id ASC`. Codex 7's `pickBundles` already sorts pinned by score; the ship spec extends the comparator to include the secondary keys.
5. **Hash the render.** Optional but cheap: emit a short hash of the output block alongside the audit row. Two identical input states produce identical hashes; if the hash drifts across boots with no input change, the determinism contract was violated.

### What "deterministic" buys us

- **Smoke tests** can fixture an anchor and assert the exact render byte-for-byte. Today the handoff tests pass synthetic git output through `runGit`, but the brainstorm-context section's freshness signal (which would change with clock drift) is not pinned. Fix 44's new tests use a fixed `now: () => 10_000_000`; codex 8 inherits that pattern.
- **Replay debugging** when a worker boots oddly: snapshot the source graph, replay the render, get the same block; bisect against changes since the snapshot.
- **Drift audits** can detect "the same anchor produced two different boot blocks across daemon restarts" as a regression.

## Proposed ship-spec deliverables

1. **New module `07-daemon/src/lex/source-graph-payload.ts`** exporting `buildSourceGraphPayload(input): SourcePayload`. Pure function over DB + fs reads. Calls `pickBundles` + `isRefStale` + `extractLastTurnPairs` + `buildRecentErrorMap`.
2. **New module `07-daemon/src/lex/worker-boot-render.ts`** exporting `renderWorkerBoot(payload, opts): string`. Action-first ordering per Q4 above; emits the 7-layer-ish shape distilled to terse.
3. **Refactor `buildWorkerHandoff`** to call `buildSourceGraphPayload` + `renderWorkerBoot` for the brainstorm-context section. Existing git / backlog / blockers / docs sections stay (they're worker-environmental, not corpus-projected) but their headers fold into the new layered shape.
4. **Refactor cold-start preload** to call `buildSourceGraphPayload` underneath `summarizeFromAnchor`. Render output stays markdown via `buildSiblingIndex` (no user-facing change for cold-start).
5. **Determinism hardening**: audit_findings + selectBlockers stable sort, single-clock-anchor opt in both paths, no-timestamps render rule documented in module headers.
6. **Tests**:
   - `source-graph-payload.test.ts`: pure unit pins per `SourcePayload` field; staleness_state transitions; freshness counts; recent_errors aggregation.
   - `worker-boot-render.test.ts`: render shape pins per mode (smart-clear vs first-attach); determinism pin (same input -> byte-identical output across two calls).
   - Integration: `worker-handoff.test.ts` extended to assert the new layered shape from a synthetic anchor with refs + chunks.
   - `cold-start-preload-integration.test.ts` (existing, codex 5 + 7) confirms no regression in markdown output.
7. **Spec/docs**: update `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` Stage 5 (line 183) note to point at the shipped modules; cross-link Stage 4 (codex 7) and Stage 5 (codex 8).
8. **Smart-clear body shape**: NO change. The resume summary inject already carries Lex's directive; the worker boot block stays directive-free on the smart-clear path. First-attach path (codex 9) is the next round.

### Default constants

```
WORKER_BOOT_REF_LIMIT          = 3        // tighter than cold-start's 5
WORKER_BOOT_PAIRS_PER_REF      = 3        // tighter than cold-start's 5
WORKER_BOOT_SUMMARY_CHAR_CAP   = 800      // hard cap on rendered ref_summary slice
WORKER_BOOT_RECENT_ERROR_LIMIT = 5        // last-1h provider failures shown
WORKER_BOOT_DOC_BULLETS_CAP    = 12       // existing default; preserved
```

### Out of scope for codex 8 (defer to codex 9+)

- First-attach path detection + bootstrap directive.
- 7-layer spec reshape (line 249-254). Codex 8 ships an action-first 6-section variant; the codex Q5 7-layer can land in codex 11 grooming.
- Decision log surface (no `decisions` column today; would need a new table or a JSON extract over `ref_summary` text).
- Project_scope_id binding (codex 12).

## Open questions for ship-spec round

1. Where does Lex's "next action" line come from on the smart-clear path? Two options: (a) Lex's resume summary inject IS the next action; worker boot block carries no next-action. (b) Lex passes `next_action` in the `clear-and-paste` body and the daemon coordinates rendering. Recommend (a) for simplicity; revisit if the operator wants a single combined block.
2. Should the worker boot block include the rolling aggregate (`anchor.last_summary`) AND the per-ref bundles, or just bundles? Investigation 2 above shows today's path renders ONLY `anchor.last_summary`. Recommend bundles primary + aggregate as a one-liner header (acts as "executive summary across the bundles").
3. `WORKER_STATUS_FOOTER_TEMPLATE` reminder appended at the end of every render. Keep verbatim or revise for the new layered shape? Recommend keep; the worker depends on this format for the parser.
4. Backlog JSON file vs DB. `c:/tmp/lex-backlog-queue.json` is fragile; codex 11 will likely move backlog into the DB. For codex 8, keep the file source; the builder is a pass-through for that section.
5. Smart-clear coordination window: when Lex fires `/clear-and-paste`, the SessionStart hook also fires `/worker/clear-handoff`. The daemon could detect this co-occurrence and skip the duplicate brainstorm-context section from the handoff (Lex's resume summary already covers it). Recommend: no detection; both blocks land. The worker harness already concatenates additionalContext; duplication is rare since Lex authors the summary based on different anchor state than the handoff's deterministic projection.

## Cross-references

- Spec: `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md:213` (worker boot wrongness), `:249-254` (codex Q5 7-layer), `:293` (codex order item 8).
- Today's worker handoff: `07-daemon/src/lex/worker-handoff.ts:380 buildWorkerHandoff`; route `07-daemon/src/dashboard/routes.ts:4506 POST /worker/clear-handoff`.
- Cold-start preload (Lex side, parallel): `07-daemon/src/lex/lex-cold-start-preamble.ts:258 summarizeFromAnchor`; route `07-daemon/src/dashboard/routes.ts:4530-ish POST /lex/cold-start-preload`.
- Fix 36 (Lex-authored resume): smart-compact `clear-and-paste` body `summary` param.
- Fix 42 staleness predicate: `07-daemon/src/lex/lex-transcript-ref.ts:31 isRefStale`.
- Fix 43 distillation_error_log + staleness UI/payload.
- Fix 44 adaptive walk-back: `07-daemon/src/lex/adaptive-walk-back.ts:scoreRef + pickBundles + buildRecentErrorMap`.
- Six-section resume scaffold (still available for callers): `07-daemon/src/lex/six-section-resume.ts:42` (v2 caller-side optional helper after Fix 36 deprecation).
