/**
 * Session audio bundle (Wave 2 day 2 step 11 / BF-11 / A4).
 *
 * Canonical on-disk layout per session: one <id>.wav (or <id>.opus
 * in future, when an encoder lands) plus a sibling <id>.cues.json
 * listing { turn_index, start_ms, end_ms }. The voice WS calls
 * appendUtterance() as each utterance transcribes; the session-end
 * pipeline calls finalize() to atomically write both files and stamp
 * brainstorm_sessions.audio_path.
 *
 * Memory profile: PCM bytes stream straight to a per-session .pcm.tmp
 * file (append mode), so even multi-hour sessions only hold the cue
 * array in memory. Finalize prepends the WAV header by writing
 * <id>.wav as header + the temp file's contents, then deletes the
 * tmp. Cues + path writes use the standard atomic dance (write to
 * .tmp, fsync, rename) so a crash mid-write never leaves a corrupt
 * cue file alongside a valid audio file.
 *
 * Consent gating: callers must check brainstorm_sessions.kind +
 * consent_acked BEFORE invoking appendUtterance(); this module trusts
 * the caller. discard() is the kill switch for the meetings-without-
 * consent case (BF-17 / spec line 281).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  brainstormAudioDir,
  brainstormAudioFile,
  brainstormCuesFile,
  ensureDir,
} from '../paths.js';

export interface AudioCue {
  turn_index: number;
  start_ms: number;
  end_ms: number;
}

interface SessionAudioState {
  brainstormId: string;
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  totalPcmBytes: number;
  cues: AudioCue[];
  pcmTmpPath: string;
}

const STATE_BY_ID = new Map<string, SessionAudioState>();

function getOrCreate(brainstormId: string, sampleRate: number): SessionAudioState {
  let s = STATE_BY_ID.get(brainstormId);
  if (s) return s;
  const dir = brainstormAudioDir(brainstormId);
  ensureDir(dir);
  const pcmTmpPath = path.posix.join(dir, `${brainstormId}.pcm.tmp`);
  /* Truncate any stale tmp from a prior crashed session so we don't
   * concatenate two unrelated sessions' audio. */
  try {
    if (fs.existsSync(pcmTmpPath)) fs.unlinkSync(pcmTmpPath);
  } catch {
    /* best-effort cleanup */
  }
  s = {
    brainstormId,
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
    totalPcmBytes: 0,
    cues: [],
    pcmTmpPath,
  };
  STATE_BY_ID.set(brainstormId, s);
  return s;
}

/* Append one transcribed utterance's PCM frames + the matching cue
 * window. Cue start_ms is computed from the running PCM byte count so
 * the offset is exact (no drift from timer-based timestamps). */
export function appendUtterance(
  brainstormId: string,
  pcm: Buffer,
  sampleRate: number,
): void {
  if (pcm.length === 0) return;
  if (sampleRate <= 0) return;
  const s = getOrCreate(brainstormId, sampleRate);
  /* Sample rate must stay constant across utterances or the cue
   * offsets stop being meaningful. Drop the utterance if a caller
   * misconfigures rather than write a corrupt bundle. */
  if (s.sampleRate !== sampleRate) return;
  const bytesPerSecond = s.sampleRate * s.channels * (s.bitsPerSample / 8);
  const start_ms = Math.round((s.totalPcmBytes / bytesPerSecond) * 1000);
  const durMs = Math.round((pcm.length / bytesPerSecond) * 1000);
  fs.appendFileSync(s.pcmTmpPath, pcm);
  s.totalPcmBytes += pcm.length;
  s.cues.push({
    turn_index: s.cues.length,
    start_ms,
    end_ms: start_ms + durMs,
  });
}

/* Finalise the bundle: write <id>.wav (header + PCM) and <id>.cues.json,
 * remove the tmp, and return the data-root-relative audio path to
 * stamp on brainstorm_sessions.audio_path. Returns null when no audio
 * was ever appended (text-only session) so the caller leaves
 * audio_path NULL. */
export function finalize(brainstormId: string): {
  audioPath: string;
  cuesPath: string;
  cueCount: number;
  bytes: number;
} | null {
  const s = STATE_BY_ID.get(brainstormId);
  if (!s) return null;
  STATE_BY_ID.delete(brainstormId);
  if (s.totalPcmBytes === 0) {
    try {
      if (fs.existsSync(s.pcmTmpPath)) fs.unlinkSync(s.pcmTmpPath);
    } catch {
      /* nothing to clean */
    }
    return null;
  }
  const wavPath = brainstormAudioFile(s.brainstormId, 'wav');
  const cuesPath = brainstormCuesFile(s.brainstormId);
  const wavTmp = `${wavPath}.tmp`;
  const cuesTmp = `${cuesPath}.tmp`;
  const header = buildWavHeader(s.totalPcmBytes, s.sampleRate, s.channels, s.bitsPerSample);
  /* Stream the tmp PCM into the new WAV: open the output for write,
   * write header, copy bytes from tmp via a read stream piped into
   * the write stream. fs.copyFileSync is the simplest implementation
   * but it would require us to write the header AFTER copying then
   * seek, which is awkward; instead read+write byte by byte via a
   * read-stream pipe through an fd. The session sizes we target
   * (multi-hour worst-case) fit comfortably in a single-pass stream. */
  const outFd = fs.openSync(wavTmp, 'w');
  try {
    fs.writeSync(outFd, header);
    const inFd = fs.openSync(s.pcmTmpPath, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      let off = 0;
      while (off < s.totalPcmBytes) {
        const n = fs.readSync(inFd, buf, 0, buf.length, off);
        if (n <= 0) break;
        fs.writeSync(outFd, buf, 0, n);
        off += n;
      }
    } finally {
      fs.closeSync(inFd);
    }
    fs.fsyncSync(outFd);
  } finally {
    fs.closeSync(outFd);
  }
  fs.renameSync(wavTmp, wavPath);
  /* Cues JSON: write tmp, fsync, rename. Same atomic pattern. */
  const cuesPayload = JSON.stringify(
    {
      session_id: s.brainstormId,
      sample_rate: s.sampleRate,
      channels: s.channels,
      bits_per_sample: s.bitsPerSample,
      cues: s.cues,
    },
    null,
    2,
  );
  const cuesFd = fs.openSync(cuesTmp, 'w');
  try {
    fs.writeSync(cuesFd, cuesPayload);
    fs.fsyncSync(cuesFd);
  } finally {
    fs.closeSync(cuesFd);
  }
  fs.renameSync(cuesTmp, cuesPath);
  try {
    fs.unlinkSync(s.pcmTmpPath);
  } catch {
    /* leaving the tmp around does not break correctness */
  }
  return {
    audioPath: wavPath,
    cuesPath,
    cueCount: s.cues.length,
    bytes: s.totalPcmBytes,
  };
}

/* Abort: discard any in-memory state + tmp file. Used by the meeting-
 * without-consent path (BF-17 / spec line 281). Idempotent. */
export function discard(brainstormId: string): void {
  const s = STATE_BY_ID.get(brainstormId);
  STATE_BY_ID.delete(brainstormId);
  if (!s) return;
  try {
    if (fs.existsSync(s.pcmTmpPath)) fs.unlinkSync(s.pcmTmpPath);
  } catch {
    /* best-effort */
  }
}

/* Test-only: snapshot the active accumulator without finalising. */
export function _peek(brainstormId: string): {
  cues: AudioCue[];
  totalPcmBytes: number;
} | null {
  const s = STATE_BY_ID.get(brainstormId);
  if (!s) return null;
  return { cues: [...s.cues], totalPcmBytes: s.totalPcmBytes };
}

function buildWavHeader(
  pcmBytes: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataLen = pcmBytes;
  const riffLen = 36 + dataLen;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(riffLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); /* PCM */
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}
