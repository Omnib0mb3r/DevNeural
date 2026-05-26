# LEX-AUTONOMY codex item 9: first-attach path using identical builder

**Reported:** 2026-05-26 06:25 EDT by operator
**Severity:** medium (first-attach worker boots blind because codex 8's source-graph builder is only triggered on smart-clear)
**Status:** investigation (no code; ship spec follows)
**Related:** spec line 294; Fix 45 (codex 8) at `665d203` ships `buildSourceGraphPayload` + `renderWorkerBoot` with smart-clear vs first-attach modes already defined.

## Question 1: first-attach detection points

### Entry points to a fresh worker

| Path | Trigger | File:line |
|---|---|---|
| Dashboard "Start session" button | `POST /projects/:id/start-claude` | `07-daemon/src/dashboard/routes.ts:2492` |
| Voice "start project ..." | brainstorm-store `attachWorkerSession` after CC handshake | `07-daemon/src/lex/brainstorm-store.ts:178` |
| External CC launch | bridge-presence file resolves the new cc_session_id to the project anchor | `07-daemon/src/dashboard/bridge-presence.ts` (resolve path) |

All three paths funnel through the SessionStart hook firing `POST /worker/clear-handoff { session_id, cwd }` (`routes.ts:4506`). That endpoint is the single observation point for "is this the first attach on this anchor".

### Today's first-attach detection: none

The handoff route does NOT distinguish first-attach from smart-clear today. It uses the same logic in both cases:
- `db.getProjectSessionByCwd(cwd)` to gate render to known anchors.
- `db.getBrainstormByAttachedWorker(session_id)` to find the brainstorm row.
- `buildSourceGraphPayload(...)` (codex 8 wire) with `firstAttach: false` (the default; the field is never set).

There is no "this is the first time this anchor has ever bound a worker" signal threaded into the response.

## Question 2: current first-attach handoff

### Payload received today on first attach

Identical to the smart-clear payload. The legacy `buildWorkerHandoff` (`worker-handoff.ts:380`) emits:
- git state (branch, last commit, in-flight files) — this is per-cwd, not per-anchor; renders identically on first attach.
- backlog active_task + next_up — file-based; identical.
- audit_findings — anchor-agnostic; identical.
- docs_index — repo-wide; identical.
- brainstorm_context — when the new cc has been bound to a brainstorm row, surfaces last_summary + ranked turn pairs (Fix 45 wire); when NOT yet bound (first-attach race window), brainstorm_context is null.

After Fix 45's route wire (`routes.ts:4506`, `23c0eab`), the response also carries `source_graph_block: string | null` rendered via `renderWorkerBoot(payload, { mode: 'smart-clear', now })`. The hardcoded `mode: 'smart-clear'` is the gap codex 9 closes.

### Where the gap lives

`07-daemon/src/dashboard/routes.ts:4554` calls:

```typescript
source_graph_block = renderWorkerBoot(payload, {
  mode: 'smart-clear',
  now,
});
```

Mode is fixed. Codex 8's `renderWorkerBoot` already has the first-attach branch (`07-daemon/src/lex/worker-boot-render.ts:90-105`); the route just never selects it.

## Question 3: detection mechanics

### Proposed signal

```typescript
function isFirstAttach(db: IndexDb, anchorId: string): boolean {
  const refCount = db.countLexTranscriptRefs(anchorId);
  if (refCount === 0) return true;
  return false;
}
```

`countLexTranscriptRefs` already exists at `07-daemon/src/store/index-db.ts:2203`. Returns 0 when no `lex_transcript_ref` row exists for the anchor. One column read; cheap.

### Why ref count alone

- A brainstorm with prior CC sessions has ≥ 1 ref row. Not first-attach.
- A brainstorm started via voice direct-llm has NO refs (refs are CC-session-keyed; direct-llm has no CC). It does have `brainstorm_chunks`. **Edge case: classify as first-attach for worker-boot purposes** because the worker has not yet seen this anchor; the direct-llm conversation is "the operator's chat with Lex", which is exactly what the first-attach payload should surface.
- A brainstorm anchor with ≥ 1 ref but the new cc_session_id is NOT yet in `lex_transcript_ref`: this is the race window between worker spawn and the ingestor binding. Treat as smart-clear because the anchor has prior history. The walk-back scorer already excludes the active cc.

### Alternate signal (rejected)

Counting `brainstorm_chunks` rows scoped to the brainstorm_id is misleading: direct-llm chunks would gate the first-attach path off even though no worker has attached. Stay with ref count.

## Question 4: render differences

### Already implemented in `renderWorkerBoot` (Fix 45)

`07-daemon/src/lex/worker-boot-render.ts:90-105`:
- Header tag `[FIRST-ATTACH]` appended when `payload.first_attach === true`.
- "Your next action" section: if `nextAction` is supplied + non-empty, render verbatim. Else default to `"FIRST-ATTACH - await Lex directive before acting."`

### What codex 9 wires

In the route handler at `routes.ts:4554`:

```typescript
const firstAttach = store.db.countLexTranscriptRefs(bs.id) === 0;
const payload = buildSourceGraphPayload({
  ...,
  firstAttach,
});
const mode = firstAttach ? 'first-attach' : 'smart-clear';
source_graph_block = renderWorkerBoot(payload, { mode, now, nextAction });
```

`buildSourceGraphPayload` already accepts `firstAttach` (codex 8 added the optional opt). The route + `renderWorkerBoot` mode pick auto-toggle off the detection.

### Sections that change on first-attach

- Header gains `[FIRST-ATTACH]` tag (codex 8 already renders this).
- Bundles section renders `(no prior sessions on this anchor; worker is the first attached process)` when `payload.refs.length === 0` AND `payload.first_attach === true` (codex 8 branch at `worker-boot-render.ts:118-122`).
- "Your next action" renders the FIRST-ATTACH default OR Lex-supplied text.

### Sections that DO NOT change

- Recent distillation errors — same render (typically empty on first-attach because nothing has tried to distill yet).
- Anchor header label — same.
- Freshness counts — typically `total=0` for first-attach; staleness_state defaults to `'no_refs'`.

## Question 5: Lex-authored next-action sources on first attach

### Priority order for the default `nextAction`

1. **Brainstorm last user directive.** The most recent user-role chunk in `brainstorm_chunks` for the anchor's brainstorm_id, IF it reads like a directive (verb-led, contains "make"/"add"/"fix"/"build" or ends with "?"/"."). Heuristic; codex 9 ship spec picks the exact regex.
2. **Active spec doc pointer.** If `docs/spec/<anchor.user_label>.md` exists, render `Read docs/spec/<label>.md, then ask Lex for the first concrete task.`
3. **Operator-supplied bootstrap.** Optional column on `brainstorm_sessions.bootstrap_directive` (new; codex 9 migration if pursued). Operator sets via dashboard before clicking Start.
4. **Default fallback.** `"FIRST-ATTACH - await Lex directive before acting."` (codex 8 default; already in place).

### Where to read sources

- Last user directive: `db.listBrainstormChunks(brainstorm_id, 20, {order: 'desc'})` then walk for the first `role==='user'`. Cheap (already indexed).
- Spec doc: `fs.existsSync(path.posix.join(repoRoot, 'docs/spec', `${label}.md`))`. Repo root resolved from anchor cwd.
- Bootstrap_directive column: requires migration 044 (additive nullable TEXT). Defer to follow-up if operator wants the dashboard surface.

### Recommendation

Ship priorities 1 + 4 in the first ship. 2 (spec doc heuristic) is high-value but file-system dependent; gated on later. 3 (operator column) is dashboard work; defer entirely to codex 11 grooming.

## Question 6: test outline

### `07-daemon/tests/first-attach-detection.test.ts` (new)

- `isFirstAttach` returns true for anchor with 0 refs.
- `isFirstAttach` returns false for anchor with 1+ refs.
- Direct-llm brainstorm (chunks present, refs absent) returns true (worker has never seen this anchor).
- Race window: anchor with 1 ref but new cc_session_id not yet bound → returns false (anchor has history).

### `07-daemon/tests/worker-boot-render.test.ts` (extend)

- First-attach mode emits `[FIRST-ATTACH]` header tag when `payload.first_attach === true` (already pinned in codex 8 tests).
- First-attach with `nextAction='Read docs/spec/foo.md'` renders verbatim.
- First-attach default fallback when `nextAction === null AND first_attach === true`.

### `07-daemon/tests/clear-handoff-route.test.ts` (new or extend existing)

- Route returns `source_graph_block` with FIRST-ATTACH header when anchor has 0 refs AND flag != 'legacy'.
- Route returns `source_graph_block` without FIRST-ATTACH header when anchor has refs.
- Route auto-toggles `mode` based on ref count; no client-side parameter needed.
- Smoke: `nextAction` derived from last user-role chunk when one exists.

### `07-daemon/tests/source-graph-payload.test.ts` (new)

- `buildSourceGraphPayload` returns `first_attach: true` when input opt is passed.
- `buildSourceGraphPayload` returns `first_attach: false` by default.
- `staleness_state === 'no_refs'` when refs array empty (first-attach happy path).

## Proposed ship-spec deliverables

1. New helper `isFirstAttach(db, anchorId): boolean` exported from `worker-handoff.ts` (or new module `first-attach-detector.ts`).
2. Route auto-toggle in `routes.ts:4554` to pick `mode: 'first-attach' | 'smart-clear'` from `isFirstAttach`.
3. New helper `deriveFirstAttachNextAction(db, brainstormId, now): string | null` reading the last user-role chunk; falls back to null when no directive-shaped chunk found. Wired into route; passed to `renderWorkerBoot`.
4. Test coverage per Q6 outline.
5. Defer migration 044 + dashboard `bootstrap_directive` surface to codex 11.

## Constants

```
FIRST_ATTACH_DIRECTIVE_LOOKBACK = 20   // chunks scanned from newest
FIRST_ATTACH_DIRECTIVE_REGEX    = /^(make|add|fix|build|implement|ship|wire|investigate)\b/i
```

## Out of scope (defer)

- `brainstorm_sessions.bootstrap_directive` column + dashboard form (codex 11 grooming).
- Spec doc heuristic (filesystem-dependent; needs cwd-to-repo-root resolver).
- Auto-firing the first inject from Lex to the worker (operator-driven still).

## Cross-references

- Codex 8 (Fix 45) close-out: 665d203.
- Existing `renderWorkerBoot` first-attach branch: `07-daemon/src/lex/worker-boot-render.ts:90-122`.
- Route wire to be edited: `07-daemon/src/dashboard/routes.ts:4506-4570`.
- Detection helper: `db.countLexTranscriptRefs(anchorId)` at `07-daemon/src/store/index-db.ts:2203`.
- Brainstorm attach: `attachWorkerSession` at `07-daemon/src/lex/brainstorm-store.ts:178`.
