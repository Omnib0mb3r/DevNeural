# LEX-AUTONOMY codex item 11: grooming/escalation + freshest artifact compare

**Reported:** 2026-05-26 06:51 EDT
**Status:** investigation (no code; ship spec follows)
**Related:** spec line 296; builds on Fixes 42 (`isRefStale`) + 43 (stale-watcher + `distillation_error_log`) + 47 (loose-ends gate).

## Q1: current grooming pipeline

| Surface | File:line | Cadence | Purpose |
|---|---|---|---|
| `runDistillationBackfill` | `07-daemon/src/lex/sibling-distillation-backfill.ts` (wired in `daemon.ts:393`) | 30s grace post-boot, then idle | Fill missing `last_summary` rows across all brainstorms |
| `distillation-scheduler` | `07-daemon/src/lex/distillation-scheduler.ts:83` | one-shot, daemon boot | Triggers backfill once |
| `idle-watcher` (LSS Phase 5) | `07-daemon/src/lex/idle-watcher.ts:136 listIdleActivity` | tick (light/mid/cold/day-cap) | Grooming passes on idle brainstorms |
| `stale-watcher` (Fix 43) | `07-daemon/src/lex/stale-watcher.ts runStaleWatchTick` | 5min | Emits `notify_class='signal'` when stale beyond T |
| HANDOVER doc compare (Fix 42) | `07-daemon/src/lex/lex-cold-start-preamble.ts:239-253` | per cold-start preload | Compares `handover.mtimeMs` vs `last_summary_ms` |

Gap: no module compares the FRESHEST file mtime across the cwd (handover + overnight + spec + bug + fixes) against the corpus's newest distill. Existing handover-only compare is too narrow.

## Q2: freshest artifact compare

### Sources per anchor

```
cwd/HANDOVER-*.md
cwd/OVERNIGHT-*.md
cwd/FIXES.md
cwd/docs/spec/*.md
cwd/docs/bugs/*.md
```

`max(file.mtimeMs)` across all matches = `artifact_high_water_ms`.

### Corpus high-water

```
corpus_high_water_ms = max(
  brainstorm_sessions.last_summary_ms,
  max(lex_transcript_ref.ref_summary_ms for all refs under anchor),
)
```

### Grooming gap

```
if artifact_high_water_ms - corpus_high_water_ms > T_GROOMING_GAP (default 15min):
  emit 'grooming_gap' gap event
```

Signal: operator has written files (commit messages, spec updates, bug notes) that the corpus hasn't seen. Lex's next handoff will be artifact-blind unless re-distillation pulls the corpus forward.

## Q3: persistent gaps for escalation

Per-anchor tick every 30 min walks:

| Gap class | Detector | Severity | Action |
|---|---|---|---|
| `distill_failure_persistent` | same `lex_transcript_ref` has `ref_summary IS NULL` for >2h | alert | escalate via emit + suggest manual `/lex/refs/:cc/redistill` |
| `parked_question_persistent` | jsonl tail parked-question detector (Fix 47) older than 4h | alert | escalate via emit + suggest operator-driven Lex inject |
| `distill_error_repeat` | `distillation_error_log` rows for same `(brainstorm_id, cc_session_id, error_class)` >3 in last 24h | alert | escalate via emit + suggest provider config check |
| `loose_ends_block_persistent` | gate has returned `blocked` for >1h with no operator action | warn | escalate; surface report on dashboard banner |
| `grooming_gap` (Q2) | artifact > corpus by T | warn | escalate; suggest redistill or operator note |
| `idle_no_distill` | brainstorm `idle` >24h with no `last_summary` | info | informational notification only |

Per-(anchor, class) debounce: 4h (longer than stale-watcher's 30min because escalations should not flap).

## Q4: escalation channels

Reuse Fix 21 / Fix 43 path:

```
emitNotification({
  severity: 'warn' | 'alert',     // per gap class
  source: 'grooming-watch',
  notify_class: 'signal',
  title: `Grooming gap: ${classLabel} (${anchorLabel})`,
  body: oneLineDetail,
  link: `/brainstorms/${anchor_id}`,
  push: severity === 'alert' ? 'force' : 'auto',
});
```

Bell + phone push gating identical to Fix 43 stale-watcher. `push='force'` for alert-severity classes lets the operator know even during quiet hours.

## Q5: module shape

`07-daemon/src/lex/grooming-watch.ts` (new):

```typescript
export type GroomingGapClass =
  | 'distill_failure_persistent'
  | 'parked_question_persistent'
  | 'distill_error_repeat'
  | 'loose_ends_block_persistent'
  | 'grooming_gap'
  | 'idle_no_distill';

export interface GroomingGap {
  class: GroomingGapClass;
  anchor_id: string;
  severity: 'info' | 'warn' | 'alert';
  detail: string;
  evidence_ms?: number;       // age signal (oldest stamp triggering)
}

export interface GroomingTickDeps {
  db: IndexDb;
  now?: () => number;
  emit?: typeof emitNotification;
  readMtime?: (path: string) => number | null;
  state?: Map<string, number>;  // per-(anchor, class) lastFired
  thresholds?: {
    distillFailurePersistentMs?: number;  // default 2h
    parkedQuestionPersistentMs?: number;  // default 4h
    distillErrorRepeatCount?: number;     // default 3
    distillErrorWindowMs?: number;        // default 24h
    looseEndsBlockPersistentMs?: number;  // default 1h
    groomingGapMs?: number;                // default 15min
    idleNoDistillMs?: number;             // default 24h
    debounceMs?: number;                  // default 4h
  };
}

export function runGroomingTick(deps: GroomingTickDeps): GroomingTickResult;
export function installGroomingScheduler(opts): GroomingHandle;
```

Cadence: 30min interval, wired in `daemon.ts` alongside `startStaleWatch` (Fix 43 pattern).

## Q6: tests

`07-daemon/tests/grooming-watch.test.ts`:

- Each gap class fires when its condition holds (6 cases).
- Debounce: second tick inside 4h window skips.
- Severity mapping per class.
- Freshest-artifact compare uses MAX across handover/overnight/spec/bug/fixes mtimes (mock fs).
- Tick fires no notifications when corpus is current.
- `loose_ends_block_persistent` requires the gate to have produced a `blocked` decision (mock the report cache or pass via deps).

## Proposed ship-spec deliverables

1. `07-daemon/src/lex/grooming-watch.ts`: detector + scheduler.
2. Wire in `daemon.ts` alongside `startStaleWatch` (Fix 43).
3. Runtime_config flag `grooming_watch_mode` ∈ `'off' \| 'shadow' \| 'live'`, default `'shadow'` per smart-compact precedent.
4. `GET /lex/grooming/recent` endpoint returning recent `GroomingGap[]` for dashboard surfacing.
5. Tests per Q6.
6. Fix 48 FIXES row.

### Defaults

```
GROOMING_TICK_MS                       = 30 * 60_000     // 30 min
GROOMING_DEBOUNCE_MS                   = 4 * 3_600_000   // 4 hours
GROOMING_GAP_THRESHOLD_MS              = 15 * 60_000     // 15 min
DISTILL_FAILURE_PERSISTENT_MS          = 2 * 3_600_000   // 2 hours
PARKED_QUESTION_PERSISTENT_MS          = 4 * 3_600_000   // 4 hours
DISTILL_ERROR_REPEAT_COUNT             = 3
DISTILL_ERROR_WINDOW_MS                = 24 * 3_600_000  // 24 hours
LOOSE_ENDS_BLOCK_PERSISTENT_MS         = 3_600_000        // 1 hour
IDLE_NO_DISTILL_MS                     = 24 * 3_600_000  // 24 hours
```

## Out of scope (defer)

- Operator-defined per-anchor override of thresholds (codex 12).
- Auto-resolve actions beyond emit (e.g. auto-redistill on `distill_failure_persistent`); could pair with Fix 47 fireAutoAction.
- Cross-anchor escalation (rolling up by user_label).

## Cross-references

- `idle-watcher.ts:136 listIdleActivity` — existing idle surface.
- `stale-watcher.ts:runStaleWatchTick` — Fix 43, debounce + emit pattern to mirror.
- `distillation-error-log` — Fix 43, source for `distill_error_repeat`.
- `loose-ends-gate.ts:evaluateLooseEnds` — Fix 47, source for `loose_ends_block_persistent` + `parked_question_persistent`.
- `handover-writer.findLatestHandover` — Fix 42, mtime read pattern to extend.
