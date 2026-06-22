# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

The rule: anyone reading this should start cold and know where the code
is, what is in flight, what is shippable next, and what blocks it.

Last touched: 2026-06-22. Branch `master`, HEAD `baa4c53`, tree clean.
Last verified: daemon 1407 green (`cd 07-daemon && npm test`; clean
1407/1407, +19 for the intelligence-pillar first slices). dashboard 146
unit green (the 2 `e2e/*.spec.ts` Playwright files vitest cannot collect
are pre-existing, not a regression). DRIVE-QUEUE complete (items 1-5 all
shipped); the only remaining step is the operator's daemon rebuild +
restart + verify. This session touched daemon only.

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
- Two-tier warmth completed (DRIVE-QUEUE 1b):
  - DIGEST PUSH (`a1d139d`): `buildVoiceDigest` derives a small digest
    from Lex's synthesized reply (lastDecision = first sentence,
    openQuestion = trailing question, prior context carried forward);
    `lex-voice-ws.ts` pushes it at every end_turn boundary + the project-
    start state change. The fast lane now passes the real `lastLexTurnMs`
    (not assumeDigestFresh), so a stale/absent digest forces the turn to
    queue to Lex. BF-4: only Lex's reply text feeds the digest.
  - LIVE RENDER (`25a65ba` primitive, `6a732b2` wiring): `renderSpokenAsync`
    (async twin of renderSpoken, same verbatim guard) + `renderReplyLive`
    (VOICE_HAIKU_MODEL restyle, low temp) + `renderReplyForSpeech`
    (flag+key gated). Wired into the speak controller as a render:true
    hook on Lex's reply BODY only (never acks/glue/heartbeats); a
    `killGen` guard drops a body barged mid-render. A dropped/flipped
    preserve span (number/decision/negation) or any miss ships the safe
    markdown-strip render, so meaning can never change and audio is never
    lost.
- Mid-reply truncation FIXED (DRIVE-QUEUE 1c, `4d409c1` + doc `1ec8aab`):
  the 1b render called the model with a fixed `max_tokens: 512`, cutting
  long replies off mid-sentence (the verbatim guard only catches dropped
  preserve spans, so a truncated prose tail shipped). `renderReplyLive`
  now sizes `max_tokens` to the input and adds a completeness backstop
  (an unterminated long restyle returns '' -> full safe render). Verified
  it is the ONLY length-bounding step in the speak path (piper / sanitize
  / selectTtsContent body / Fix-51 controller are all unbounded). Doc:
  `docs/bugs/2026-06-22-mid-reply-tts-truncation.md` (canonical entry; no
  prior doc existed). Net: spoken body is a complete warm restyle or the
  complete safe render, never truncated.
- DEFERRED: slow-lane bridge line is still the deterministic `pickBridgeLine`
  hash pick (not yet a live-haiku bridge). Digest deriver is heuristic
  (first-sentence); a richer Lex-authored structured digest (real
  currentTask/workerStatus/nextSteps) is a future refinement. In practice
  the digest stays fresh per turn, so the staleness gate only bites on a
  push failure or before Lex's first reply.

## Follow-on builds landed this session (all ADDITIVE)

- Lifecycle dashboard, WIRED to real data (DRIVE-QUEUE 3): scaffold was
  `27b92b8`/`630e2a9`/`4e4c193`. Now: `eeed6c4` runnable gates - the
  always-false stub replaced by `gateProbe(stage, GateSignals)` (intake /
  spec doc / tests / test runner / suite green / open bugs),
  `effectiveStage` (NULL default: live -> execution, else new_project),
  `gateNeeds` + `lifecycleGreetingLine`, and `project-lifecycle-probes.ts`
  `gatherGateSignals` (bounded fs walk; suite run is OPT-IN). `c1a141c`
  routes `GET /lex/lifecycle` (stage + gate + can_advance) and `POST
  /lex/lifecycle` (state-machine-validated SET, persists the migration-045
  `stage` column). `c68085e` stage-aware cold-start greeting (appends the
  supervised project's stage + gate-needs to the first-reply preamble,
  resolved by the brainstorm anchor's cwd). `3752ef0` dashboard rail wired
  to `GET /lex/lifecycle` via a project selector; marks the live stage +
  gate, cold start renders New Project. ProjectsGrid + open-sessions +
  Stream Deck + KPI strip untouched.
- Smart-clear automation (DRIVE-QUEUE 4, spec 2b): auto context-full
  wind-down on the investigator engine. `f990f2c` trigger
  (`07-daemon/src/lex/smart-clear.ts` config: `smart_clear_mode`
  off|shadow|live default off, threshold 40% / ceiling 60% adjustable;
  `evaluateSmartClearTrigger` idle/wind-down/force-stop; GET
  `/lex/smart-clear/state` + GET/POST `/config`). `d401563`
  `assembleSmartClearReport` (broad sweep via `assembleInvestigatorContext`
  + the two artifacts: `draftStoppingPoint` commit-first-when-dirty /
  after-commit-never-mid-edit, `draftReseed` adaptive sufficiency = HEAD +
  doing/next/decisions, not a transcript). `b4f2f3f` `vetReseed` gate
  (verified state + next + not-a-dump; the daemon never blind-injects).
  `6dc14d2` `confirmResumeOnTask` trail probe + POST `/lex/smart-clear/plan`
  (assemble + vet, never inject) + POST `/confirm` + audit rows. Division
  of labor: daemon ASSEMBLES/LOGS/gates, Lex DECIDES/FIRES (stop -> worker
  commits + /clears -> Lex /lex/smart-compact/clear-and-paste with the
  VETTED reseed -> trail-confirm). Inert until `smart_clear_mode` flipped.
- Intelligence pillars, first slices (DRIVE-QUEUE 5, EXPLORATORY): all
  PURE + additive, no caller yet (zero live behavior change, no flag
  needed). `111723c` (a) `07-daemon/src/lex/standards-store.ts` -
  proposeStandards emits CANDIDATE meta-rules (same trade-off chosen >= 3x)
  + contradiction flags from memory records; never auto-applied
  (Lex/human confirm). `f0df95b` (b) `trajectory-check.ts`
  predictNextObstacle at a commit boundary -> stuck-loop /
  schema-needs-migration / approaching-unresolved-decision, surfaced only.
  `baa4c53` (c) `confidence-gate.ts` tagConfidence + gateClaim: a
  below-threshold claim routes to VERIFY via the fact-validator (cited SHA
  exists / count matches) before asserting. Each is one small module + its
  own tests; live wiring (investigator pass, supervision boundary,
  speak-path gate) is future work.
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
  session-id join never see them.
- Unified Knowledge Index, part 2A incremental watcher (`500d54b` core +
  `62ea611` watcher + `d516b00` route): the index re-indexes on file
  change without a full run. `VectorStore.deleteWhere` + `removeDocFile` /
  `reindexDocFile` (delete the file's old line-keyed chunks, re-chunk +
  embed + add fresh - clears stale chunks when a file shrinks);
  `project-doc-watcher.ts` `createDocWatchCoordinator` (debounced, default
  750ms, longest-dir store resolution, exists -> reindex vs gone ->
  remove) + `startProjectDocWatch` (fs.watch shell). Live via `POST
  /lex/watch-docs {project_id, action:'start'|'stop', stores[]}`. Strict
  project scope preserved on every incremental op.
- Unified Knowledge Index, part 2B orb (`7a00770` endpoint + `fa2788b`
  view): the visual browse front. Daemon `listProjectDocs` + `GET
  /lex/doc-index?project_id=...` return the project's index grouped by
  file (store, path, chunk pointers), strict-scoped. Dashboard route
  `/knowledge` (`08-dashboard/src/knowledge/`): a project-scoped
  force-graph orb (store-hub + file nodes), per-store filter CHIPS,
  project selector (defaults DevNeural), side panel showing a clicked
  file's path + chunk headings/lines/snippets. Pure `buildKnowledgeGraph`
  shaper is unit-tested. Additive: a new route + TopBar "Knowledge index"
  entry; the global `/orb` graph and all panels are untouched. Still out:
  the DevNeural store-set auto-resolver (callers still pass explicit store
  dirs to index-docs / watch-docs).

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
- part 2A incremental watcher route (`d516b00`, Rebuild: yes) goes live on
  the same rebuild: `POST /lex/watch-docs {project_id, action, stores[]}`.
  After rebuild, start it for DevNeural with the same store-set used for
  `/lex/index-docs`, then verify: edit a watched .md, wait a few seconds,
  and `/lex/recall {project_docs:true}` reflects the change without a
  manual re-index; delete a file and its pointers stop appearing.
- part 2B orb: daemon `GET /lex/doc-index` (`7a00770`, Rebuild: yes) goes
  live on the same rebuild. The dashboard `/knowledge` view (`fa2788b`)
  needs a DASHBOARD build (`cd 08-dashboard && npm run build`), not a
  daemon rebuild, to ship (the daemon serves the static export). Verify:
  open /knowledge, pick DevNeural, see store-grouped file nodes, toggle a
  store chip, click a file -> path + chunk pointers in the side panel.
- lifecycle (DRIVE-QUEUE 3): daemon `GET/POST /lex/lifecycle` + the
  stage-aware greeting (`c1a141c`/`c68085e`, Rebuild: yes) go live on the
  same rebuild; the dashboard rail (`3752ef0`) needs the DASHBOARD build.
  Verify: open /projects/lifecycle, pick DevNeural -> rail marks the live
  stage with the gate status (NULL rows default live -> Execution); GET
  `/lex/lifecycle?cwd=...&run_tests=1` confirms the suite-green gate; a new
  Lex cold start that supervises a project states the stage on its first
  reply.
- live voice (glue 1a `11ecf2f` + digest push & body render 1b `a1d139d`
  / `6a732b2` + truncation fix 1c `4d409c1`, all Rebuild: yes) goes live
  on the same rebuild but ALSO needs both `DEVNEURAL_VOICE_HAIKU=1` and
  `ANTHROPIC_API_KEY`. Flag off, or flag on but no key: deterministic
  fallback (= today's behavior), nothing changes until the operator opts
  in. Verify with both set: (1) repeat an ack ("ok"/"nice") a few times,
  the spoken reply varies and never repeats; (2) Lex's reply body sounds
  warm/spoken yet every number/decision/negation survives verbatim (the
  verbatim guard ships the safe render if not); (3) a LONG reply speaks to
  completion (no mid-sentence cut, the 1c symptom); (4) "stop"/"quiet"
  still cut instantly with no model latency, including a barge while a
  body is mid-render.
- smart-clear (DRIVE-QUEUE 4, `f990f2c`/`d401563`/`b4f2f3f`/`6dc14d2`, all
  Rebuild: yes for the routes) goes live on the same rebuild but stays
  inert until `POST /lex/smart-clear/config {mode:'live'}`. Default off =
  no behavior change. The actual stop/clear/reseed/trail loop is LEX'S job
  at runtime (poll /state -> /plan -> vet -> drive stop -> clear-and-paste
  -> /confirm); the daemon only assembles/gates/logs. Verify with mode
  live: at ~40% worker ctx /state returns wind-down; /plan returns a
  commit-first stop when dirty + a vetting reseed.

## Next up (not started)

- Knowledge Index remainder (2A watcher + 2B orb now DONE): the only
  piece left is the DevNeural store-set auto-resolver - map a project to
  its disjoint memory/docs/spec/bugs/brainstorm dirs so /lex/index-docs,
  /lex/watch-docs, and the /knowledge orb work without the caller (or the
  view's implicit defaults) hand-passing absolute dirs. Live-verify 2 +
  2A + 2B after the operator rebuild + dashboard build: POST
  `/lex/index-docs` for DevNeural, start `/lex/watch-docs`, edit a doc,
  confirm `/lex/recall {project_docs:true}` reflects it within seconds,
  and the /knowledge orb shows the store-grouped files.
- Voice (1a + 1b done: live glue, digest push, body render). Remaining:
  live-haiku slow-lane BRIDGE line (still the deterministic hash pick in
  `pickBridgeLine`), and a richer Lex-authored structured digest (the
  deriver is heuristic first-sentence today).
- Lifecycle (DRIVE-QUEUE 3 DONE: stage persistence, runnable gates,
  GET/SET routes, stage-aware greeting, live rail). Remaining: auto-advance
  (a supervisor that advances a stage when can_advance flips true), and
  richer per-gate probes (execution "plan done" is currently approximated
  by "a test runner exists"; spec/tdd probes are filesystem heuristics).
- Smart-clear (DRIVE-QUEUE 4 DONE: trigger, report+artifacts, vet gate,
  trail-confirm, routes - the daemon primitives). Remaining: the LIVE Lex
  driver loop (Lex polling /state, calling /plan, vetting, driving stop ->
  clear-and-paste -> /confirm) is Lex's runtime prompt/skill, not built
  here; plus the optional Opus refinement of the reseed draft (the deter-
  ministic draft + Lex's vet/tighten is the floor) and a dashboard panel.
  Rename smart-compact -> smart-clear across the old surface is still
  queued (the new module is additive alongside it).

## Working constraints

- Do NOT restart the daemon / flip flags live (operator owns it).
- Caveman lite mode active (terse; code/commits normal). No em dashes.
  No AI co-author tags. Commit incrementally; each body ends with a
  `Rebuild: yes/no` line.
- Additive only: never break existing behavior or the regression-guard
  surfaces (terminal/PTY binding, bridge presence, cross-session inject).
- The Bash tool runs Git Bash, not PowerShell; use POSIX there.
