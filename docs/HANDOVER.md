# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

## Cursor (2026-07-17, voice engine replacement wave)

- **HEAD:** 0485e13 on master (VE-6 warmup re-probe + VE-7 lazy-spawn
  hygiene), tree clean after the docs commit.
- **PROD:** daemon pid 135480 booted 13:22:38Z - NOT via
  start-daemon.ps1 but via a hook lazy-spawn that won the restart race
  (VE-7): it runs with cwd=REPO ROOT and a leaked live-session env,
  and it predates VE-6/VE-7, so the swallowed-probe warmup bug is
  still live in it. It DOES run the voice-engine wave code (dist was
  rebuilt 02:39). Next operator restart via the task/script picks up
  0485e13 dist (rebuilt 13:49) AND clears the wrong cwd/env.
- **13:25Z incident (the operator's "spoke to Lex, nothing happened"):**
  first voice spawn after the restart storm; claude booted slower than
  the 3s probe delay, the probe text was swallowed pre-paint, bare-CR
  nudges no-opped 4.5min, warmup killed the session. Full chain +
  ConPTY repro evidence in FIXES.md VE-6/VE-7.
- **Audit notes:** Smart Turn v3 has been integrated since 07-15
  (model on disk, live holds in tonight's log); deck worker nesting
  live since 4779d7b. VE-5 closed the one real endpointing gap: held
  fragments now ship at the 3s governor ceiling instead of starving.
- **On restart the engine goes live:** word-gated barge (words
  interrupt, noise never), media-element playback (AEC finally sees
  the TTS), fuzzy echo discard, drain-window fix, deterministic
  stop-class mid-turn interrupts, played-ms context truncation,
  delivery dedupe, quiet bell (telemetry reclassed, idle_prompt
  debounced), cross-session delivery confirmation.
- **Operator verification after restart:** FIXES.md VE-table lists the
  six live metrics; the barge cooldown + pause sliders are now inert
  by design (engine self-manages; panels untouched per spec).

## Tonight's work (newest first)

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
