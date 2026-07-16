/**
 * Semantic turn detection (voice top layer phase 2, 2026-07-15 spec).
 *
 * After the client's VAD closes an utterance (fixed 450ms silence
 * redemption), the daemon asks the Pipecat Smart Turn v3 model whether
 * the operator actually finished talking. "incomplete" means the pause
 * was mid-thought: the utterance is held briefly and merged with the
 * continuation instead of being answered mid-sentence.
 *
 * Three cooperating pieces, deliberately kept out of lex-voice-ws.ts:
 *
 *   1. analyzeTurn(pcm16, sampleRateHz): runs the ONNX model on the
 *      tail of the utterance audio. Returns 'complete' | 'incomplete'
 *      | 'unavailable'. NEVER throws, never blocks on the network: a
 *      missing model kicks off a background download and reports
 *      'unavailable' until the file is in place.
 *   2. decideCoalesce(...): a PURE hold/merge state machine. No timers
 *      inside; the caller drives time. Fully unit-testable.
 *   3. isSmartTurnEnabled(): runtime_config 'voice_smart_turn' kill
 *      switch (same read-then-env-then-default cascade as the other
 *      daemon toggles, e.g. dashboard_supervisor_enabled). Default ON
 *      when the model file exists, OFF when it does not. Never crashes
 *      when the DB is unavailable.
 *
 * Model: huggingface.co/pipecat-ai/smart-turn-v3, file
 * smart-turn-v3.2-cpu.onnx (int8 quantized, ~8.3MB, whisper-tiny
 * encoder backbone). This is the exact file pipecat bundles for its
 * LocalSmartTurnAnalyzerV3. Preprocessing is a faithful port of
 * pipecat's vendored numpy implementation
 * (pipecat/audio/turn/smart_turn/_whisper_features.py +
 * local_smart_turn_v3.py):
 *
 *   - float32 mono audio at 16kHz (int16 / 32768)
 *   - truncate keeping the LAST 8s; shorter input is zero-padded at
 *     the BEGINNING so speech ends at the window end
 *   - zero-mean unit-variance normalization over the 128000-sample
 *     window (eps 1e-7)
 *   - whisper log-mel features: n_fft 400, hop 160, 80 slaney mels,
 *     periodic hann, reflect-centered, power 2, log10, drop trailing
 *     frame (=> 800 frames), clamp to max-8, then (x+4)/4
 *   - ONNX input tensor "input_features" float32 [1, 80, 800]
 *   - output[0][0] is a sigmoid probability; > 0.5 => turn complete
 *
 * The mel frontend reuses @xenova/transformers' WhisperFeatureExtractor
 * (already a daemon dependency for the embedder); its spectrogram math
 * is the same transformers reference pipecat vendored, including the
 * 801 -> 800 frame truncation and the max-8 / (x+4)/4 scaling.
 * Inference reuses onnxruntime-node 1.14.0, which @xenova/transformers
 * already installs (optional dependency, hoisted to node_modules). Both
 * are loaded lazily via dynamic import so this module costs nothing
 * when the feature is off and degrades to 'unavailable' when either
 * package cannot load.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getStore } from '../lex/brainstorm-store.js';

/* ────────────────────────── verdicts + config ───────────────────── */

export type TurnVerdict = 'complete' | 'incomplete' | 'unavailable';

export const SMART_TURN_CONFIG_KEY = 'voice_smart_turn';
export const SMART_TURN_MODEL_FILENAME = 'smart-turn-v3.2-cpu.onnx';
export const DEFAULT_SMART_TURN_HOLD_MS = 1600;

const DEFAULT_MODEL_URL =
  'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/' +
  SMART_TURN_MODEL_FILENAME;
/* HF LFS pointer for smart-turn-v3.2-cpu.onnx (fetched 2026-07-15).
 * SAFETY-CRITICAL: onnxruntime-node 1.14 does not reject a malformed
 * model file; it silently hard-exits the whole process (verified on
 * this machine: InferenceSession.create on garbage kills node with
 * exit code 0 and no error). The daemon therefore never hands ORT a
 * file whose sha256 it has not verified. Override the pin with
 * DEVNEURAL_SMART_TURN_MODEL_SHA256 when using a custom model URL
 * ('skip' disables verification; only do that for files you trust). */
export const SMART_TURN_MODEL_SHA256 =
  '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f';
/* The real file is 8,679,182 bytes. Anything under a megabyte is a
 * truncated download or an HTML error page saved to disk; treat it as
 * missing so the next ensure re-fetches instead of feeding garbage to
 * onnxruntime forever. */
const MODEL_MIN_BYTES = 1_000_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/* After a failed download, wait this long before trying again so a
 * dead network does not turn every utterance into an HTTP attempt. */
const DOWNLOAD_RETRY_COOLDOWN_MS = 10 * 60_000;

const MODEL_SAMPLE_RATE = 16_000;
const WINDOW_SECONDS = 8;
const WINDOW_SAMPLES = MODEL_SAMPLE_RATE * WINDOW_SECONDS; // 128000
const N_FFT = 400;
const HOP_LENGTH = 160;
const N_MELS = 80;
const N_FRAMES = 800;
const NORM_VARIANCE_EPS = 1e-7;
const DEFAULT_THRESHOLD = 0.5;
/* Below ~10ms of audio there is nothing for the model to say. */
const MIN_PCM_BYTES = 320;

type Log = (msg: string) => void;
const noopLog: Log = () => undefined;

/* ────────────────── DLL-order guard (Windows) ───────────────────
 * Two onnxruntime-node versions live in this daemon: the direct
 * ^1.27 dependency (this module) and @xenova/transformers' nested
 * optional 1.14 (the embedder). Windows resolves an addon's
 * dependent DLLs by BASE NAME against the already-loaded module
 * list, so whichever binding loads first decides which
 * onnxruntime.dll every later binding gets. ORT's C API is
 * version-negotiated (OrtGetApiBase().GetApi(v)), which makes the
 * 1.27 dll able to serve the 1.14 binding, but NOT the reverse:
 * verified on this machine, embedder-first leaves smart turn
 * permanently 'unavailable' while smart-turn-first leaves both
 * working. Loading our (newer) binding synchronously at module
 * evaluation guarantees the good order inside the daemon, because
 * ESM module evaluation always completes before any runtime call
 * (embedder warmUp included) can touch the nested 1.14 binding.
 * Skipped under tests so vitest workers stay native-free; if it
 * fails we degrade to 'unavailable' lazily, never crash. */
if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
  try {
    createRequire(import.meta.url)('onnxruntime-node');
  } catch {
    /* analyzeTurn will report 'unavailable' via the lazy path */
  }
}

/* Truthy/falsy string parser mirroring the runtime_config toggle
 * convention used across the daemon (see dashboard-supervisor.ts).
 * Returns null when the string does not parse so the caller can fall
 * through to the next source. */
function parseToggle(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

/* ─────────────────────────── model location ─────────────────────── */

/* Data root is resolved at CALL time (not import time, unlike
 * paths.ts DATA_ROOT) so tests can point DEVNEURAL_DATA_ROOT at a temp
 * dir after import. */
function dataRoot(): string {
  return (
    process.env.DEVNEURAL_DATA_ROOT?.replace(/\\/g, '/') ??
    'C:/dev/data/skill-connections'
  );
}

export function smartTurnModelDir(): string {
  return path.posix.join(dataRoot(), 'models', 'smart-turn');
}

export function smartTurnModelPath(): string {
  return path.posix.join(smartTurnModelDir(), SMART_TURN_MODEL_FILENAME);
}

export function smartTurnModelExists(): boolean {
  try {
    const st = fs.statSync(smartTurnModelPath());
    return st.isFile() && st.size >= MODEL_MIN_BYTES;
  } catch {
    return false;
  }
}

function expectedModelSha256(): string | null {
  const raw = process.env.DEVNEURAL_SMART_TURN_MODEL_SHA256?.trim();
  if (raw?.toLowerCase() === 'skip') return null;
  if (raw && /^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  return SMART_TURN_MODEL_SHA256;
}

/** sha256-verify a model file before onnxruntime ever maps it (see the
 * SAFETY-CRITICAL note on SMART_TURN_MODEL_SHA256: ORT 1.14 hard-exits
 * the process on malformed input instead of throwing). Runs once per
 * session load, not per utterance. */
function verifyModelFile(modelPath: string, log: Log): boolean {
  const expected = expectedModelSha256();
  if (expected === null) {
    log('[smart-turn] model sha256 verification SKIPPED by env');
    return true;
  }
  try {
    const actual = createHash('sha256')
      .update(fs.readFileSync(modelPath))
      .digest('hex');
    if (actual === expected) return true;
    log(
      `[smart-turn] model sha256 mismatch: refusing to load ${modelPath} ` +
        `(got ${actual.slice(0, 12)}..., want ${expected.slice(0, 12)}...)`,
    );
    return false;
  } catch (err) {
    log(`[smart-turn] model verify failed: ${(err as Error).message}`);
    return false;
  }
}

/* ───────────────────────── model acquisition ────────────────────── */

/* Tests must never hit the network. vitest sets VITEST=true in every
 * worker; NODE_ENV=test and the explicit opt-out cover other runners. */
function downloadsBlocked(): boolean {
  if (parseToggle(process.env.DEVNEURAL_SMART_TURN_NO_DOWNLOAD ?? null) === true)
    return true;
  if (process.env.VITEST) return true;
  if (process.env.NODE_ENV === 'test') return true;
  return false;
}

let downloadInFlight: Promise<string | null> | null = null;
let lastDownloadFailureMs = 0;

async function downloadModel(
  modelPath: string,
  log: Log,
  timeoutMs: number,
): Promise<string> {
  const url = process.env.DEVNEURAL_SMART_TURN_MODEL_URL ?? DEFAULT_MODEL_URL;
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  const tmpPath = `${modelPath}.part-${process.pid}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    log(`[smart-turn] downloading model: ${url}`);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} fetching smart-turn model`);
    }
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      fs.createWriteStream(tmpPath),
    );
    const written = fs.statSync(tmpPath).size;
    const expected = Number(res.headers.get('content-length') ?? NaN);
    if (written < MODEL_MIN_BYTES) {
      throw new Error(`downloaded file too small (${written} bytes)`);
    }
    if (Number.isFinite(expected) && expected > 0 && written !== expected) {
      throw new Error(
        `downloaded ${written} bytes, expected ${expected} (truncated)`,
      );
    }
    if (!verifyModelFile(tmpPath, log)) {
      throw new Error('downloaded file failed sha256 verification');
    }
    fs.renameSync(tmpPath, modelPath);
    log(`[smart-turn] model saved: ${modelPath} (${written} bytes)`);
    return modelPath;
  } finally {
    clearTimeout(timer);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/**
 * Idempotent model fetch. Returns the model path when the file is (or
 * becomes) available, null otherwise. Single-flight; never throws; a
 * failure arms a cooldown so repeated calls do not hammer the network.
 */
export async function ensureSmartTurnModel(
  opts: { log?: Log; timeoutMs?: number } = {},
): Promise<string | null> {
  const log = opts.log ?? noopLog;
  const modelPath = smartTurnModelPath();
  if (smartTurnModelExists()) return modelPath;
  if (downloadsBlocked()) return null;
  if (downloadInFlight) return downloadInFlight;
  if (Date.now() - lastDownloadFailureMs < DOWNLOAD_RETRY_COOLDOWN_MS) {
    return null;
  }
  downloadInFlight = downloadModel(
    modelPath,
    log,
    opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
  )
    .catch((err: unknown) => {
      lastDownloadFailureMs = Date.now();
      log(
        `[smart-turn] model download failed: ${(err as Error).message}; ` +
          `retry allowed in ${Math.round(DOWNLOAD_RETRY_COOLDOWN_MS / 60000)}min`,
      );
      return null;
    })
    .finally(() => {
      downloadInFlight = null;
    });
  return downloadInFlight;
}

/* ─────────────────────── onnxruntime session ────────────────────── */

/* Minimal structural types for onnxruntime-node. The package is an
 * OPTIONAL dependency of @xenova/transformers (hoisted into
 * node_modules today), so both the import specifier and the types stay
 * out of compile-time resolution: if the package vanishes we degrade
 * to 'unavailable' at runtime instead of failing tsc. */
interface OrtTensorLike {
  data: ArrayLike<number>;
}
interface OrtSessionLike {
  outputNames: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, OrtTensorLike>>;
}
interface OrtModuleLike {
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: readonly number[],
  ) => unknown;
  InferenceSession: {
    create(
      modelPath: string,
      options?: Record<string, unknown>,
    ): Promise<OrtSessionLike>;
  };
}

let ortModulePromise: Promise<OrtModuleLike | null> | null = null;

async function loadOrt(log: Log): Promise<OrtModuleLike | null> {
  if (!ortModulePromise) {
    ortModulePromise = (async () => {
      /* Non-literal specifier keeps TypeScript from resolving the
       * module at compile time (see the structural-type note above). */
      const specifier = 'onnxruntime-node';
      try {
        const mod = (await import(specifier)) as Record<string, unknown>;
        const resolved = (
          mod.InferenceSession ? mod : (mod.default ?? mod)
        ) as unknown as OrtModuleLike;
        if (!resolved?.InferenceSession?.create || !resolved?.Tensor) {
          throw new Error('onnxruntime-node exports missing');
        }
        return resolved;
      } catch (err) {
        log(
          `[smart-turn] onnxruntime-node unavailable: ${(err as Error).message}`,
        );
        return null;
      }
    })();
  }
  return ortModulePromise;
}

interface SmartTurnSession {
  ort: OrtModuleLike;
  session: OrtSessionLike;
  modelPath: string;
}

let sessionPromise: Promise<SmartTurnSession | null> | null = null;
let sessionModelPath: string | null = null;

function intraOpThreads(): number {
  const raw = Number(process.env.DEVNEURAL_SMART_TURN_THREADS ?? NaN);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 16) return Math.floor(raw);
  return 2;
}

async function loadSession(
  modelPath: string,
  log: Log,
): Promise<SmartTurnSession | null> {
  /* Re-key the cache if the model path changed (env rewrite in tests
   * or a data-root move); a cached failure for the same path stays
   * cached so a broken model file does not retry on every utterance. */
  if (sessionPromise && sessionModelPath === modelPath) return sessionPromise;
  sessionModelPath = modelPath;
  sessionPromise = (async () => {
    /* Verify BEFORE importing onnxruntime: a bad file must never reach
     * ORT 1.14's process-killing loader (see SMART_TURN_MODEL_SHA256). */
    if (!verifyModelFile(modelPath, log)) return null;
    const ort = await loadOrt(log);
    if (!ort) return null;
    /* Mirrors pipecat's session options (sequential, single inter-op
     * thread, full graph optimization). intra-op threads default to 2
     * for latency; DEVNEURAL_SMART_TURN_THREADS overrides. */
    const options = {
      executionMode: 'sequential',
      interOpNumThreads: 1,
      intraOpNumThreads: intraOpThreads(),
      graphOptimizationLevel: 'all',
    };
    const t0 = Date.now();
    try {
      let session: OrtSessionLike;
      try {
        session = await ort.InferenceSession.create(modelPath, options);
      } catch {
        /* Older onnxruntime-node builds reject unknown option keys;
         * a bare create is better than no smart turn at all. */
        session = await ort.InferenceSession.create(modelPath);
      }
      log(
        `[smart-turn] model loaded in ${Date.now() - t0}ms: ${modelPath}`,
      );
      return { ort, session, modelPath };
    } catch (err) {
      log(
        `[smart-turn] model load failed: ${(err as Error).message} (${modelPath})`,
      );
      return null;
    }
  })();
  return sessionPromise;
}

/* ──────────────────────── audio preprocessing ───────────────────── */

/** Little-endian signed 16-bit PCM to float32 in [-1, 1). Exported for
 * tests. */
export function pcm16ToFloat32(pcm16: Buffer): Float32Array {
  const samples = Math.floor(pcm16.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = pcm16.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/** Linear-interpolation resample. The daemon's voice path is already
 * 16kHz mono so this is a correctness fallback, not a quality path.
 * Exported for tests. */
export function resampleLinear(
  input: Float32Array,
  fromHz: number,
  toHz: number,
): Float32Array {
  if (fromHz === toHz || input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * toHz) / fromHz));
  const out = new Float32Array(outLen);
  const step = (input.length - 1) / Math.max(1, outLen - 1);
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

/** Fixed 8s model window: keep the LAST 8 seconds, zero-pad at the
 * BEGINNING when shorter (pipecat local_smart_turn_v3 behavior, so the
 * speech tail always sits at the window end). Exported for tests. */
export function tailWindow(audio: Float32Array): Float32Array {
  if (audio.length === WINDOW_SAMPLES) return audio;
  const out = new Float32Array(WINDOW_SAMPLES);
  if (audio.length > WINDOW_SAMPLES) {
    out.set(audio.subarray(audio.length - WINDOW_SAMPLES));
  } else {
    out.set(audio, WINDOW_SAMPLES - audio.length);
  }
  return out;
}

/** Zero-mean unit-variance waveform normalization (transformers
 * do_normalize=True, population variance, eps 1e-7). In place;
 * exported for tests. */
export function normalizeWaveform(audio: Float32Array): Float32Array {
  const n = audio.length;
  if (n === 0) return audio;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += audio[i]!;
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = audio[i]! - mean;
    varSum += d * d;
  }
  const denom = Math.sqrt(varSum / n + NORM_VARIANCE_EPS);
  for (let i = 0; i < n; i++) audio[i] = (audio[i]! - mean) / denom;
  return audio;
}

/* Whisper log-mel frontend via @xenova/transformers. The extractor is
 * config-driven; with chunk_length 8 (n_samples 128000, nb_max_frames
 * 800) its output is bit-compatible with pipecat's vendored numpy
 * reference for our exactly-128000-sample windows. */
interface FbankExtractorLike {
  _extract_fbank_features(waveform: Float32Array): {
    data: Float32Array;
    dims: number[];
  };
}

let extractorPromise: Promise<FbankExtractorLike | null> | null = null;

async function loadExtractor(log: Log): Promise<FbankExtractorLike | null> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const mod = (await import('@xenova/transformers')) as unknown as {
          WhisperFeatureExtractor: new (
            config: Record<string, unknown>,
          ) => FbankExtractorLike;
        };
        return new mod.WhisperFeatureExtractor({
          feature_size: N_MELS,
          sampling_rate: MODEL_SAMPLE_RATE,
          hop_length: HOP_LENGTH,
          chunk_length: WINDOW_SECONDS,
          n_fft: N_FFT,
          n_samples: WINDOW_SAMPLES,
          nb_max_frames: N_FRAMES,
          padding_value: 0,
        });
      } catch (err) {
        log(
          `[smart-turn] feature extractor unavailable: ${(err as Error).message}`,
        );
        return null;
      }
    })();
  }
  return extractorPromise;
}

function threshold(): number {
  const raw = Number(process.env.DEVNEURAL_SMART_TURN_THRESHOLD ?? NaN);
  if (Number.isFinite(raw) && raw > 0 && raw < 1) return raw;
  return DEFAULT_THRESHOLD;
}

/* ───────────────────────────── analyzeTurn ──────────────────────── */

export interface SmartTurnStats {
  analyze_calls: number;
  unavailable_count: number;
  last_probability: number | null;
  last_infer_ms: number | null;
  last_verdict: TurnVerdict | null;
}

const stats: SmartTurnStats = {
  analyze_calls: 0,
  unavailable_count: 0,
  last_probability: null,
  last_infer_ms: null,
  last_verdict: null,
};

export function smartTurnStats(): SmartTurnStats {
  return { ...stats };
}

/**
 * Run Smart Turn v3 on the tail of an utterance.
 *
 * @param pcm16 Little-endian signed 16-bit mono PCM of the whole
 *   utterance (the daemon's mic buffer at VAD close).
 * @param sampleRateHz Sample rate of pcm16 (the voice path sends 16000).
 * @returns 'complete' when the operator sounds done, 'incomplete' for
 *   a mid-thought pause, 'unavailable' whenever the model cannot
 *   answer (missing/corrupt model, runtime missing, bad input). Never
 *   throws; never waits on the network.
 */
export async function analyzeTurn(
  pcm16: Buffer,
  sampleRateHz: number,
  opts: { log?: Log } = {},
): Promise<TurnVerdict> {
  const log = opts.log ?? noopLog;
  stats.analyze_calls += 1;
  try {
    if (
      !pcm16 ||
      pcm16.byteLength < MIN_PCM_BYTES ||
      !Number.isFinite(sampleRateHz) ||
      sampleRateHz <= 0
    ) {
      return unavailable();
    }
    if (!smartTurnModelExists()) {
      /* Kick a background acquisition (no-op under tests / cooldown)
       * and answer without it. The next utterance after the download
       * finishes gets the real model. */
      void ensureSmartTurnModel({ log });
      return unavailable();
    }
    const handle = await loadSession(smartTurnModelPath(), log);
    if (!handle) return unavailable();
    const extractor = await loadExtractor(log);
    if (!extractor) return unavailable();

    const t0 = Date.now();
    let audio = pcm16ToFloat32(pcm16);
    if (sampleRateHz !== MODEL_SAMPLE_RATE) {
      audio = resampleLinear(audio, sampleRateHz, MODEL_SAMPLE_RATE);
    }
    const window = normalizeWaveform(tailWindow(audio));
    const { data, dims } = extractor._extract_fbank_features(window);
    if (dims.length !== 2 || dims[0] !== N_MELS || dims[1] !== N_FRAMES) {
      log(`[smart-turn] unexpected feature dims [${dims.join(',')}]`);
      return unavailable();
    }
    const tensor = new handle.ort.Tensor('float32', data, [
      1,
      N_MELS,
      N_FRAMES,
    ]);
    const outputs = await handle.session.run({ input_features: tensor });
    const outName = handle.session.outputNames[0];
    const out = outName ? outputs[outName] : undefined;
    const probability = Number(out?.data?.[0]);
    if (!Number.isFinite(probability)) {
      log('[smart-turn] model produced no finite probability');
      return unavailable();
    }
    const ms = Date.now() - t0;
    const verdict: TurnVerdict =
      probability > threshold() ? 'complete' : 'incomplete';
    stats.last_probability = probability;
    stats.last_infer_ms = ms;
    stats.last_verdict = verdict;
    log(
      `[smart-turn] verdict=${verdict} p=${probability.toFixed(3)} ms=${ms}`,
    );
    return verdict;
  } catch (err) {
    log(`[smart-turn] analyze failed: ${(err as Error).message}`);
    return unavailable();
  }

  function unavailable(): TurnVerdict {
    stats.unavailable_count += 1;
    stats.last_verdict = 'unavailable';
    return 'unavailable';
  }
}

/* ─────────────────────────── kill switch ────────────────────────── */

/**
 * runtime_config 'voice_smart_turn' toggle. Cascade:
 *   1. runtime_config row (dashboard /system writes, hot)
 *   2. DEVNEURAL_SMART_TURN env
 *   3. default: ON when the model file exists, OFF when it does not
 * Pass a db-shaped object for tests; without one the daemon's store
 * singleton is used. Any DB failure falls through the cascade instead
 * of crashing the voice path.
 */
export function isSmartTurnEnabled(
  db?: { getRuntimeConfig(key: string): string | null } | null,
): boolean {
  let raw: string | null = null;
  try {
    const source = db ?? getStore().db;
    raw = source.getRuntimeConfig(SMART_TURN_CONFIG_KEY);
  } catch {
    raw = null;
  }
  const fromDb = parseToggle(raw);
  if (fromDb !== null) return fromDb;
  const fromEnv = parseToggle(process.env.DEVNEURAL_SMART_TURN ?? null);
  if (fromEnv !== null) return fromEnv;
  return smartTurnModelExists();
}

/* ──────────────────── hold/merge state machine ──────────────────── */

export interface TurnCoalescerState {
  heldText: string | null;
  heldSinceMs: number;
}

export interface CoalesceDecision {
  action: 'process' | 'hold';
  /** For 'process': the full (merged) text to dispatch. For 'hold':
   * the accumulated held text, for telemetry/UI. */
  text: string;
  nextState: TurnCoalescerState;
}

export function emptyCoalescerState(): TurnCoalescerState {
  return { heldText: null, heldSinceMs: 0 };
}

/** Hold window: DEVNEURAL_SMART_TURN_HOLD_MS env, default 1600ms. */
export function smartTurnHoldWindowMs(): number {
  const raw = Number(process.env.DEVNEURAL_SMART_TURN_HOLD_MS ?? NaN);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_SMART_TURN_HOLD_MS;
}

function joinUtterances(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

/**
 * Pure hold/merge decision. No timers, no I/O; the caller supplies
 * nowMs and owns any flush timer.
 *
 * Semantics:
 *   - verdict 'incomplete': hold. New text is appended to any
 *     already-held text. heldSinceMs is pinned to the FIRST held
 *     utterance so total added latency stays bounded by the window.
 *   - verdict 'complete' / 'unavailable': process. Held text (if any)
 *     is prepended and the state clears.
 *   - Held text older than holdWindowMs at the NEXT event still merges
 *     but processes immediately, whatever the verdict says. This is
 *     the anti-starvation rule: the model can never hold speech
 *     hostage for more than one window past the first hold.
 *   - A caller-driven timeout flush is just
 *     decideCoalesce(state, 'complete', '', now): held text comes back
 *     as a process action and the state clears.
 *   - Holding nothing is meaningless: an 'incomplete' verdict whose
 *     merged text is empty returns a no-op process with text ''.
 */
export function decideCoalesce(
  state: TurnCoalescerState,
  verdict: TurnVerdict,
  text: string,
  nowMs: number,
  holdWindowMs: number = smartTurnHoldWindowMs(),
): CoalesceDecision {
  const held = state.heldText;
  const merged =
    held !== null ? joinUtterances(held, text) : (text ?? '').trim();
  const heldExpired =
    held !== null && nowMs - state.heldSinceMs > holdWindowMs;

  if (verdict === 'incomplete' && !heldExpired && merged) {
    return {
      action: 'hold',
      text: merged,
      nextState: {
        heldText: merged,
        heldSinceMs: held !== null ? state.heldSinceMs : nowMs,
      },
    };
  }
  return { action: 'process', text: merged, nextState: emptyCoalescerState() };
}

/* ───────────────────────────── test seam ────────────────────────── */

/** Reset lazy caches (session, extractor, download state, stats) so
 * tests can flip env vars between cases. Not for production use. */
export function _resetSmartTurnForTests(): void {
  ortModulePromise = null;
  sessionPromise = null;
  sessionModelPath = null;
  extractorPromise = null;
  downloadInFlight = null;
  lastDownloadFailureMs = 0;
  stats.analyze_calls = 0;
  stats.unavailable_count = 0;
  stats.last_probability = null;
  stats.last_infer_ms = null;
  stats.last_verdict = null;
}
