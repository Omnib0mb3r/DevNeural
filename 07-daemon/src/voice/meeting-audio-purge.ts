/**
 * Wave 2 carry-over #4: meeting audio purge job.
 *
 * /meetings/:id derives `audio_purges_at` at read time
 * (ended_ms + DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS, default 30d) but
 * nothing actually deletes the file when the timestamp passes. This
 * module is the cron that walks every meeting row with an audio_path
 * set, keep_audio not pinned, and a passed audio_purges_at; it deletes
 * the on-disk WAV plus the matching cues JSON sidecar, then clears
 * audio_path via setBrainstormPhaseTwo (the safe writer that bypasses
 * the INSERT OR REPLACE round-trip).
 *
 * Idempotent: meetings with no audio_path, keep_audio=1, or no
 * ended_ms are skipped on every pass.
 */
import * as fs from 'node:fs';
import type { Store } from '../store/index.js';

const DEFAULT_MAX_AGE_DAYS = 30;

export interface PurgeOptions {
  maxAgeDays?: number;
  log?: (msg: string) => void;
  /* Test override: clock fixture so unit tests don't have to wait
   * 30 days of wall time. Defaults to Date.now(). */
  nowMs?: number;
}

export interface PurgeResult {
  scanned: number;
  purged: number;
  skipped_keep_audio: number;
  skipped_not_due: number;
  errors: number;
}

export function purgeMeetingAudio(
  store: Store,
  opts: PurgeOptions = {},
): PurgeResult {
  const maxAgeDays =
    opts.maxAgeDays ??
    Number(process.env.DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS ?? DEFAULT_MAX_AGE_DAYS);
  const log = opts.log ?? (() => undefined);
  const now = opts.nowMs ?? Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  const result: PurgeResult = {
    scanned: 0,
    purged: 0,
    skipped_keep_audio: 0,
    skipped_not_due: 0,
    errors: 0,
  };

  /* Direct better-sqlite3 query: list every meeting row that still has
   * an audio_path on it. The TS Store helpers don't expose a meeting
   * filter so this is the most direct path; the column shape is the
   * same as BrainstormSessionRow. */
  const dbHandle = (store.db as unknown as {
    db: import('better-sqlite3').Database;
  }).db;
  const rows = dbHandle
    .prepare(
      `SELECT id, audio_path, keep_audio, ended_ms
         FROM brainstorm_sessions
        WHERE kind = 'meeting'
          AND audio_path IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    audio_path: string | null;
    keep_audio: number | null;
    ended_ms: number | null;
  }>;

  for (const row of rows) {
    result.scanned += 1;
    if ((row.keep_audio ?? 0) === 1) {
      result.skipped_keep_audio += 1;
      continue;
    }
    if (!row.ended_ms || !row.audio_path) {
      result.skipped_not_due += 1;
      continue;
    }
    const purgeAt = row.ended_ms + maxAgeMs;
    if (now < purgeAt) {
      result.skipped_not_due += 1;
      continue;
    }
    try {
      if (fs.existsSync(row.audio_path)) {
        fs.unlinkSync(row.audio_path);
      }
      /* Sidecar cues file lives next to the wav under the same id
       * (see audio-bundle.finalize). Delete if present; absence is
       * fine because manually-imported audio may not have one. */
      const cuesPath = row.audio_path.replace(/\.wav$/i, '.cues.json');
      if (cuesPath !== row.audio_path && fs.existsSync(cuesPath)) {
        fs.unlinkSync(cuesPath);
      }
      store.db.setBrainstormPhaseTwo(row.id, { audio_path: null });
      result.purged += 1;
      log(`[meeting-audio-purge] removed ${row.audio_path} (meeting ${row.id})`);
    } catch (err) {
      result.errors += 1;
      log(
        `[meeting-audio-purge] failed for ${row.id}: ${(err as Error).message}`,
      );
    }
  }

  return result;
}
