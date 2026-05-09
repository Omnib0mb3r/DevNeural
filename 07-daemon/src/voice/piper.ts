/**
 * Piper TTS streaming wrapper.
 *
 * Synthesizes text into 22050 Hz mono 16-bit PCM that the browser can
 * play with low latency. Each call spawns piper.exe with --output_raw,
 * pipes the text on stdin, and streams PCM chunks back as they're
 * produced. We deliberately do not maintain a persistent piper process:
 * piper itself takes ~200ms cold-start, but its onnxruntime ONNX
 * graph caches between calls in OS file cache so warm starts are
 * fast. Per-call processes also give us clean cancel semantics for
 * barge-in (kill the child when the user starts speaking; nothing
 * lingers).
 *
 * Voice configuration via env:
 *   DEVNEURAL_PIPER_BIN    path to piper.exe (default:
 *                          C:/dev/piper/piper/piper.exe)
 *   DEVNEURAL_PIPER_VOICE  path to .onnx voice file (default:
 *                          C:/dev/piper/voices/en_US-ryan-high.onnx)
 *   DEVNEURAL_PIPER_RATE   playback sample rate hint, must match the
 *                          voice's onnx.json sample_rate (Ryan high is
 *                          22050).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

const DEFAULT_BIN = 'C:/dev/piper/piper/piper.exe';
const DEFAULT_VOICE = 'C:/dev/piper/voices/en_US-ryan-high.onnx';
const DEFAULT_RATE = 22050;

function getBin(): string {
  return (process.env.DEVNEURAL_PIPER_BIN || DEFAULT_BIN).replace(/\\/g, '/');
}
function getVoice(): string {
  return (process.env.DEVNEURAL_PIPER_VOICE || DEFAULT_VOICE).replace(/\\/g, '/');
}
function getRate(): number {
  const v = Number(process.env.DEVNEURAL_PIPER_RATE || DEFAULT_RATE);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RATE;
}

export interface PiperStatus {
  configured: boolean;
  bin: string;
  voice: string;
  rate: number;
}

export function piperStatus(): PiperStatus {
  return {
    configured: fs.existsSync(getBin()) && fs.existsSync(getVoice()),
    bin: getBin(),
    voice: getVoice(),
    rate: getRate(),
  };
}

export interface SynthHandle {
  /** Readable stream of raw 16-bit signed little-endian PCM at
   * `sampleRate` Hz, mono. Caller pipes this to a WebSocket client
   * that buffers + plays via Web Audio API. */
  pcm: Readable;
  sampleRate: number;
  cancel: () => void;
  done: Promise<void>;
}

/**
 * Synthesize text to streaming PCM. Returns immediately; audio chunks
 * begin flowing on the returned `pcm` stream within ~150ms.
 *
 * To support barge-in (the user starts talking while Lex is talking),
 * call handle.cancel() — kills the child process and ends the stream
 * with no further chunks. The browser stops playback on its end on
 * receiving a "tts-cancel" WebSocket frame.
 */
export function synthesize(text: string): SynthHandle {
  const bin = getBin();
  const voice = getVoice();
  if (!fs.existsSync(bin)) throw new Error(`piper binary not found: ${bin}`);
  if (!fs.existsSync(voice)) throw new Error(`piper voice not found: ${voice}`);

  const proc: ChildProcess = spawn(
    bin,
    [
      '--model',
      voice,
      '--output_raw',
      '--quiet',
      /* Slightly faster than default; tuneable per voice taste. */
      '--length_scale',
      '0.95',
    ],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(bin),
    },
  );

  /* Feed text on stdin and close to signal "synthesize this and exit". */
  proc.stdin?.write(text);
  proc.stdin?.end();

  let done: () => void;
  const donePromise = new Promise<void>((resolve) => {
    done = resolve;
  });

  proc.on('exit', () => {
    done!();
  });
  proc.stderr?.on('data', () => {
    /* swallowed; piper logs progress to stderr */
  });

  /* The stdout stream IS our PCM. Wrap so cancel can break it cleanly. */
  const pcm = proc.stdout as Readable;

  const cancel = () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };

  return {
    pcm,
    sampleRate: getRate(),
    cancel,
    done: donePromise,
  };
}

/**
 * Buffer the entire synth output into a single PCM buffer. Convenience
 * for non-streaming callers (e.g. the dashboard's "test voice" button).
 * Real-time playback uses synthesize() and pipes pcm directly.
 */
export async function synthesizeToBuffer(text: string): Promise<{
  pcm: Buffer;
  sampleRate: number;
  ms: number;
}> {
  const t0 = Date.now();
  const h = synthesize(text);
  const chunks: Buffer[] = [];
  for await (const c of h.pcm) chunks.push(c as Buffer);
  await h.done;
  return {
    pcm: Buffer.concat(chunks),
    sampleRate: h.sampleRate,
    ms: Date.now() - t0,
  };
}

/**
 * Wrap raw PCM in a 16-bit mono WAV header so the browser can play it
 * directly via an <audio> element or AudioBufferSourceNode without
 * AudioWorklet plumbing. Mostly used for the smoke-test endpoint.
 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const samples = pcm.length / 2;
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  void samples;
  return buf;
}
