# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

## Cursor (2026-07-18, voice Phase 2 + layer config - DEPLOYED)

- **HEAD:** 3b8ef37 on master, tree clean (after this docs commit). 7
  feature commits this session (see Tonight's work).
- **PROD:** daemon bounced TWICE via `POST /admin/daemon/restart`
  (endpoint arms the DevNeural-Daemon-Restart scheduled task; both
  came back clean, ~6-24s). Final pid 34592, running the freshly-built
  dist with EVERYTHING. Client `08-dashboard/out/` rebuilt (served
  per-request by @fastify/static). Fully DEPLOYED - no pending restart.
- **The "spoke to Lex / listening but nothing happened" bug is FIXED.**
  Root cause proven in the live log: the old heavy top layer returned
  `speech=null` and the turn was DROPPED (`top-layer turn speech=null
  forward=null control=none`). Phase 2 fixes it two ways: R1 haiku top
  (fast, warms in seconds not 33s) and R4 fail-safe (a null top turn
  now FORWARDS the utterance to Lex instead of dropping).
- **Layer config (live):** L1 top = haiku headless. L2 mid = opus,
  `--permission-mode bypassPermissions` (NOT plan - headless plan mode
  STALLS on the plan-approval prompt; see FUTURE-FEATURES "L2
  mechanical confirm-gate"). L3 worker = `claude --model opus
  --dangerously-skip-permissions`. LIVE opus<->fable switch, no
  rebuild: `POST /runtime-config/{mid_model,worker_model,
  mid_permission_mode} {"value":...}` - read per-spawn
  (`src/lex/layer-model.ts`, whitelisted = injection-safe). "ultracode"
  is NOT wired: not a claude flag (zero repo hits), it's a VS Code
  terminal setting the operator manages.
- **L2-confirms-before-worker:** Lex's core prompt now requires it to
  state the plan + get the operator's go-ahead before `POST
  /lex/inject-cross-session`. Prompt-enforced; mechanical gate deferred
  to FUTURE-FEATURES.
- **Operator verification:** (1) reload the PWA (SW auto-updates) for
  the client changes - three-way transcript, warming pill, /lex worker
  mirror, touch scrollbars, home Start-Claude button; (2) reopen the
  brainstorm to get the confirm-first Lex + haiku top; (3) talk - voice
  should respond. Confirm-before-dispatch + new models take effect on
  the NEXT mid/worker spawn.
- **Pre-existing reds (NOT this session):** full daemon suite = 2 fails
  = grooming-routes (FIXES.md SM-7 baseline) + one identity-file
  test-isolation flake (passes isolated). Dashboard = 2 playwright e2e
  spec files vitest can't collect (run via `npm run e2e`).

## Tonight's work (newest first)

- **Voice Phase 2 + layer config + dashboard fixes (2026-07-18, 7
  commits 4fa678d..3b8ef37, DEPLOYED via 2 daemon bounces):**
  - `926ecd1` Phase 2 "top layer always-live + fast" (VOICE-TOP-LAYER-
    SPEC.md Phase 2): TOP session now spawns `--model haiku --tools ""
    --strict-mcp-config` (was NO --model = booted account default,
    ~33s; the root cause of dropped first turns). Client stays
    "connecting" until the top brain is warm then goes live (daemon
    `voice-brain {ready}` frame, fail-open cap, no-op when disabled).
    mid-turn-no-tts hold queue retired (`_shouldDeferForwardToMidTurn
    Boundary` always false) - operator forward routes to mid LIVE (CC
    composer buffers it); the null-top-turn fail-safe (forward the
    utterance) is locked; top stays context-thin (uses pty-host.spawnLex
    directly, never the cold-start path). "askVoice queue" read as the
    operator-holding paths, NOT the single-PTY IO serialization (kept).
  - `6fe6939` Three-way transcript: the /lex transcript labels turns by
    layer - you (operator) -> lex (voice, the top hop `to Lex: ...`) ->
    lex (deep, the mid reply). daemon tags `transcript`/`assistant-text`
    with `layer` + emits a `layer-hop` frame; client renders it. Plus
    client deploy-order fail-open (new client no longer strands on
    "connecting" against an old daemon that never sends voice-brain).
  - `e1ff047` Honest status: pill says "warming" while the backend
    boots, "ready" only when ready to WORK (was "ready" the instant the
    WS bound).
  - `a86c54c` /lex worker terminal mirror (read from the tracked
    supervises binding, no anchor-logic change) + 14px touch-grabbable
    scrollbars on the terminal viewports and the page (AppShell main).
  - `4bb1608` Per-layer model + permission modes with a LIVE opus<->
    fable switch via runtime_config (`src/lex/layer-model.ts`, 10 test
    pins incl. command-injection guard). See Cursor for the config.
  - `3b8ef37` L2 confirms alignment before dispatching to the worker
    (prompt-enforced in Lex's contract).
  - `4fa678d` Restored the Start-Claude button on home ProjectsGrid
    tiles (voice-wave cc26d96 had made them read-only); wired to the
    existing startClaude path, rendering-only.

- **Voice engine replacement wave (VE-0..VE-5, 14eaded..4dfe56b, per
  VOICE-TOP-LAYER-SPEC.md):** full replacement, not patches, 100+ new
  test pins across 5 phases. Phase 0 audit findings appended to
  voice-review.md (AudioContext playback was AEC-blind = THE echo
  source; barge death = per-segment cooldown restamps x 1500ms pref;
  during-TTS window died at synth end; stop-class rode an LLM round
  trip or queued to boundary; duplicate delivery = repaste + CR storm
  + requeue; 12 bell emitters inventoried). Then the build: five pure
  engine modules (echo filter, word-gated barge, endpoint governor,
  interrupt arbiter, delivery dedupe); media-element playback queue
  (WAV segments through one HTMLAudioElement so AEC references the
  TTS, instant cancel with real played-ms, true-drain signal); daemon
  + client wired end to end (vad-onset/asr-interim/asr-final/
  playback-drained/playback-stopped frames; words interrupt, noise
  never; stop-class finals hard-interrupt mid-turn deterministically;
  echo transcripts drop loudly; context truncates to words actually
  heard; one utterance = one delivery across every re-send path;
  VoiceClient net -36 lines, cooldown gate deleted); DRIVE-QUEUE
  riders (reinforcement telemetry off the bell, idle_prompt debounced
  10min/session, cross-session injects verify delivery on both
  transports with a followup bell on stuck paste); VE-5 held-turn
  governor flush (starved mid-thought fragments ship at the 3s hard
  ceiling through the identical pipeline). Smart Turn v3 was already
  integrated + model on disk since 07-15; deck worker nesting already
  live since 4779d7b - both audit-corrected in FIXES.md, not
  re-shipped.
- **Fifth wave (SM-19..SM-22, ecc22e4):** replay-on-switch stamps
  its own delivery so ws flap can never loop the same reply (repeat
  bug the operator heard at 01:33Z; replay-once on disconnect/switch
  preserved); headless distill timeout 60s -> 180s (env
  DEVNEURAL_DISTILL_TIMEOUT_MS) after 12+ hours of every pass dying at
  the cap logged as "empty reply" - spawnHeadlessOpus now names the
  real failure (timeout / exit code + stderr tail / empty stdout);
  cold-start preload now appends the last 10 dashboard-log turns
  (brainstorm_chunks) so voice-only conversation reaches a fresh Lex
  even when distillation lags; /help rebuilt as a full help section
  (sticky topic nav, 9 topics, 4 new plain-English guides).
- **SM-18 (d238332):** ws-close is never terminal - a socket drop runs
  the distillation flush only; the brainstorm stays alive for the
  reconnect. Terminal pipeline reserved for spoken end-session, UI
  end, compaction-restart. (The old code ended live brainstorm
  4bbafb48 twice tonight; row reopened both times, last at ~01:49Z -
  it is live now.)
- **Voice fourth wave (73508bd, 65a8dc0, 7d4222a, 1cc3701 =
  SM-15/17/14/16):** delivery verifier treats the utterance
  fingerprint as THE delivery signal (no repaste/FAILED on delivered
  words; loud TRUNCATED DELIVERY line); signal-based liveness
  everywhere (jsonl growth OR pty output within 15s = alive; timeouts
  bound silence, not reply time); 15s client keepalive ping + loud
  ws-close code/reason logging; silent TTS deaths scream (no-live-sink
  guard, TTS SYNTH FAILED / TTS STREAM ERROR in daemon.log).
- **Dashboard audit wave 2026-07-16 (6ce60f2..cc26d96, GS-1..GS-12):**
  supervision default=event everywhere (migration 051 backfilled 31
  seeded-polling anchors); selector on every anchor + small-screen
  wrap; settings cards in plain English (Worker auto-clear rename,
  history headers, effective-mode line); wiki match history with
  headers/verdicts/injected previews; periodic vector flush (dirty ->
  "saving soon"); bell counts only actionable + clear-all; home tiles
  show status not controls; brief refresh regenerates + 24h self-heal;
  deck nests workers under brainstorms; curator feed clear-all +
  destination hints; terminal mirror labeled; sessions page one merged
  table; KPI artifacts/lineage wired from wiki_drafts (migration 052
  collapsed 6,972 duplicate lint findings); drafts + meetings
  empty-states explain themselves (dead /sessions/new link fixed).
- **2026-07-16 earlier voice waves (SM-1..SM-13):** see FIXES.md; verified
  live except where the checklist says otherwise.

## Known baseline noise (NOT tonight's work)

- tests/grooming-routes.test.ts: one pre-existing failure (documented
  in FIXES.md SM-7).
- tests/sessions-anchor-liveness.test.ts: environmental flake, comes
  and goes with the operator's VS Code bridge heartbeat.
- 08-dashboard: 2 Playwright e2e spec files mis-collected by vitest
  (collection error only; 233 unit tests green).
- CuratorHealthCard "canary: not wired": honest label, probe does not
  exist yet.

## Next steps

1. Operator walks RESTART-TEST-CHECKLIST items 1-26 (dashboard wave +
   voice wave) on the live daemon.
2. Any failure: evidence is pre-wired - ws closes log code/reason,
   TTS deaths log loudly, delivery truncation logs TRUNCATED DELIVERY.
   Grep daemon.log first.
3. Phase Two remains queued behind the P2-0 adversarial review of
   FUNCTIONAL-SPEC (standing project rule).
4. Meeting flow still untested end to end (checklist item 20).

## Standing rules (unchanged)

- Daemon restart is OPERATOR-ONLY unless explicitly authorized in the
  moment. Builds are fine.
- Additive-only fixes; tests green before/after; commit bodies end
  with a Rebuild: yes/no line; FIXES.md row per fix.
- Regression-guard surfaces: terminal/PTY, bridge, cross-session
  inject.
