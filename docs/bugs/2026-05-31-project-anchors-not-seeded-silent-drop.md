# 2026-05-31 Project anchors never seeded, presence silently dropped

**Status:** open (production code never finished; rediscovered after Docker install hung daemon and broke prior Lex session 1e762120)

## Symptom

- Dashboard shows phantom / inconsistent "new projects appearing" tiles.
- A VS Code bridge that opens in a `cwd` the daemon has never seen before never flips that project to live. The presence file is silently dropped.
- No project_session rows exist on first boot unless someone has manually opened a CC session in that folder AND the seeding write path has run. There is no boot-time enumeration of `C:/dev/Projects`.

## Root cause

`docs/spec/PROJECT-ANCHORS.md` line 57 "## Seeding" section was specified but the implementation never landed.

Two missing pieces:

1. **No boot seed.** `07-daemon/src/daemon.ts` boot sequence never enumerates `C:/dev/Projects` to upsert a `project_session` row per top-level subdir. The spec calls for this on every boot AND on filesystem-change events.
2. **Silent drop in reconcile.** `07-daemon/src/dashboard/bridge-presence.ts:243`
   ```
   const anchor = db.getProjectSessionByCwd(cwd);
   if (!anchor) continue;
   ```
   When a bridge presence file arrives for a cwd that has no seeded anchor row, reconcile silently skips it. The bridge keeps reporting, the daemon keeps ignoring. Project never goes live in the dashboard.

The "phantom new project" symptom is the dashboard rendering whatever stale state survives the missing seed pass plus whatever else half-creates anchor rows via other code paths.

## Plan

10-step plan was queued in prior CC Lex session `1e762120-4b45-4430-9167-e1071d732692` (timestamps 2026-05-31T16:51-16:53Z, then the daemon hung after Docker Desktop install reshuffled the Windows network stack and the session was cut off mid-task 1). Tasks 1-10:

1. Read daemon.ts boot sequence + fs-watcher.ts for insertion point.
2. Write `07-daemon/src/dashboard/seed-project-anchors.ts`. Pure `seedProjectAnchors(db, {root?, now?})`. Enumerate top-level subdirs, idempotent upsert keyed on `cwd`. Skip non-dirs and dotfiles. Honour `DEVNEURAL_PROJECTS_ROOT` env override.
3. Wire seed into `daemon.ts` boot after `store.open()` and before the bridge-presence loop start. Add `fs.watch(root)` so a new top-level dir triggers re-seed.
4. Fix `bridge-presence.ts:243`. Replace the silent `continue` with an inline auto-create via the same seed helper, then flip live in the same pass.
5. Write `seed-project-anchors.test.ts`. Pins: idempotent re-run, cwd normalization, skip non-dirs / dotfiles, `DEVNEURAL_PROJECTS_ROOT` override respected.
6. Extend `bridge-presence.test.ts` with an auto-create pin. Presence file for unknown cwd ⇒ reconcile creates anchor + flips status='live' same pass.
7. Build daemon + run full suite. All green required.
8. Park voice turn-overlap regression as a separate investigation (reply A still playing when reply B starts; distinct from Fix 40 / Fix 51).
9. Atomic commit per repo two-commit pattern. FIXES.md row. HANDOVER.md refresh.

## Acceptance

- `seedProjectAnchors` enumerates every top-level dir under `C:/dev/Projects` and upserts one `project_session` row per dir, idempotent across reruns.
- A bridge presence file for a cwd with no pre-seeded anchor still flips that project to live on first reconcile pass.
- `fs.watch(root)` triggers re-seed on new top-level dir creation.
- All daemon tests green.
- Dashboard projects panel only shows anchors that match disk reality + explicitly retained dormant rows (per spec: folders removed from disk stay in DB until explicit user delete).

## Why this kept getting lost

The original session that planned this work was cut off when Docker Desktop install wedged the daemon socket. Daemon process stayed alive but stopped accepting connections; the prior Lex session terminated mid-task with the 10-step plan still pending. No bug doc had been written. Future sessions reading TODO.md or HANDOVER.md had no breadcrumb to this work. This doc + the matching SMOKE-TEST entry are the breadcrumb.

## Sibling bug: cold-start preload reports "OK" but Lex still lands blind

Dashboard /system Cold-Start Preload panel for anchor `4bbafb48-bbf...` on 2026-05-31 01:36:55 PM EDT shows:

```
OK Loaded 5 sibling sessions, last distilled 13:33 EDT, 48 recent turns appended.
siblings: 5  turns: 48  distilled: 01:33 PM  stale: 28  synced: 0  partial
cc: 332e6e5b
```

Status is green "LIVE" runtime + green "OK" verdict, but two red counters are real failure signals:

- **stale: 28**: 28 sibling refs have no fresh distillation row.
- **synced: 0**: zero refs in the synced state.
- **partial**: preload shipped a partial payload.

Net effect: a fresh Lex session attaches, the preload pipeline fires, the audit row says "OK accepted text_length=...", but in practice 28/33 sibling sessions arrive un-summarised and Lex still has to ask the operator "where were we." That is the exact symptom we hit today: a new CC session opened against this project had to grep jsonl for the prior-session plan instead of reading a distilled cold-start block. The second-brain machinery silently degraded into "load whatever distillations happen to exist" without surfacing the gap as a real failure.

Distinct, but tightly coupled to this work because both bugs together produced today's loss. Diagnose in this same investigation cycle.

### Acceptance for the sibling bug

- Distillation worker actually runs against ended brainstorms and writes `brainstorm_sessions.last_summary` within a bounded window after end.
- `stale: 28` count drops to zero (or near zero) under steady-state operation; long-tail untouched anchors are documented separately.
- Cold-start preload verdict is `partial` ONLY when the operator has explicitly skipped a session; otherwise it must be `synced` and `OK`.
- A `partial` verdict triggers a visible warning (yellow or red) in the dashboard panel AND surfaces a structured signal Lex can react to, instead of the green `OK` label that hides the gap.
- Sessions that ended abruptly (daemon crash, /clear, host reboot) get distilled on next daemon boot via a recovery sweep; the un-distilled session from today's daemon hang is the canary case.

### Diagnostic next steps

1. Read `07-daemon/src/lex/lex-cold-start-preamble.ts` + `07-daemon/src/curation/*distill*` to map who is supposed to call the distiller, when, and against which session set.
2. Query `SELECT id, status, last_summary IS NOT NULL AS has_summary, last_summary_ms FROM brainstorm_sessions WHERE status='ended' ORDER BY last_summary_ms DESC LIMIT 30` to see the stale/synced split in the DB.
3. Check if there is a boot-time recovery sweep for sessions that ended without a summary; if not, add one.
4. Audit when the `partial` verdict is emitted vs `synced`. Promote `partial` from informational to actionable.

## Related

- `docs/spec/PROJECT-ANCHORS.md` line 57.
- `07-daemon/src/dashboard/bridge-presence.ts:243`.
- Prior Lex session jsonl: `C:/Users/michael/.claude/projects/C--dev-Projects-DevNeural/1e762120-4b45-4430-9167-e1071d732692.jsonl`.
