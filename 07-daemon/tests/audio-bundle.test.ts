/**
 * Wave 2 day 2 step 11 (BF-11 / A4). audio-bundle finalises one
 * <id>.wav + <id>.cues.json per session. PCM streams to a tmp file
 * during the session; finalise prepends the WAV header and renames
 * to the canonical path. discard wipes state without writing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendUtterance,
  finalize,
  discard,
  _peek,
} from '../src/voice/audio-bundle.js';
import { brainstormAudioFile, brainstormCuesFile } from '../src/paths.js';

let tmpRoot: string;
let priorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-audio-bundle-'));
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpRoot;
});

afterEach(() => {
  /* Always reset env, even when an assertion threw, so the next test
   * gets a clean DATA_ROOT. */
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function pcm(len: number, fill: number): Buffer {
  const buf = Buffer.alloc(len * 2);
  for (let i = 0; i < len; i++) buf.writeInt16LE(fill, i * 2);
  return buf;
}

describe('audio-bundle', () => {
  it('appendUtterance accumulates cues with running ms offsets', () => {
    const id = 'bs-a-1';
    /* 16 kHz mono int16: 16000 samples = 1s. 800 samples = 50ms. */
    appendUtterance(id, pcm(800, 100), 16000);
    appendUtterance(id, pcm(1600, 200), 16000);
    const snap = _peek(id)!;
    expect(snap.cues).toEqual([
      { turn_index: 0, start_ms: 0, end_ms: 50 },
      { turn_index: 1, start_ms: 50, end_ms: 150 },
    ]);
    expect(snap.totalPcmBytes).toBe(800 * 2 + 1600 * 2);
    discard(id);
  });

  it('finalize writes <id>.wav + <id>.cues.json and stamps a riff header', () => {
    const id = 'bs-fin-1';
    appendUtterance(id, pcm(1600, 50), 16000);
    appendUtterance(id, pcm(3200, 60), 16000);
    const res = finalize(id);
    expect(res).not.toBeNull();
    if (!res) return;
    expect(res.audioPath).toBe(brainstormAudioFile(id, 'wav'));
    expect(res.cuesPath).toBe(brainstormCuesFile(id));
    expect(res.cueCount).toBe(2);

    const wav = fs.readFileSync(res.audioPath);
    expect(wav.slice(0, 4).toString()).toBe('RIFF');
    expect(wav.slice(8, 12).toString()).toBe('WAVE');
    expect(wav.slice(36, 40).toString()).toBe('data');
    /* 44-byte header + pcm bytes */
    expect(wav.length).toBe(44 + (1600 + 3200) * 2);
    const sampleRate = wav.readUInt32LE(24);
    expect(sampleRate).toBe(16000);
    const channels = wav.readUInt16LE(22);
    expect(channels).toBe(1);

    const cues = JSON.parse(fs.readFileSync(res.cuesPath, 'utf-8'));
    expect(cues.sample_rate).toBe(16000);
    expect(cues.channels).toBe(1);
    expect(cues.cues).toHaveLength(2);
    expect(cues.cues[0]).toEqual({ turn_index: 0, start_ms: 0, end_ms: 100 });
    expect(cues.cues[1].turn_index).toBe(1);
  });

  it('finalize returns null when no audio was ever appended', () => {
    expect(finalize('nope-' + Date.now())).toBeNull();
  });

  it('discard drops state without writing files', () => {
    const id = 'bs-discard-1';
    appendUtterance(id, pcm(800, 10), 16000);
    discard(id);
    expect(_peek(id)).toBeNull();
    expect(fs.existsSync(brainstormAudioFile(id, 'wav'))).toBe(false);
    expect(fs.existsSync(brainstormCuesFile(id))).toBe(false);
  });

  it('mismatched sample rate is dropped without corrupting the bundle', () => {
    const id = 'bs-rate-1';
    appendUtterance(id, pcm(800, 10), 16000);
    /* Second call passes a wrong rate; spec says we drop it rather
     * than write a corrupt cues file. The good first chunk stays. */
    appendUtterance(id, pcm(800, 10), 22050);
    const snap = _peek(id)!;
    expect(snap.cues).toHaveLength(1);
    discard(id);
  });
});
