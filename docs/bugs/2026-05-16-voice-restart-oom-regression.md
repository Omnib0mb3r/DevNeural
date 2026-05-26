# Voice mic init OOM regression after disable+restart

**Date observed:** 2026-05-16 (~21:13 EDT)
**Severity:** medium (blocks voice session resumption after Lex disable)
**Suspect commit:** 393d4f5 (COOP/COEP unlock + singleton VAD/ORT init) — incomplete coverage of the disable+restart path
**Related:** docs/POSTMORTEM-2026-05-17-voice-tts-stale-shell.md, smoke 5 in project_active_smoke_test_2026-05-14.md

## Symptom

User had a healthy voice session. Lex (brainstorm side) fired POST `/voice/stop` as a smoke test against commit 0fe27f1. Endpoint delivered `voice-disable` to one client (the user). Panel flipped off as expected. User then clicked Retry to restart voice. Init failed with:

> mic init failed: no available backend found. ERR: [wasm] RangeError: Out of memory, [cpu] Error: previous call to 'initWasm()' failed.

Screenshot: `C:/dev/data/skill-connections/uploads/screenshots/6e1e7725-332d-4caa-aa56-e115e17fcc00.jpeg`.

## Expected

Commit 393d4f5 introduced a singleton `getVadModule()` import + COOP/COEP isolation so the second VAD remount reuses the configured ORT instance instead of re-running pin + re-instantiating WASM. The hypothesis when 393d4f5 landed was that "VAD remount on tab switch" was the trigger. The disable+restart path was not explicitly smoke-tested.

## Hypothesis

1. `voice-disable` (HTTP `/voice/stop` or voice command "Lex disable") tears the visible panel but does not reset the singleton VAD/ORT pin. Retry then enters init with a half-disposed WASM heap and the second `initWasm()` blows the SharedArrayBuffer growable.
2. The singleton holds a strong ref to the previous WASM memory; disable cuts the panel but the buffer never releases. Restart allocates additional memory on top and OOMs.
3. The Retry button calls a different init path than the initial mount, and that path skips the singleton check.

## Repro

1. Open `/lex` brainstorm in voice mode (fresh shell, `crossOriginIsolated === true`).
2. Confirm voice works.
3. Fire `POST /voice/stop` (or say "Lex disable"). Panel flips off.
4. Click Retry on the voice panel.
5. Observe: `mic init failed: no available backend found. ERR: [wasm] RangeError: Out of memory`.

## Where to look

- `08-dashboard/components/VoiceClient.tsx` — Retry handler, init path on re-mount after disable.
- `08-dashboard/lib/voice/vad-module.ts` (or wherever `getVadModule()` lives) — singleton lifecycle on disable + restart.
- Browser memory profile during retry: confirm the prior WASM memory is actually freed.

## Acceptance

After firing `voice-disable` (HTTP or voice command), clicking Retry on the voice panel succeeds without OOM. Singleton VAD/ORT either reuses the prior instance or fully tears down + reallocates without exceeding SharedArrayBuffer growable cap.

## Related

Pairs with `docs/bugs/2026-05-16-voice-cmd-blocked-during-tts.md` (smoke 5). Both indicate the voice lifecycle (init, AEC, disable, restart) needs an end-to-end audit, not point fixes per symptom.

---

## 2026-05-25 recurrence (Lex brainstorm-side log)

User hit this again on mobile Safari over Tailscale at ~00:34 EDT. UI message verbatim:
"mic init failed: no available backend found. ERR: [wasm] RangeError: Out of memory, [cpu] Error: previous call to 'initWasm()' failed."

User flagged a second gap alongside the recurrence: this mic-init failure does NOT land in the voice error log surface. Invisible to operator + audit.

### Root cause confirmed via code re-audit

**Why wasm OOM:** Mobile Safari on Tailscale has no COOP/COEP, so crossOriginIsolated === false. voice-ort-config.ts line 50 correctly returns VAD_NUM_THREADS=1, but vad-web's wasm still tries threaded binding and fails SharedArrayBuffer allocation. ORT cascades to single-thread path with Silero VAD + Whisper eager-loaded into one 256MB-1GB tab heap. OOM. ORT then marks its internal state "initWasm() failed", poisoning the cpu fallback.

**Why cpu fallback fails:** voice-ort-config.ts lines 123-124 cache vadModulePromise + vadModuleConfigured as module-level singletons. On disable+restart paths that miss resetVadModuleCache(), the cached ORT env retains the failure flag. Next init lands on the dead backend.

**Why error doesn't log:** VoiceClient.tsx lines 2471-2473 and 2563-2565 only call setErrMsg() (UI toast). No logVoice("vad-error", ...) call, no postVoiceHealth() call. Ring buffer never sees it, /dashboard/voice-health endpoint never hit. /dashboard/voice-health currently only handles TTS watchdog, not mic init failures.

### Fix queued behind Stage 2 of LEX-AUTONOMY-PAYLOAD-SPEC

Three changes, smallest viable patch:

1. VoiceClient.tsx catch blocks at the mic-init paths (lines 2471-2473 and 2563-2565): call resetVadModuleCache() inside the catch BEFORE setStatus/setErrMsg, so the next Retry boots a fresh ORT env. The 2026-05-16 fix added resetVadModuleCache to the disable path; this extends it to the error path.
2. Same catch blocks: add logVoice("vad-error", err.message, undefined, "error") so the failure lands in the ring buffer and Voice diagnostics panel.
3. Follow-up (deferable): non-isolated tabs lazy-load Whisper, only Silero VAD eager at init, to fit single-thread heap budget. Tracks under "long-term" until short-term fixes prove insufficient on repeat hits.

Worker is mid-Stage-2 of LEX-AUTONOMY-PAYLOAD-SPEC. Patch lands after Stage 2 ships unless a critical voice failure forces interrupt.
