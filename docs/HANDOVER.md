# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

The rule: anyone reading this should start cold and know where the code
is, what is in flight, what is shippable next, and what blocks it.

Last touched: 2026-07-15 (second cursor). Branch `master` @ 20971ec.
Daemon suite 1756/1757 green (same 1 pre-existing grooming-routes
failure). Dashboard build green. Dist rebuilt from committed source.
The daemon RESTARTED onto the first-wave build mid-day 2026-07-15
(capture catch-up drained the 65-day backlog, 948 files; curator
injections are firing organically again). A SECOND restart is needed
to pick up the wave-3 additions below. Bridge VSIX rebuilt +
installed 2026-07-15 (VS Code windows activate on reload).

### 2026-07-15 wave 3 (operator rule: nothing deferred unilaterally)

- e876ca3 voice-ws + pty-host diagnostics through the daemon logger.
- 635cee6 anchor open reports bridge delivery confirmation.
- 08544cf post-session meeting diarization (transcribe/diarize.py,
  opt-in runtime_config diarize_meetings='on' + HF_TOKEN, migration
  050 meeting_diarization table).
- 02749c9 explicit LLM inject verdicts (DEVNEURAL_INJECT_VERDICT=1,
  migration 049, curator_signal source llm-judge).
- 70363af expectation dispatcher: drift detection finally has data
  (open design question: supersede policy for repeat dispatches).
- 6f27bbc wiki reconcile tool, applied live w/ backups: zero drift.
- 20971ec decay now syncs meta rows (the drift regenerator) +
  drafts-promote test can no longer leak into the production data
  root (it had, twice; leaked files quarantined).
- Dashboard access incident root-caused: prod builds share .next with
  the supervised dev server, corrupting its cache mid-build; dev
  server restarted clean. Known residual: full prod builds while the
  dev server runs can transiently unstyle it.
- LightRAG/RAG-Anything install: awaiting explicit operator GO (new
  external service + Python dependency stack).

### 2026-07-15 goal audit: 13 fix packages, 9 commits (b5cbf69..4105eae)

Full-system audit of the operator's broken-feature list. Every claim
was root-caused with live evidence before fixing. Summary; details in
each commit body:

- CAPTURE PIPELINE DEAD 65 DAYS (auto-lint, daily brief, wiki,
  reinforcement all starved): chokidar v4 dropped glob support and
  transcript-watcher passed a glob string, watching nothing since
  2026-05-11. Fixed (root-dir watch + filter, Fix 34b pattern), plus
  offset-aware boot catch-up for the backlog and a 30-min staleness
  self-check. 2199c96.
- HOOK STDIN NEVER PIPED (curator loop dead at stage zero, all hook
  payloads empty): every phase except SessionStart wrapped in
  wscript.exe silent-runner.vbs which drops stdin. install-hooks now
  wraps every phase in silent-shim.exe; APPLIED 2026-07-15 (settings
  .json rewritten with backup, 33 shim entries, zero VBS). New CC
  sessions get real payloads. Also: curator_signal ledger wired,
  opt-in DEVNEURAL_CURATOR_VET judge gate (default off). a8e6cfe.
- CONTROL PATHS PTY-ONLY: panic/double-ESC and /lex/steer could not
  reach bridge-attached workers (live pty_not_found proof); the four
  operator inject routes lacked the Fix 15a stale-uuid redirect + Fix
  18 deliverability gate; rejected_scope 403s were invisible AND the
  audit-table CHECK constraint was silently swallowing those rows.
  All fixed; migrations 046-048. f2fc8fb.
- SMART-CLEAR HAD NO DRIVER (primitives live since 2026-07-09, zero
  fires): Lex's prompt never mentioned the loop. New scoped-only
  Supervision drive contract (continuous duty, proactive report-back,
  full state->plan->vet->stop->clear-and-paste->confirm loop, stopping
  point rules) + smart-clear/compact endpoints in API_SURFACE; the
  from_anchor_id mandate is now scoped-only (unscoped Lex is no longer
  told to send an anchor id the daemon 403s). 669961f.
- WORKER EVENTS DROPPED SILENTLY 26 DAYS (no live lex_session,
  no-target discard, misleading routed=N log): no-target now emits a
  debounced operator notification, the log line reports real outcome
  counts, bridge-presence lookups are case-insensitive. 5f3fdcf. DB
  repaired live (backups first): 3 drive-letter-case anchor splits
  merged (DevNeural event toggle was on a dead duplicate), live
  DevNeural anchor set supervision_mode=event, runtime_config
  default_supervision_mode=event, 27 projects seeded into the
  registry (was 1; LOC tile now has data).
- DASHBOARD: dev-proxy missing stats/lex/admin/pty prefixes + JSON
  fetches to /sessions,/projects,/reminders losing to page routes
  (beforeFiles JSON-gated rewrites added; WS paths preserved); three
  KPI cards used nonexistent Tailwind tokens (the different-outline
  complaint) -> shared ui/Card; projects()/reminders errors no longer
  masked as empty states; stub metrics labeled honestly; stale-brief
  badge. 147c99f. Health pill shows unreachable on query error;
  restart waiting UI persists across refresh, polls 15 min with
  honest copy; /settings links to /system. eea7597.
- RESTART RELAUNCHER silently failed ~47% (no error handler +
  job-object kill of the detached child; recovery waited for the
  5-min scheduled-task tick = the operator's 10-minute blank).
  Relaunch now schtasks /run DevNeural-Daemon with logged powershell
  fallback. Start Claude is no longer fire-and-forget: bridge writes
  .result.json, daemon polls and reports delivery
  confirmed/failed/unconfirmed + bridge_offline warning (bridge needs
  VSIX rebuild+reinstall to ship its half). POST
  /projects/scan-and-register added. 1a565aa.
- VOICE: fast/slow lanes get a local-time context block (daypart-
  aware greetings, mismatch correction); greetings answer on the fast
  lane even digest-cold; digest seeds at session bind (warm right
  after switch); filler pool rewritten natural. 0578fab. Mic sliders
  actually work now: vad-web 0.0.30 ms-based option keys (legacy
  frame keys were silently dropped), live setOptions on drag, and one
  shared GainNode stream feeds BOTH VAD triggering and transcription
  (gain finally tames pickup). 8e7e03d.
- MEETING NOTES MODE made real: notes mode sets kind='meeting' via a
  default-on toggle in the hello (consent gate, purge, /meetings UI,
  meeting retrieval weight now engage); name-gated replies (non-
  addressed utterances captured to brainstorm_chunks, only
  "lex + question/request" forwarded); MeetingDetail transcript view
  + attendees/topic editing (PATCH /meetings/:id); README privacy
  claim scoped honestly. 4105eae.
- OBSERVABILITY: daemon.log rotation (32MB, one generation),
  grooming-watch tick logging (+ unguarded-throw fix),
  bridge-presence hourly heartbeat. b656ead.
- TTS double-talk: VERIFIED solved (layered guards traced); mouth
  lock is flag-conditional but unconditional layers cover it.

### Pending the operator (2026-07-15)

- Daemon restart to go live on the new build (relauncher fix, dual
  transport, capture revival + catch-up, meeting notes, scan route).
  The restart button itself is fixed IN this build, so use the
  scheduled task or start-daemon.ps1 for THIS one restart.
- Dashboard prod: cd 08-dashboard && npm run build (for the static
  export daemon serves; dev :3000 already reflects source).
- 09-bridge: npm run build && npm run package, reinstall VSIX
  (delivery confirmation + result files).
- tailscale serve: remove/document the undocumented :10000 -> dev
  :3000 rule (dev/prod confusion source). tailscale serve status to
  list; the :443 -> 3747 rule is the documented one.
- ZsgAreaBlock still points at dev-template's git remote (identity
  collision, registry holds one entry for both). Fix its remote or
  accept shared identity. OPS + transcribe are not git repos (no LOC
  contribution possible).
- Rotate BRIDGER_ANTHROPIC_API (hit a terminal 2026-07-09; still in
  use as voice key).
- Optional flags: DEVNEURAL_CURATOR_VET=1 (pre-inject judge),
  DEVNEURAL_VOICE_HAIKU already self-enables with key.

### Deferred (flagged, not built this pass)

- expectation-supervisor is dead by construction (recordExpectation
  has zero callers; table empty forever). Needs a dispatcher design.
- Diarization: wire C:/dev/Projects/transcribe/diarize.py (whisperx +
  pyannote, working on this GPU) as a post-session batch against the
  consented meeting WAV; merge speaker labels into chunks.
- LightRAG/RAG-Anything: recommended hybrid - daemon stays the single
  ingest front door (POST /upload, /ingest, /lex/index-docs),
  optional LightRAG fan-out backend later; Remarkable-Pro posts
  transcriptions to the daemon when its /ingest seam ships.
- Explicit worker accept/decline signal for curator injections
  (today: inference via reply-cosine + correction regex).
- Wiki SQL/disk desync (167 rows vs 179 files, test-fixture pages in
  prod data root) - rebuild-index pass once capture is confirmed
  flowing again.
- console.log black hole: stdout/stderr redirect files are 0 bytes;
  lex-voice-ws.ts + pty-host.ts diagnostics invisible. Migrate to the
  injected logger.
- projects-routes.ts openProjectAnchor still uses its own DB-status
  poll, not the new .result.json delivery signal.

### 2026-07-09 fix: Lex voice silent - CLAUDE_CODE_CHILD_SESSION leak

Symptom: talking to Lex, he either hung "thinking" with no reply, or
replied only as on-screen text with no voice. Root cause (not a
DevNeural regression - an inherited-env bug): the daemon had been
restarted from inside a Claude Code session, so
`CLAUDE_CODE_CHILD_SESSION=1` sat in the daemon's process.env.
`spawnLex` passed the full env through to every Lex PTY (pty-host.ts
old line 391, `{...process.env, ...opts.env}`). A claude that sees
that flag runs in child-session mode: it writes NO transcript jsonl
under `~/.claude/projects/<slug>/<uuid>.jsonl` and NO
`~/.claude/sessions/<pid>.json` pidfile. The voice + terminal-mirror
pipeline tails that jsonl for assistant turns, so a child-session Lex
was invisible: it thought and replied inside its own PTY, but the
watcher never saw the turn - no assistant-text event, no Piper TTS,
injects looked ignored. Broke ~00:17 Jul 9 when the last long-lived
sessions (created before the poison entered the daemon env) were
killed by a restart; every fresh spawn after that inherited the flag.

Proof chain: daemon Lex sessions (cc=4735ac31, ddd60b75) had no jsonl
on disk and no pidfile; direct PTY repro showed claude replies but
writes nothing while the flag is set; stripping
`CLAUDE_CODE_CHILD_SESSION` alone restored both the transcript and the
pidfile. Not version- or wrapper-specific (2.1.197 and 2.1.205, cmd
wrapper and direct exe, all reproduce; `--print` is unaffected).

Fix: `sanitizeClaudeSpawnEnv` in `07-daemon/src/dashboard/pty-host.ts`
strips the parent's child-session identity markers
(`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_TRANSCRIPT_PATH`) from the env AFTER merging opts.env, so Lex
always spawns as a top-level session regardless of how the daemon was
launched. Regression test `tests/spawn-env-child-session.test.ts`
(5 cases). Built + operator-directed daemon restart applied and
verified LIVE 2026-07-09: fresh Lex spawn now writes its transcript
jsonl and pidfile; old broken PTYs died with the old daemon. NOT yet
git-committed (source edited + dist rebuilt on disk). Rebuild: yes.

Note: an env dump during diagnosis surfaced `BRIDGER_ANTHROPIC_API`
(a real Anthropic key) to the terminal. It is now intentionally used as
the voice-haiku key (see next entry); still worth rotating since it hit
a terminal, but it is no longer just a leak.

### 2026-07-09 batch: voice smartness + switch + cold-start + replay

Four operator-reported issues, all fixed + LIVE (daemon restarted, boot
log confirms `[voice-haiku] enabled=true api_key=present flag=1`). New
tests across the batch; full suite green apart from the one pre-existing
grooming-watch failure.

- Smart replies (was: flat "on it" / "let me look"). Two causes:
  (1) no ANTHROPIC_API_KEY, so glue + spoken render fell back to canned
  lines; (2) the slow-lane bridge was never wired to a live model.
  Fixes: `voiceApiKey()` (voice-haiku.ts) reads ANTHROPIC_API_KEY OR
  `BRIDGER_ANTHROPIC_API` (a persistent User env var the daemon inherits
  on ANY launch path - the flag/key kept coming up absent because recent
  restarts were manual `node dist/daemon.js` that skip start-daemon.ps1's
  env block); `enableVoiceHaikuIfKeyPresent()` self-enables the lane at
  daemon boot when a key is present (useVoiceHaiku() stays a strict '1'
  gate for testability). Slow-lane bridge is now `composeBridgeReply` /
  `generateBridgeReply` - a live, request-specific line ("let me pull up
  the academy status") fired async so Lex's inject is not delayed, with a
  fail-fast fallback to the deterministic `pickBridgeLine`. Billing: the
  key is read as BRIDGER_ANTHROPIC_API (claude ignores it) and spawnLex
  strips ANTHROPIC_API_KEY (SPAWN_STRIP_ENV), so Lex stays on Claude Max.
  A `[voice-haiku]` boot log line makes flat-voice a one-line check.
- Session switch didn't move the voice controls. `VoiceClient.tsx` bound
  to the newest-started brainstorm PTY (stale "one Lex at a time"
  assumption); with worker-scoped brainstorms several are live at once.
  Now mirrors app/lex/page.tsx: the `?brainstorm=` selection's
  current_pty_id wins, newest-started only as the un-parameterised
  fallback. Needs the DASHBOARD build (done) + daemon restart to serve.
- Cold-start preload polluted. The recent-thread tail was flooded with
  `[silent supervision tick]` prompts + empty "." acks. `isNoiseTurn`
  (jsonl-transcript-reader.ts) filters both, so the seed reflects the
  real thread. Empty prior-session summaries were a side effect of the
  child-session persistence bug (fixed above).
- Replay-on-switch (item 2, operator "do what makes sense"). On binding
  to a session, `maybeReplayLastTurnOnBind` speaks its last assistant
  reply ONCE if recent (`readLastAssistantTurn` + REPLAY_WINDOW_MS,
  default 8 min; DEVNEURAL_VOICE_REPLAY_ON_SWITCH=0 disables). No
  double-speak: the live watcher's offset is EOF at bind. notes mode
  stays silent.

Not committed to git (source edited + dist + dashboard rebuilt on disk,
all live). Rebuild: yes.

### 2026-07-09 session: worker-scoped brainstorms + switch + binding

- Worker scope, fully wired, no flags: every Lex brainstorm anchor
  supervises at most one project anchor and sees/controls ONLY that
  worker. `resolveLexScope`/`buildVoiceSnapshot(scope)` (per-turn),
  `buildLexSystemPromptVersioned(scope)` + "# Worker scope" contract
  (spawn + reopen + compaction restart), `checkLexScope` enforcement
  on inject/steer/prompt/suggest routes (`from_anchor_id`,
  decision=rejected_scope, 403), scoped `GET
  /lex/snapshot?brainstorm_id=`. Live-verified: MHA anchor's snapshot
  shows only Material-Handling-Academy; cross-scope steer 403s.
- Deterministic session binding: spawn-lex-session passes the
  pre-minted `--session-id` into spawnLex which stamps the handle at
  spawn; shared-cwd jsonl discovery replaced by `pickDiscoveryJsonl`
  (creation-time based + claimed-set; Windows ctime=last-write was
  cross-binding sibling brainstorms). Live-verified with two
  concurrent spawns.
- Dashboard switch: /lex honors `?brainstorm=<anchor id>` (page PTY
  resolution, voice hello, inject target); switch/open/new/end all
  maintain the param; a selected anchor without a live PTY renders
  offline instead of silently mirroring another session.
- Data repair (backed up first): two cross-bound rows repointed,
  19 mis-attributed chunks moved home, 82 unnamed brainstorm sessions
  deleted, labels mirrored from lex_session titles.
- Gates unflipped per operator directive: smart_clear_mode=live
  (runtime config), DEVNEURAL_INVESTIGATOR_HEADLESS=1 in
  start-daemon.ps1. smart-compact + auto-advance were already live.
- Knowledge-index store-set auto-resolver SHIPPED
  (`lex/doc-store-resolver.ts`): /lex/index-docs + /lex/watch-docs
  resolve root/memory/docs/spec/bugs from the anchor cwd when stores
  are omitted. Live-verified: DevNeural indexed 120 files / 2036
  chunks across all five stores; watcher running.
- Deliberately NOT flipped (operator decisions): DEVNEURAL_CURATOR_LLM
  (inline qwen3 polish would exceed the hook's 1500ms budget on every
  prompt; needs an offline-polish design), DEVNEURAL_HEARTBEAT_URL
  (needs an external watcher endpoint provisioned),
  DEVNEURAL_PASS2_FALLBACK=anthropic + voice live-haiku
  (ANTHROPIC_API_KEY not set anywhere; cost/privacy call).

## HARD constraint

Do NOT restart the daemon (it kills the supervising Lex session)
unless the operator has directed it in the active conversation. The
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

## Lex decisions on the three open calls (2026-07-15, 1:10 PM Eastern)

Injected answer bounced (bridge owns no terminal for this session; the
worker runs in the VS Code Claude panel, so bridge/PTY transports cannot
reach it). Parking the decisions here instead.

1. Daemon restart: operator-only, stays pending. Do not restart.
2. LightRAG/RAG-Anything: NO-GO for now. New external dependency is the
   user's call. Do not install anything until he says go.
3. Expectation supersede policy: DECIDED, and it is your next work item.
   Implement: a new instruction injected to a worker supersedes that
   worker's prior OPEN expectation. Mark the old row status=superseded
   with superseded_by=<new expectation id> and a timestamp; never delete
   rows (audit trail stays). Add a test covering supersede-on-new-
   instruction; keep existing dispatcher tests green. Commit with a
   Rebuild line.
