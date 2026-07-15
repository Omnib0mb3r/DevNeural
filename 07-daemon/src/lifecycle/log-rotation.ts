/**
 * Size-based rotation for the daemon's append-only log sink.
 *
 * Observability hardening finding F1: daemon.log grew unrotated to
 * 130MB / 1.13M lines (93% of it one historical error's spam) because
 * the appendFileSync sink had no size cap at all. This module adds a
 * single rotated generation: once daemon.log crosses maxBytes, it is
 * renamed to daemon.log.1 (replacing any prior .1) and a fresh file
 * starts on the next write.
 *
 * The size check is deliberately NOT run on every write. A stat() call
 * per log line would put filesystem I/O on the hot path of every
 * logger() call across the daemon. Instead the check cadence is
 * gated by writes-since-last-check OR elapsed time, whichever comes
 * first (defaults: every 1000 writes or 60s), so a quiet period still
 * gets checked promptly and a noisy burst doesn't wait a full minute.
 *
 * Because the check is periodic rather than per-write, the file can
 * overshoot maxBytes by up to one cadence window's worth of writes
 * before rotation catches it. That's an accepted tradeoff: exact
 * byte-cap enforcement isn't the goal, keeping the file bounded and
 * the logger cheap is.
 */
import * as fs from 'node:fs';

export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_CHECK_EVERY_WRITES = 1000;
export const DEFAULT_CHECK_EVERY_MS = 60_000;

export interface LogRotationOptions {
  /** Absolute path to the log file being appended to. */
  filePath: string;
  /** Rotate once the file exceeds this many bytes. */
  maxBytes?: number;
  /** Re-check the file size at most once per this many writes. */
  checkEveryWrites?: number;
  /** Re-check the file size at most once per this many elapsed ms. */
  checkEveryMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Renames filePath -> filePath + '.1', replacing any existing '.1'
 * generation, so exactly one rotated generation is ever kept.
 * Best-effort: a failed rename (e.g. another process holding the
 * handle) is swallowed so a rotation hiccup never takes the logger
 * itself down. Returns true when a rotation actually happened.
 */
export function rotateLogFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.renameSync(filePath, `${filePath}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether filePath currently exceeds maxBytes and rotates it
 * if so. Cheap (one stat + maybe one rename); callers decide how
 * often this runs via the cadence gating in createRotatingAppender.
 */
export function maybeRotate(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): boolean {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  return rotateLogFile(filePath);
}

/**
 * Wraps a raw append-only writer with periodic size-based rotation.
 * Returns a write(line) function that appends synchronously to
 * filePath and, at the configured cadence, checks the file size and
 * rotates daemon.log -> daemon.log.1 when it exceeds maxBytes.
 */
export function createRotatingAppender(
  opts: LogRotationOptions,
): (line: string) => void {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const checkEveryWrites = opts.checkEveryWrites ?? DEFAULT_CHECK_EVERY_WRITES;
  const checkEveryMs = opts.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS;
  const now = opts.now ?? Date.now;
  let writesSinceCheck = 0;
  let lastCheckMs = now();

  return (line: string): void => {
    fs.appendFileSync(opts.filePath, line, 'utf-8');
    writesSinceCheck += 1;
    const elapsed = now() - lastCheckMs;
    if (writesSinceCheck < checkEveryWrites && elapsed < checkEveryMs) {
      return;
    }
    writesSinceCheck = 0;
    lastCheckMs = now();
    maybeRotate(opts.filePath, maxBytes);
  };
}
