# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

The rule: anyone reading this should start cold and know where the code
is, what is in flight, what is shippable next, and what blocks it.

Last touched: 2026-06-22. Branch `master`, HEAD `11ecf2f`, tree clean.
Last verified: daemon 1308 tests green (`cd 07-daemon && npm test`;
+14 this session: +9 project-doc index, +5 net live voice glue. Clean
runs were 1294/1294 then 1308/1308; the project-doc run once flaked on 9
unrelated specs under concurrent load, Windows temp-dir EPERM + 5s
timeouts, green on re-run). dashboard 138 unit green (2 `e2e/*.spec.ts`
are pre-existing Playwright specs vitest cannot collect, not a
regression). This session touched daemon only.

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
- Fast-lane glue is now LIVE haiku (DRIVE-QUEUE 1a): `4df083c`
  `07-daemon/src/voice/voice-haiku-glue.ts` (`generateGlueReply` ->
  VOICE_HAIKU_MODEL in persona + live digest, warm/varied, never-twice
  ring + avoid-list, `<none>` = absorb, fail-fast null on miss);
  `11ecf2f` wires `composeGlueReply` async into the WS fast lane. Canned
  strings are now the FALLBACK only (no key / call miss), byte-identical
  to before. "say again" stays a deterministic verbatim replay; control
  reflexes (stop/quiet/abort/redirect) never touch the model. BF-4 held:
  the glue model only ever sees the persona+digest (Lex synthesis) + the
  user aside, never raw content.
- DEFERRED: Lex-authored digest push (the digest the glue model speaks
  from is still pushed by the deterministic seam; Lex writing it live on
  every turn boundary is the remaining BF-4/latency fork). The slow-lane
  bridge line + the safe-render path are still deterministic.

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
- Unified Knowledge Index, piece 2 (embed + scoped query): `8a61664`
  core `07-daemon/src/lex/project-doc-index.ts` (`indexProjectDocs` embeds
  the corpus into `raw_chunks` under `PROJECT_DOC_KIND` with deterministic
  ids `project-doc:<pid>:<path>#<line>`, idempotent upsert;
  `projectDocSearch` strict-scopes to one project and returns pointers
  {store, path, heading, line, snippet, score}). `f64d58c` wiring:
  exclusion guards in search-all / curator / backfill keep the shared
  `raw_chunks` collection clean for transcript recall (project-doc never
  leaks), plus additive routes `POST /lex/index-docs {project_id,
  stores[]}`, `/lex/chunk-search {project_id, docs:true} -> doc_hits`,
  `/lex/recall {project_docs:true} -> doc_pointers`. project-doc chunks
  get NO `raw_chunks_meta` (SQL) row, so the cull job + brainstorm
  session-id join never see them. Still out: the DevNeural store-set
  auto-resolver, orb UI, file-watcher (auto-refresh).

## Pending the operator daemon rebuild + restart

`cd 07-daemon && npm run build` then restart, then verify:
- daemon log shows `[distill-scheduler] headless Opus engine
  (DEVNEURAL_DISTILL_HEADLESS=1)`.
- a Lex spawn writes a dated file under
  `C:/dev/Projects/DevNeural/investigator-reports/`.
- inaugural: stale ref count == 0 on the live DevNeural Testing anchor
  (`4bbafb48`). See `docs/SMOKE-TEST.md`.
- piece 2 routes + recall guards (`f64d58c`, Rebuild: yes) go live on the
  same rebuild: `/lex/index-docs`, `/lex/chunk-search` doc_hits,
  `/lex/recall` doc_pointers, and the project-doc exclusion in search-all
  / curator / backfill. Until then they exist only in the build.
- live voice glue (`11ecf2f`, Rebuild: yes) goes live on the same rebuild
  but ALSO needs both `DEVNEURAL_VOICE_HAIKU=1` and `ANTHROPIC_API_KEY`
  set. With the flag off, or the flag on but no key, the fast lane uses
  the deterministic fallback (= today's canned glue), so nothing changes
  until the operator opts in. Verify: with both set, repeat an ack ("ok",
  "nice") a few times and confirm the spoken reply varies and never
  repeats; confirm "stop"/"quiet" still cut instantly (no model latency).

## Next up (not started)

- Knowledge Index piece 3: DevNeural store-set auto-resolver (map a
  project to its disjoint memory/docs/spec/bugs/brainstorm dirs so
  `/lex/index-docs` is callable without hand-passing absolute dirs),
  then the file-watcher (auto re-index on markdown change) + orb UI.
  Live-verify piece 2 first: after the operator rebuild, POST
  `/lex/index-docs` for DevNeural, then `/lex/recall {project_docs:true}`
  and confirm `doc_pointers` resolve to real files with no cross-project
  bleed and no change to the existing `results`/`groups`.
- Voice: Lex-authored digest push (live haiku glue for the fast lane is
  done, `11ecf2f`; remaining is Lex writing the digest live on every turn
  boundary so the glue speaks from genuinely fresh synthesis). Slow-lane
  bridge line is still deterministic.
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
