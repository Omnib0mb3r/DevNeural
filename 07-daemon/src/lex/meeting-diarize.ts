/**
 * Post-session meeting diarization (2026-07-15).
 *
 * Wraps the standalone `diarize.py` CLI (whisperx large-v3 + pyannote
 * speaker-diarization-community-1, GPU-only) as an opt-in step that
 * runs after a meeting's audio bundle finalizes. diarize.py's real
 * contract (read from C:/dev/Projects/transcribe/diarize.py):
 *
 *   python diarize.py <audio_or_video> <output_dir> [num_speakers]
 *
 *   - requires HF_TOKEN or HUGGINGFACE_TOKEN in the environment;
 *     missing token -> prints an error and exits with code 2.
 *   - writes <output_dir>/<stem>_diarized.txt (speaker-grouped plain
 *     text, NO per-utterance timestamps) and
 *     <output_dir>/<stem>_diarized.srt (one entry per utterance, with
 *     "HH:MM:SS,mmm --> HH:MM:SS,mmm" timing and a "[SPEAKER_XX] text"
 *     body line) where stem is the input file's basename without
 *     extension.
 *   - on success prints "DONE\n..." to stdout; on any other failure
 *     it either exits non-zero (unhandled exception) or exits 2 (no
 *     token).
 *
 * Only the .srt output carries timestamps, so segment construction
 * parses that file; the .txt file is not required.
 *
 * Storage: brainstorm_chunks (migration 003) has no start_ms/end_ms
 * columns, only turn_index, and created_at is a wall-clock write
 * time rather than an audio-relative offset. There is no reliable
 * time-overlap alignment onto chunk rows without guessing, so parsed
 * segments land in the dedicated meeting_diarization table (migration
 * 050) instead. See src/store/index-db.ts MeetingDiarizationRow /
 * insertMeetingDiarizationSegments.
 *
 * Speaker naming: diarize.py's raw labels (SPEAKER_00, SPEAKER_01,
 * ...) are kept verbatim on every stored row. A best-effort guess at
 * the human name is stored alongside by walking the session's
 * comma-separated attendees field in list order (SPEAKER_00 ->
 * attendees[0], SPEAKER_01 -> attendees[1], ...). This is only a
 * starting guess -- pyannote's speaker index order has no relation to
 * attendee list order -- so the raw label is never overwritten.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Store } from '../store/index.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PYTHON_BIN = 'python';
const DEFAULT_SCRIPT_PATH = 'C:/dev/Projects/transcribe/diarize.py';
/* diarize.py's own stdout / real-time progress can be long-running;
 * cap what we buffer from stderr for error reporting so a runaway
 * traceback can't balloon memory. */
const MAX_STDERR_CAPTURE = 4000;

export type DiarizeSkipReason =
  | 'session_not_found'
  | 'not_meeting'
  | 'no_consent'
  | 'no_wav'
  | 'no_hf_token'
  | 'spawn_error'
  | 'nonzero_exit'
  | 'timeout'
  | 'no_output'
  | 'no_segments';

export interface DiarizeSegment {
  startMs: number;
  endMs: number;
  /** Raw diarize.py / pyannote label, e.g. "SPEAKER_00". */
  speaker: string;
  /** Best-effort attendees-list mapping; null when the session has no
   * attendees recorded or the speaker index runs past the list. */
  speakerGuess: string | null;
  text: string;
}

export interface MeetingDiarizeResult {
  ok: boolean;
  skipped?: DiarizeSkipReason;
  error?: string;
  segments?: DiarizeSegment[];
  storedCount?: number;
}

/* Minimal structural shape of a spawned child process -- matches
 * node:child_process's ChildProcess closely enough for our purposes
 * (stdout/stderr data events, error, close) while staying easy to
 * fake in tests without a real EventEmitter subclass requirement. */
export interface DiarizeChildProcess {
  stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill?: (signal?: NodeJS.Signals | number) => boolean | void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => DiarizeChildProcess;

const defaultSpawnFn: SpawnFn = (command, args, options) =>
  spawn(command, args as string[], options) as unknown as DiarizeChildProcess;

export interface MeetingDiarizeDeps {
  store: Store;
  log?: (msg: string) => void;
  /** Test seam: replaces node:child_process spawn. */
  spawnFn?: SpawnFn;
  /** Test seam: overrides process.env lookups. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** True when either variable diarize.py itself checks is present.
 * Exported so the session-end-pipeline trigger can pre-flight the
 * same check before firing the async task (avoids spawning python
 * only to have it exit 2). */
export function hasHfToken(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HF_TOKEN?.trim() || env.HUGGINGFACE_TOKEN?.trim());
}

/** Split the session's comma-separated attendees field (see
 * PATCH /meetings/:id in dashboard/routes.ts) into a trimmed,
 * order-preserved list. */
export function parseAttendees(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Map "SPEAKER_00" -> attendees[0], "SPEAKER_01" -> attendees[1], etc.
 * Returns null for non-standard labels or when the index runs past
 * the attendees list (more speakers detected than named attendees, or
 * no attendees recorded at all). */
export function mapSpeakerToAttendee(
  speakerLabel: string,
  attendees: string[],
): string | null {
  const m = /^SPEAKER_0*(\d+)$/i.exec(speakerLabel.trim());
  if (!m) return null;
  const idx = Number(m[1]);
  if (!Number.isFinite(idx) || idx < 0 || idx >= attendees.length) return null;
  return attendees[idx] ?? null;
}

const SRT_TIME_RE = /(\d{2}):(\d{2}):(\d{2}),(\d{3})/;

function srtTimeToMs(match: RegExpExecArray): number {
  const [, h, m, s, ms] = match;
  return (
    Number(h) * 3_600_000 +
    Number(m) * 60_000 +
    Number(s) * 1_000 +
    Number(ms)
  );
}

/** Parse diarize.py's <stem>_diarized.srt output into raw segments
 * (speaker label not yet mapped to an attendee guess). Each SRT block
 * is:
 *   <index>
 *   HH:MM:SS,mmm --> HH:MM:SS,mmm
 *   [SPEAKER_XX] utterance text
 *   <blank line>
 * Tolerant of \r\n line endings and blocks missing the leading index
 * line; skips any block it cannot parse a timing range + speaker tag
 * from rather than throwing, since a partially-malformed run should
 * still yield the segments it can. */
export function parseDiarizedSrt(
  text: string,
): Array<{ startMs: number; endMs: number; speaker: string; text: string }> {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const segments: Array<{
    startMs: number;
    endMs: number;
    speaker: string;
    text: string;
  }> = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;

    const [rawStart, rawEnd] = lines[timingIdx]!.split('-->').map((p) => p.trim());
    if (!rawStart || !rawEnd) continue;
    const startMatch = SRT_TIME_RE.exec(rawStart);
    const endMatch = SRT_TIME_RE.exec(rawEnd);
    if (!startMatch || !endMatch) continue;

    const bodyText = lines.slice(timingIdx + 1).join(' ').trim();
    if (!bodyText) continue;
    const speakerMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(bodyText);
    const speaker = speakerMatch ? speakerMatch[1]!.trim() : 'UNKNOWN';
    const spokenText = speakerMatch ? speakerMatch[2]!.trim() : bodyText;
    if (!spokenText) continue;

    segments.push({
      startMs: srtTimeToMs(startMatch),
      endMs: srtTimeToMs(endMatch),
      speaker,
      text: spokenText,
    });
  }

  return segments;
}

interface ResolvedSession {
  wavPath: string;
  attendees: string[];
}

type ResolveOutcome =
  | { ok: true; session: ResolvedSession }
  | { ok: false; skipped: DiarizeSkipReason };

function resolveSession(sessionId: string, store: Store): ResolveOutcome {
  const row = store.db.getBrainstorm(sessionId);
  if (!row) return { ok: false, skipped: 'session_not_found' };
  if ((row.kind ?? 'brainstorm') !== 'meeting') {
    return { ok: false, skipped: 'not_meeting' };
  }
  if ((row.consent_acked ?? 0) !== 1) {
    return { ok: false, skipped: 'no_consent' };
  }
  const wavPath = row.audio_path ?? null;
  if (!wavPath || !fs.existsSync(wavPath)) {
    return { ok: false, skipped: 'no_wav' };
  }
  return {
    ok: true,
    session: { wavPath, attendees: parseAttendees(row.attendees) },
  };
}

interface ProcessOutcome {
  ok: boolean;
  reason?: DiarizeSkipReason;
  detail?: string;
}

function runDiarizeProcess(
  spawnFn: SpawnFn,
  pythonBin: string,
  args: string[],
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let child: DiarizeChildProcess;

    const finish = (outcome: ProcessOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.kill?.();
      } catch {
        /* already gone */
      }
      resolve(outcome);
    };

    try {
      child = spawnFn(pythonBin, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, reason: 'spawn_error', detail: (err as Error).message });
      return;
    }

    let stderr = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf-8')).slice(-MAX_STDERR_CAPTURE);
    });

    const timer = setTimeout(() => {
      log(`[meeting-diarize] process exceeded ${timeoutMs}ms; killing`);
      finish({ ok: false, reason: 'timeout', detail: `exceeded ${timeoutMs}ms` });
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: false, reason: 'spawn_error', detail: err.message });
    });

    child.on('close', (code: number | null) => {
      if (code === 2) {
        /* diarize.py's own no-token exit code (defensive backstop;
         * the pre-spawn hasHfToken() check should normally catch this
         * first since the child inherits the parent env). */
        finish({ ok: false, reason: 'no_hf_token', detail: stderr });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, reason: 'nonzero_exit', detail: `exit ${code}: ${stderr}` });
        return;
      }
      finish({ ok: true });
    });
  });
}

/** Resolve, gate, run diarize.py, parse its .srt output, and persist
 * segments to meeting_diarization. sessionId is a brainstorm_sessions
 * row id (kind='meeting'). Never throws; every failure path resolves
 * a MeetingDiarizeResult with `ok: false` and a `skipped` reason. */
export async function runMeetingDiarization(
  sessionId: string,
  deps: MeetingDiarizeDeps,
): Promise<MeetingDiarizeResult> {
  const log = deps.log ?? (() => undefined);
  const env = deps.env ?? process.env;
  const spawnFn = deps.spawnFn ?? defaultSpawnFn;

  const resolved = resolveSession(sessionId, deps.store);
  if (!resolved.ok) {
    log(`[meeting-diarize] session=${sessionId} skipped: ${resolved.skipped}`);
    return { ok: false, skipped: resolved.skipped };
  }

  if (!hasHfToken(env)) {
    log(`[meeting-diarize] session=${sessionId} skipped: no_hf_token`);
    return { ok: false, skipped: 'no_hf_token' };
  }

  const pythonBin = env.DEVNEURAL_DIARIZE_PY?.trim() || DEFAULT_PYTHON_BIN;
  const scriptPath = env.DEVNEURAL_DIARIZE_SCRIPT?.trim() || DEFAULT_SCRIPT_PATH;
  const timeoutRaw = Number(env.DEVNEURAL_DIARIZE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS;

  const wavPath = resolved.session.wavPath.replace(/\\/g, '/');
  const outDir = path.posix.dirname(wavPath);
  const stem = path.posix.basename(wavPath).replace(/\.[^./]+$/, '');
  const srtPath = path.posix.join(outDir, `${stem}_diarized.srt`);

  log(`[meeting-diarize] session=${sessionId} starting: ${pythonBin} ${scriptPath} ${wavPath} ${outDir}`);
  const processResult = await runDiarizeProcess(
    spawnFn,
    pythonBin,
    [scriptPath, wavPath, outDir],
    timeoutMs,
    log,
  );
  if (!processResult.ok) {
    log(
      `[meeting-diarize] session=${sessionId} failed: ${processResult.reason} ${processResult.detail ?? ''}`,
    );
    return { ok: false, skipped: processResult.reason, error: processResult.detail };
  }

  if (!fs.existsSync(srtPath)) {
    log(`[meeting-diarize] session=${sessionId} no_output: expected ${srtPath}`);
    return { ok: false, skipped: 'no_output', error: `srt not found at ${srtPath}` };
  }

  const srtText = fs.readFileSync(srtPath, 'utf-8');
  const rawSegments = parseDiarizedSrt(srtText);
  if (rawSegments.length === 0) {
    log(`[meeting-diarize] session=${sessionId} no_segments parsed from ${srtPath}`);
    return { ok: false, skipped: 'no_segments' };
  }

  const attendees = resolved.session.attendees;
  const segments: DiarizeSegment[] = rawSegments.map((seg) => ({
    ...seg,
    speakerGuess: mapSpeakerToAttendee(seg.speaker, attendees),
  }));

  const rows = segments.map((seg) => ({
    id: randomUUID(),
    session_id: sessionId,
    start_ms: seg.startMs,
    end_ms: seg.endMs,
    speaker: seg.speaker,
    speaker_guess: seg.speakerGuess,
    text: seg.text,
  }));
  const storedCount = deps.store.db.insertMeetingDiarizationSegments(rows);

  const speakerCount = new Set(segments.map((s) => s.speaker)).size;
  log(
    `[meeting-diarize] session=${sessionId} stored ${storedCount} segments across ${speakerCount} speakers`,
  );

  return { ok: true, segments, storedCount };
}
