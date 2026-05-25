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
import { DATA_ROOT } from '../paths.js';

const DEFAULT_BIN = 'C:/dev/piper/piper/piper.exe';
const DEFAULT_VOICE_DIR = 'C:/dev/piper/voices';
/* en_GB-alan-medium is the closest to a "Jarvis" timbre out of the
 * voices we currently ship: deep British male, calm cadence. We
 * default to it; the dashboard picker can flip per-conversation. */
const DEFAULT_VOICE_FILE = 'en_GB-alan-medium.onnx';

/* Active voice override set at runtime by the dashboard. Persists
 * for the lifetime of the daemon process; survives across sessions
 * via the disk file so a daemon restart doesn't reset preference.
 *
 * Originally wrapped in a try/catch with require() to "avoid circular
 * deps". The project is `"type": "module"` so require() always threw,
 * the catch swallowed it, and VOICE_PREF_FILE silently became "".
 * Every read/write then early-exited as a no-op: setters returned
 * ok:true but never persisted, getters never re-hydrated, sliders
 * appeared to work but reset on every daemon restart. Switched to a
 * plain static ESM import; there is no circular dep here. */
const VOICE_PREF_FILE = path.posix.join(
  DATA_ROOT.replace(/\\/g, '/'),
  'voice-preferences.json',
);

let cachedActiveVoice: string | null = null;
let cachedLengthScale: number | null = null;
let cachedBargeCooldownMs: number | null = null;
let cachedVadSensitivity: number | null = null;
let cachedMicGain: number | null = null;
let cachedVadRedemptionMs: number | null = null;

/* Default barge-in cooldown after tts-start. Bedroom-mic feedback was
 * triggering self-barge: Lex's own audio bled into the mic, VAD fired
 * speech-start, the client interrupted Lex and re-injected the captured
 * echo as a new turn. 250ms is enough to swallow the initial chunk
 * without making barge-in feel sluggish for real interruptions. */
const DEFAULT_BARGE_COOLDOWN_MS = 250;
const MIN_BARGE_COOLDOWN_MS = 0;
const MAX_BARGE_COOLDOWN_MS = 2000;

/* Piper's --length_scale baseline for the dashboard's "1.0x speed".
 * Lower = faster, higher = slower. 0.475 was the previous hardcoded
 * value (roughly 2x of piper's own default 1.0). User-facing speed
 * multiplier is inverted: ui_speed=1.0 keeps this baseline; ui_speed=
 * 0.5 doubles length_scale (twice as slow). */
const BASE_LENGTH_SCALE = 0.475;
const MIN_LENGTH_SCALE = 0.25;
const MAX_LENGTH_SCALE = 1.5;

/* VAD sensitivity. 0 = least sensitive (high speech threshold, ignores
 * background noise), 1 = most sensitive (low threshold, fires on any
 * sound). 0.5 reproduces the legacy hardcoded thresholds
 * positiveSpeechThreshold=0.5 / negativeSpeechThreshold=0.4. The client
 * computes the actual silero thresholds from this single knob. */
const DEFAULT_VAD_SENSITIVITY = 0.5;
const MIN_VAD_SENSITIVITY = 0;
const MAX_VAD_SENSITIVITY = 1;

/* Mic input gain. Multiplier applied to captured float samples before
 * the int16 conversion that ships to whisper. 1.0 = passthrough,
 * <1 quieter, >1 louder. Cap at 3.0 so a runaway slider can't blow
 * out the int16 range too aggressively (clipping still occurs above
 * ~1.5 for already-loud sources). */
const DEFAULT_MIC_GAIN = 1.0;
const MIN_MIC_GAIN = 0;
const MAX_MIC_GAIN = 3.0;

/* VAD end-of-utterance redemption window. How long after the last
 * detected speech frame silero waits before declaring end-of-
 * utterance and shipping the buffer. Higher = more tolerance for
 * mid-sentence pauses (fewer cut-off words at the cost of more
 * dead air before Lex starts thinking). 768ms reproduces the
 * legacy hardcoded 24-frame value (silero frames are 32ms at
 * 16kHz). The client converts ms → frames at VAD init time. */
const DEFAULT_VAD_REDEMPTION_MS = 768;
const MIN_VAD_REDEMPTION_MS = 200;
const MAX_VAD_REDEMPTION_MS = 6000;

function readPersistedPrefs(): {
  voice?: string;
  length_scale?: number;
  barge_cooldown_ms?: number;
  vad_sensitivity?: number;
  mic_gain?: number;
  vad_redemption_ms?: number;
} {
  if (!VOICE_PREF_FILE) return {};
  try {
    if (!fs.existsSync(VOICE_PREF_FILE)) return {};
    return JSON.parse(fs.readFileSync(VOICE_PREF_FILE, 'utf-8')) as {
      voice?: string;
      length_scale?: number;
      barge_cooldown_ms?: number;
      vad_sensitivity?: number;
      mic_gain?: number;
    };
  } catch {
    return {};
  }
}

function readPersistedVoice(): string | null {
  return readPersistedPrefs().voice ?? null;
}

function readPersistedLengthScale(): number | null {
  const v = Number(readPersistedPrefs().length_scale);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function writePersistedPrefs(patch: {
  voice?: string;
  length_scale?: number;
  barge_cooldown_ms?: number;
  vad_sensitivity?: number;
  mic_gain?: number;
  vad_redemption_ms?: number;
}): void {
  if (!VOICE_PREF_FILE) return;
  try {
    const merged = { ...readPersistedPrefs(), ...patch };
    fs.writeFileSync(
      VOICE_PREF_FILE,
      JSON.stringify(merged, null, 2),
      'utf-8',
    );
  } catch {
    /* ignore */
  }
}

function writePersistedVoice(voice: string): void {
  writePersistedPrefs({ voice });
}

function getLengthScale(): number {
  if (cachedLengthScale !== null) return cachedLengthScale;
  const persisted = readPersistedLengthScale();
  if (persisted !== null) {
    cachedLengthScale = clampLengthScale(persisted);
    return cachedLengthScale;
  }
  cachedLengthScale = BASE_LENGTH_SCALE;
  return cachedLengthScale;
}

function clampLengthScale(v: number): number {
  if (!Number.isFinite(v)) return BASE_LENGTH_SCALE;
  if (v < MIN_LENGTH_SCALE) return MIN_LENGTH_SCALE;
  if (v > MAX_LENGTH_SCALE) return MAX_LENGTH_SCALE;
  return v;
}

/* User-facing speed multiplier <-> length_scale. ui_speed = BASE / ls,
 * so 1.0 = baseline. Persisted as length_scale so the math stays
 * authoritative even if BASE changes. */
export function getActiveSpeed(): number {
  return BASE_LENGTH_SCALE / getLengthScale();
}

function clampBargeCooldownMs(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_BARGE_COOLDOWN_MS;
  if (v < MIN_BARGE_COOLDOWN_MS) return MIN_BARGE_COOLDOWN_MS;
  if (v > MAX_BARGE_COOLDOWN_MS) return MAX_BARGE_COOLDOWN_MS;
  return Math.round(v);
}

function readPersistedBargeCooldownMs(): number | null {
  const v = Number(readPersistedPrefs().barge_cooldown_ms);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export function getBargeCooldownMs(): number {
  if (cachedBargeCooldownMs !== null) return cachedBargeCooldownMs;
  const persisted = readPersistedBargeCooldownMs();
  cachedBargeCooldownMs = persisted !== null
    ? clampBargeCooldownMs(persisted)
    : DEFAULT_BARGE_COOLDOWN_MS;
  return cachedBargeCooldownMs;
}

export function setBargeCooldownMs(ms: number): {
  ok: boolean;
  barge_cooldown_ms: number;
} {
  if (!Number.isFinite(ms) || ms < 0) {
    return { ok: false, barge_cooldown_ms: getBargeCooldownMs() };
  }
  const clamped = clampBargeCooldownMs(ms);
  cachedBargeCooldownMs = clamped;
  writePersistedPrefs({ barge_cooldown_ms: clamped });
  return { ok: true, barge_cooldown_ms: clamped };
}

function clampVadSensitivity(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VAD_SENSITIVITY;
  if (v < MIN_VAD_SENSITIVITY) return MIN_VAD_SENSITIVITY;
  if (v > MAX_VAD_SENSITIVITY) return MAX_VAD_SENSITIVITY;
  return v;
}

function readPersistedVadSensitivity(): number | null {
  const v = Number(readPersistedPrefs().vad_sensitivity);
  return Number.isFinite(v) ? v : null;
}

export function getVadSensitivity(): number {
  if (cachedVadSensitivity !== null) return cachedVadSensitivity;
  const persisted = readPersistedVadSensitivity();
  cachedVadSensitivity = persisted !== null
    ? clampVadSensitivity(persisted)
    : DEFAULT_VAD_SENSITIVITY;
  return cachedVadSensitivity;
}

export function setVadSensitivity(value: number): {
  ok: boolean;
  vad_sensitivity: number;
} {
  if (!Number.isFinite(value)) {
    return { ok: false, vad_sensitivity: getVadSensitivity() };
  }
  const clamped = clampVadSensitivity(value);
  cachedVadSensitivity = clamped;
  writePersistedPrefs({ vad_sensitivity: clamped });
  return { ok: true, vad_sensitivity: clamped };
}

function clampMicGain(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_MIC_GAIN;
  if (v < MIN_MIC_GAIN) return MIN_MIC_GAIN;
  if (v > MAX_MIC_GAIN) return MAX_MIC_GAIN;
  return v;
}

function readPersistedMicGain(): number | null {
  const v = Number(readPersistedPrefs().mic_gain);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export function getMicGain(): number {
  if (cachedMicGain !== null) return cachedMicGain;
  const persisted = readPersistedMicGain();
  cachedMicGain = persisted !== null
    ? clampMicGain(persisted)
    : DEFAULT_MIC_GAIN;
  return cachedMicGain;
}

export function setMicGain(value: number): {
  ok: boolean;
  mic_gain: number;
} {
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, mic_gain: getMicGain() };
  }
  const clamped = clampMicGain(value);
  cachedMicGain = clamped;
  writePersistedPrefs({ mic_gain: clamped });
  return { ok: true, mic_gain: clamped };
}

function clampVadRedemptionMs(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VAD_REDEMPTION_MS;
  if (v < MIN_VAD_REDEMPTION_MS) return MIN_VAD_REDEMPTION_MS;
  if (v > MAX_VAD_REDEMPTION_MS) return MAX_VAD_REDEMPTION_MS;
  return Math.round(v);
}

function readPersistedVadRedemptionMs(): number | null {
  const v = Number(readPersistedPrefs().vad_redemption_ms);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function getVadRedemptionMs(): number {
  if (cachedVadRedemptionMs !== null) return cachedVadRedemptionMs;
  const persisted = readPersistedVadRedemptionMs();
  cachedVadRedemptionMs = persisted !== null
    ? clampVadRedemptionMs(persisted)
    : DEFAULT_VAD_REDEMPTION_MS;
  return cachedVadRedemptionMs;
}

export function setVadRedemptionMs(ms: number): {
  ok: boolean;
  vad_redemption_ms: number;
} {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { ok: false, vad_redemption_ms: getVadRedemptionMs() };
  }
  const clamped = clampVadRedemptionMs(ms);
  cachedVadRedemptionMs = clamped;
  writePersistedPrefs({ vad_redemption_ms: clamped });
  return { ok: true, vad_redemption_ms: clamped };
}

export function setActiveSpeed(uiSpeed: number): {
  ok: boolean;
  speed: number;
  length_scale: number;
} {
  if (!Number.isFinite(uiSpeed) || uiSpeed <= 0) {
    return {
      ok: false,
      speed: getActiveSpeed(),
      length_scale: getLengthScale(),
    };
  }
  const ls = clampLengthScale(BASE_LENGTH_SCALE / uiSpeed);
  cachedLengthScale = ls;
  writePersistedPrefs({ length_scale: ls });
  return { ok: true, speed: BASE_LENGTH_SCALE / ls, length_scale: ls };
}

function voiceDir(): string {
  return (process.env.DEVNEURAL_PIPER_VOICE_DIR || DEFAULT_VOICE_DIR).replace(
    /\\/g,
    '/',
  );
}

function getBin(): string {
  return (process.env.DEVNEURAL_PIPER_BIN || DEFAULT_BIN).replace(/\\/g, '/');
}

function resolveVoiceFile(name: string | null): string {
  /* Accept either a bare name (en_GB-alan-medium) or full path. */
  if (!name) name = DEFAULT_VOICE_FILE;
  const cleaned = name.replace(/\\/g, '/');
  if (cleaned.endsWith('.onnx') && fs.existsSync(cleaned)) return cleaned;
  /* Bare name → resolve under voiceDir. */
  const base = cleaned.replace(/\.onnx$/i, '');
  return path.posix.join(voiceDir(), `${base}.onnx`);
}

function getVoice(): string {
  /* Env var wins (operator-level override), then runtime cache, then
   * persisted preference, then default. */
  const env = process.env.DEVNEURAL_PIPER_VOICE;
  if (env) return resolveVoiceFile(env);
  if (cachedActiveVoice) return resolveVoiceFile(cachedActiveVoice);
  const persisted = readPersistedVoice();
  if (persisted) {
    cachedActiveVoice = persisted;
    return resolveVoiceFile(persisted);
  }
  return resolveVoiceFile(DEFAULT_VOICE_FILE);
}

function getRate(): number {
  /* Each Piper voice has its own native sample rate in the .onnx.json
   * config. We read the active voice's config to surface the correct
   * rate to the browser; without this the playback would be at the
   * wrong pitch when switching voices with different rates. */
  const v = Number(process.env.DEVNEURAL_PIPER_RATE || 0);
  if (Number.isFinite(v) && v > 0) return v;
  try {
    const onnx = getVoice();
    const cfg = onnx + '.json';
    if (fs.existsSync(cfg)) {
      const obj = JSON.parse(fs.readFileSync(cfg, 'utf-8')) as {
        audio?: { sample_rate?: number };
      };
      const r = obj.audio?.sample_rate;
      if (Number.isFinite(r) && (r as number) > 0) return r as number;
    }
  } catch {
    /* fall through */
  }
  return 22050;
}

export interface VoicePack {
  /** Bare name without .onnx suffix, e.g. "en_GB-alan-medium". */
  name: string;
  /** Absolute path to the .onnx model. */
  path: string;
  /** Sample rate from the voice's config. */
  sampleRate: number;
}

export function listVoices(): VoicePack[] {
  const dir = voiceDir();
  if (!fs.existsSync(dir)) return [];
  const out: VoicePack[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.onnx')) continue;
    const onnxPath = path.posix.join(dir, e.name);
    let sr = 22050;
    try {
      const cfgPath = onnxPath + '.json';
      if (fs.existsSync(cfgPath)) {
        const obj = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
          audio?: { sample_rate?: number };
        };
        if (Number.isFinite(obj.audio?.sample_rate)) {
          sr = obj.audio?.sample_rate as number;
        }
      }
    } catch {
      /* ignore */
    }
    out.push({
      name: e.name.replace(/\.onnx$/i, ''),
      path: onnxPath,
      sampleRate: sr,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function setActiveVoice(name: string): { ok: boolean; error?: string } {
  const file = resolveVoiceFile(name);
  if (!fs.existsSync(file)) {
    return { ok: false, error: `voice not installed: ${name}` };
  }
  cachedActiveVoice = name.replace(/\.onnx$/i, '').replace(/\\/g, '/');
  writePersistedVoice(cachedActiveVoice);
  return { ok: true };
}

export function getActiveVoice(): string {
  return getVoice()
    .split('/')
    .pop()!
    .replace(/\.onnx$/i, '');
}

export interface PiperStatus {
  configured: boolean;
  bin: string;
  voice: string;
  active_voice: string;
  rate: number;
  speed: number;
  length_scale: number;
  barge_cooldown_ms: number;
  vad_sensitivity: number;
  mic_gain: number;
  vad_redemption_ms: number;
  voices: VoicePack[];
}

export function piperStatus(): PiperStatus {
  return {
    configured: fs.existsSync(getBin()) && fs.existsSync(getVoice()),
    bin: getBin(),
    voice: getVoice(),
    active_voice: getActiveVoice(),
    rate: getRate(),
    speed: getActiveSpeed(),
    length_scale: getLengthScale(),
    barge_cooldown_ms: getBargeCooldownMs(),
    vad_sensitivity: getVadSensitivity(),
    mic_gain: getMicGain(),
    vad_redemption_ms: getVadRedemptionMs(),
    voices: listVoices(),
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
      /* User-tuneable via /voice/set-speed; persisted in
       * voice-preferences.json. Lower = faster, higher = slower.
       * Baseline 0.475 ≈ 2x default (current "1.0x" speed). */
      '--length_scale',
      String(getLengthScale()),
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
