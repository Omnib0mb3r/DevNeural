# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

The rule: anyone reading this should start cold and know where the code
is, what is in flight, what is shippable next, and what blocks it.

Last touched: 2026-06-22. Branch `master`, HEAD `5bea58c`, tree clean.
Last verified: daemon 1285 tests green (`cd 07-daemon && npm test`),
dashboard 138 unit green (2 `e2e/*.spec.ts` are pre-existing Playwright
specs vitest cannot collect, not a regression).

## HARD constraint

Do NOT restart the daemon (it kills the supervising Lex session). The
operator owns every daemon restart + flag flip.

## The program: Investigator Pipeline (3 pillars) + follow-ons

Design of record: `docs/spec/INVESTIGATOR-PIPELINE-SPEC.md` +
`C:/dev/data/skill-connections/brainstorm/INVESTIGATOR-PIPELINE-PLAN.md`.
Bar: a pillar is "done" only when the real metric moves on live hardware.
Green + committed = "built", not "verified".

### Pillar 1 - cold start (BUILT; live on next restart)
- `gateColdStart` in `07-daemon/src/lex/lex-investigator.ts`, wired into
  `spawn-lex-session.ts` (replaced the fire-and-forget that wrote
  nothing). Synchronous: assemble -> validate prior -> persist report ->
  cache seed, before Claude's SessionStart hook. Cannot hang; headless
  Opus is an opt-in bounded async upgrade.
- Reports land in the PROJECT folder
  `<projectDir>/investigator-reports/<YYYY-MM-DD_HHmm-ss>.md` (+ archive/).
  DevNeural: `C:/dev/Projects/DevNeural/investigator-reports/`. Newest =
  seed; older move to archive/ (never deleted). Dir is gitignored.
- `67828ff`: within the HANDOVER doc family the freshest leads (mtime
  sort) so current state is on top. Verified by unit test.

### Pillar 2 - distillation (BUILT, behind DEVNEURAL_DISTILL_HEADLESS)
- Staleness-driven re-distill on the unified headless-Opus engine; one
  writer / one signal (`latest_chunk_ms > ref_summary_ms`).
- `DEVNEURAL_DISTILL_HEADLESS=1` set in
  `07-daemon/scripts/start-daemon.ps1` (committed); live on restart.

### Pillar 3 - voice / haiku (BUILT, behind DEVNEURAL_VOICE_HAIKU, default OFF)
- Modules V1-V7 in `07-daemon/src/voice/` (single-mouth lock, control
  channel, deny-by-default whitelist, two-lane router, renderer + verbatim
  preserve-list, folded heartbeat, persona + digest + front desk) + live
  WS capstone in `lex-voice-ws.ts` (CAP-1 render/heartbeat, CAP-2 inbound
  lane routing). Flag OFF = byte-identical to current voice.
- DEFERRED: live haiku MODEL calls + Lex-authored digest push (BF-4 +
  latency fork). Deterministic glue + safe-render run for now.

## Follow-on builds landed this session (all ADDITIVE)

- Lifecycle dashboard scaffold (spec item 8): `27b92b8` stage model
  `07-daemon/src/lex/project-lifecycle.ts`; `630e2a9` migration
  `045-project-session-stage.sql` (nullable `stage`, NULL on all rows);
  `4e4c193` static route `08-dashboard/app/projects/lifecycle/page.tsx` +
  `components/LifecycleRail.tsx`. Stubs only; ProjectsGrid + open-sessions
  untouched.
- Unified Knowledge Index, first slice: `5bea58c` markdown corpus chunker
  `07-daemon/src/lex/markdown-corpus.ts` (walks memory/docs**/brainstorm/
  spec/bugs, chunks by heading, tags {store, path, heading, line, snippet,
  text}, project-scoped). Pure + tested; no caller wired yet.

## Pending the operator daemon rebuild + restart

`cd 07-daemon && npm run build` then restart, then verify:
- daemon log shows `[distill-scheduler] headless Opus engine
  (DEVNEURAL_DISTILL_HEADLESS=1)`.
- a Lex spawn writes a dated file under
  `C:/dev/Projects/DevNeural/investigator-reports/`.
- inaugural: stale ref count == 0 on the live DevNeural Testing anchor
  (`4bbafb48`). See `docs/SMOKE-TEST.md`.

## Next up (not started)

- Knowledge Index piece 2: embed corpus chunks into `store.rawChunks`
  under a `project-doc` kind + scoped query returning pointer results;
  widen `/lex/recall` + `/lex/chunk-search` additively (keep brainstorm-
  chunk recall intact). Pattern: `chunk-retrieval.ts:46` (chunkSearch),
  `embedOne` from `../embedder/index.js`. Still out: orb UI + file-watcher.
- Voice: live haiku model calls + Lex digest push.
- Lifecycle: wire the stage column + real gate exit criteria + stage-aware
  greeting.

## Working constraints

- Do NOT restart the daemon / flip flags live (operator owns it).
- Caveman lite mode active (terse; code/commits normal). No em dashes.
  No AI co-author tags. Commit incrementally; each body ends with a
  `Rebuild: yes/no` line.
- Additive only: never break existing behavior or the regression-guard
  surfaces (terminal/PTY binding, bridge presence, cross-session inject).
- The Bash tool runs Git Bash, not PowerShell; use POSIX there.
