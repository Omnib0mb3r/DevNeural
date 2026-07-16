/**
 * Semantic turn detection (src/voice/smart-turn.ts).
 *
 * Pins:
 *   1. decideCoalesce hold/merge state machine, exhaustively (pure).
 *   2. isSmartTurnEnabled cascade + DB-unavailable fallback.
 *   3. analyzeTurn 'unavailable' paths with the model pointed at a
 *      temp dir. Model inference itself is NOT unit-tested (no model
 *      file in CI); vitest's VITEST env var plus the temp data root
 *      guarantee no test ever downloads or touches the real model.
 *   4. PCM preprocessing helpers (conversion, resample, tail window,
 *      normalization).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SMART_TURN_HOLD_MS,
  SMART_TURN_MODEL_FILENAME,
  _resetSmartTurnForTests,
  analyzeTurn,
  decideCoalesce,
  emptyCoalescerState,
  ensureSmartTurnModel,
  isSmartTurnEnabled,
  normalizeWaveform,
  pcm16ToFloat32,
  resampleLinear,
  smartTurnHoldWindowMs,
  smartTurnModelExists,
  smartTurnModelPath,
  tailWindow,
  type TurnCoalescerState,
} from '../src/voice/smart-turn.js';

const SAVED_ENV_KEYS = [
  'DEVNEURAL_DATA_ROOT',
  'DEVNEURAL_SMART_TURN',
  'DEVNEURAL_SMART_TURN_HOLD_MS',
  'DEVNEURAL_SMART_TURN_NO_DOWNLOAD',
  'DEVNEURAL_SMART_TURN_MODEL_URL',
  'DEVNEURAL_SMART_TURN_MODEL_SHA256',
  'DEVNEURAL_SMART_TURN_THRESHOLD',
] as const;

let savedEnv: Record<string, string | undefined>;
let tmpRoot: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k];
  tmpRoot = fs
    .mkdtempSync(path.join(os.tmpdir(), 'smart-turn-test-'))
    .replace(/\\/g, '/');
  process.env.DEVNEURAL_DATA_ROOT = tmpRoot;
  delete process.env.DEVNEURAL_SMART_TURN;
  delete process.env.DEVNEURAL_SMART_TURN_HOLD_MS;
  delete process.env.DEVNEURAL_SMART_TURN_NO_DOWNLOAD;
  delete process.env.DEVNEURAL_SMART_TURN_MODEL_URL;
  delete process.env.DEVNEURAL_SMART_TURN_MODEL_SHA256;
  delete process.env.DEVNEURAL_SMART_TURN_THRESHOLD;
  _resetSmartTurnForTests();
});

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetSmartTurnForTests();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows can hold the dir briefly; temp cleanup is best-effort */
  }
});

function held(text: string, sinceMs: number): TurnCoalescerState {
  return { heldText: text, heldSinceMs: sinceMs };
}

/* ───────────────────── decideCoalesce (pure) ────────────────────── */

describe('decideCoalesce', () => {
  const HOLD = 1600;

  it('processes a complete verdict with no held text', () => {
    const d = decideCoalesce(emptyCoalescerState(), 'complete', 'ship it', 1000, HOLD);
    expect(d.action).toBe('process');
    expect(d.text).toBe('ship it');
    expect(d.nextState).toEqual({ heldText: null, heldSinceMs: 0 });
  });

  it('processes an unavailable verdict with no held text (fail-open)', () => {
    const d = decideCoalesce(emptyCoalescerState(), 'unavailable', 'ship it', 1000, HOLD);
    expect(d.action).toBe('process');
    expect(d.text).toBe('ship it');
    expect(d.nextState.heldText).toBeNull();
  });

  it('holds an incomplete verdict and stamps heldSinceMs with nowMs', () => {
    const d = decideCoalesce(emptyCoalescerState(), 'incomplete', 'so what I want is', 5000, HOLD);
    expect(d.action).toBe('hold');
    expect(d.text).toBe('so what I want is');
    expect(d.nextState).toEqual({ heldText: 'so what I want is', heldSinceMs: 5000 });
  });

  it('appends a second incomplete utterance and keeps the FIRST heldSinceMs', () => {
    const first = decideCoalesce(emptyCoalescerState(), 'incomplete', 'so what I want is', 5000, HOLD);
    const second = decideCoalesce(first.nextState, 'incomplete', 'a smarter endpointer', 5900, HOLD);
    expect(second.action).toBe('hold');
    expect(second.text).toBe('so what I want is a smarter endpointer');
    expect(second.nextState.heldText).toBe('so what I want is a smarter endpointer');
    expect(second.nextState.heldSinceMs).toBe(5000);
  });

  it('prepends held text on a complete verdict and clears state', () => {
    const d = decideCoalesce(held('so what I want is', 5000), 'complete', 'a smarter endpointer', 5800, HOLD);
    expect(d.action).toBe('process');
    expect(d.text).toBe('so what I want is a smarter endpointer');
    expect(d.nextState).toEqual({ heldText: null, heldSinceMs: 0 });
  });

  it('prepends held text on an unavailable verdict and clears state', () => {
    const d = decideCoalesce(held('hold my thought', 5000), 'unavailable', 'and continue', 5800, HOLD);
    expect(d.action).toBe('process');
    expect(d.text).toBe('hold my thought and continue');
    expect(d.nextState.heldText).toBeNull();
  });

  it('still merges but processes immediately when the held text expired (complete verdict)', () => {
    const d = decideCoalesce(held('stale thought', 1000), 'complete', 'finally done', 1000 + HOLD + 1, HOLD);
    expect(d.action).toBe('process');
    expect(d.text).toBe('stale thought finally done');
    expect(d.nextState.heldText).toBeNull();
  });

  it('still merges but processes immediately when the held text expired, even on incomplete', () => {
    const d = decideCoalesce(held('stale thought', 1000), 'incomplete', 'still rambling', 1000 + HOLD + 1, HOLD);
    expect(d.action).toBe('process');
    expect(d.text).toBe('stale thought still rambling');
    expect(d.nextState.heldText).toBeNull();
  });

  it('treats age exactly equal to the window as NOT expired (strict >)', () => {
    const d = decideCoalesce(held('right on the line', 1000), 'incomplete', 'more words', 1000 + HOLD, HOLD);
    expect(d.action).toBe('hold');
    expect(d.nextState.heldSinceMs).toBe(1000);
  });

  it('flush pattern: complete verdict with empty text releases held text alone', () => {
    const d = decideCoalesce(held('flush me', 1000), 'complete', '', 2000, HOLD);
    expect(d.action).toBe('process');
    expect(d.text).toBe('flush me');
    expect(d.nextState.heldText).toBeNull();
  });

  it('never holds emptiness: incomplete verdict with empty text and no held state is a no-op process', () => {
    const d = decideCoalesce(emptyCoalescerState(), 'incomplete', '   ', 2000, HOLD);
    expect(d.action).toBe('process');
    expect(d.text).toBe('');
    expect(d.nextState.heldText).toBeNull();
  });

  it('joins with a single space and trims ragged whitespace', () => {
    const first = decideCoalesce(emptyCoalescerState(), 'incomplete', '  first part  ', 100, HOLD);
    const done = decideCoalesce(first.nextState, 'complete', '  second part ', 200, HOLD);
    expect(done.text).toBe('first part second part');
  });

  it('does not mutate the input state object', () => {
    const state = held('immutable', 1000);
    decideCoalesce(state, 'incomplete', 'suffix', 1100, HOLD);
    expect(state).toEqual({ heldText: 'immutable', heldSinceMs: 1000 });
  });

  it('uses the env-configured default hold window when the arg is omitted', () => {
    process.env.DEVNEURAL_SMART_TURN_HOLD_MS = '100';
    const d = decideCoalesce(held('old', 1000), 'incomplete', 'new', 1201);
    expect(d.action).toBe('process');
    expect(d.text).toBe('old new');
  });
});

describe('smartTurnHoldWindowMs', () => {
  it('defaults to 1600ms', () => {
    expect(smartTurnHoldWindowMs()).toBe(DEFAULT_SMART_TURN_HOLD_MS);
    expect(DEFAULT_SMART_TURN_HOLD_MS).toBe(1600);
  });

  it('honors DEVNEURAL_SMART_TURN_HOLD_MS', () => {
    process.env.DEVNEURAL_SMART_TURN_HOLD_MS = '2500';
    expect(smartTurnHoldWindowMs()).toBe(2500);
  });

  it('falls back to the default on garbage or non-positive values', () => {
    process.env.DEVNEURAL_SMART_TURN_HOLD_MS = 'soon';
    expect(smartTurnHoldWindowMs()).toBe(1600);
    process.env.DEVNEURAL_SMART_TURN_HOLD_MS = '-5';
    expect(smartTurnHoldWindowMs()).toBe(1600);
    process.env.DEVNEURAL_SMART_TURN_HOLD_MS = '0';
    expect(smartTurnHoldWindowMs()).toBe(1600);
  });
});

/* ─────────────────────── isSmartTurnEnabled ─────────────────────── */

describe('isSmartTurnEnabled', () => {
  const dbWith = (value: string | null) => ({
    getRuntimeConfig: (key: string) =>
      key === 'voice_smart_turn' ? value : null,
  });

  it('runtime_config on/off wins over everything', () => {
    process.env.DEVNEURAL_SMART_TURN = 'off';
    expect(isSmartTurnEnabled(dbWith('on'))).toBe(true);
    process.env.DEVNEURAL_SMART_TURN = 'on';
    expect(isSmartTurnEnabled(dbWith('off'))).toBe(false);
  });

  it('parses the usual toggle spellings', () => {
    for (const v of ['on', 'true', '1', 'yes']) {
      expect(isSmartTurnEnabled(dbWith(v))).toBe(true);
    }
    for (const v of ['off', 'false', '0', 'no']) {
      expect(isSmartTurnEnabled(dbWith(v))).toBe(false);
    }
  });

  it('unparseable runtime_config falls through to the env toggle', () => {
    process.env.DEVNEURAL_SMART_TURN = 'on';
    expect(isSmartTurnEnabled(dbWith('garbage'))).toBe(true);
    process.env.DEVNEURAL_SMART_TURN = 'off';
    expect(isSmartTurnEnabled(dbWith('garbage'))).toBe(false);
  });

  it('defaults OFF when the model file does not exist', () => {
    expect(isSmartTurnEnabled(dbWith(null))).toBe(false);
  });

  it('defaults ON when the model file exists', () => {
    const modelPath = smartTurnModelPath();
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, Buffer.alloc(1_100_000));
    expect(isSmartTurnEnabled(dbWith(null))).toBe(true);
  });

  it('a tiny (truncated) model file does not count as present', () => {
    const modelPath = smartTurnModelPath();
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, Buffer.from('not a real model'));
    expect(isSmartTurnEnabled(dbWith(null))).toBe(false);
    expect(smartTurnModelExists()).toBe(false);
  });

  it('never crashes when the db read throws', () => {
    const throwing = {
      getRuntimeConfig: () => {
        throw new Error('db is gone');
      },
    };
    expect(isSmartTurnEnabled(throwing)).toBe(false);
    process.env.DEVNEURAL_SMART_TURN = 'on';
    expect(isSmartTurnEnabled(throwing)).toBe(true);
  });

  it('never crashes when no db is passed and the store singleton is uninitialised', () => {
    /* getStore() throws before daemon boot; the toggle must swallow
     * that and fall through the cascade. */
    expect(isSmartTurnEnabled()).toBe(false);
    process.env.DEVNEURAL_SMART_TURN = 'on';
    expect(isSmartTurnEnabled()).toBe(true);
  });
});

/* ──────────────── analyzeTurn unavailable paths ─────────────────── */

describe('analyzeTurn (no model, no network)', () => {
  it('reports unavailable when the model file is missing, without downloading', async () => {
    const pcm = Buffer.alloc(16_000 * 2); // 1s of silence
    const verdict = await analyzeTurn(pcm, 16_000);
    expect(verdict).toBe('unavailable');
    /* VITEST env blocks downloads; nothing may appear on disk. */
    expect(fs.existsSync(smartTurnModelPath())).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'models'))).toBe(false);
  });

  it('reports unavailable for an empty or too-short buffer', async () => {
    expect(await analyzeTurn(Buffer.alloc(0), 16_000)).toBe('unavailable');
    expect(await analyzeTurn(Buffer.alloc(100), 16_000)).toBe('unavailable');
  });

  it('reports unavailable for a nonsense sample rate', async () => {
    const pcm = Buffer.alloc(16_000 * 2);
    expect(await analyzeTurn(pcm, 0)).toBe('unavailable');
    expect(await analyzeTurn(pcm, -8)).toBe('unavailable');
    expect(await analyzeTurn(pcm, Number.NaN)).toBe('unavailable');
  });

  it('reports unavailable (never throws, never loads ORT) when the model file is corrupt', async () => {
    /* onnxruntime-node 1.14 hard-exits the process on a malformed
     * model instead of rejecting (verified on this machine), so the
     * sha256 gate in loadSession is what keeps this test (and the
     * daemon) alive: the garbage file must be rejected BEFORE the
     * native loader ever maps it. */
    const modelPath = smartTurnModelPath();
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    /* Big enough to pass the size floor, but not the pinned sha256. */
    fs.writeFileSync(modelPath, Buffer.alloc(1_100_000, 7));
    const pcm = Buffer.alloc(16_000 * 2);
    const verdict = await analyzeTurn(pcm, 16_000);
    expect(verdict).toBe('unavailable');
  });

  it('honors a DEVNEURAL_SMART_TURN_MODEL_SHA256 pin override', async () => {
    const modelPath = smartTurnModelPath();
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    const bytes = Buffer.alloc(1_100_000, 9);
    fs.writeFileSync(modelPath, bytes);
    /* Pin an arbitrary wrong hash: still unavailable, still alive. */
    process.env.DEVNEURAL_SMART_TURN_MODEL_SHA256 = 'ab'.repeat(32);
    const verdict = await analyzeTurn(Buffer.alloc(16_000 * 2), 16_000);
    expect(verdict).toBe('unavailable');
  });

  it('ensureSmartTurnModel is a guarded no-op under vitest', async () => {
    const result = await ensureSmartTurnModel();
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(tmpRoot, 'models'))).toBe(false);
  });

  it('model filename is pinned to the pipecat production model', () => {
    expect(SMART_TURN_MODEL_FILENAME).toBe('smart-turn-v3.2-cpu.onnx');
    expect(smartTurnModelPath()).toBe(
      `${tmpRoot}/models/smart-turn/smart-turn-v3.2-cpu.onnx`,
    );
  });
});

/* ─────────────────── preprocessing helpers ──────────────────────── */

describe('pcm16ToFloat32', () => {
  it('converts little-endian int16 to [-1, 1) float32', () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(16384, 2);
    buf.writeInt16LE(-16384, 4);
    buf.writeInt16LE(-32768, 6);
    const f = pcm16ToFloat32(buf);
    expect(Array.from(f)).toEqual([0, 0.5, -0.5, -1]);
  });

  it('ignores a trailing odd byte', () => {
    const buf = Buffer.alloc(3);
    expect(pcm16ToFloat32(buf).length).toBe(1);
  });
});

describe('resampleLinear', () => {
  it('passes 16k audio through untouched', () => {
    const x = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(x, 16_000, 16_000)).toBe(x);
  });

  it('halves the sample count from 32k to 16k', () => {
    const x = new Float32Array(3200);
    expect(resampleLinear(x, 32_000, 16_000).length).toBe(1600);
  });

  it('interpolates between neighbors', () => {
    const x = new Float32Array([0, 1]);
    const out = resampleLinear(x, 1, 3);
    expect(out.length).toBe(6);
    expect(out[0]).toBe(0);
    expect(out[5]).toBe(1);
    /* strictly increasing ramp */
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThan(out[i - 1]!);
    }
  });
});

describe('tailWindow', () => {
  it('zero-pads at the BEGINNING so the speech tail sits at the window end', () => {
    const x = new Float32Array([0.5, 0.25]);
    const w = tailWindow(x);
    expect(w.length).toBe(128_000);
    expect(w[0]).toBe(0);
    expect(w[127_998]).toBe(0.5);
    expect(w[127_999]).toBe(0.25);
  });

  it('keeps the LAST 8 seconds of longer audio', () => {
    const x = new Float32Array(128_100);
    x[99] = 0.7; // dropped: within the first 100 samples
    x[100] = 0.9; // first surviving sample
    x[128_099] = 0.4; // final sample survives at the very end
    const w = tailWindow(x);
    expect(w.length).toBe(128_000);
    expect(w[0]).toBe(Math.fround(0.9));
    expect(w[127_999]).toBe(Math.fround(0.4));
    expect(w.includes(Math.fround(0.7))).toBe(false);
  });

  it('returns exact-size input as-is', () => {
    const x = new Float32Array(128_000);
    expect(tailWindow(x)).toBe(x);
  });
});

describe('normalizeWaveform', () => {
  it('produces zero mean and unit variance', () => {
    const x = new Float32Array(1000);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 7) * 0.3 + 0.1;
    normalizeWaveform(x);
    let sum = 0;
    for (const v of x) sum += v;
    const mean = sum / x.length;
    let varSum = 0;
    for (const v of x) varSum += (v - mean) ** 2;
    expect(Math.abs(mean)).toBeLessThan(1e-4);
    expect(varSum / x.length).toBeCloseTo(1, 2);
  });

  it('leaves pure silence finite (eps guards the divide)', () => {
    const x = new Float32Array(100);
    normalizeWaveform(x);
    for (const v of x) expect(v).toBe(0);
  });
});
