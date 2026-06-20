/* Cold-start investigator reports (sliver 3; relocated 2026-06-20).
 *
 * The investigator block is the seed Lex boots from. It is persisted as a
 * timestamped report so the seed survives a daemon restart - the only
 * durable artifact in the ephemeral-investigator design.
 *
 * Location (operator requirement): reports live in the PROJECT folder, not
 * under an opaque anchor UUID, so the operator opens the project and the
 * reports are right there:
 *
 *   <projectDir>/investigator-reports/<YYYY-MM-DD_HHmm-ss>.md
 *   <projectDir>/investigator-reports/archive/   (older, never deleted)
 *
 * Project dir resolution, scope-isolated per project: the anchor's
 * project_session mapping (project_scope_id -> project_session.cwd) wins;
 * fall back to the spawning session cwd (the brainstorm row's cwd). All
 * anchors of one project share that project's investigator-reports folder;
 * the newest file is the active seed.
 *
 * Filenames are local wall-clock, lexically sortable (a string sort is a
 * chronological sort), so the operator can read them at a glance and the
 * newest sorts last. Retention archives, never deletes: writes keep the
 * newest few active and move older ones into archive/.
 *
 * Every function is best-effort: a write/read/resolve failure returns
 * null / [] rather than throwing, matching the fail-safe posture of the
 * rest of the investigator.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import type { IndexDb } from '../store/index-db.js';

/** Newest N reports kept in the active folder; older move to archive/. */
export const KEEP_ACTIVE_DEFAULT = 5;

/* Resolve the project dir for an anchor: project_session mapping first,
 * then the brainstorm's own cwd. null when neither resolves. */
export function resolveProjectDir(
  db: IndexDb,
  anchorId: string,
): string | null {
  let cwd: string | null = null;
  try {
    const bs = db.getBrainstorm(anchorId) as
      | { cwd?: string | null; project_scope_id?: string | null }
      | null;
    if (bs?.project_scope_id) {
      try {
        const ps = db.getProjectSession(bs.project_scope_id);
        if (ps?.cwd) cwd = ps.cwd;
      } catch {
        /* fall through to the brainstorm cwd */
      }
    }
    if (!cwd && bs?.cwd) cwd = bs.cwd;
  } catch {
    return null;
  }
  return cwd ? cwd.replace(/\\/g, '/') : null;
}

export function investigatorReportDir(
  db: IndexDb,
  anchorId: string,
): string | null {
  const projectDir = resolveProjectDir(db, anchorId);
  if (!projectDir) return null;
  return nodePath.posix.join(projectDir, 'investigator-reports');
}

function archiveDirFor(reportDir: string): string {
  return nodePath.posix.join(reportDir, 'archive');
}

export interface ColdStartReportRef {
  path: string;
  /** Epoch ms parsed back from the dated filename. */
  ms: number;
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})-(\d{2})\.md$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/* Local wall-clock stamp, lexically == chronologically sortable. */
export function formatReportStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function parseReportStamp(name: string): number | null {
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  ).getTime();
}

/* Persist a block as a dated report in the project's investigator-reports
 * folder, then archive older reports beyond keepActive. Returns the path,
 * or null on an empty block / unresolved project / write failure. */
export function writeColdStartReport(
  db: IndexDb,
  anchorId: string,
  block: string,
  nowMs: number,
  keepActive: number = KEEP_ACTIVE_DEFAULT,
): string | null {
  if (!anchorId || !block || !block.trim()) return null;
  const dir = investigatorReportDir(db, anchorId);
  if (!dir) return null;
  let file: string;
  try {
    nodeFs.mkdirSync(dir, { recursive: true });
    file = nodePath.posix.join(dir, `${formatReportStamp(nowMs)}.md`);
    nodeFs.writeFileSync(file, block, 'utf8');
  } catch {
    return null;
  }
  /* Archive older reports (never delete). Best-effort. */
  try {
    archiveOldReports(dir, keepActive);
  } catch {
    /* retention is best-effort; the report still wrote */
  }
  return file;
}

function readActiveRefs(dir: string): ColdStartReportRef[] {
  let entries: string[];
  try {
    entries = nodeFs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ColdStartReportRef[] = [];
  for (const name of entries) {
    const ms = parseReportStamp(name);
    if (ms === null) continue; // skips archive/ and any stray file
    out.push({ path: nodePath.posix.join(dir, name), ms });
  }
  out.sort((a, b) => b.ms - a.ms);
  return out;
}

/* Active reports for an anchor's project (archive excluded), newest-first. */
export function listColdStartReports(
  db: IndexDb,
  anchorId: string,
): ColdStartReportRef[] {
  const dir = investigatorReportDir(db, anchorId);
  if (!dir) return [];
  return readActiveRefs(dir);
}

/* The newest active report (the seed), with its block read from disk. */
export function readLatestColdStartReport(
  db: IndexDb,
  anchorId: string,
): { path: string; ms: number; block: string } | null {
  const reports = listColdStartReports(db, anchorId);
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

/* Move reports older than the newest keepActive into archive/. Never
 * deletes. Returns the count archived. */
function archiveOldReports(reportDir: string, keepActive: number): number {
  if (keepActive <= 0) return 0;
  const refs = readActiveRefs(reportDir);
  if (refs.length <= keepActive) return 0;
  const archive = archiveDirFor(reportDir);
  nodeFs.mkdirSync(archive, { recursive: true });
  let moved = 0;
  for (const r of refs.slice(keepActive)) {
    const dest = nodePath.posix.join(archive, nodePath.posix.basename(r.path));
    try {
      nodeFs.renameSync(r.path, dest);
      moved += 1;
    } catch {
      /* leave it active; best-effort */
    }
  }
  return moved;
}

/* Explicit archive pass: keep the newest keepActive active, move the rest
 * into archive/. Best-effort; returns the count archived. */
export function pruneColdStartReports(
  db: IndexDb,
  anchorId: string,
  keepActive: number = KEEP_ACTIVE_DEFAULT,
): number {
  const dir = investigatorReportDir(db, anchorId);
  if (!dir) return 0;
  try {
    return archiveOldReports(dir, keepActive);
  } catch {
    return 0;
  }
}
