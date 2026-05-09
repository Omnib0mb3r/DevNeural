/**
 * whisper.cpp CUDA wrapper.
 *
 * Spawns whisper-server.exe (the persistent HTTP server build from
 * the cuBLAS release) as a managed child process so the model is
 * loaded once on otlcdev's RTX 5080 and reused for every transcription
 * request. Without this, every utterance would pay a ~1.1s model load
 * cost on a `medium.en` model — fine for one-off testing, fatal for
 * conversational latency.
 *
 * The daemon's voice pipeline calls transcribe(pcmWavBuffer) and
 * gets back plain text. The browser/iPad mic client buffers a single
 * utterance (VAD-bounded), wraps it as a 16kHz mono WAV, and the
 * daemon POSTs that to whisper-server's /inference endpoint.
 *
 * Configuration via env:
 *   DEVNEURAL_WHISPER_BIN   path to whisper-server.exe (default:
 *                            C:/dev/whisper.cpp/cublas/Release/whisper-server.exe)
 *   DEVNEURAL_WHISPER_MODEL path to ggml model (default:
 *                            C:/dev/whisper.cpp/models/ggml-medium.en.bin)
 *   DEVNEURAL_WHISPER_PORT  port for the local server (default 8723,
 *                            unconventional to avoid 8080 conflicts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_BIN =
  'C:/dev/whisper.cpp/cublas/Release/whisper-server.exe';
const DEFAULT_MODEL =
  'C:/dev/whisper.cpp/models/ggml-medium.en.bin';
const DEFAULT_PORT = 8723;

interface ServerState {
  proc: ChildProcess | null;
  port: number;
  ready: boolean;
  startedAt: number;
  lastError: string | null;
  /* In-flight ready promise so concurrent transcribe() calls during
   * cold-start serialise on the same boot rather than spawning twice. */
  readyPromise: Promise<void> | null;
}

const state: ServerState = {
  proc: null,
  port: 0,
  ready: false,
  startedAt: 0,
  lastError: null,
  readyPromise: null,
};

function getBin(): string {
  const v = process.env.DEVNEURAL_WHISPER_BIN || DEFAULT_BIN;
  return v.replace(/\\/g, '/');
}

function getModel(): string {
  const v = process.env.DEVNEURAL_WHISPER_MODEL || DEFAULT_MODEL;
  return v.replace(/\\/g, '/');
}

function getPort(): number {
  const v = Number(process.env.DEVNEURAL_WHISPER_PORT || DEFAULT_PORT);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PORT;
}

async function probeReady(port: number, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      /* whisper-server has no /health, but a HEAD on the inference
       * path 405s once the server is listening. ECONNREFUSED while
       * still booting; once we see ANY HTTP response back we know
       * it's up. */
      const r = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'HEAD',
      });
      if (r.status >= 200 && r.status < 600) return true;
    } catch {
      /* connection refused, not yet listening */
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

/**
 * Lazy-start the whisper server on first call. Subsequent calls reuse
 * the running process. If the process exits (crash, OOM), the next
 * transcribe() spawns a fresh one.
 */
export async function ensureServer(): Promise<void> {
  if (state.ready && state.proc && !state.proc.killed) return;
  if (state.readyPromise) return state.readyPromise;

  state.readyPromise = (async () => {
    const bin = getBin();
    const model = getModel();
    if (!fs.existsSync(bin)) {
      throw new Error(`whisper binary not found: ${bin}`);
    }
    if (!fs.existsSync(model)) {
      throw new Error(`whisper model not found: ${model}`);
    }
    const port = getPort();
    state.port = port;

    const proc = spawn(
      bin,
      [
        '--model',
        model,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        /* Beam-1 is faster than the default beam-search; for short
         * conversational utterances the accuracy hit is negligible. */
        '--beam-size',
        '1',
        '--best-of',
        '1',
        /* Suppress per-token timestamps in JSON; we only need text. */
        '--no-timestamps',
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.dirname(bin),
      },
    );

    state.proc = proc;
    state.startedAt = Date.now();
    state.ready = false;
    state.lastError = null;

    proc.stderr?.on('data', (b: Buffer) => {
      const s = b.toString();
      if (/error/i.test(s)) state.lastError = s.trim().slice(0, 500);
    });
    proc.on('exit', (code) => {
      state.ready = false;
      state.proc = null;
      state.readyPromise = null;
      state.lastError = `whisper-server exited (code=${code ?? 'null'})`;
    });

    const ok = await probeReady(port);
    if (!ok) {
      proc.kill();
      throw new Error(
        `whisper-server failed to come up within 30s. Last stderr: ${state.lastError ?? '(none)'}`,
      );
    }
    state.ready = true;
  })();

  try {
    await state.readyPromise;
  } finally {
    state.readyPromise = null;
  }
}

/**
 * Encode a Float32Array (or Int16Array) of 16kHz mono PCM samples as a
 * 16-bit WAV buffer suitable for whisper-server. Browsers ship raw
 * PCM via MediaRecorder/AudioWorklet; the server wants WAV with
 * RIFF header.
 */
export function pcm16ToWav(
  pcm: Int16Array | Float32Array,
  sampleRate = 16000,
): Buffer {
  let int16: Int16Array;
  if (pcm instanceof Float32Array) {
    int16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  } else {
    int16 = pcm;
  }
  const samples = int16.length;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(int16[i] ?? 0, 44 + i * 2);
  }
  return buf;
}

interface TranscribeResult {
  text: string;
  ms: number;
}

/**
 * Transcribe a WAV buffer (already includes RIFF header). Spawns the
 * server lazily on first call. Returns plain text; whitespace
 * normalised, BOMs / leading silence markers stripped.
 */
export async function transcribeWav(wav: Buffer): Promise<TranscribeResult> {
  await ensureServer();
  const t0 = Date.now();
  const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' });
  const form = new FormData();
  form.append('file', blob, 'audio.wav');
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  const r = await fetch(`http://127.0.0.1:${state.port}/inference`, {
    method: 'POST',
    body: form,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`whisper inference failed ${r.status}: ${body.slice(0, 300)}`);
  }
  const json = (await r.json()) as { text?: string };
  const text = (json.text ?? '').trim().replace(/^\uFEFF/, '');
  return { text, ms: Date.now() - t0 };
}

export interface WhisperStatus {
  configured: boolean;
  ready: boolean;
  bin: string;
  model: string;
  port: number;
  startedAt: number | null;
  lastError: string | null;
}

export function whisperStatus(): WhisperStatus {
  return {
    configured: fs.existsSync(getBin()) && fs.existsSync(getModel()),
    ready: state.ready,
    bin: getBin(),
    model: getModel(),
    port: state.port || getPort(),
    startedAt: state.startedAt || null,
    lastError: state.lastError,
  };
}

export function shutdownWhisper(): void {
  if (state.proc) {
    try {
      state.proc.kill();
    } catch {
      /* ignore */
    }
  }
  state.proc = null;
  state.ready = false;
  state.readyPromise = null;
}
