# Smart-compact policy refactor: move decisioning out of daemon, into Lex

**Reported:** 2026-05-26 04:00 EDT by operator (Fix 41 pre-investigation)
**Severity:** medium (architectural; current pipeline works but is blind-scheduled)
**Status:** CLOSED. Shipped as Fix 41 three-stage refactor (`e936908` Stage 1 + `bb12b4a` Stage 2 + `6359fd2` Stage 3, 2026-05-26). See FIXES.md row 41.
**Related:** `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` (Stages 5-12, Stage 5 shipped as Fix 36 moved summary authorship to Lex); `docs/spec/LEX-STANDALONE-SUPERVISION.md`; FIXES.md row 36 (Lex-authored resume), row 40 (cc-pty speak-queue).

## Motivation (operator-stated, 2026-05-26 04:00 EDT)

The 60-second blind scheduler in `07-daemon/src/dashboard/smart-compact-scheduler.ts` walks every live anchor without knowing whether the worker is at a real stopping point. Wrap fires can land mid-tool. Threshold + window logic is policy that belongs to the supervisor brain, not the executor. Fix 36 already moved summary authorship to Lex; this is the next half of the same direction.

The daemon should retain transport, filesystem watching, audit writes, /clear injection, and paste injection. Lex should own all decisioning: when to evaluate, what threshold, what window, whether the anchor is at a stop point, whether to fire wrap, whether to fire clear, whether to wait. Shadow gating is a candidate to kill entirely (flagged by operator as "dumb for fresh anchors").

## Section 1: function-by-function mechanical vs policy audit

### `07-daemon/src/dashboard/smart-compact-scheduler.ts` (139 lines)

| Function | Lines | Category | Disposition |
|---|---|---|---|
| `runSmartCompactTick` | 66-139 | **POLICY (entire function)** | Delete after Lex loop verified. The walk-all-anchors + evaluate + route logic IS the scheduler. Lex replaces this with its own poll cadence and per-anchor decisioning. |

The whole module is the policy surface. There is nothing mechanical to keep here. Module dies in the cutover commit once the Lex-driven flag flips default.

### `07-daemon/src/dashboard/smart-compact-routes.ts` (639 lines)

| Function | Lines | Category | Disposition |
|---|---|---|---|
| `jsonlForAnchor(db, anchorId)` | 81-85 | Mechanical | Keep. DB lookup of transcript ref tail. Lex needs this via endpoint. |
| `deriveLastTool(jsonlPath)` | 87-121 | Mechanical (fs tail read) | Keep as internal helper. Lex can read jsonl tail itself, but exposing a `GET /lex/smart-compact/last-tool-ms` is cheaper than every Lex loop re-implementing tail logic. Optional. |
| `deriveLastCommit(cwd)` | 123-136 | Mechanical (git shell-out) | Keep as internal helper. Same logic as above; could be exposed if Lex doesn't want to shell out itself. |
| `evaluateSmartCompact(db, anchorId, opts)` | 138-199 | **POLICY** (calls `evaluateTrigger` + reads defaults + isShadow) | Demote. Lex calls a new endpoint that returns only the raw inputs (`ctx_pct`, `last_commit_ms`, `last_tool_ms`, `phase`, `jsonl_path`) and runs `evaluateTrigger` Lex-side. The `evaluate` route stays as a compat shim during cutover, hard-coded to call `evaluateTrigger` with Lex-supplied params. |
| `evaluateTrigger` (in `lex/smart-compact.ts`) | n/a here | **POLICY** | Move the function module out of daemon (`07-daemon/src/lex/`) and into Lex's tool surface. Daemon stops importing it once cutover done. |
| `smartCompactMode(db)` | 288-298 | Mechanical (runtime_config + env resolver) | Keep. This is a transport-level kill-switch (operator forces off without bouncing daemon). Stays daemon-side. |
| `parseSmartCompactValue` | 276-286 | Mechanical | Keep. Pure parser. |
| `smartCompactGloballyEnabled` | 304-306 | Mechanical | Keep. Compat shim. |
| `fireSmartCompact(db, anchorId, opts)` | 310-483 | **MIXED** | Split. The shadow-gate branch (322-359) is policy. The actual inject choreography (372-457) is mechanical. New design: daemon's `clear-and-paste` endpoint runs only the inject choreography + audit row. Shadow gating moves to Lex (or is killed). Off-mode short-circuit stays as a transport-level safety. |
| `recentSmartCompacts(db, limit)` | 485-490 | Mechanical | Keep. Audit log read. |
| `registerSmartCompactRoutes` | 492-638 | Mechanical (route binding) | Keep, with route signatures changed per Section 2. |
| `/lex/smart-compact/toggle` GET/POST | 603-637 | Mechanical (operator kill-switch) | Keep verbatim. Three-state mode stays daemon-side. |
| `WRAP_AND_COMMIT_PROMPT` const (re-export from lex/) | 39, 99 | **POLICY** | Move to Lex. Daemon stops being the author of the wrap prompt. Lex composes contextually per tick. |

### `07-daemon/src/lex/smart-compact.ts` (166 lines)

| Function | Lines | Category | Disposition |
|---|---|---|---|
| `evaluateTrigger(input)` | 57-97 | **POLICY (core decision)** | Move out of daemon into Lex's tool surface. Daemon retains an `evaluate` compat shim during cutover; post-cutover the daemon no longer imports this. |
| `WRAP_AND_COMMIT_PROMPT` | 99-100 | **POLICY (prompt authorship)** | Move to Lex. Lex authors wrap prompts contextually per anchor state, not a daemon-side fixed string. |
| `shadowThreshold` | 104-109 | Policy (configurable N) | Move to Lex. Operator flagged shadow as dumb for fresh anchors; candidate to delete entirely. If retained, threshold is a Lex memory value, not a daemon env. |
| `isShadow(db, anchorId, n)` | 111-118 | **POLICY** | Move to Lex (or kill). DB count is mechanical, but the threshold + decision is policy. Lex queries the count via a daemon endpoint and decides shadow-or-not itself. |
| `ctxPctFromJsonl(file, deriver)` | 129-142 | Mechanical | Keep. Pure derivation helper. Daemon exposes via `GET /lex/smart-compact/ctx-pct?anchor_id=...`. |
| `defaults()` | 151-165 | **POLICY (threshold + window values)** | Move to Lex. Threshold 60, bandHalf 5, hardCeiling 90, stopWindowMs 30s are all policy. Lex stores in memory or config, not daemon env. |

### `07-daemon/src/dashboard/smart-compact-injector.ts` (362 lines)

| Function | Lines | Category | Disposition |
|---|---|---|---|
| `makeSmartCompactInjector(deps)` | 78-125 | Mechanical (transport with bridge fallback) | Keep verbatim. Pure transport: PTY direct or bridge queue with auto-CR nudge. Lex never touches this code. |
| `defaultScheduleCommit` | 71-76 | Mechanical | Keep. |
| `capturePreClearJsonlSet(ccProjectsDir, io)` | 200-212 | Mechanical (fs snapshot) | Keep. Used by readiness gate. |
| `ccProjectsDirForCwd(homeDir, cwd)` | 218-226 | Mechanical (path slug derivation) | Keep. |
| `awaitNewSessionReady(opts)` | 228-361 | Mechanical (fs poll + jsonl tail for SessionStart attachment burst) | Keep verbatim. This is the post-/clear readiness gate that fixed the parked-summary bug. Lex never re-implements this. |

**Summary.** The injector module is 100% mechanical and stays exactly as-is. The routes module is ~60% mechanical (transport, audit, toggle) and ~40% policy (evaluate, shadow gate, defaults). The lex/smart-compact.ts module is 100% policy and moves out of the daemon. The scheduler module is 100% policy and dies in the cutover.

## Section 2: new daemon endpoints Lex needs

### 2.1 `GET /lex/smart-compact/ctx-pct?anchor_id=<id>` (new)

Read-only ctx_pct for a given anchor. No decision, no audit row.

Response:
```
{
  ok: true,
  anchor_id: string,
  ctx_pct: number | null,
  tokens: number | null,
  max: number | null,
  jsonl_path: string | null
}
```

`ctx_pct=null` when the anchor has no jsonl ref or the tail has no usage record yet. Lex polls this on its own cadence.

### 2.2 `GET /lex/smart-compact/state?anchor_id=<id>` (new, optional consolidation)

Single call that returns all the raw inputs Lex needs to run `evaluateTrigger` locally:

Response:
```
{
  ok: true,
  anchor_id: string,
  ctx_pct: number | null,
  last_commit_ms: number | null,
  last_tool_ms: number | null,
  jsonl_path: string | null,
  shadow_count: number,   // count of smart_compact_log rows for this anchor
  mode: 'off' | 'shadow' | 'live'
}
```

Lex composes one request per anchor per tick, runs its own `evaluateTrigger`, decides. Saves N round-trips vs. polling ctx-pct, last-commit, last-tool separately.

### 2.3 `POST /lex/smart-compact/clear-and-paste` (new; replaces current `fire` action=fire path)

Daemon does only mechanical work: readiness gate, /clear inject, summary paste, audit row write. No threshold check, no window math, no shadow gate. Lex is the decider.

Request:
```
{
  anchor_id: string,
  summary: string,           // required, non-empty (Lex-authored)
  reason: string,            // free-form Lex tag e.g. "window-open-stop" (audit only)
  caller?: string,           // default 'lex'
  pre_ctx_pct?: number,      // optional, recorded in audit row
  use_readiness_gate?: boolean   // default true; false = legacy back-to-back inject
}
```

Response:
```
{
  ok: boolean,
  log_id: string,
  inject_result: 'accepted-pending-ready' | 'accepted' | 'pty_not_found',
  anchor_id: string
}
```

Daemon-side semantics:
1. Resolve target (current_pty_id || current_session_id).
2. If mode='off', return `{ok: true, log_id: '', inject_result: 'noop'}` and write no row.
3. Else: inject /clear, await readiness (if enabled), inject summary, write audit row with `action='fire'`, `payload_text=summary`.
4. Auto-CR nudge stays in the injector (already there).

### 2.4 `POST /lex/smart-compact/wrap-paste` (new; replaces current `fire` action=wrap path)

Daemon injects a single caller-supplied wrap prompt. No daemon-authored `WRAP_AND_COMMIT_PROMPT`. Lex composes contextually.

Request:
```
{
  anchor_id: string,
  prompt: string,            // required, non-empty (Lex-authored wrap)
  reason: string,
  caller?: string,
  pre_ctx_pct?: number
}
```

Response:
```
{
  ok: boolean,
  log_id: string,
  inject_result: 'wrap-injected' | 'pty_not_found',
  anchor_id: string
}
```

Audit row: `action='wrap'`, `payload_text=prompt`.

### 2.5 `GET /lex/smart-compact/recent` (unchanged)

Already exists. No change.

### 2.6 `GET/POST /lex/smart-compact/toggle` (unchanged)

Already exists. The three-state operator kill-switch is transport-level and stays daemon-side.

### 2.7 Optional: ctx-pct change subscription

Two implementation options:

**Option A (poll, simpler):** Lex polls `/lex/smart-compact/state` every 5-10s per live anchor. Cheap and synchronous with Lex's own loop.

**Option B (push, lower latency):** Daemon exposes SSE at `GET /lex/smart-compact/events?anchor_id=<id>` and streams `{type: 'ctx-pct', value, ts}` when the jsonl tail tick recomputes ctx. Lex listens, runs evaluate when threshold band crossed.

**Recommendation:** start with Option A. The existing scheduler already polled on 60s; Lex polling on 10s is finer-grained and adds no new daemon machinery. Revisit SSE only if poll cost becomes measurable (it won't).

### 2.8 Endpoints to deprecate (post-cutover)

| Endpoint | Status after cutover |
|---|---|
| `POST /lex/smart-compact/evaluate` | Keep as compat shim for one release; emits deprecation log. Remove once dashboard and tests migrated. |
| `POST /lex/smart-compact/fire` | Split: action='fire' callers migrate to `/clear-and-paste`; action='wrap' callers migrate to `/wrap-paste`. Keep `/fire` as a compat shim that forwards to the two new endpoints. |

## Section 3: what Lex owns post-refactor

Lex's tool surface gains a new module (proposed `lex-tools/smart-compact.ts` or wherever the tool surface lives) that owns all of the following:

### 3.1 Threshold + window math

- `threshold` default 60 (operator tunable, in Lex memory or config)
- `bandHalf` default 5 (band is `[threshold-bandHalf, threshold+bandHalf]`)
- `hardCeiling` default 90 (always-fire ceiling)
- `stopWindowMs` default 30000 (recent-commit / idle-tool window)

Stored as Lex memory or a config file in `~/.claude/projects/.../memory/`. Tuneable per-anchor if it ever matters (it probably doesn't).

### 3.2 Stop-point classification

Lex reads worker jsonl tail (same way it already does for stall classification) and computes:
- `recent_commit`: was the worker's last git commit inside `stopWindowMs`?
- `idle_tool`: is the last tool_use event older than `stopWindowMs` (or absent)?
- `idle_phase`: is the worker phase one of `{idle, permission}`?

`hasStop = recent_commit || idle_tool || idle_phase`. Drives the `window-open` (fire) vs `no-stop` (wait) decision inside the band.

### 3.3 Shadow-mode gating decision

Two options:
- **Keep shadow:** Lex queries `shadow_count` from the new state endpoint, applies `count < shadowThreshold` rule, marks the inject as shadow itself by not calling `/clear-and-paste` (just logging the would-have-fired locally). Daemon never sees a shadow inject request.
- **Kill shadow entirely** (operator flagged as preferred): every fire decision goes through. New anchors that haven't been tuned will fire on their first window-open. If the threshold + stop-point logic is sound this is fine; if it isn't, shadow was just hiding the bug.

**Recommendation:** kill shadow. The decisioning is now Lex-side and self-correcting per anchor (Lex sees the inject's effect on the next tick). Shadow was a daemon-side safety because the daemon was blind; Lex isn't.

### 3.4 Wrap-prompt authorship

Currently `WRAP_AND_COMMIT_PROMPT` is a fixed 32-word string in `07-daemon/src/lex/smart-compact.ts:99`. Post-refactor, Lex composes the wrap prompt per anchor using whatever context it has: current phase, last tool, last commit, what file was being edited, etc. Example wrap prompt Lex might compose:

> "You are mid-edit on `07-daemon/src/dashboard/smart-compact-routes.ts`, ctx at 87%. Commit what is stable with a meaningful message (looks like the new clear-and-paste endpoint scaffold). Defer the readiness-gate refactor with a TODO. Reply 'ready' when done. Context refresh imminent."

vs the current generic prompt. Worth the round-trip cost.

### 3.5 Resume summary authorship

Already Lex-owned per Fix 36 (Stage 5 of LEX-AUTONOMY). No change.

### 3.6 Fire/wait/wrap decision

The whole `evaluateTrigger` function moves to Lex. Daemon stops importing it post-cutover.

### 3.7 Cadence

Lex picks its own poll cadence. 10s is a reasonable default. Lex can also be event-driven: if the supervisor-event wire already notifies Lex when the worker goes idle or commits, Lex can evaluate-and-fire on that event instead of waiting for the next tick.

## Section 4: backwards-compat path

Cutover happens in three stages with a dashboard toggle controlling which loop is active.

### Stage A (this ship spec, follow-up commit)

1. Add `GET /lex/smart-compact/state` (consolidated raw inputs).
2. Add `POST /lex/smart-compact/clear-and-paste`.
3. Add `POST /lex/smart-compact/wrap-paste`.
4. Existing `/evaluate` and `/fire` endpoints unchanged.
5. Existing scheduler unchanged.
6. Add Lex-side `smart-compact` tool module (poll loop, evaluateTrigger, decide). Tool gated behind a new dashboard toggle `lex_drives_smart_compact` (default `false`).
7. Dashboard panel adds a third state: scheduler-only (current), lex-only (new), both (shadow comparison).

Both loops can run concurrently in "both" mode. Lex-side logs would-have-fired decisions to a new shadow audit table or just to the daemon log without injecting. Operator compares both for a few hours, verifies Lex's decisions match (or improve on) the scheduler's.

### Stage B (after Lex loop verified)

1. Flip `lex_drives_smart_compact` default to `true`.
2. Scheduler-only mode still selectable in dashboard for rollback.
3. `/evaluate` and `/fire` endpoints emit a deprecation log line every call, with caller info.

### Stage C (after one stable week)

1. Delete `07-daemon/src/dashboard/smart-compact-scheduler.ts`.
2. Delete `evaluateSmartCompact`, `fireSmartCompact` policy branches from `smart-compact-routes.ts`. Keep transport + audit + toggle.
3. Delete `evaluateTrigger`, `defaults`, `shadowThreshold`, `isShadow`, `WRAP_AND_COMMIT_PROMPT` from `07-daemon/src/lex/smart-compact.ts`. The `07-daemon/src/lex/smart-compact.ts` module either dies entirely or keeps only `ctxPctFromJsonl` (which is mechanical).
4. Remove `lex_drives_smart_compact` toggle (Lex is the only path).
5. Compat shim routes (`/evaluate`, `/fire`) deleted.

### Rollback path

At any point in Stage A or B, flip `lex_drives_smart_compact` to `false`. Scheduler resumes. No code change, no daemon restart.

### Test coverage gates

Stage A ship must include:
- Lex-side `evaluateTrigger` unit test (port the existing daemon test verbatim).
- Lex-side poll loop test (deterministic clock, deterministic ctx provider).
- `/clear-and-paste` route test (mock injector, assert /clear inject -> readiness gate -> summary inject -> audit row).
- `/wrap-paste` route test (mock injector, assert prompt inject -> audit row).
- Compat shim test: existing `/fire` action=fire still works (forwards to /clear-and-paste internally).
- Both-mode shadow comparison test: scheduler decides X, Lex would-have decided Y, audit log shows both rows.

Existing scheduler tests stay green through Stage A and B. They die with the scheduler in Stage C.

## Open questions for ship-spec round

1. Where exactly does the new Lex `smart-compact` tool module live? Tool surface is currently spread across `07-daemon/src/lex/` (server-side helpers) and Lex's tool definitions (client-side); the operator should pick the home.
2. Kill shadow gating entirely (recommended) or move it to Lex (safer)?
3. Add SSE event push for ctx-pct changes (Option B in 2.7) or stay with poll (Option A)?
4. Migrate `defaults()` env vars to Lex memory or to a project-level config file? Memory is simpler; config is more debuggable.
5. Stage C deletion: do it as one commit or split per file? One commit is cleaner; split is easier to revert.

## Out of scope (this round)

- Code changes. Two-spec policy applies; this is the investigation, ship spec follows.
- Curator/reinforcement smart-compact interaction (separate concern, deferred per overnight plan).
- Voice/TTS interaction with smart-compact fires (Fix 40 is the last word here).
- Dashboard UI changes beyond the toggle (Lex's loop is server-side, no new panels needed).
