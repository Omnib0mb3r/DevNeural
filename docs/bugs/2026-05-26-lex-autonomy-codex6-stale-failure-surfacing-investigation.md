# LEX-AUTONOMY codex item 6: explicit stale/failure surfacing (UI + payload + reminder)

**Reported:** 2026-05-26 04:58 EDT by operator
**Severity:** medium (codex 5 freshness data now exists; without surfacing the human + Lex still can't see it)
**Status:** CLOSED. Shipped as Fix 43 (`71a4ebc`, 2026-05-26). See FIXES.md row 43.
**Related:** `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` codex order item 6; `docs/bugs/2026-05-26-lex-autonomy-codex5-sync-barrier-investigation.md`; Fix 42 (codex 5 ship, commit ec0d98a, adds `latest_chunk_ms` + `isRefStale` + sync barrier + per-row staleness counters). Codex 6 builds the surfacing layer atop the data Fix 42 produces. Codex 7 (adaptive walk-back) is downstream; codex 6 stays descriptive on failure shapes per the operator's caveat.

## Question 1: UI surface today

### Where the brainstorm/session status pill lives

There is no single brainstorm "status pill" component today. Two adjacent UI surfaces share the burden:

| Surface | File:line | What it shows | Data source |
|---|---|---|---|
| Cold-start preload panel (system page) | `08-dashboard/components/LexColdStartPreloadPanel.tsx:79-160` (`PreloadEventCard`) | Per-brainstorm group, latest event's `sibling_count` + `recent_turns_appended`, drill-down on rows showing preamble + counts + cc_session_id | `coldStartPreloadEvents` query → `GET /lex/cold-start-preload/events` (`07-daemon/src/dashboard/routes.ts:4773`) |
| Brainstorm detail summary | `08-dashboard/components/BrainstormDetail.tsx:114-119` | `bs.last_summary` rendered verbatim as a paragraph | `brainstorms/:id` route returning `BrainstormSessionRow` |

The cold-start panel is the closer match to "status pill" semantics. The brainstorm detail page only renders the rolling aggregate text and has no health indicator.

### States the panel currently surfaces

`PreloadEventCard` at `08-dashboard/components/LexColdStartPreloadPanel.tsx:91-110` collapses to one line:
- `failed (${failure_reason})` when `failure_reason` is non-null. Tone `text-err`.
- `${sibling} siblings · ${turns} turns` otherwise. Tone `text-ok`.

Open the card and each row at lines 116-156 shows `siblings:`, `turns:`, `distilled:` (HH:MM), `preloaded:` count, `cached:` count, `cc:` short id. The `failure_reason` is uppercased into a 16-char column.

### Fix 42 fields not yet surfaced

The route at `07-daemon/src/dashboard/routes.ts:4503` writes the audit row with `{stale_refs_count, synced_refs_count, partial_sync}` packed as JSON into `cross_session_injection_log.reject_reason` (per the codex 5 ship spec). Two consumers see this:

1. The audit log query (`injectionLog` in `08-dashboard/lib/daemon-client.ts`) returns the raw `reject_reason` string. The `LexColdStartPreloadPanel`'s "recent shadow fires" list at `LexColdStartPreloadPanel.tsx:331-371` renders `r.text_preview` but not `reject_reason`. The freshness JSON is in memory + on disk but never reaches the DOM.
2. The `preload_summary` returned by `POST /lex/cold-start-preload` at `07-daemon/src/dashboard/routes.ts:4696-4707` carries `stale_refs_count`, `synced_refs_count`, `partial_sync` (Fix 42 fields on `ColdStartPreloadSummary`). The `buildPreloadEventLogRow` builder at `07-daemon/src/lex/lex-cold-start-preamble.ts:374` does NOT propagate those three fields onto `PreloadEventLogRow` (only `sibling_count` / `last_distilled_ms` / `recent_turns_appended` / `preloaded_ids` / `already_present_ids` / `failure_reason` make it). So the events endpoint serves rows that have already dropped the staleness data.

Net: Fix 42 added the data + the audit row + the in-memory `ColdStartPreloadSummary`, but the dashboard query path drops the fields before render. Codex 6 needs to thread `stale_refs_count` + `synced_refs_count` + `partial_sync` through `PreloadEventLogRow` AND surface them in `PreloadEventCard`.

### Proposed UI badge shape

#### A. Extend `PreloadEventCard` header line

Add a staleness chip between the tone span and the events count when the freshness barrier fired. Three tones:

- `[fresh]` — `stale_refs_count === 0 && synced_refs_count === 0 && !partial_sync`. Omit chip entirely (no visual noise on the happy path).
- `[caught up N]` — `synced_refs_count > 0 && !partial_sync`. Tone `text-ok` faint background. Renders next to the existing `${sibling} siblings · ${turns} turns` text.
- `[stale N${partial_sync ? '/partial' : ''}]` — `(stale_refs_count - synced_refs_count) > 0`. Tone `text-warn` when partial_sync false; `text-err` when partial_sync true.

Per-row drill-down (lines 116-156) gains a small line: `stale: <stale_refs_count> · synced: <synced_refs_count>${partial_sync ? ' · partial' : ''}`. Only render when at least one of the three values is non-zero so the happy path stays clean.

#### B. New per-brainstorm header pill (BrainstormDetail)

`BrainstormDetail.tsx:114-119` renders `last_summary` as a paragraph. Add a pill at the top of the section reading:

- Healthy: `Summary: 3 refs fresh, latest 14:22 EDT`
- Stale within threshold: `Summary: 1 of 3 refs stale, catching up...`
- Stale beyond threshold: `Summary: 2 of 3 refs STALE - last distill 14h ago`

Data source: a new derived field on the brainstorm detail route. Compose by reading `listLexTranscriptRefs(brainstorm_id)` and running `isRefStale` (already exported from Fix 42's `07-daemon/src/lex/lex-transcript-ref.ts:31`). Add `staleness: { fresh: number; stale: number; oldest_stale_ms: number | null }` to the GET `/brainstorms/:id` response.

#### C. New badge on the brainstorms list (BrainstormList)

`08-dashboard/components/BrainstormList.tsx` renders one row per brainstorm. Codex 6 should add a small `[stale]` chip on rows whose anchor has any stale ref. Same data source as B. Optional for the ship spec; the brainstorm detail page is the higher-value target.

## Question 2: payload surface (Lex's runtime view)

### Where the live_state block is built

Two distinct injection pipelines exist:

1. **Voice-path per-utterance** (`07-daemon/src/lex/snapshot-context.ts:78` `buildVoiceSnapshot`). Prepends a `<live_state>...</live_state>` block to every voice-transcribed turn injected into the PTY. Built fresh per voice utterance from one fs scan + one SQLite query.
2. **Text-path UserPromptSubmit curation** (`07-daemon/src/capture/hooks/hook-runner.ts:65` `curateAndPrint`). Posts the user's prompt to `POST /curate` (handler in `07-daemon/src/curation/curator.ts`), reads the `injection` field, prints to stdout so CC injects as additionalContext. The `/curate` endpoint composes deterministic injection sections at `07-daemon/src/curation/curator.ts:407` `composeDeterministic`. Does NOT include a `<live_state>` block today.

### Fields included in voice live_state today

`buildVoiceSnapshot` at `07-daemon/src/lex/snapshot-context.ts:188-238` emits:

```
<live_state ts="ISO">
open_projects (live Claude Code sessions ...):
  - <slug> (anchor <id8>, session <cc8>, status=live, bridge=ok|N)
active_brainstorms (Lex conversations in progress):
  - <label> (mode=conversation, started 5m ago, turns=12)
live_ptys: 2
open_reminders: 3
host: <hostname> (<platform>)
data_root_separator: backslash on Windows (C:\dev\data)
curator_flags (actionable - surface if asked about system health):
  audit_findings_high: 4 open (lint=2, self-audit=2)
memory_index (...): bullets from MEMORY.md
docs_index (...): bullets from docs/INDEX.md
</live_state>
```

There is NO field carrying the freshness state of any sibling ref. Lex can be mid-turn while three prior refs are stale and the context block gives her zero indication.

### Proposed new section: `stale_refs`

Add to `buildVoiceSnapshot` between `curator_flags` and `memory_index` (so it sits next to other actionable surfaces, not next to the inert host/data lines):

```
stale_refs (per-session distillations that lag behind the chunks they cover; trust last_summary cautiously when set):
  - <brainstorm-id8> "<label>": <stale_count> of <total_count> refs stale, oldest stale <h>h ago
```

When all refs are fresh, render the entire section as `stale_refs: (none stale)` so absence is observable (Lex can tell the system reported "all fresh" vs "stale_refs section was forgotten").

### Data construction

For each `listBrainstorms({ status: 'active' })` row:
1. `db.listLexTranscriptRefs(row.id)` → array of refs.
2. Filter via `isRefStale` (imported from `07-daemon/src/lex/lex-transcript-ref.ts`).
3. Count stale + compute `min(stale.latest_chunk_ms)` = oldest stale-since timestamp.
4. Render line.

Cost: 1 SQLite query per active brainstorm per voice utterance. Active brainstorm count is capped at 8 by the existing slice at `snapshot-context.ts:136`; bounded.

### Codex 6 should also wire the same section into `/curate`

The text-path UserPromptSubmit hook currently misses the live_state block entirely. Either:

- **Option A**: Plumb `buildVoiceSnapshot` into `composeDeterministic` (curator.ts:407) so text-mode injections carry the same block voice-mode ones do. Lossless coverage; one new dependency edge.
- **Option B**: Build a slimmer `buildTextSnapshot` that includes only the stale_refs + reminder-count sections (the per-turn ones Lex actually needs every turn). Tighter context budget; two compose sites to maintain.

**Recommendation:** Option A. The voice block is already short (8 brainstorms × 1 line + 12 anchors × 1 line + a handful of headers); duplicating it onto text-path injections keeps Lex's view consistent across modes.

### Payload field shape

```typescript
interface StaleRefsBlock {
  total_refs: number;          // refs across all active brainstorms
  stale_refs: number;          // count where isRefStale === true
  oldest_stale_ms: number | null;  // min(latest_chunk_ms) across stale refs
  per_brainstorm: Array<{
    brainstorm_id: string;
    label: string | null;
    stale_count: number;
    total_count: number;
    oldest_stale_ms: number | null;
  }>;
}
```

Rendered into the `<live_state>` block as plain text (Lex parses by section header heuristics, not JSON). The struct shape lives on the dashboard endpoint backing the BrainstormDetail pill in Q1.

## Question 3: reminder surface

### Notification taxonomy today

`07-daemon/src/dashboard/notifications.ts:46` defines the taxonomy:

| `notify_class` | Bell? | Used by |
|---|---|---|
| `conversation` | no (filtered) | Spoken voice replies. Default for un-tagged emits (safe filter). |
| `report` | yes | Morning report, session-end brief (`session-end-pipeline.ts:192`), redistill. |
| `followup` | yes | Reminder pipeline (`reminder-push.ts:133`), lex-attention follow-up (`lex-attention.ts:208`). |
| `signal` | yes | Worker stalls, daemon-down, reinforcement events (`reinforcement/index.ts:155`), curator events, lex-attention escalations (`lex-attention.ts:252`). |

Severity (`info | warn | alert`) crosses with `notify_class`. Per Fix 21 (`07-daemon/src/dashboard/push.ts maybePushNotification`):

| severity | notify_class | bell | phone push |
|---|---|---|---|
| info | conversation | filtered | skipped |
| info | report/followup | shown | sent |
| info | signal | shown | skipped (severity gate) |
| warn / alert | (any) | shown | sent |

### What triggers a reminder/notification today

`firePushForReminder` at `reminder-push.ts:113` is the only path that converts a *scheduled* reminder into a `notification`. Other paths emit notifications directly without a backing `reminders` row:

- Session-end report: `session-end-pipeline.ts:192`, `notify_class='report'`, severity='info'.
- Worker stall fires: `lex-attention.ts:200`, `notify_class='followup'|'signal'` depending on the path.
- Reinforcement signals: `reinforcement/index.ts:154-196`, `notify_class='signal'`.
- Wiki ingest done: `wiki/auto-ingest.ts:284`.
- Lint flag: `wiki/lint.ts:235`.
- Cross-session inject result: `dashboard/routes.ts:850`, `notify_class='followup'`.
- /notification endpoint: `dashboard/routes.ts:2395`, `notify_class=body.notify_class ?? 'signal'`.

There is NO existing notification for "distillation is stale beyond a threshold". The cold-start preload writes an audit row with the staleness JSON, but never emits a notification.

### Proposed reminder trigger for codex 6

#### Trigger

A new emit point fires when ANY of the following holds for any active brainstorm:

(a) `isRefStale(ref) === true` AND `now - ref.latest_chunk_ms >= STALE_THRESHOLD_MS` for any ref under the anchor.

(b) `staleness_state === 'distill_failed'` (proposed in Q4 below) is set on any ref.

(c) `partial_sync === true` on a cold-start audit row AND that row is the most recent for the brainstorm AND `now - audit.ts >= STALE_THRESHOLD_MS / 2`.

#### Shape

```typescript
emitNotification({
  severity: 'warn',
  source: 'distillation-stale',
  notify_class: 'signal',
  title: `Distillation stale: ${brainstormLabel}`,
  body: `${stale_count} of ${total_count} refs unrefreshed (oldest ${hAgo}h ago). Lex's prior-session context will be partial until catchup runs.`,
  link: `/brainstorms/${brainstormId}`,
  push_data: { brainstorm_id, stale_count, oldest_stale_ms },
});
```

`notify_class='signal'` matches the lex-attention pattern (automated supervision). Bell-visible; phone-push gated by severity (warn → sent).

#### Cadence + dedupe

Per-anchor cooldown to prevent spam:

- New runtime_config key `distillation_stale_reminder_cooldown_ms`, default `60 * 60_000` (1 hour).
- A new in-memory `Map<brainstormId, lastFiredMs>` keyed by brainstorm anchor (similar to the stall watch's `stallState` at `daemon.ts:582`).
- A scheduler tick (new module, mirroring `runWorkerStallTick`) walks active brainstorms every `STALE_TICK_MS` (default 5min), runs the trigger check, fires emit when conditions hold AND cooldown elapsed.
- Cooldown clears on (i) anchor going inactive, (ii) all refs becoming fresh again (catchup ran), or (iii) operator-driven reset via a future dashboard action.

Daemon-restart resets cooldowns (fine; aligns with how `stallState` Map works).

#### Severity tiering

Default `severity='warn'` when stale + within `STALE_THRESHOLD_MS * 4` (= 4× the threshold = 20 min if threshold is 5 min).

Escalate to `severity='alert'` when:
- `partial_sync === true` AND it has been `partial_sync` for ≥ 2 consecutive emit cycles.
- A distillation_failed audit row exists for the anchor (Q4).
- `now - oldest_stale_ms > STALE_THRESHOLD_MS * 12` (= 1 hour at threshold=5min): something is wrong with the writer.

## Question 4: failure surface

### Existing failure / diagnostic tables

| Table | Migration | Used for | Could host distillation failures? |
|---|---|---|---|
| `smart_compact_log` | 021 + 040 | smart-compact /clear+paste fires, action enum | No - smart-compact specific. |
| `cross_session_injection_log` | 017 + many | every cross-session-inject + cold-start-preload audit row | Possible - `caller_label` differentiates senders; could add `caller_label='distillation-error'`. But the decision/reject_reason fields are sized for inject outcomes, not multi-line error context. |
| `worker_event_diagnostic_log` | 039 | per-stage event-supervisor instrumentation; `stage` is free-form | **Best fit** - generic stage+verdict+detail surface; already plumbed for `stage='detector.*'` and `stage='inject.*'` rows. Adding `stage='distillation.failed'` is additive, no schema change. |
| `panic_log` | 020 | panic button audit | No - panic-specific. |
| `lex_retrieval_log` | 015 | Lex retrieval audit | No - retrieval-specific. |

### Where distillation failures land today

`createPerSessionDistillationGenerator` at `07-daemon/src/lex/distillation-generator.ts:242` returns null on six paths:

1. No provider → log line `[per-session-distill] no provider; skip <tag>` (line 252-254).
2. Provider not configured → log line (line 256-260).
3. BF-4 anthropic block → log line (line 262-268).
4. No session-scoped chunks → log line `no_session_scoped_chunks` (line 279-289).
5. Empty transcript → log `empty_transcript` (line 299-302).
6. Provider call throw → log `provider call failed` (line 316-321).
7. Empty LLM reply → log `empty_llm_reply` (line 322-325).

All seven land in stdout/file logs only. None hit the DB. Cold-start preload's stale catchup (`runStaleRefCatchup` in `lex-cold-start-preamble.ts`) catches the null and marks `partial_sync=true` but the *reason* the generator returned null is lost.

Same shape on the legacy anchor-flat `createLlmDistillationGenerator` at `distillation-generator.ts:122-180`.

### Proposed failure audit shape

#### Reuse `worker_event_diagnostic_log`

Add stage values:
- `distillation.skipped` — verdict ∈ {`no_provider`, `provider_not_configured`, `bf4_anthropic_blocked`}. Soft skip; not a failure.
- `distillation.failed` — verdict ∈ {`provider_call_threw`, `empty_llm_reply`}. Hard failure; warrants the warn-level reminder above.
- `distillation.no_chunks` — verdict ∈ {`no_session_scoped_chunks`, `empty_transcript`}. Anomalous data state; informational.

`anchor_id` column: pack the `brainstorm_id`. `detail` column: pack `{cc_session_id, provider, error_message}` as JSON for the failed path; structured tag string for the others.

#### New row writes

Three sites need to write to `worker_event_diagnostic_log`:

1. `createPerSessionDistillationGenerator` (every null-return branch).
2. `createLlmDistillationGenerator` (every null-return branch).
3. `runStaleRefCatchup` (`07-daemon/src/lex/lex-cold-start-preamble.ts:118`) when the per-session generator times out (rather than just returns null).

Helper: a new `recordDistillationOutcome(db, anchorId, stage, verdict, detail)` in `07-daemon/src/lex/distillation-audit.ts` (new file) so the call sites stay one-liners. Best-effort; never throws past the audit attempt.

#### Dashboard surface

The `LexColdStartPreloadPanel` gains a new sub-section "Recent distillation outcomes" pulling from `worker_event_diagnostic_log` filtered by `stage LIKE 'distillation.%'`. New endpoint `GET /lex/distillation-events?limit=20` returns the recent rows. Surface defers per Q1's "ship spec" caveat; the data lands first, the UI consumes it after.

#### Why not a new dedicated table

Codex 6's failure surfacing scope is narrow: capture enough to render staleness reasons + drive the reminder. The generic diagnostic log handles that without a migration. A future codex 7 (adaptive walk-back) may want richer per-attempt state (timing, token counts, retry pointers); deferring the new-table decision until then keeps codex 6 additive-only.

## Question 5: cross-cutting

### Stale threshold T

**Default:** 5 minutes (`5 * 60_000` ms). Rationale:

- `stopWindowMs` in smart-compact is 30s (`07-daemon/src/lex/smart-compact-policy.ts policyDefaults`). 5 min = 10× that: well past the legitimate ingestor-tick (5s) + per-session generator wall-time (~2-3s in practice) catchup window.
- Below 5 min, transient ingestor lag would fire spurious warnings. Above 5 min, a real distillation outage would go undetected for too long during an active brainstorm.

**Configurable:** runtime_config key `distillation_stale_threshold_ms`. Operator can tighten/loosen without a daemon restart. Reuses the same three-state resolver pattern Fix 41 introduced (`runtime_config` → env → default).

**Per-anchor override:** out of scope for codex 6. The single global value is the simpler ship. Add per-anchor only if a hot anchor needs a tighter SLO than a slow archival one.

### Stale-but-bounded vs stale-beyond-T mapping

| Condition | Severity | notify_class | Bell? | Phone push? |
|---|---|---|---|---|
| `partial_sync=true` on most-recent preload, within T | (no notification) | n/a | activity rail only | no |
| stale ref within T | (no notification) | n/a | activity rail only | no |
| stale ref beyond T | warn | signal | yes | yes (severity ≥ warn) |
| `partial_sync=true` for two consecutive cycles | alert | signal | yes | yes |
| `distillation.failed` row exists | alert | signal | yes | yes |
| `now - oldest_stale_ms > T*12` (≈ 1h at default) | alert | signal | yes | yes |

The "activity rail only" cases write a `worker_event_diagnostic_log` row (so the dashboard panel surfaces them) but skip `emitNotification` so the bell stays quiet.

### Codex 7 caveat compliance

Codex 7 ships adaptive walk-back: the logic that decides "this ref is too stale to use as context; walk back to an older but fresher ref instead". Codex 6 stays descriptive. The surfacing layer reports "ref X is stale" without prescribing what to do; codex 7 reads the same `isRefStale` predicate + thresholds and decides the action. Concretely:

- Codex 6 emits `emitNotification` and updates the live_state block.
- Codex 6 does NOT modify `buildSiblingIndex` to skip stale refs or substitute older ones.
- Codex 6 does NOT modify `recomputeRollingAggregate` to walk back.
- Codex 7 owns those behaviour changes.

The data model + reminder shape proposed here is forward-compatible with codex 7: the same `worker_event_diagnostic_log` rows + `staleness_state` field + threshold key are what codex 7's walk-back logic will consume.

## Proposed ship-spec shape (this round = investigation; next round = code)

### Deliverables

1. **Dashboard `PreloadEventCard` extension**: stale_refs chip + per-row stale/synced line. Files: `08-dashboard/components/LexColdStartPreloadPanel.tsx` + `08-dashboard/lib/daemon-client.ts` (extend `ColdStartPreloadEvent` type).
2. **`buildPreloadEventLogRow` field propagation**: include `stale_refs_count`, `synced_refs_count`, `partial_sync`. File: `07-daemon/src/lex/lex-cold-start-preamble.ts` (~line 374).
3. **Brainstorm detail freshness pill**: new derived field on `GET /brainstorms/:id`; new pill in `BrainstormDetail.tsx`.
4. **`buildVoiceSnapshot` stale_refs section**: new section in `<live_state>` listing per-brainstorm staleness. Files: `07-daemon/src/lex/snapshot-context.ts` + `07-daemon/src/curation/curator.ts` (cross-wire text-path).
5. **Distillation outcome audit**: new `recordDistillationOutcome` helper writing to `worker_event_diagnostic_log` with `stage='distillation.{skipped,failed,no_chunks}'`. New file `07-daemon/src/lex/distillation-audit.ts`. Call-site wiring in `distillation-generator.ts` + `lex-cold-start-preamble.ts`.
6. **Distillation stale reminder tick**: new module `07-daemon/src/lex/distillation-stale-watch.ts` walking active brainstorms every 5min (configurable via `DEVNEURAL_DISTILLATION_STALE_TICK_MS`), firing `emitNotification` with `source='distillation-stale'`, `notify_class='signal'`, per-anchor cooldown via in-memory Map. Wired in `daemon.ts` alongside `runWorkerStallTick`.
7. **Runtime_config keys**: `distillation_stale_threshold_ms` (default 300_000), `distillation_stale_reminder_cooldown_ms` (default 3_600_000). Helpers in `smart-compact-routes.ts`-style three-state pattern.
8. **Tests**: pin reminder trigger conditions (stale within T → no emit, beyond T → emit, cooldown enforced, severity escalation when partial_sync persists). Pin diagnostic-row writes per skip path. Pin live_state section render. Pin dashboard chip render.

### Out of scope for ship spec (defer to codex 7)

- Adaptive walk-back over stale refs.
- `staleness_state` enum column on `lex_transcript_ref` (the investigation's Q3 proposed adding it; codex 7 wires the consumer, so the column lands with codex 7).
- Per-anchor threshold overrides.
- Push payload deep-link routing beyond the `/brainstorms/:id` link.

### Rollback path

Every emit goes through `emitNotification`; the existing /notifications dismiss path handles operator-driven silencing. The new reminder tick is gated by an env var + runtime_config flag (mirroring smart-compact's three-state pattern); operator can flip `distillation_stale_reminder_mode='off'` to silence the surface entirely without a daemon restart.

## Open questions for ship-spec round

1. Should the live_state `stale_refs` section render in voice + text paths, or only when the anchor's brainstorm is the active one for the current voice WS session? Option A (always render every active anchor's staleness) is more honest; Option B (only the active brainstorm) is more context-frugal. Recommend Option B — Lex doesn't need to hear about a parallel inactive brainstorm's staleness.
2. Where does the reminder tick read the threshold from — module-level constant, env, runtime_config, or all three? The smart-compact precedent uses all three; codex 6 should match for consistency.
3. Should `distillation.failed` rows themselves trigger a separate notification (one-shot per failure event) in addition to the periodic stale-watch tick? Failure-on-failure is the most informative; the risk is spamming the bell during an outage. Recommend one-shot per (anchor, cc_session_id) tuple with a 1-hour suppression window.
4. Codex 6's UI extension touches 3 dashboard files. Single commit per the existing two-commit pattern, or split daemon-side + dashboard-side? Single commit keeps the migration story atomic; split commit keeps the rebuild story atomic (dashboard rebuilds independently of daemon). Recommend single commit unless the diff size forces a split.
5. Threshold default 5 minutes might be too tight for archival brainstorms (last touched hours ago, no expectation of fresh distill). Should the threshold apply only to brainstorms with chunk activity in the last N minutes? Recommend yes — the watch's trigger predicate already needs `now - latest_chunk_ms < ACTIVITY_WINDOW` to avoid waking dormant anchors. Default activity window: 30 min.

## Cross-references for ship spec

- Fix 42 (codex 5 ship): ec0d98a + 4c4f95e
- Fix 42 investigation: docs/bugs/2026-05-26-lex-autonomy-codex5-sync-barrier-investigation.md
- `isRefStale`: `07-daemon/src/lex/lex-transcript-ref.ts:31`
- `ColdStartPreloadSummary`: `07-daemon/src/lex/lex-cold-start-preamble.ts:84`
- `buildVoiceSnapshot`: `07-daemon/src/lex/snapshot-context.ts:78`
- `emitNotification`: `07-daemon/src/dashboard/notifications.ts:106`
- `worker_event_diagnostic_log`: migration 039
- Codex 7 (deferred): adaptive walk-back over session bundles
