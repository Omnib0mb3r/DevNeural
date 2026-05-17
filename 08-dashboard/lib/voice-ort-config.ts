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
/* numThreads pinning rule:
 *   - When the dashboard tab is crossOriginIsolated (COOP+COEP shipped
 *     by the daemon / Next dev server) we can ask ORT for the threaded
 *     WASM build, which uses a SharedArrayBuffer-backed WebAssembly
 *     Memory that can grow past the per-tab single-thread heap budget.
 *     This is what makes VAD remount survive without the
 *     `[wasm] RangeError: Out of memory` cascade.
 *   - When the tab is not isolated (no headers, a stale cache, or
 *     served from an origin we don't control yet) we stay on the
 *     single-thread SIMD path. Asking for threads without isolation
 *     forces the pthread shim to fail and ORT cascades into "no
 *     available backend".
 * Cap at 2 threads because the silero VAD model is tiny; more threads
 * just burn worker spin-up on every remount. */
function pickInitialNumThreads(): number {
  const g = typeof globalThis === 'undefined'
    ? null
    : (globalThis as { crossOriginIsolated?: boolean });
  const isolated = g?.crossOriginIsolated === true;
  if (!isolated) return 1;
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.min(2, Math.max(1, hc));
}
export const VAD_NUM_THREADS = pickInitialNumThreads();
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

/* Singleton vad-web import + ORT pin.
 *
 * Why: a fresh dynamic import always returns the same cached module
 * record, but `configureVadOrt` mutates `mod.ort.env.wasm` and
 * MicVAD.new triggers ORT's internal WASM compile/init. We do not
 * want to re-walk that compile every time VoiceClient remounts (page
 * nav, mic toggle, dev HMR), because each remount used to cost a
 * fresh WASM instantiation and steadily grew the tab's heap until
 * the next instantiation OOM'd.
 *
 * The singleton:
 *   - Caches the module promise so repeated `getVadModule()` calls
 *     share one in-flight load.
 *   - Runs `configureVadOrt` exactly once. ORT keys its internal
 *     WASM module cache by the env.wasm settings; keeping them
 *     stable lets the underlying ort-wasm module instance be reused
 *     across MicVAD.new calls instead of being torn down and
 *     re-compiled on every remount.
 *
 * MicVAD instance itself is NOT cached here. Per-mount instances
 * keep their own callbacks (onSpeechStart/End, runtime params), and
 * a stale instance would fire handlers into a torn-down React tree.
 * vad-web's destroy() releases the session but leaves the ORT
 * module/WASM intact, which is the layer we want to keep warm. */
let vadModulePromise: Promise<unknown> | null = null;
let vadModuleConfigured = false;

export async function getVadModule(): Promise<unknown> {
  if (vadModulePromise) return vadModulePromise;
  vadModulePromise = (async () => {
    const mod = await import('@ricky0123/vad-web');
    if (!vadModuleConfigured) {
      configureVadOrt(mod);
      vadModuleConfigured = true;
    }
    return mod;
  })().catch((err) => {
    /* Surface the load failure but clear the cache so the next
     * retry attempt (VoiceErrorPill -> retry button) actually
     * re-tries instead of resolving to the same rejected promise. */
    vadModulePromise = null;
    vadModuleConfigured = false;
    throw err;
  });
  return vadModulePromise;
}

export function resetVadModuleCacheForTests(): void {
  vadModulePromise = null;
  vadModuleConfigured = false;
}

/**
 * Drop the cached vad-web module + the configured flag so the next
 * `getVadModule()` call dynamically re-imports and re-runs
 * `configureVadOrt` against a fresh ORT env. Used on the
 * disable + restart path where MicVAD.destroy() terminates the
 * threaded-backend's worker pool but leaves the singleton ORT env
 * reporting "configured", so the next MicVAD.new lands on a dead
 * pthread shim and ORT cascades into
 * `RangeError: Out of memory` + `previous call to 'initWasm()'
 * failed.` Resetting the cache rebuilds the backend cleanly at the
 * cost of one fresh WASM init per enable cycle, which is acceptable
 * because the disable path is rare in real usage (hands-busy
 * interrupt, not a hot loop).
 *
 * Tab-switch remount keeps the cache warm: the cleanup that fires
 * on enabled-stays-true component remount does NOT call
 * MicVAD.destroy and does NOT need to call this; that path is what
 * 393d4f5's singleton was originally designed for and still
 * benefits from.
 */
export function resetVadModuleCache(): void {
  vadModulePromise = null;
  vadModuleConfigured = false;
}

export function isVadModuleConfigured(): boolean {
  return vadModuleConfigured;
}
