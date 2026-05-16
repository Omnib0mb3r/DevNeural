/**
 * Configure the ONNX Runtime Web instance that @ricky0123/vad-web
 * actually uses.
 *
 * Why this lives in its own module: vad-web bundles its own copy of
 * onnxruntime-web via `import * as ortInstance from
 * "onnxruntime-web/wasm"` (see real-time-vad.d.ts inside the
 * package) and re-exports it as the named `ort` export. A separate
 * `import("onnxruntime-web")` in the consumer returns a different
 * module record, so mutations to its env are invisible to MicVAD.new.
 * The previous pin (commit 637ae73) wrote to the wrong instance and
 * silently no-op'd; the WASM RangeError that pin was meant to fix
 * has kept surfacing as `mic init failed: no available backend
 * found. ERR: [wasm] RangeError ...`.
 *
 * The pin matters because on tabs without cross-origin isolation
 * (no COOP/COEP headers, which is every Tailscale-reachable view we
 * ship) the threaded WASM build cannot allocate a SharedArrayBuffer
 * and cascades into:
 *
 *   no available backend found.
 *     ERR: [wasm] RangeError: Out of memory,
 *          [cpu] Error: previous call to 'initWasm()' failed.
 *
 * numThreads=1 + simd=true + proxy=false steers ORT onto the
 * single-thread SIMD path, which the silero-vad model fits in
 * without exhausting the per-tab heap budget.
 */

export const VAD_WASM_PATHS = '/vad/';
export const VAD_NUM_THREADS = 1;
export const VAD_SIMD = true;
export const VAD_PROXY = false;

interface OrtEnvShape {
  env?: {
    wasm?: Record<string, unknown>;
  };
}

interface VadModuleShape {
  ort?: OrtEnvShape;
}

/**
 * Apply the WASM pin to the vad-web-bundled ORT instance.
 * Defensive: vad-web's API surface has moved across minor versions
 * and the env may be locked or partially shaped, so every write is
 * try-guarded. Returns the keys actually written so tests + callers
 * can confirm the pin took.
 */
export function configureVadOrt(mod: unknown): string[] {
  const m = mod as VadModuleShape;
  const wasm = m?.ort?.env?.wasm;
  if (!wasm) return [];
  const written: string[] = [];
  const tries: Array<[string, unknown]> = [
    ['wasmPaths', VAD_WASM_PATHS],
    ['numThreads', VAD_NUM_THREADS],
    ['simd', VAD_SIMD],
    ['proxy', VAD_PROXY],
  ];
  for (const [key, value] of tries) {
    try {
      wasm[key] = value;
      written.push(key);
    } catch {
      /* env shape can lock fields across ORT minor bumps; pinning
       * each field independently keeps the others working when one
       * is read-only. */
    }
  }
  return written;
}
