# DevNeural Smoke Test Checklist

Live punch list of things shipped in code but not yet verified end-to-end on real hardware / real users / real PWAs. Refresh as items get verified or new code lands.

Last updated: 2026-05-13.

## In flight

- [ ] **VAD stuck-open fix**. Two-part patch: (1) rolling Silero probability floor, average over last ~1.5s, if <0.4 while open force end-of-utterance; (2) post-Whisper sanity drop, discard empty / `[BLANK_AUDIO]` / <2-word utterances. Knobs in `08-dashboard/components/VoiceClient.tsx` (VAD_SENSITIVITY, VAD_REDEMPTION_MS). Must not penalize long real utterances. Land as one atomic commit so it can be reverted cleanly.
- [ ] **Lex cold-start context preload**. Gap analysis vs `07-daemon/src/lex/sibling-distillation-preload.ts` in progress. After diff lands, verify next brainstorm cold-start gets: sibling index + last-2-sibling distillations + recent turns appended, in that order.

## Queued

- [ ] **Smart-compact shadow-mode flip**. Flip `DEVNEURAL_SMART_COMPACT_ENABLED` to shadow (log decisions, do not fire). Watch decision log for false positives.
- [ ] **Smart-compact UI selector switch**. `/system` page currently has audit panel + pause toggle but no enable switch. Add selector after shadow-mode lands.

## Verification opens from already-shipped code

- [ ] **iOS PWA push end-to-end**. Code complete (reminder-push.ts + daemon.ts call site + tests). Confirm a real iOS PWA actually receives the push: subscribe button on dashboard, fire a test reminder, watch device buzz.
- [ ] **Brainstorm threading Phase 1 sibling index**. Cca1353. Confirm sibling index actually surfaces on next brainstorm cold-start when ≥2 sessions share a `user_label`.
- [ ] **Brainstorm threading Phase 2 preload + backfill**. 0a32429 (preloader) + 32d711c (backfill, N=5 cap). Confirm cold-start gets last-2 sibling distillations + recent turns appended after the index. Note: backfill scheduler module is pure with injected generator + clock; no LLM provider wired in yet, so backfill stays inert until that's connected.
- [ ] **Anchor-binding regression fix**. 0119710 (daemon) + 0e1d496 (bridge). VSIX rebuilt and installed. Confirm anchor surfaces in `/lex/voice-snapshot` on first cron tick after a populated bridge-presence dir appears (one VS Code window reload).
- [ ] **PANIC-BUTTON**. c3a6b6f + 27b6e2b + b4e098f. Single-target resolver, Ctrl+Alt+. keybind, audit panel. Smoke deferred until a throwaway coding session is live (user nervous to press on real work).
- [ ] **Lex voice-command suite (2026-05-14)**. Every command requires the `Lex` prefix. Five commands to verify on real hardware:
  - `Lex disable` — voice pill flips off equivalent to clicking stop. In-flight TTS cuts. Lex thinking continues (watch transcript still fill). No voice resume; click `start voice` to come back.
  - `Lex mute` (and `Lex shut up`, `Lex be quiet`, `Lex stop talking`) — TTS halts mid-sentence. Pill switches to `muted (voice)` with attn tone. Future assistant turns keep arriving with silent marker. Badge counter on pill increments per silent message.
  - `Lex unmute` — TTS resumes on the NEXT reply; messages received during mute are NOT auto-replayed. Badge clears to 0. Pill returns to live status.
  - `Lex emergency stop` — fires panic, audit row shows `caller='lex-voice'` with `result='accepted'` on a live anchor. Bare `emergency stop` should NOT fire.
  - `Lex end session` — routes through end-session pipeline (ingest + summary + RAG embed), then WS tears down. Bare `end session` / `stop voice` / `goodbye lex` should NOT fire (those legacy patterns were retired with the Lex-prefix lock).

## Deferred (won't smoke yet)

- [ ] **PANIC-BUTTON live press** on a throwaway session, not real work.
- [ ] **Auto-discover projects** under `C:/dev/Projects` filtered by project-marker files. Not built; smoke when shipped.
- [ ] **Event-driven supervision router**. Not built. Smoke when shipped: confirm debouncer dedups by tail signature, kill-switch trips at >20 events / 10min, dashboard supervision_mode toggle (polling / event / off) actually flips state.

## Stop conditions

Item moves out of this doc when verified on real hardware and noted in HOW-TOs or HANDOVER. Item moves to deferred only if blocking conditions (real iOS device, real third-party session, throwaway worker) aren't present.
