/**
 * Observability hardening (F1) - daemon.log size-based rotation.
 *
 * Drives createRotatingAppender / maybeRotate / rotateLogFile
 * directly against a temp file with tiny thresholds injected through
 * options, so the test never has to write anywhere near 32MB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRotatingAppender,
  maybeRotate,
  rotateLogFile,
  DEFAULT_MAX_BYTES,
  DEFAULT_CHECK_EVERY_WRITES,
  DEFAULT_CHECK_EVERY_MS,
} from '../src/lifecycle/log-rotation.js';

let tmpDir: string;
let logFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-logrot-'));
  logFile = path.join(tmpDir, 'daemon.log');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('rotateLogFile', () => {
  it('renames the file to .1', () => {
    fs.writeFileSync(logFile, 'hello\n', 'utf-8');
    const rotated = rotateLogFile(logFile);
    expect(rotated).toBe(true);
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.readFileSync(`${logFile}.1`, 'utf-8')).toBe('hello\n');
  });

  it('replaces an existing .1 generation instead of accumulating', () => {
    fs.writeFileSync(`${logFile}.1`, 'old generation\n', 'utf-8');
    fs.writeFileSync(logFile, 'new generation\n', 'utf-8');
    rotateLogFile(logFile);
    expect(fs.readFileSync(`${logFile}.1`, 'utf-8')).toBe('new generation\n');
  });

  it('returns false and does nothing when the source file is missing', () => {
    expect(rotateLogFile(logFile)).toBe(false);
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
  });
});

describe('maybeRotate', () => {
  it('rotates when the file exceeds maxBytes', () => {
    fs.writeFileSync(logFile, 'x'.repeat(100), 'utf-8');
    const rotated = maybeRotate(logFile, 50);
    expect(rotated).toBe(true);
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
  });

  it('does not rotate when the file is under maxBytes', () => {
    fs.writeFileSync(logFile, 'x'.repeat(10), 'utf-8');
    const rotated = maybeRotate(logFile, 50);
    expect(rotated).toBe(false);
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
  });

  it('returns false when the file does not exist yet', () => {
    expect(maybeRotate(logFile, 50)).toBe(false);
  });

  it('exports sane production defaults', () => {
    expect(DEFAULT_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(DEFAULT_CHECK_EVERY_WRITES).toBe(1000);
    expect(DEFAULT_CHECK_EVERY_MS).toBe(60_000);
  });
});

describe('createRotatingAppender', () => {
  it('appends every write to the file', () => {
    const write = createRotatingAppender({ filePath: logFile, maxBytes: 1_000_000 });
    write('line one\n');
    write('line two\n');
    expect(fs.readFileSync(logFile, 'utf-8')).toBe('line one\nline two\n');
  });

  it('rotates once the write-count cadence trips and the file is over maxBytes, keeping exactly one generation', () => {
    /* Each line is 10 bytes ("0123456789\n" is 11, use fixed 10-char
     * lines for a predictable total). maxBytes=25 means the 3rd write
     * (30 bytes total) crosses the threshold; checkEveryWrites=3 means
     * the cadence gate opens on exactly that write. */
    const write = createRotatingAppender({
      filePath: logFile,
      maxBytes: 25,
      checkEveryWrites: 3,
      checkEveryMs: 10 * 60_000,
    });
    write('0123456789\n'); // 11 bytes, write #1 - no check yet
    write('0123456789\n'); // 22 bytes, write #2 - no check yet
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    write('0123456789\n'); // 33 bytes, write #3 - cadence trips, 33 > 25 -> rotate
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    /* Original 33-byte generation preserved in .1. */
    expect(fs.readFileSync(`${logFile}.1`, 'utf-8')).toBe(
      '0123456789\n'.repeat(3),
    );
    /* daemon.log does not exist until the next write recreates it,
     * matching production behaviour where appendFileSync recreates a
     * missing file on the very next call. */
    write('0123456789\n');
    expect(fs.readFileSync(logFile, 'utf-8')).toBe('0123456789\n');
  });

  it('does not rotate before the write-count cadence, even when already over maxBytes', () => {
    const write = createRotatingAppender({
      filePath: logFile,
      maxBytes: 5,
      checkEveryWrites: 1000,
      checkEveryMs: 10 * 60_000,
    });
    for (let i = 0; i < 10; i++) write('0123456789\n');
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    expect(fs.readFileSync(logFile, 'utf-8').length).toBeGreaterThan(5);
  });

  it('rotates on elapsed time even when the write-count cadence has not been reached', () => {
    let nowMs = 0;
    const write = createRotatingAppender({
      filePath: logFile,
      maxBytes: 5,
      checkEveryWrites: 1000,
      checkEveryMs: 1000,
      now: () => nowMs,
    });
    write('0123456789\n');
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    nowMs = 1500;
    write('0123456789\n');
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
  });

  it('replaces an existing .1 generation on each subsequent rotation instead of growing without bound', () => {
    /* checkEveryWrites=2: cadence opens on every 2nd write, so each
     * rotated .1 generation holds exactly two lines before being
     * replaced wholesale by the next pair. */
    const write = createRotatingAppender({
      filePath: logFile,
      maxBytes: 5,
      checkEveryWrites: 2,
      checkEveryMs: 10 * 60_000,
    });
    write('generation-a\n');
    write('generation-b\n'); // cadence trips, over maxBytes -> rotate
    const afterFirst = fs.readFileSync(`${logFile}.1`, 'utf-8');
    expect(afterFirst).toContain('generation-a');
    expect(afterFirst).toContain('generation-b');
    write('generation-c\n');
    write('generation-d\n'); // cadence trips again -> .1 replaced wholesale
    const afterSecond = fs.readFileSync(`${logFile}.1`, 'utf-8');
    expect(afterSecond).toContain('generation-c');
    expect(afterSecond).not.toContain('generation-a');
  });
});
