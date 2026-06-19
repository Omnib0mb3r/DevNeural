/**
 * Spawn helper for the new Lex session model
 * (PLAN-lex-session-rewrite.md, step 2).
 *
 * Generates the CC session UUID daemon-side, computes the transcript
 * jsonl path Claude Code will write to, and persists the
 * lex_transcript_ref row BEFORE any subprocess starts. That ordering
 * is the crash-safety guarantee in the plan: a daemon kill between
 * row insertion and PTY spawn just leaves a ref pointing at a file
 * that will never exist (cleaned up by future reaper) — there is no
 * window in which a transcript file exists without a corresponding
 * ref pointing at it.
 *
 * Two flows:
 *   - prepareLexSpawn({ cwd })                 → fresh anchor.
 *   - prepareLexSpawn({ lexSessionId, cwd? })  → reopen existing
 *     anchor; cwd defaults to the anchor's stored cwd.
 *
 * Both return the materialised CC session id, the transcript path,
 * the lex_session row, the new transcript ref, and the args fragment
 * the caller appends to claude's argv (`--session-id <uuid>`).
 *
 * The actual node-pty spawn (spawnLexSession) wraps prepareLexSpawn
 * so the route handler can call one function. prepareLexSpawn is
 * exported separately so unit tests can verify the row + path
 * materialisation without touching the PTY layer.
 */
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendTranscriptRef,
  closeTranscriptRef,
  createLexSession,
  deleteLexSession,
  getLexSession,
  setLexSessionStatus,
} from './lex-session-store.js';
import {
  getStore,
  bindBrainstormSessionId,
} from './brainstorm-store.js';
import type {
  LexSessionRow,
  LexTranscriptRefRow,
} from '../store/index-db.js';
import { spawnLex, type SpawnLexResult } from '../dashboard/pty-host.js';
import { prewarmInvestigator } from './lex-investigator.js';

/* Mirror of pty-host's cwdToClaudeSlug (kept private there). Replaces
 * `:`, `/`, and `\` with `-` so a windows path like
 * C:\dev\data\skill-connections\brainstorm becomes the slug
 * C--dev-data-skill-connections-brainstorm. */
export function cwdToClaudeSlug(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-');
}

/* Compute the absolute path Claude Code will write a session jsonl
 * to under ~/.claude/projects/<slug>/<cc_session_id>.jsonl. Daemon
 * pre-computes this so the lex_transcript_ref row can be persisted
 * BEFORE the subprocess starts and any output races to disk. */
export function transcriptPathFor(opts: {
  cwd: string;
  ccSessionId: string;
  homeDir?: string;
}): string {
  const home = (opts.homeDir ?? os.homedir()).replace(/\\/g, '/');
  const slug = cwdToClaudeSlug(opts.cwd);
  return path.posix.join(
    home,
    '.claude',
    'projects',
    slug,
    `${opts.ccSessionId}.jsonl`,
  );
}

export interface PrepareLexSpawnOptions {
  /** When supplied, reopen this anchor: a new CC session uuid is
   * minted, a new transcript ref is appended, but the anchor row is
   * preserved. Omit to create a brand-new anchor. */
  lexSessionId?: string;
  /** CWD claude will be spawned in. Required for new anchors;
   * optional on reopen (defaults to the anchor's stored cwd). */
  cwd?: string;
  /** Optional title applied to a freshly-created anchor. Ignored on
   * reopen. */
  title?: string;
  /** Override for unit tests. */
  homeDir?: string;
  /** Override for unit tests. */
  ccSessionId?: string;
  /** Override for unit tests. */
  nowMs?: number;
}

export interface PrepareLexSpawnResult {
  lexSession: LexSessionRow;
  ccSessionId: string;
  transcriptPath: string;
  transcriptRef: LexTranscriptRefRow;
  /** Args fragment to append to claude's argv. Always includes
   * `--session-id <uuid>` so claude writes its jsonl to the path the
   * daemon already recorded in the transcript ref. */
  args: string[];
  isReopen: boolean;
}

export function prepareLexSpawn(
  opts: PrepareLexSpawnOptions,
): PrepareLexSpawnResult {
  let anchor: LexSessionRow;
  let isReopen: boolean;
  if (opts.lexSessionId) {
    const existing = getLexSession(opts.lexSessionId);
    if (!existing) {
      throw new Error(
        `prepareLexSpawn: lexSessionId not found: ${opts.lexSessionId}`,
      );
    }
    anchor = existing;
    isReopen = true;
  } else {
    if (!opts.cwd) {
      throw new Error(
        'prepareLexSpawn: cwd is required when creating a new anchor',
      );
    }
    anchor = createLexSession({
      cwd: opts.cwd,
      title: opts.title ?? null,
      createdMs: opts.nowMs ?? Date.now(),
    });
    isReopen = false;
  }

  /* cwd resolution: explicit opts.cwd wins (handles a future cwd
   * relocation), then anchor.cwd. */
  const cwd = (opts.cwd ?? anchor.cwd).replace(/\\/g, '/');
  const ccSessionId = opts.ccSessionId ?? randomUUID();
  const transcriptPath = transcriptPathFor({
    cwd,
    ccSessionId,
    homeDir: opts.homeDir,
  });

  /* Persist the ref BEFORE returning so the caller's spawn step
   * cannot lose this binding — even if the subprocess fails to
   * launch the row already exists pointing at a path the eventual
   * cleanup pass can recognise as orphan. */
  const transcriptRef = appendTranscriptRef({
    lexSessionId: anchor.id,
    ccSessionId,
    transcriptPath,
    startedMs: opts.nowMs ?? Date.now(),
  });

  const args = ['--session-id', ccSessionId];

  return {
    lexSession: anchor,
    ccSessionId,
    transcriptPath,
    transcriptRef,
    args,
    isReopen,
  };
}

export interface SpawnLexSessionOptions extends PrepareLexSpawnOptions {
  /** Extra argv added after the daemon-supplied --session-id. The
   * route handler injects --dangerously-skip-permissions and the
   * (future, step 3) catch-up system prompt here. */
  extraArgs?: string[];
  /** Forwarded to pty-host.spawnLex unchanged. */
  command?: string;
  systemPrompt?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface SpawnLexSessionResult extends SpawnLexResult {
  lexSessionId: string;
  ccSessionId: string;
  transcriptPath: string;
  isReopen: boolean;
}

/* Mirror the new anchor into the legacy brainstorm_sessions table.
 * Write-through keeps existing read paths (artifacts endpoints,
 * session-end pipeline, retrieval joins) working without a flag-day
 * migration. The legacy row's id matches lex_session.id so anything
 * keyed on either resolves the same conversation. */
function writeThroughBrainstormRow(opts: {
  lexSession: LexSessionRow;
  ccSessionId: string;
  ptyId: string;
}): void {
  const store = getStore();
  const existing = store.db.getBrainstorm(opts.lexSession.id);
  if (existing) {
    /* Reopen path: rebind the legacy row to the new PTY + CC
     * session id and flip status back to active. */
    bindBrainstormSessionId(opts.lexSession.id, opts.ptyId, opts.ccSessionId);
    return;
  }
  /* Fresh anchor path: insert a legacy row whose id matches the
   * lex_session id so future artifact / end-pipeline lookups land
   * on the same conversation. insertBrainstorm uses INSERT OR
   * REPLACE so this is also safe on re-run. */
  store.db.insertBrainstorm({
    id: opts.lexSession.id,
    claude_session_id: opts.ccSessionId,
    pty_id: opts.ptyId,
    cwd: opts.lexSession.cwd,
    user_label: opts.lexSession.title,
    derived_label: opts.lexSession.derived_title,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.lexSession.created_ms,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: JSON.stringify({
      research_notes: [],
      wiki_drafts: [],
      reminders: [],
      spawned_projects: [],
    }),
    last_summary: null,
    last_summary_ms: null,
  });
}

/* Full spawn: prepare the rows + args, then hand off to pty-host's
 * existing PTY runner. Wraps the spawn in try/catch so a failure
 * rolls back the optimistically-inserted lex_session + transcript
 * ref (fresh anchor) or the dangling transcript ref (reopen). On
 * success, updates lex_session status, mirrors into the legacy
 * brainstorm_sessions table for read-side compatibility, and
 * stamps handle.brainstormId on the PTY via opts.brainstormId so
 * pty-host's onExit flips the right anchor dormant when the PTY
 * dies. */
export function spawnLexSession(
  opts: SpawnLexSessionOptions,
): SpawnLexSessionResult {
  const prep = prepareLexSpawn(opts);
  const args = [...prep.args, ...(opts.extraArgs ?? [])];
  let ptyResult: SpawnLexResult;
  try {
    ptyResult = spawnLex({
      cwd: prep.lexSession.cwd,
      command: opts.command,
      args,
      cols: opts.cols,
      rows: opts.rows,
      systemPrompt: opts.systemPrompt,
      env: opts.env,
      brainstormId: prep.lexSession.id,
      skipLegacyBrainstormRegister: true,
    });
  } catch (err) {
    /* Rollback. The transcript ref was inserted before the spawn;
     * close it with the same timestamp so it can't surface as
     * "still in progress". On a brand-new anchor (not a reopen),
     * also delete the lex_session row outright so the past-sessions
     * list doesn't grow a dormant ghost the user never started. */
    try {
      closeTranscriptRef(prep.ccSessionId);
    } catch {
      /* observability only */
    }
    if (!prep.isReopen) {
      try {
        deleteLexSession(prep.lexSession.id);
      } catch {
        /* observability only */
      }
    }
    throw err;
  }
  setLexSessionStatus(prep.lexSession.id, {
    status: 'live',
    currentPtyId: ptyResult.ptyId,
  });
  try {
    writeThroughBrainstormRow({
      lexSession: prep.lexSession,
      ccSessionId: prep.ccSessionId,
      ptyId: ptyResult.ptyId,
    });
  } catch {
    /* Read-side write-through is best-effort. Failure here just
     * means a future artifact lookup may 404 until the next run;
     * the new lex_session model is unaffected. */
  }
  /* Cold-start investigator pre-warm (2026-06-19). Fire-and-forget:
   * assemble the scope-isolated primed-context block for this anchor and
   * cache it so the SessionStart cold-start route can serve it the
   * instant Claude Code boots. Deterministic assemble only by default
   * (the headless Opus refinement is gated on DEVNEURAL_INVESTIGATOR_HEADLESS)
   * so the cache is warm within ms, well before the hook fires; the
   * headless pass is too slow for the spawn->hook window and stays
   * opt-in. Never blocks the spawn and never throws: a confidently-empty
   * anchor caches nothing and the cold-start route falls through to its
   * existing path with no regression. */
  try {
    const headless = process.env.DEVNEURAL_INVESTIGATOR_HEADLESS === '1';
    void prewarmInvestigator({
      db: getStore().db,
      anchorId: prep.lexSession.id,
      cwd: prep.lexSession.cwd,
      label: prep.lexSession.title,
      enableHeadless: headless,
    }).catch(() => {
      /* fire-and-forget; prewarmInvestigator is fail-safe by contract */
    });
  } catch {
    /* never let pre-warm wiring affect the spawn result */
  }
  return {
    ...ptyResult,
    lexSessionId: prep.lexSession.id,
    ccSessionId: prep.ccSessionId,
    transcriptPath: prep.transcriptPath,
    isReopen: prep.isReopen,
  };
}
