# LEX-AUTONOMY codex item 10: enforce loose-ends handoff gate

**Reported:** 2026-05-26 06:34 EDT
**Status:** CLOSED 2026-05-29. Shipped as Fix 47 (`3da61e1` + `d9bc5d7` + `a82451f` + `40f4624` + `89de4d7` + `528c56e`). See FIXES.md row 47.
**Related:** spec line 295; builds on Fixes 42 (`isRefStale`) + 43 (`distillation_error_log` + stale-watcher) + 45 (`isFirstAttach` + `buildSourceGraphPayload`) + 46 (first-attach detection).

## Question 1: worker-start paths

| Path | Trigger | File:line |
|---|---|---|
| Dashboard "Start session" button | `POST /projects/:id/start-claude` | `07-daemon/src/dashboard/routes.ts:2492` |
| Voice "start project ..." | voice WS handler -> `attachWorkerSession` | `07-daemon/src/lex/brainstorm-store.ts:178` |
| Smart-compact /clear-and-paste | `POST /lex/smart-compact/clear-and-paste` | `07-daemon/src/dashboard/smart-compact-routes.ts clearAndPaste` (Fix 41 Stage 1) |
| External CC launch (bridge file) | bridge-presence resolve -> `bindBrainstormSessionId` / project-anchor bind | `07-daemon/src/dashboard/bridge-presence.ts` |
| SessionStart hook handoff | `POST /worker/clear-handoff` | `07-daemon/src/dashboard/routes.ts:4506` |

Gate must fire BEFORE the first inject lands. `/start-claude` is the earliest hook (operator click, daemon decides to spawn); voice command + smart-clear come next; external CC launch is the trickiest (the daemon learns about the worker AFTER it's already spawned, so the gate runs post-hoc and blocks the next inject rather than the spawn itself).

## Question 2: loose-end taxonomy

| Class | Detector | Source |
|---|---|---|
| **mid_tool** | last prior ref's jsonl tail has `tool_use` with no matching `tool_result` | `extractLastTurnPairs`-style walk over `ref.transcript_path` |
| **parked_question** | last assistant turn ends with `?` AND no subsequent user turn | jsonl tail scan |
| **dirty_worktree** | `git status --short` non-empty in `anchor.cwd` | existing `runGit` in `worker-handoff.ts:186` |
| **open_audit_finding** | `audit_findings` rows with `status='open' AND severity='high'` scoped to anchor | `db.listAuditFindings({status,severity})` (already used by worker-handoff) |
| **distill_error** | `distillation_error_log` rows in last 1h for any ref under the anchor | `db.listRecentDistillationErrors(50, {brainstormId})` (Fix 43) |
| **undistilled_ref** | `lex_transcript_ref` rows with `ref_summary IS NULL AND ended_ms IS NOT NULL` | DB scan against the anchor's refs |
| **stale_ref_beyond_T** | refs where `isRefStale(ref) === true AND now - latest_chunk_ms > T` (T = 10 min, matches stale-watcher) | `isRefStale` (Fix 42) + clock |

## Question 3: resolution policy

| Class | Disposition | Action |
|---|---|---|
| mid_tool | **auto-resolvable** | inject `[recovery] mid-tool boundary; continue from the next planned step.` via cross-session-inject (uses existing `lex-cancelled-tool-recovery` path Fix 33). |
| parked_question | **operator-only** | dashboard banner shows the question text + `Answer` / `Dismiss`. Gate stays blocked until operator acts. |
| dirty_worktree | **informational + operator-only on confirm-required anchors** | default: informational (surface in banner, do not block). When `anchor.require_clean_tree=true` (proposed flag): operator-only. |
| open_audit_finding | **informational** | already surfaced by worker-handoff "Open blockers" section; gate logs the count. |
| distill_error | **auto-resolvable** | re-fire `createPerSessionDistillationGenerator` for the affected ref(s) inside a 5s budget (same as Fix 42 sync-catchup). |
| undistilled_ref | **auto-resolvable** | same as distill_error: synchronous catch-up pass. |
| stale_ref_beyond_T | **informational** | already covered by Fix 43 stale-watcher reminder; gate does not double-fire. |

## Question 4: gate enforcement

### Module signature

`07-daemon/src/lex/loose-ends-gate.ts` (new):

```typescript
export type LooseEndClass =
  | 'mid_tool'
  | 'parked_question'
  | 'dirty_worktree'
  | 'open_audit_finding'
  | 'distill_error'
  | 'undistilled_ref'
  | 'stale_ref_beyond_T';

export type LooseEndDisposition = 'auto' | 'operator' | 'informational';

export interface LooseEnd {
  class: LooseEndClass;
  disposition: LooseEndDisposition;
  severity: 'info' | 'warn' | 'alert';
  detail: string;       // human-readable one-liner
  evidence_ref_id?: number | null;
  evidence_cc_session_id?: string | null;
}

export interface LooseEndsReport {
  anchor_id: string;
  ends: LooseEnd[];
  has_blocker: boolean;          // any operator-only end present
  has_auto: boolean;             // any auto end present
  generated_ms: number;
}

export function evaluateLooseEnds(
  db: IndexDb,
  anchorId: string,
  opts?: { now?: () => number; readTranscript?: (p: string) => string | null },
): LooseEndsReport;

export type GateDecisionKind = 'clear' | 'auto-resolving' | 'blocked';
export interface GateDecision {
  kind: GateDecisionKind;
  report: LooseEndsReport;
  /** When kind='auto-resolving', the list of injects / generators
   * the gate fired. Caller waits for these to settle (5s budget)
   * before proceeding. */
  auto_actions: Array<{
    class: LooseEndClass;
    action: 'recovery-inject' | 'redistill';
    target: string;             // cc_session_id or ref id
  }>;
}

export async function enforceLooseEndsGate(
  db: IndexDb,
  anchorId: string,
  mode: 'block' | 'auto-resolve',
): Promise<GateDecision>;
```

### Flow

1. Worker-start route calls `enforceLooseEndsGate(anchorId, 'auto-resolve')`.
2. `evaluateLooseEnds` walks each detector, accumulates `LooseEnd[]`.
3. If `has_blocker === true`: return `{kind: 'blocked', report}`. Caller refuses to spawn / inject + emits a `notify_class='followup'` notification carrying the report payload.
4. If `has_blocker === false AND has_auto === true`: fire each auto resolution inside a 5s budget. Return `{kind: 'auto-resolving', report, auto_actions}`. Caller may proceed; the auto-resolutions race the worker start, which is acceptable because they're additive.
5. If both false: return `{kind: 'clear', report}`. Caller proceeds normally.

### Gate placement

Wrap each worker-start route with a pre-flight `enforceLooseEndsGate` call. For external CC launch (bridge presence), wire the gate into `bindBrainstormSessionId` so the next inject the worker would receive is gated until the loose ends clear.

## Question 5: dashboard surface

### New banner shape

Extend `08-dashboard/components/BrainstormDetail.tsx` (Fix 43 already added the staleness pill) with a new `LooseEndsBanner` component. Reads from `GET /brainstorms/:id/loose-ends` (new route returning the most-recent `LooseEndsReport`).

```
+---------------------------------------------------+
| Loose ends block worker start (3):                |
|  alert: parked question - "should we ship X?"     |
|  warn:  dirty worktree (4 files modified)         |
|  info:  2 undistilled refs (auto-resolving...)    |
|  [Resolve all] [Dismiss informational]            |
+---------------------------------------------------+
```

Severity tones reuse Fix 43 tokens (`text-err`/`text-warn`/`text-info`).

### Notification reuse

Operator-only loose ends emit one notification via existing `emitNotification` with `source='loose-ends-gate'`, `notify_class='followup'`, `severity` set per the end's severity. Per-anchor debounce 30 min (mirrors Fix 43 stale-watcher debounce).

### Routes

- `GET /brainstorms/:id/loose-ends` → returns latest `LooseEndsReport` from an in-memory cache (keyed by anchor_id; TTL 5min so the report stays fresh across panel polls).
- `POST /brainstorms/:id/loose-ends/dismiss` body `{class: LooseEndClass}` → marks a class dismissed for this anchor; gate ignores it on next evaluation.
- `POST /brainstorms/:id/loose-ends/refresh` → forces a fresh evaluation (operator-triggered).

## Severity ordering rules

Sort `LooseEnd[]` in the report by:
1. `severity` DESC (alert > warn > info)
2. `disposition` DESC (operator > auto > informational)
3. `class` lexicographic (stable tiebreak)

Banner renders top-N (N=5 default) with overflow shown via `[+M more]` link.

## Question 6: test outline

### `07-daemon/tests/loose-ends-gate.test.ts` (new)

- `evaluateLooseEnds` detects each class in isolation:
  - mid_tool: synthetic jsonl with unbalanced tool_use → detected.
  - parked_question: assistant ends `?`, no user follow-up → detected.
  - dirty_worktree: `runGit('status --short')` returns non-empty → detected.
  - open_audit_finding: high-severity audit rows present → detected.
  - distill_error: recent `distillation_error_log` rows → detected.
  - undistilled_ref: ref with `ended_ms NOT NULL AND ref_summary IS NULL` → detected.
  - stale_ref_beyond_T: synthetic stale ref → detected.
- `enforceLooseEndsGate`:
  - Clear anchor returns `kind='clear'`.
  - Operator-only end returns `kind='blocked'` with the report payload.
  - Auto-only ends return `kind='auto-resolving'` and the auto_actions array contains the fired injects.
  - Mixed ends: blocker wins; auto actions still fire alongside.
- Severity ordering: `report.ends` sorted alert > warn > info; operator > auto > informational; lexicographic class tiebreak.

### Route tests

- `GET /brainstorms/:id/loose-ends` returns the cached report.
- `POST .../dismiss` removes a class from the next evaluation.
- `POST .../refresh` forces re-evaluation.

## Proposed ship-spec deliverables

1. Migration 044 (optional): `anchor_loose_ends_dismissed` table or `brainstorm_sessions.loose_ends_dismissed_json` column. Recommend the column to avoid table churn; codex 11 grooming can revisit.
2. `07-daemon/src/lex/loose-ends-gate.ts`: detectors + `evaluateLooseEnds` + `enforceLooseEndsGate`.
3. Route wires:
   - `POST /projects/:id/start-claude`: pre-flight `enforceLooseEndsGate`. Refuse when blocked (HTTP 409).
   - `POST /lex/smart-compact/clear-and-paste`: pre-flight gate; surface in response.
   - `POST /worker/clear-handoff`: include the report in the response payload so the SessionStart hook can prepend a "blocked by loose ends" note (additionalContext).
   - `bridge-presence.bindBrainstormSessionId`: gate the first inject.
4. `08-dashboard/components/LooseEndsBanner.tsx` + route consumers.
5. Notification emit via `source='loose-ends-gate'`, debounce 30min per anchor.
6. Tests per Q6.

### Defaults

```
LOOSE_ENDS_STALE_T_MS              = 10 * 60_000   // 10 min (mirrors Fix 43)
LOOSE_ENDS_AUTO_RESOLVE_BUDGET_MS  = 5000          // sync catch-up window
LOOSE_ENDS_BANNER_TOP_N            = 5
LOOSE_ENDS_NOTIFY_DEBOUNCE_MS      = 30 * 60_000
LOOSE_ENDS_REQUIRE_CLEAN_TREE      = false         // default off; per-anchor opt-in via brainstorm.require_clean_tree flag (codex 11)
```

### Out of scope (defer)

- `brainstorm.require_clean_tree` flag (codex 11 grooming).
- Spec-doc TODO marker detector (filesystem heuristic; needs cwd-to-repo-root).
- Operator UI for setting per-anchor dismissal lists (codex 11).

## Cross-references

- Spec line 295: codex 9 + 10 sequencing (first-attach before loose-ends gate).
- Fix 42 isRefStale: `07-daemon/src/lex/lex-transcript-ref.ts:31`.
- Fix 43 distillation_error_log + stale-watcher.
- Fix 45/46 source-graph + first-attach.
- Existing recovery primitive (auto-inject): `07-daemon/src/lex/cancelled-tool-recovery.ts` (Fix 33).
- Existing notify pipeline: `07-daemon/src/dashboard/notifications.ts:106 emitNotification`.
