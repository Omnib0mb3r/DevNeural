/* Cold-start report persistence (sliver 3, 2026-06-19).
 *
 * The investigator block is the seed Lex boots from. Until now it lived
 * only in an in-memory cache (lex-investigator.ts), so a daemon restart
 * lost it and the next cold start fell back to the deterministic
 * assembler. This module persists each block as a timestamped report on
 * disk so the seed survives a restart - the only durable artifact in the
 * ephemeral-investigator design.
 *
 * Layout: one folder per anchor, scope-isolated by anchorId, under the
 * existing per-anchor brainstorm tree:
 *
 *   <DATA_ROOT>/brainstorms/<anchorId>/cold-start/<epoch-ms>.md
 *
 * The filename IS the timestamp (epoch ms, fixed-width-sortable through
 * year 2286), so a lexical sort is a chronological sort and the newest
 * file is the active seed. The newest report's ms is also the
 * last-clean-boot marker crash recovery (sliver 4) reads jsonl after.
 *
 * Retention: nothing is discarded automatically (the full history is the
 * audit trail that catches "we said it was fixed and it wasn't").
 * pruneColdStartReports is an explicit opt-in cap for operators who want
 * the folder lean.
 *
 * Every function is best-effort: a write/read failure returns null / []
 * rather than throwing, matching the fail-safe posture of the rest of
 * the investigator. The file == the seed (no second copy), so this never
 * becomes a rival "what's going on" doc next to the rolling handover.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { DATA_ROOT } from '../paths.js';

/* Lazy data-root read so tests that set DEVNEURAL_DATA_ROOT per-case
 * (after paths.ts froze its const at import) still resolve to the tmp
 * dir. Falls back to the frozen const, then the prod default. */
function dataRoot(): string {
  return (
    process.env.DEVNEURAL_DATA_ROOT?.replace(/\\/g, '/') ?? DATA_ROOT
  );
}

export function coldStartReportDir(anchorId: string): string {
  return nodePath.posix.join(
    dataRoot(),
    'brainstorms',
    anchorId,
    'cold-start',
  );
}

export interface ColdStartReportRef {
  /** Absolute path to the report file. */
  path: string;
  /** Epoch ms parsed from the filename = when the report was written. */
  ms: number;
}

const REPORT_RE = /^(\d{10,})\.md$/;

/* Persist a block as a timestamped report. Returns the path, or null on
 * an empty block / write failure (best-effort, never throws). */
export function writeColdStartReport(
  anchorId: string,
  block: string,
  nowMs: number,
): string | null {
  if (!anchorId || !block || !block.trim()) return null;
  try {
    const dir = coldStartReportDir(anchorId);
    nodeFs.mkdirSync(dir, { recursive: true });
    const file = nodePath.posix.join(dir, `${nowMs}.md`);
    nodeFs.writeFileSync(file, block, 'utf8');
    return file;
  } catch {
    return null;
  }
}

/* Every report for an anchor, newest-first. Files that don't match the
 * <ms>.md pattern are ignored so a stray file never breaks ordering. */
export function listColdStartReports(anchorId: string): ColdStartReportRef[] {
  const dir = coldStartReportDir(anchorId);
  let entries: string[];
  try {
    entries = nodeFs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ColdStartReportRef[] = [];
  for (const name of entries) {
    const m = REPORT_RE.exec(name);
    if (!m) continue;
    out.push({ path: nodePath.posix.join(dir, name), ms: Number(m[1]) });
  }
  out.sort((a, b) => b.ms - a.ms);
  return out;
}

/* The newest report (the active seed / last-clean-boot marker), with its
 * block content read from disk. null when none exists or it can't be
 * read. */
export function readLatestColdStartReport(
  anchorId: string,
): { path: string; ms: number; block: string } | null {
  const reports = listColdStartReports(anchorId);
  if (reports.length === 0) return null;
  const latest = reports[0]!;
  try {
    const block = nodeFs.readFileSync(latest.path, 'utf8');
    if (!block.trim()) return null;
    return { path: latest.path, ms: latest.ms, block };
  } catch {
    return null;
  }
}

/* Explicit retention cap: keep the newest `retain` reports, delete the
 * rest. retain <= 0 is a no-op (unlimited). Best-effort; returns the
 * count actually deleted. Never called automatically - persistence
 * archives by default. */
export function pruneColdStartReports(
  anchorId: string,
  retain: number,
): number {
  if (retain <= 0) return 0;
  const reports = listColdStartReports(anchorId);
  if (reports.length <= retain) return 0;
  let deleted = 0;
  for (const r of reports.slice(retain)) {
    try {
      nodeFs.unlinkSync(r.path);
      deleted += 1;
    } catch {
      /* leave it; best-effort */
    }
  }
  return deleted;
}
