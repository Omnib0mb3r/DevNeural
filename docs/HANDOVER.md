# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

The rule: anyone reading this should start cold and know where the code
is, what is in flight, what is shippable next, and what blocks it.

Last touched: 2026-06-22. Branch `master`, HEAD `d516b00`, tree clean.
Last verified: daemon 1342 tests green (`cd 07-daemon && npm test`; +10
knowledge-index 2A: +4 incremental reindex primitives, +6 watcher
coordinator; clean run 1342/1342). The full suite still flakes on a
cluster of timing/temp-dir specs under concurrent load (auto-advance-
supervisor, stale-watcher, smart-compact-injector, loose-ends-gate,
grooming-watch, etc., none touched here; the failing set changes run-to-
run); all pass in isolation. dashboard 138 unit green (2 `e2e/*.spec.ts`
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
  project scope preserved on every incremental op. Still out: orb UI, and
  the DevNeural store-set auto-resolver (callers still pass explicit
  store dirs to both index-docs and watch-docs).

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

## Next up (not started)

- Knowledge Index remainder (2A incremental watcher DONE): next is the
  ORB UI (the part 2B the directive flagged), plus the DevNeural store-set
  auto-resolver (map a project to its disjoint memory/docs/spec/bugs/
  brainstorm dirs so /lex/index-docs + /lex/watch-docs are callable
  without hand-passing absolute dirs). Live-verify piece 2 + 2A first
  after the operator rebuild: POST `/lex/index-docs` for DevNeural, start
  `/lex/watch-docs`, edit a doc, and confirm `/lex/recall
  {project_docs:true}` reflects it within seconds with no cross-project
  bleed and no change to the existing `results`/`groups`.
- Voice (1a + 1b done: live glue, digest push, body render). Remaining:
  live-haiku slow-lane BRIDGE line (still the deterministic hash pick in
  `pickBridgeLine`), and a richer Lex-authored structured digest (the
  deriver is heuristic first-sentence today).
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
