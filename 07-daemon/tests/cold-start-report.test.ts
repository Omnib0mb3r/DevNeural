/**
 * Cold-start report persistence (sliver 3).
 *
 * Pins: write -> file at brainstorms/<id>/cold-start/<ms>.md; list +
 * read return newest-first; scope isolation per anchor; prune caps
 * retention without touching the newest; best-effort null/empty paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  coldStartReportDir,
  writeColdStartReport,
  listColdStartReports,
  readLatestColdStartReport,
  pruneColdStartReports,
} from '../src/lex/cold-start-report.js';

let tmpDir: string;
let prior: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-csr-'));
  prior = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (prior === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = prior;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cold-start-report persistence', () => {
  it('writes a timestamped report under the per-anchor cold-start dir', () => {
    const out = writeColdStartReport('anchor-1', '# seed block', 1_700_000_000_000);
    expect(out).not.toBeNull();
    const dir = coldStartReportDir('anchor-1');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, '1700000000000.md'))).toBe(true);
    expect(fs.readFileSync(out!, 'utf8')).toBe('# seed block');
  });

  it('returns null on an empty/whitespace block (no file written)', () => {
    expect(writeColdStartReport('anchor-2', '   ', 1_700_000_000_000)).toBeNull();
    expect(listColdStartReports('anchor-2')).toEqual([]);
  });

  it('lists reports newest-first and ignores non-matching files', () => {
    writeColdStartReport('anchor-3', 'older', 1_700_000_000_000);
    writeColdStartReport('anchor-3', 'newer', 1_700_000_060_000);
    /* Stray non-report file must be ignored. */
    fs.writeFileSync(path.join(coldStartReportDir('anchor-3'), 'notes.txt'), 'x');
    const list = listColdStartReports('anchor-3');
    expect(list.map((r) => r.ms)).toEqual([1_700_000_060_000, 1_700_000_000_000]);
  });

  it('reads the newest report block', () => {
    writeColdStartReport('anchor-4', 'OLD SEED', 1_700_000_000_000);
    writeColdStartReport('anchor-4', 'NEW SEED', 1_700_000_120_000);
    const latest = readLatestColdStartReport('anchor-4');
    expect(latest?.block).toBe('NEW SEED');
    expect(latest?.ms).toBe(1_700_000_120_000);
  });

  it('returns null when no report exists', () => {
    expect(readLatestColdStartReport('nobody')).toBeNull();
    expect(listColdStartReports('nobody')).toEqual([]);
  });

  it('isolates reports per anchor (no cross-read)', () => {
    writeColdStartReport('anchor-a', 'A-SEED', 1_700_000_000_000);
    writeColdStartReport('anchor-b', 'B-SEED', 1_700_000_000_000);
    expect(readLatestColdStartReport('anchor-a')?.block).toBe('A-SEED');
    expect(readLatestColdStartReport('anchor-b')?.block).toBe('B-SEED');
    expect(listColdStartReports('anchor-a')).toHaveLength(1);
  });

  it('prune keeps the newest N and deletes the rest', () => {
    for (let i = 0; i < 5; i++) {
      writeColdStartReport('anchor-p', `seed ${i}`, 1_700_000_000_000 + i * 60_000);
    }
    const deleted = pruneColdStartReports('anchor-p', 2);
    expect(deleted).toBe(3);
    const remaining = listColdStartReports('anchor-p');
    expect(remaining).toHaveLength(2);
    /* Newest two survive. */
    expect(remaining.map((r) => r.ms)).toEqual([
      1_700_000_000_000 + 4 * 60_000,
      1_700_000_000_000 + 3 * 60_000,
    ]);
  });

  it('prune is a no-op for retain <= 0 or when under the cap', () => {
    writeColdStartReport('anchor-q', 'one', 1_700_000_000_000);
    expect(pruneColdStartReports('anchor-q', 0)).toBe(0);
    expect(pruneColdStartReports('anchor-q', 10)).toBe(0);
    expect(listColdStartReports('anchor-q')).toHaveLength(1);
  });
});
