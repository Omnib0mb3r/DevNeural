# 2026-05-14 VAD path uses deprecated ScriptProcessorNode

**Status:** fixed (pending soak) in 4ae0f0a — VAD parallel-capture tap migrated to AudioWorkletNode via the new `08-dashboard/public/vad-tap.worklet.js`. Push-to-talk rig (separate code path) still uses createScriptProcessor; leave for a follow-up pass per the migration scope rule.


## Symptom
Chromium console emits repeated deprecation warning:
> [Deprecation] The ScriptProcessorNode is deprecated. Use AudioWorkletNode instead.

Visible in the dev console alongside the VAD trace lines (`VAD | initializing`, etc).

## Why it matters
Chromium has had this deprecated for several years. The warning is currently advisory but Chromium has signalled eventual removal. When ScriptProcessorNode is removed, the silero VAD path breaks entirely and voice capture stops working.

## Fix scope
Migrate the VAD audio-tap from ScriptProcessorNode to AudioWorkletNode:
1. Write a tiny worklet processor module (`vad-tap.worklet.js` or similar) that forwards PCM frames over `port.postMessage` exactly the way the current onaudioprocess callback does.
2. Load it via `audioContext.audioWorklet.addModule(...)` during the VAD `start()` path.
3. Replace the `createScriptProcessor` call with `new AudioWorkletNode(audioContext, 'vad-tap', {...})`.
4. Wire the node's `port.onmessage` to the same frame consumer the ScriptProcessor was feeding.
5. Update any cleanup/teardown to disconnect the worklet node correctly.

## Constraints
- AudioWorkletNode requires AudioContext to be unsuspended and resumed via user gesture. Already the case in this codebase (Enable Audio button gates the whole rig).
- Worklet module files must be served from same origin or with CORS — should ship as a static asset in the dashboard public dir.
- Sample rate handling: AudioWorklet runs at AudioContext rate (typically 48kHz); the current path likely already downsamples in JS. Keep that intact.

## Priority
Medium. Not blocking today, but should ship before the next browser stable that actually pulls the API. Not a quick one-shot — proper feature commit.

## Queue position
Behind: wake-word telemetry (in flight), wake-word root-cause fix (after telemetry).
