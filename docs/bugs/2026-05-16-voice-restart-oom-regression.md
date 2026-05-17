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
