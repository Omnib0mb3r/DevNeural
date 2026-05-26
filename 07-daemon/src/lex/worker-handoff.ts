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
import { WORKER_STATUS_FOOTER_TEMPLATE } from '../dashboard/worker-status-footer.js';
import {
  DEFAULT_DOCS_INDEX_PATH,
  loadIndexBullets,
  renderIndexSection,
} from './docs-index.js';
import { buildSourceGraphPayload } from './source-graph-payload.js';

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
  /** Three-tier docs index (2026-05-22): table of contents for
   * docs/. Same shape as the live_state docs_index block injected on
   * voice turns; worker SessionStart gets the doc catalog every time
   * the worker resumes so it never forgets which reference material
   * exists. Memory index does NOT apply on the worker side. */
  docs_index: string[];
  /** Brainstorm-as-durable-primary-entity (2026-05-22): present when
   * the worker's cc_session_id matched a brainstorm row's
   * attached_worker_session_id. The brainstorm IS the durable Lex
   * brain; this block hands the worker the conversation thread Lex
   * has been driving so /clear or a fresh spawn does not lose
   * continuity. Null when no brainstorm has claimed this worker. */
  brainstorm_context: {
    brainstorm_id: string;
    user_label: string | null;
    last_summary: string | null;
    recent_chunks: Array<{
      role: 'user' | 'lex' | 'tool';
      text: string;
    }>;
  } | null;
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
  /** Brainstorm-as-durable-primary-entity (2026-05-22): the new CC
   * session id the worker is starting under. When provided AND the
   * db carries a brainstorm row with this attached_worker_session_id,
   * the rendered block gains a ## Brainstorm context section pulling
   * the brainstorm's last_summary plus its most recent chunks so the
   * worker resumes the thread the brainstorm has been driving. Null
   * skips the lookup. */
  workerSessionId?: string;
  /** Test seam: cap on the number of recent brainstorm chunks
   * replayed in the brainstorm-context section. */
  brainstormChunkLimit?: number;
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
  /** Three-tier docs index (2026-05-22): override the docs/INDEX.md
   * path for tests. Defaults to <repo>/docs/INDEX.md. */
  docsIndexPath?: string;
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

  /* Brainstorm-as-durable-primary-entity (2026-05-22): when a
   * brainstorm has bound this worker via attachWorkerSession, the
   * worker resumes the thread Lex has been driving. Last summary +
   * the last few user/assistant turns lets the worker pick up
   * without re-discovering state. The block is intentionally short
   * so a /clear + handoff cycle does not blow context budget; full
   * history lives in brainstorm_chunks and the worker can ask Lex
   * to recall older turns via cross-session inject. */
  if (sections.brainstorm_context) {
    const bc = sections.brainstorm_context;
    lines.push('');
    lines.push('## Brainstorm context');
    lines.push(
      'The brainstorm bound to this worker is the durable Lex brain. Your role is the tool side: implement, test, commit. The summary + recent turns below capture what Lex has been working through so you can resume the thread without re-discovery.',
    );
    lines.push('');
    lines.push(`- brainstorm_id: ${bc.brainstorm_id}`);
    if (bc.user_label) lines.push(`- label: ${bc.user_label}`);
    if (bc.last_summary) {
      lines.push('');
      lines.push('### Last summary');
      lines.push(bc.last_summary);
    }
    if (bc.recent_chunks.length > 0) {
      lines.push('');
      lines.push('### Recent turns (oldest first)');
      for (const c of bc.recent_chunks) {
        const speaker =
          c.role === 'lex' ? 'Lex' : c.role === 'tool' ? 'Tool' : 'User';
        lines.push(`- ${speaker}: ${trimTitle(c.text, 280)}`);
      }
    }
  }

  /* Three-tier docs index (2026-05-22): same shape and source file
   * as the live_state docs_index block voice gets every turn. Read
   * live on each handoff render so a newly-added doc lands without
   * a daemon restart. The header phrasing differs slightly from the
   * voice block so the worker reads it as a starting catalog rather
   * than a per-turn refresher. */
  if (sections.docs_index.length > 0) {
    lines.push('');
    lines.push('## Docs index');
    lines.push(
      'Reference material under docs/. Read the full file with the Read tool when a topic is relevant; do not re-derive from code if a doc already covers it.',
    );
    const block = renderIndexSection(
      '',
      sections.docs_index,
      'docs/INDEX.md',
    );
    /* renderIndexSection prefixes its first line with the header
     * argument; we already emitted our own `## Docs index` heading
     * just above, so drop the empty header line it emits. */
    for (const l of block.slice(1)) lines.push(l);
  }

  /* Phase 1 of the autonomous supervisor: every worker SessionStart
   * additionalContext carries the status footer protocol reminder so
   * the worker emits a machine-parsable footer on every terminal
   * turn. The parser lives at dashboard/worker-status-footer.ts;
   * Phase 1 lands the protocol + parser only and does NOT wire any
   * decision logic on top yet. */
  lines.push('');
  lines.push(WORKER_STATUS_FOOTER_TEMPLATE);
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
    docs_index: [],
    brainstorm_context: null,
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
  const docsIndexPath = opts.docsIndexPath ?? DEFAULT_DOCS_INDEX_PATH;
  const chunkLimit = opts.brainstormChunkLimit ?? 6;
  /* Codex item 8 (Fix 45): replace the anchor-flat brainstorm-context
   * read with a projection through `buildSourceGraphPayload`. The same
   * primitive powers cold-start preload (Lex side); both consumers see
   * pickBundles + isRefStale + distillation_error_log surfacing.
   *
   * The legacy `brainstorm_context` field on the sections object is
   * kept for back-compat with existing renderers + tests, but its
   * recent_chunks list is now populated from the bundle picked by the
   * walk-back scorer rather than the last-6-anchor-flat read. */
  let brainstormContext: WorkerHandoffSections['brainstorm_context'] = null;
  if (opts.db && opts.workerSessionId) {
    try {
      const bs = opts.db.getBrainstormByAttachedWorker(opts.workerSessionId);
      if (bs) {
        const payload = buildSourceGraphPayload({
          db: opts.db,
          anchorId: bs.id,
          currentCcSessionId: opts.workerSessionId,
          refLimit: 3,
          pairsPerRef: 3,
          now: opts.now ?? Date.now,
        });
        /* Compose legacy `recent_chunks` from the highest-scored bundle's
         * turn pairs so existing renderers stay compatible. */
        const topBundle = payload.refs[0];
        const recent: Array<{ role: 'user' | 'lex' | 'tool'; text: string }> = [];
        if (topBundle) {
          for (const t of topBundle.turn_pairs) {
            recent.push({
              role: t.role === 'user' ? 'user' : 'lex',
              text: t.text,
            });
          }
        }
        /* Fallback to the legacy anchor-flat last-N read when the
         * walk-back surfaced zero bundles (e.g. anchor with no refs
         * yet, codex-9 first-attach edge case). */
        if (recent.length === 0) {
          const chunks = opts.db.listBrainstormChunks(bs.id, chunkLimit, {
            order: 'desc',
          });
          for (const c of chunks.reverse()) {
            recent.push({ role: c.role, text: c.text });
          }
        }
        brainstormContext = {
          brainstorm_id: bs.id,
          user_label: bs.user_label ?? bs.derived_label ?? null,
          last_summary: bs.last_summary ?? null,
          recent_chunks: recent,
        };
      }
    } catch {
      /* observational; never block the handoff on a missing column */
    }
  }
  const sections: WorkerHandoffSections = {
    where_left_off: buildGitState(cwd, runGit, inFlightLimit),
    active_task: selectActiveTask(entries),
    next_up: selectNextUp(entries, nextUpLimit),
    open_blockers: selectBlockers(opts.db, blockerLimit),
    docs_index: loadIndexBullets(docsIndexPath),
    brainstorm_context: brainstormContext,
  };
  return {
    ok: true,
    block: renderBlock(sections),
    sections,
    reason: 'rendered',
  };
}
