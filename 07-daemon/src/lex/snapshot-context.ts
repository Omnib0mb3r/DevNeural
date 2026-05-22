/**
 * Per-turn live-state snapshot prepended to every voice utterance.
 *
 * Why per-turn instead of relying on the spawn-time system prompt
 * Layer 6 snapshot: the system-prompt snapshot is stale the moment
 * Lex spawns, and Claude Code injects its own "Working directories"
 * harness block above it. When the user asks "what projects do I
 * have open?" Lex tends to answer from the harness cwd list rather
 * than from Layer 6, which produces nonsense answers.
 *
 * Solution: build a small <live_state> block on every voice turn and
 * prepend it directly to the user's transcribed utterance before
 * injecting into the PTY. Right next to the question, impossible to
 * ignore. The system prompt has a matching rule that says "always
 * use this block for project/session questions, never the harness
 * cwd list".
 *
 * Cheap to build: one fs scan + one SQLite query + one in-memory list.
 *
 * Wave 3 Lane B step 36 (LX-13): extends the block with actionable
 * curator events (high-severity audit findings, open lint flags,
 * unresolved draft conflicts). Only surfaced when present; count and
 * worst-severity label only, never full detail (that blows context).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { listPtys } from '../dashboard/pty-host.js';
import { listBrainstorms, getStore } from './brainstorm-store.js';
import { listReminders } from '../dashboard/reminders.js';
import { decodeBridgeMarker } from '../dashboard/bridge-presence.js';
import { resolveCcProjectDir } from './cc-project-slug.js';
import {
  DEFAULT_DOCS_INDEX_PATH,
  loadIndexBullets,
  renderIndexSection,
} from './docs-index.js';
import type { ProjectSessionRow } from '../store/index-db.js';

/* Resolve the active brainstorm's MEMORY.md by mapping the brainstorm
 * cwd to the Claude Code per-project memory directory (under
 * ~/.claude/projects/<slug>/memory/). Returns the absolute path even
 * when the file does not exist; loadIndexBullets handles the absence. */
export function resolveBrainstormMemoryIndexPath(
  cwd: string | null | undefined,
): string | null {
  if (!cwd) return null;
  const projDir = resolveCcProjectDir(cwd);
  if (!projDir) return null;
  return path.posix.join(projDir, 'memory', 'MEMORY.md');
}

export interface VoiceSnapshotOptions {
  /** Active brainstorm cwd; used to locate the per-brainstorm
   * MEMORY.md so the per-turn block can pass through its bullets.
   * Omitted = no memory_index section (back-compat for callers that
   * have not threaded the cwd through yet). */
  activeBrainstormCwd?: string | null;
  /** Override docs index location (tests). */
  docsIndexPath?: string;
  /** Override memory index path (tests). When provided, bypasses
   * the cwd-based resolver. */
  memoryIndexPath?: string;
}

function ageHuman(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return `${Math.floor(d / 86400_000)}d ago`;
}

/**
 * Build a compact live-state block for prepending to a voice turn.
 * Keep it short so it doesn't blow Lex's context budget on chatty
 * sessions. Voice replies are 1-3 sentences anyway.
 */
export function buildVoiceSnapshot(opts: VoiceSnapshotOptions = {}): string {
  const ts = new Date().toISOString();
  /* Project anchor surface from docs/spec/PROJECT-ANCHORS.md step 5
   * / 6. project_session WHERE status='live' is the authoritative
   * source for "what projects are open". Step 6 retired the legacy
   * listSessions() identity-file path entirely. */
  const projectAnchors = (() => {
    try {
      return getStore().db.listProjectSessions({ status: 'live', limit: 200 });
    } catch {
      return [] as ProjectSessionRow[];
    }
  })();
  const brainstorms = (() => {
    try {
      return listBrainstorms({ status: 'active', limit: 8 });
    } catch {
      return [];
    }
  })();
  const ptys = (() => {
    try {
      return listPtys().filter((p) => !p.exited);
    } catch {
      return [];
    }
  })();
  const reminderCount = (() => {
    try {
      return listReminders().filter((r) => !r.completed_at && !r.archived)
        .length;
    } catch {
      return 0;
    }
  })();

  /* Anchor-backed open_projects lines. Format per spec:
   *   - <slug> (anchor <id8>, session <cc8>, status=live, bridge=ok|N)
   * where bridge=ok for single-window connections and bridge=N when
   * multiple VS Code windows are bound to the same anchor. */
  const sessionLines = projectAnchors.length
    ? projectAnchors
        .slice(0, 12)
        .map((a) => {
          const anchorShort = a.id.slice(0, 8);
          const ccShort = a.current_session_id
            ? a.current_session_id.slice(0, 8)
            : 'none';
          const decoded = decodeBridgeMarker(a.current_bridge_id);
          const bridge =
            decoded.count > 1 ? `bridge=${decoded.count}` : 'bridge=ok';
          return `  - ${a.project_slug} (anchor ${anchorShort}, session ${ccShort}, status=live, ${bridge})`;
        })
        .join('\n')
    : '  (none)';

  const brainstormLines = brainstorms.length
    ? brainstorms
        .slice(0, 5)
        .map((b) => {
          const label = b.user_label ?? b.derived_label ?? b.id.slice(0, 8);
          return `  - ${label} (mode=${b.mode}, started ${ageHuman(b.started_ms)}, turns=${b.turn_count})`;
        })
        .join('\n')
    : '  (none)';

  /* Wave 3 Lane B step 36 (LX-13): curator events (audit findings, lint
   * flags, draft conflicts). Read from SQLite via the brainstorm-store
   * singleton's IndexDb. Best-effort: if the store is not initialised
   * yet (early in daemon boot), silently skip. */
  const curatorFlags = (() => {
    try {
      const store = getStore();
      /* High-severity open audit findings only (lint + self-audit).
       * Count and worst source label; never dump the full detail into
       * the voice turn. */
      const highFindings = store.db.listAuditFindings({
        status: 'open',
        severity: 'high',
        limit: 10,
      });
      const lintFlags = highFindings.filter((f) => f.source === 'lint');
      const auditFlags = highFindings.filter((f) => f.source === 'self-audit');
      /* Open wiki drafts in conflict state (superseded status from
       * promote-conflict; pending with high confidence that are > 14d
       * old may also be a signal, but we keep it simple here). */
      const conflictDrafts = store.db.listWikiDrafts({
        status: 'superseded',
        limit: 10,
      });
      const lines: string[] = [];
      if (highFindings.length > 0) {
        lines.push(
          `  audit_findings_high: ${highFindings.length} open (lint=${lintFlags.length}, self-audit=${auditFlags.length})`,
        );
      }
      if (conflictDrafts.length > 0) {
        lines.push(`  draft_conflicts: ${conflictDrafts.length} superseded drafts need review`);
      }
      return lines.length > 0 ? lines.join('\n') : null;
    } catch {
      return null;
    }
  })();

  const ptyLine = `live_ptys: ${ptys.length}`;
  const remLine = `open_reminders: ${reminderCount}`;
  const hostLine = `host: ${os.hostname()} (${process.platform})`;
  const dataLine = `data_root_separator: backslash on Windows (C:\\dev\\data)`;

  const parts = [
    `<live_state ts="${ts}">`,
    'open_projects (live Claude Code sessions, this is the answer to "what projects do I have open"):',
    sessionLines,
    'active_brainstorms (Lex conversations in progress):',
    brainstormLines,
    ptyLine,
    remLine,
    hostLine,
    dataLine,
  ];
  if (curatorFlags) {
    parts.push('curator_flags (actionable - surface if asked about system health):');
    parts.push(curatorFlags);
  }

  /* Memory index (per-brainstorm MEMORY.md). Read live every turn so
   * a newly-added memory shows up on the next inject without a
   * daemon restart. Caller-supplied cwd resolves to the Claude Code
   * per-project memory dir; missing cwd or absent MEMORY.md renders
   * as a placeholder. */
  const memoryPath =
    opts.memoryIndexPath ??
    resolveBrainstormMemoryIndexPath(opts.activeBrainstormCwd ?? null);
  if (memoryPath) {
    const bullets = loadIndexBullets(memoryPath);
    if (bullets.length > 0) {
      parts.push(
        ...renderIndexSection(
          'memory_index (use as table of contents; read the full file when relevant):',
          bullets,
          'MEMORY.md',
        ),
      );
    }
  }

  /* Docs index (docs/INDEX.md). Read live every turn so a newly-
   * added doc shows up without daemon restart. */
  const docsPath = opts.docsIndexPath ?? DEFAULT_DOCS_INDEX_PATH;
  const docsBullets = loadIndexBullets(docsPath);
  if (docsBullets.length > 0) {
    parts.push(
      ...renderIndexSection(
        'docs_index (DevNeural project docs; read the full file when relevant):',
        docsBullets,
        'docs/INDEX.md',
      ),
    );
  }
  parts.push('</live_state>');
  return parts.join('\n');
}
