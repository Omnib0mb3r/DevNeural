/**
 * Worker-side context handoff doc.
 *
 * Daemon-owned project worker sessions (CC sessions running in a
 * project anchor's cwd) only got a thin stop_hook_summary one-liner
 * carrying over /clear and fresh-session boundaries. Everything that
 * mattered, the active task spec, the next queued backlog items, the
 * blockers, the in-flight files, was lost. This builder produces a
 * structured handoff doc that the SessionStart hook injects as the
 * first turn of the new session so the worker resumes with the full
 * picture.
 *
 * Four sections in fixed order:
 *
 *   1. Where you left off
 *      - current branch
 *      - last commit subject (and short sha)
 *      - in-flight file edits (`git status --short`)
 *
 *   2. Active task
 *      - the backlog entry whose status === 'in-flight'
 *      - id + full title (which contains the acceptance criteria)
 *
 *   3. Next up
 *      - the next 2-3 backlog entries whose status is neither 'done'
 *        nor 'in-flight'
 *
 *   4. Open blockers
 *      - audit_findings rows with status='open' and severity='high'
 *      - capped so a noisy day cannot bury the rest of the doc
 *
 * Pure module: git runner, fs reader, db reader, and clock are
 * injected so tests drive every branch without touching the host's
 * git tree, /tmp, or the real db.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { IndexDb } from '../store/index-db.js';

export interface BacklogEntry {
  id: string;
  status?: string;
  title?: string;
  injected_at?: string;
  done_at?: string;
  resolution?: string;
}

export interface WorkerHandoffSections {
  where_left_off: {
    branch: string | null;
    last_commit_subject: string | null;
    last_commit_sha: string | null;
    in_flight_files: string[];
  };
  active_task: {
    id: string;
    title: string;
  } | null;
  next_up: Array<{
    id: string;
    title: string;
  }>;
  open_blockers: Array<{
    id: string;
    finding: string;
  }>;
}

export interface WorkerHandoffResult {
  ok: boolean;
  block: string;
  sections: WorkerHandoffSections;
  reason: 'rendered' | 'not-a-project-anchor' | 'no-cwd';
}

export interface BuildWorkerHandoffOptions {
  /** Working directory of the new CC session. */
  cwd: string | null | undefined;
  /** Daemon store. Used for the project-anchor lookup and the
   * audit_findings query. Pass null to skip the project-anchor gate
   * (tests that exercise the rendering path directly). */
  db: IndexDb | null;
  /** Path to the backlog queue JSON. Defaults to the env override or
   * c:/tmp/lex-backlog-queue.json. */
  backlogPath?: string;
  /** Test seam: git runner. Receives args and cwd, returns stdout or
   * null on failure. Defaults to a bounded execFileSync wrapper. */
  runGit?: (args: string[], cwd: string) => string | null;
  /** Test seam: fs reader for the backlog json. */
  readBacklog?: (path: string) => string | null;
  /** Test seam: clock for any future relative-time formatting. */
  now?: () => number;
  /** Cap on next-up entries. Default 3 per the user's spec
   * ("next 2-3 queued backlog items"). */
  nextUpLimit?: number;
  /** Cap on blocker entries so a noisy day cannot drown the doc. */
  blockerLimit?: number;
  /** Cap on in-flight files surfaced in the git-state section. */
  inFlightLimit?: number;
}

const DEFAULT_NEXT_UP_LIMIT = 3;
const DEFAULT_BLOCKER_LIMIT = 5;
const DEFAULT_IN_FLIGHT_LIMIT = 10;

function defaultBacklogPath(): string {
  return process.env.DEVNEURAL_BACKLOG_QUEUE_PATH ?? 'c:/tmp/lex-backlog-queue.json';
}

function defaultRunGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out;
  } catch {
    return null;
  }
}

function defaultReadBacklog(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function parseBacklog(raw: string | null): BacklogEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as BacklogEntry[];
    return [];
  } catch {
    return [];
  }
}

function buildGitState(
  cwd: string,
  runGit: (args: string[], cwd: string) => string | null,
  inFlightLimit: number,
): WorkerHandoffSections['where_left_off'] {
  const branchRaw = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = branchRaw ? branchRaw.trim() || null : null;
  const subjectRaw = runGit(['log', '-1', '--pretty=%s'], cwd);
  const last_commit_subject = subjectRaw ? subjectRaw.trim() || null : null;
  const shaRaw = runGit(['log', '-1', '--pretty=%h'], cwd);
  const last_commit_sha = shaRaw ? shaRaw.trim() || null : null;
  const statusRaw = runGit(['status', '--short'], cwd);
  const in_flight_files: string[] = [];
  if (statusRaw) {
    for (const line of statusRaw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      in_flight_files.push(trimmed);
      if (in_flight_files.length >= inFlightLimit) break;
    }
  }
  return { branch, last_commit_subject, last_commit_sha, in_flight_files };
}

function selectActiveTask(
  entries: BacklogEntry[],
): WorkerHandoffSections['active_task'] {
  const inFlight = entries.find((e) => e.status === 'in-flight');
  if (!inFlight) return null;
  return {
    id: inFlight.id,
    title: (inFlight.title ?? '').trim(),
  };
}

function selectNextUp(
  entries: BacklogEntry[],
  limit: number,
): WorkerHandoffSections['next_up'] {
  const queued = entries.filter((e) => {
    const status = (e.status ?? '').toLowerCase();
    return status !== 'done' && status !== 'in-flight';
  });
  return queued.slice(0, limit).map((e) => ({
    id: e.id,
    title: (e.title ?? '').trim(),
  }));
}

function selectBlockers(
  db: IndexDb | null,
  limit: number,
): WorkerHandoffSections['open_blockers'] {
  if (!db) return [];
  try {
    const rows = db.listAuditFindings({
      status: 'open',
      severity: 'high',
      limit,
    });
    return rows.map((r) => ({ id: r.id, finding: r.finding }));
  } catch {
    return [];
  }
}

function trimTitle(s: string, max = 280): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function renderBlock(sections: WorkerHandoffSections): string {
  const lines: string[] = [];
  lines.push('# Worker handoff');
  lines.push('');
  lines.push(
    'Context restored from the prior session. Use this as your starting point; do not re-discover the state by reading files.',
  );
  lines.push('');

  lines.push('## Where you left off');
  const g = sections.where_left_off;
  lines.push(`- Branch: ${g.branch ?? '(unknown)'}`);
  if (g.last_commit_sha && g.last_commit_subject) {
    lines.push(`- Last commit: ${g.last_commit_sha} ${g.last_commit_subject}`);
  } else if (g.last_commit_subject) {
    lines.push(`- Last commit: ${g.last_commit_subject}`);
  } else {
    lines.push('- Last commit: (none)');
  }
  if (g.in_flight_files.length === 0) {
    lines.push('- In-flight edits: none (working tree clean)');
  } else {
    lines.push('- In-flight edits:');
    for (const f of g.in_flight_files) lines.push(`  - ${f}`);
  }
  lines.push('');

  lines.push('## Active task');
  if (sections.active_task) {
    lines.push(`- ${sections.active_task.id}`);
    lines.push(`  ${trimTitle(sections.active_task.title)}`);
  } else {
    lines.push('- (no in-flight task in the backlog queue)');
  }
  lines.push('');

  lines.push('## Next up');
  if (sections.next_up.length === 0) {
    lines.push('- (queue empty)');
  } else {
    for (const e of sections.next_up) {
      lines.push(`- ${e.id}: ${trimTitle(e.title, 200)}`);
    }
  }
  lines.push('');

  lines.push('## Open blockers');
  if (sections.open_blockers.length === 0) {
    lines.push('- (none)');
  } else {
    for (const b of sections.open_blockers) {
      lines.push(`- ${b.id}: ${trimTitle(b.finding, 200)}`);
    }
  }
  return lines.join('\n');
}

export function buildWorkerHandoff(
  opts: BuildWorkerHandoffOptions,
): WorkerHandoffResult {
  const cwd = (opts.cwd ?? '').trim();
  const emptySections: WorkerHandoffSections = {
    where_left_off: {
      branch: null,
      last_commit_subject: null,
      last_commit_sha: null,
      in_flight_files: [],
    },
    active_task: null,
    next_up: [],
    open_blockers: [],
  };
  if (!cwd) {
    return { ok: true, block: '', sections: emptySections, reason: 'no-cwd' };
  }

  /* Only render for cwds that match a known project anchor. Lex
   * brainstorm spawns and other non-anchor sessions already have
   * their own preload (lex/cold-start-preload); the worker handoff
   * stays scoped to project workers so the two paths do not
   * double-inject. db===null is a test escape hatch that skips this
   * gate so a unit test can exercise the renderer directly. */
  if (opts.db) {
    const anchor = opts.db.getProjectSessionByCwd(cwd);
    if (!anchor) {
      return {
        ok: true,
        block: '',
        sections: emptySections,
        reason: 'not-a-project-anchor',
      };
    }
  }

  const runGit = opts.runGit ?? defaultRunGit;
  const readBacklog = opts.readBacklog ?? defaultReadBacklog;
  const backlogPath = opts.backlogPath ?? defaultBacklogPath();
  const nextUpLimit = opts.nextUpLimit ?? DEFAULT_NEXT_UP_LIMIT;
  const blockerLimit = opts.blockerLimit ?? DEFAULT_BLOCKER_LIMIT;
  const inFlightLimit = opts.inFlightLimit ?? DEFAULT_IN_FLIGHT_LIMIT;

  const entries = parseBacklog(readBacklog(backlogPath));
  const sections: WorkerHandoffSections = {
    where_left_off: buildGitState(cwd, runGit, inFlightLimit),
    active_task: selectActiveTask(entries),
    next_up: selectNextUp(entries, nextUpLimit),
    open_blockers: selectBlockers(opts.db, blockerLimit),
  };
  return {
    ok: true,
    block: renderBlock(sections),
    sections,
    reason: 'rendered',
  };
}
