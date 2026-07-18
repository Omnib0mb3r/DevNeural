# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

## Cursor (2026-07-18 ~15:20Z, VOICE CAPTURE FIXED + LIVE-VERIFIED; TTS stall is the new open item)

**RESOLVED:** the wave client's stuck-open recovery raced FrameProcessor
redemption and discarded every utterance (full mechanism + arithmetic
in FIXES.md SM-24). Fix shipped (recovery window now redemptionMs +
1500 margin) plus: MicVAD back on its own mic grant, server prefs
healed (gain 1.0 / sensitivity 0.5 / redemption 1400), ORT assets
cache-busted. **Live verify 15:14:32Z: `transcript received words=8`
on the current client - capture works with ALL wave features intact
(3-layer transcript, word-gate barge, dedup, warm gate).**

**NEW OPEN (next session, needs operator restart authorization for any
daemon change):** status stuck on "speaking" after the reply - client
got tts-start then ZERO PCM frames 30s+ (frame_timeout heal_failed
15:16Z rows), and NO `top-layer turn` line followed the 15:14:32
transcript in daemon.log. Reply/synth pipeline stalled server-side;
box is heavily loaded (llama-server 10GB, whisper, multiple claude
sessions; sw.js served in 6s). Start with: does the top-layer ask
hang, or does piper synth stall? Daemon logs neither per-synth
timing nor tts-start emission - add that visibility first.

**Cleanup owed:** capture probe + vad-err mirroring in VoiceClient.tsx
(self-terminating, harmless, but remove once the TTS stall is fixed);
voice_health "probe" rows can be pruned.

The investigation record below (evidence chain, deltas, A/B) is kept
for context.

## Investigation record (2026-07-18 afternoon, superseded by the fix above)

**The wave client (07-14..07-18, b5cbf69..e1ff047) broke voice capture.
Proven by A/B, not conjecture.** Read this section before touching
anything voice.

### Symptom + timeline (all times Z)

- Since ~13:00 the operator talks and NOTHING lands: no transcript
  anywhere, no injection, no reply. Typed input works (it rides HTTP
  inject, not the voice WS). Replies show in the terminal mirror but
  NOT the transcript box (assistant turns reach the box only via the
  voice WS; typed-only usage has no reply channel - open defect).
- 04:55 voice WORKED in the same room/mic/browser: that tab was
  running the PRE-WAVE bundle out of the service-worker cache. The
  operator's PWA hard reset later pulled the new wave bundle; broken
  ever since. This is why "it worked this morning".

### Evidence chain (each step has artifacts)

1. daemon.log: voice WS sessions connect fine all afternoon; ZERO
   `transcript received` / `dropped whisper utterance` lines. The
   daemon never received utterance-end. Whisper healthy (prewarm 200).
2. Server-pushed voice prefs were a live mute: `mic_gain 0.4` +
   `vad_sensitivity 0.1` in voice-preferences.json, re-pushed to every
   client on connect (survives every reload/hard reset). HEALED via
   the daemon's own routes to gain=1.0, sensitivity=0.5, and
   vad_redemption_ms 2500 -> 1400. Healing alone did NOT fix capture.
3. Capture probe (added to the client, reports to the voice_health
   table as "cp:" rows, read via `GET /dashboard/voice-health`):
   capture ctx running, worklet ~125fps, silero fed at the legacy
   96ms cadence, `m=1.00` (silero heard speech at full probability),
   `ss` fires (speech start) but **`se=0` always** - the utterance
   NEVER closes, so audio never ships. That is the capture bug's
   signature. Probe run at 14:16 was pre-heal (rd=2500); the rd=1400
   retest with the CURRENT client has NOT happened yet.
4. Later Chrome attempts hit the ORT init cascade `no available
   backend found. ERR: [wasm] RangeError` in a 1/s retry loop
   (vad-err rows in voice_health). Fresh Edge/incognito/Safari also
   fail (silently or with a different error) -> NOT browser state.
   Server-side ort wasm verified intact (13,022,405 bytes, magic OK).
   Suspected truncated 13MB wasm fetches: the daemon is serving
   assets at 2-6s each under load (sw.js took 6.2s; whisper-prewarm
   2s -> 13s; box carries llama-server 10GB etc.).
5. **A/B proof:** pre-wave client files (5896402: VoiceClient.tsx +
   voice libs) built and served against the CURRENT daemon -> Lex
   replied to speech. Daemon/whisper/inject/TTS exonerated. The old
   bundle double-talked; operator says double-talk was ALSO solved
   pre-wave, so do not assume the wave's SM-12 dedup was the only
   owner of that fix - verify before re-shipping any of it.

### Key capture-chain deltas old -> new (the compare)

- 8e7e03d (R3): MicVAD no longer opens its own mic; it gets a
  synthetic GainNode -> MediaStreamAudioDestinationNode stream. The
  se=0 behavior appeared with this feed in place.
- ms-based VAD option keys are LIVE in the wave client. The old
  client's frame-count keys were silently dropped by vad-web, so the
  old build actually ran vad-web's 1400ms default redemption and
  never applied the operator's slider values. The wave made stale
  slider state real (the "placebo became live mute" class, again).
- utterance-start -> vad-onset + asr word-gate protocol: daemon
  supports BOTH (legacy case retained); not the break.
- Engine-cut playback + voice-brain warm gate: playback-side, not
  capture; the warm gate only affects the status label, initVad runs
  on hello-ack regardless.

### Deployed state RIGHT NOW

- Working tree (UNCOMMITTED): current-HEAD client PLUS (a) capture
  probe + speech-start/end counters + trailing-avg prob `la`, (b)
  vad-err mirroring to voice_health, (c) ORT asset cache-bust
  (`?v=st1` explicit wasmPaths map in lib/voice-ort-config.ts), (d)
  voice-watchdog "probe" status. Built + shipped, sw stamp
  2026-07-18T14:57:33Z. tsc clean.
- Server state: voice-preferences.json = gain 1.0 / sensitivity 0.5 /
  redemption 1400 / barge_cooldown 1500. FIXES.md: new row SM-23
  (end-button hang + distill ordering, queued).
- Daemon: operator-restarted ~13:47; NOT rebuilt this session (no
  daemon source changes).

### Next test (FIRST thing next session)

Operator: hard reset -> start voice -> speak one phrase -> 2s pause.
Then read `GET /dashboard/voice-health?limit=10`:

- `se>0` + `transcript received` in daemon.log -> the 2500ms
  redemption was the killer; keep 1400, delete the probes, ship, done.
- `ss>0, se=0` and `la` HIGH (>0.4) during silence -> silero "hears
  speech" in silence through the synthetic feed (AGC on the raw
  grant + gain graph are the suspects). Fix the feed: try dropping
  autoGainControl on the capture getUserMedia, or feed VAD the raw
  stream (pre-wave behavior) while keeping the gain node for the
  transcription buffer only.
- `vad-err ... RangeError` again -> asset integrity under load;
  confirm a full-200 wasm fetch in daemon.log http lines (the
  ?v=st1 URLs force it), and look at daemon serving latency.

### Open defects surfaced by this investigation

1. Transcript box has NO reply channel without the voice WS
   (typed-only usage shows the question, never the answer).
2. Silent-off: voice can be off/broken while the operator talks, with
   zero unmissable feedback; every teardown is silent. The probe
   infrastructure (voice_health rows) is the seed of the fix.
3. Daemon asset serving degrades badly under load (6s for a 4KB
   file); event-loop or box-load issue, deserves its own pass.
4. handleUtteranceEnd's empty-micBuf and STT-error paths send client
   frames but log NOTHING server-side - two silent failure modes.
5. SM-23 (FIXES.md): end-button hang; end-session hook + distill
   chain verification; restart-before-distill ordering + UI wait
   indication.

## Previous cursor (2026-07-18 overnight, voice Phase 2 + layer config - DEPLOYED)

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
