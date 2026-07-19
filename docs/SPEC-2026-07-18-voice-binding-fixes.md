# Spec: three voice / supervision fixes (2026-07-18)

Authored by Lex from two read-only investigator passes. Implement tests-first, commit each fix separately with a FIXES row + `Rebuild:` line. Do NOT restart the daemon (kills the live Lex session). Michael rebuilds + restarts when ready; none of these go live before that.

---

## Fix 1 — deep-layer TTS truncation (deep replies cut off at first sentence)

**Symptom:** mid/deep-layer voice replies are spoken only up to the first period; top-layer replies speak in full. User has to read the rest.

**Cause (investigator, cited) — it is NOT the feed.** Every sentence is enqueued and shipped. The truncation only manifests on a *phantom barge*: the daemon word-gate fires on Lex's OWN spoken sentence-1 because the echo filter fails to recognize it as Lex's own audio (`lex-voice-ws.ts:4916` / `:4871`), triggering `killActiveTts` (`:3333`). The asymmetry that turns that into "first sentence only":
- TOP layer speaks the whole reply as ONE unsplit `speak()` segment (`lex-voice-ws.ts:4387`, `:4439`, `:4459`) → captured whole as `interruptedSegment`, resumes in full.
- MID/DEEP layer splits into N per-sentence segments (`:2893`, `:2896-2900`, `splitForSpeech` → one `speak(s,{continuation:true})` each). Because synth serializes on piper pcm `end` (Fix 51, synth speed, not playback speed), all N segments ship to the client ahead of realtime playback. By barge time `state.ttsQueue` is already drained, so the barge stash (`:3341-3342`, reads the SERVER queue) captures at most the one in-flight segment. `resumeBargedSpeech` (`:3293`, `_resumeBargedSpeechImpl` `:1596-1621`) restores only sentence 1. Sentences 2..N are gone.

**Fix (recommended):** on phantom-barge resume, re-speak the UN-played remainder of the full original body (which `speakViaBrain` still holds in `text`) from the client's reported `played_ms` offset (client already emits `played_ms` on `playback-stopped`, `VoiceClient.tsx:1192`), instead of resuming only the drained server `ttsQueue` snapshot at `:3341-3342`. Keeps the sentence-split latency benefit and never loses the tail.

**Also:** verify WHY the phantom barge still fires despite the shipped echo-kill work — the trigger is the echo filter not recognizing Lex's re-delivered sentence-1 as own audio. Fix the tail-loss regardless (robust defense), and check the echo/self-barge trigger.

**Stale doc:** `docs/bugs/2026-06-22-mid-reply-tts-truncation.md` blames a live-haiku `max_tokens:512` cap; that path was removed in the 2026-07-15 spec-v2 rework. Update that doc with the real cause (append, do not multiply).

---

## Fix 1b — VB-1 REOPENED: deep replies killing each other (TOP PRIORITY)

VB-1 (barge-resume) shipped but is INSUFFICIENT. User evidence contradicts the phantom-barge-only theory:
1. The deep reply still cuts off at the first sentence even when he MUTES after finishing speaking — NO barge, NO self-echo involved.
2. When the deep layer emits multiple reply records/utterances in one turn, only ONE is spoken aloud ("four deep replies, you'll only say one of them").

**Hard requirement (user, verbatim intent):** EVERY reply that reaches the voice layer must be spoken IN FULL, in sequence, unless the USER actually interrupts (real barge / stop / mute).

**Concrete lead:** `killActiveTts(reason: 'utterance-start' | 'barge-in')` at `07-daemon/src/voice/lex-voice-ws.ts:3427`. Investigate whether a NEW utterance (`'utterance-start'`) kills the currently-playing deep-reply TTS, so successive deep replies/segments cancel each other and only one survives. Also check whether the mute/finalize path fires a `tts-cancel` that drops the tail. VB-1 only restored a tail AFTER a cancel; the real defect is replies being killed / not queued in the first place.

**Fix:** multiple deep-reply utterances must QUEUE and play fully in order; only a genuine user interrupt cancels. **Verify against BOTH:** (a) the mute-after-finish case, and (b) a multi-reply turn where every reply plays start to finish. Do this BEFORE the bell fix.

## Fix 2 — fresh-worker supervision gap (shows "unsupervised / not nested")

**Symptom:** a freshly dashboard-launched worker shows unsupervised and does not nest under its brainstorm; inject auto-target fails.

**Cause (investigator, cited) — consumers are already canonical, this is a data-population timing gap.** All worker-for-anchor resolvers (anchor-tiles, Stream Deck slug nesting, inject auto-target, supervisor label) already walk `supervises_project_anchor_id` → project anchor → `current_session_id`/`project_slug`. The `session.lex_anchor_id` field is a `brainstorm_sessions.claude_session_id` self-join, null by design for workers, NOT the binding — do not touch it. The real gap: `bridge-presence.ts:306-310` reconcile leaves `current_session_id` at its prior value (null for a fresh anchor) when the bridge has not yet reported a cc id (`ccSessionIds.length===0`). Until backfill: live-filtered `/projects/anchor-tiles` tile is absent, inject auto-target returns `422 bound-project-dormant` (`routes.ts:7192-7198`), supervisor label renders empty `worker=`.

**Fix:** ensure `current_session_id` backfills promptly when a live worker exists — e.g. re-run reconcile when the bridge reports the cc id, or resolve it from the most-recent live cc jsonl for the bound project when `ccSessionIds` is empty but a session is active. Verify: a fresh worker nests and inject auto-targets without the 422 window.

**Also flag (latent, separate):** `resolveLexTargetSession` global-Lex fallback (`worker-event-router.ts:288-293`) can mis-route a worker event to the wrong Lex when no Lex is bound. Reverse direction, does not cause the "unsupervised" symptom. Flag it; fix only if cheap.

---

## Fix 3 — false "voice error" on timeout

**Symptom:** a "voice error" banner fires even though every message actually lands. Still actively firing ("still killing me").

**RE-VERIFY the cause against current code before touching it — no speculative fix.** Prior read (last night's live daemon log): the voice WS cycles once per turn and the delivery-verify declares an inject "failed" purely on a timeout despite successful delivery; also fires when the deep layer thinks for a long time.

**Fix intent:** a timeout without a genuinely faulted required subsystem must NOT surface as an error. Reclassify: only a real subsystem fault raises the error banner.

---

## Process
- Tests first for each fix.
- Commit each fix separately; FIXES tracker row per commit; end each commit body with `Rebuild: yes/no <reason>`.
- Do NOT restart the daemon.
- Report back when all three are committed against git HEAD.
