/**
 * Sticky CC session id latch.
 *
 * Replaces the prior 30s freshness-window scan that re-derived the
 * cc_session_id for a workspace cwd on every presence tick. The
 * window dropped the UUID the moment the worker stopped writing
 * turns (idle >30s), which made cross-session inject fail with
 * `target_session required` and flipped the daemon-side anchor
 * `current_session_id=null` even though the VS Code window was
 * still alive.
 *
 * Correct shape per TODO.md bug #2 (2026-05-13):
 *
 *   - Presence-file heartbeat is the persistence signal. The bridge
 *     keeps reporting the latched UUID until VS Code deactivates
 *     the extension OR a newer jsonl UUID supersedes it on disk.
 *   - Daemon side trusts the sticky value as long as presence stays
 *     fresh; presence going stale (worker terminal closed) is what
 *     dormant-flips the anchor, not jsonl mtime drift.
 *
 * Supersession rule: newest jsonl by mtime in the slug dir wins.
 * A fresh session creates a new <uuid>.jsonl that immediately has
 * the largest mtime; the latch picks it up on the next call. An
 * idle worker's jsonl stays the freshest among its own dir contents
 * (no other jsonl in the same slug is being written), so the latch
 * keeps it.
 *
 * Pure module: filesystem + clock are injected so tests can drive
 * the resolver without touching ~/.claude/projects/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cwdToSlug } from './slug.js';

export interface CcSessionLatchEntry {
  uuid: string;
  mtimeMs: number;
  firstLatchedMs: number;
}

export interface CcSessionLatchDeps {
  /** Claude Code projects root, normally ~/.claude/projects. */
  claudeProjectsRoot: string;
  /** Clock injection point; defaults to Date.now. */
  now?: () => number;
}

export class CcSessionLatch {
  private readonly latch = new Map<string, CcSessionLatchEntry>();
  private readonly root: string;
  private readonly now: () => number;

  constructor(deps: CcSessionLatchDeps) {
    this.root = deps.claudeProjectsRoot;
    this.now = deps.now ?? Date.now;
  }

  /** Lookup the latched UUID for a workspace cwd. */
  resolve(cwd: string): string | undefined {
    const slug = cwdToSlug(cwd);
    const slugKey = slug.toLowerCase();
    if (!fs.existsSync(this.root)) return this.latch.get(slugKey)?.uuid;

    /* Slug encoding preserves case. On Windows the filesystem is
     * case-insensitive so a direct join lookup hits the dir
     * regardless of casing; on case-sensitive hosts we fall back
     * to a readdir + case-insensitive match. */
    let slugDir = path.posix.join(this.root, slug);
    if (!fs.existsSync(slugDir)) {
      try {
        const candidates = fs.readdirSync(this.root, { withFileTypes: true });
        const match = candidates.find(
          (e) => e.isDirectory() && e.name.toLowerCase() === slugKey,
        );
        if (!match) return this.latch.get(slugKey)?.uuid;
        slugDir = path.posix.join(this.root, match.name);
      } catch {
        return this.latch.get(slugKey)?.uuid;
      }
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch {
      return this.latch.get(slugKey)?.uuid;
    }

    let newest: { uuid: string; mtimeMs: number } | undefined;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const full = path.posix.join(slugDir, e.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = {
          uuid: e.name.replace(/\.jsonl$/, ''),
          mtimeMs: stat.mtimeMs,
        };
      }
    }

    /* No jsonls in the slug dir: keep whatever was previously latched.
     * Important for the "worker started but hasn't written its jsonl
     * yet" window and for any filesystem race where readdir returns
     * an empty list for a tick. */
    if (!newest) return this.latch.get(slugKey)?.uuid;

    const prior = this.latch.get(slugKey);
    if (
      !prior ||
      newest.uuid !== prior.uuid ||
      newest.mtimeMs > prior.mtimeMs
    ) {
      /* First sight OR a different / newer jsonl: supersede. The
       * mtime-newer check covers the case where the worker writes
       * another turn to the same UUID (refresh stamp) so the latch
       * tracks the live one even across long quiet stretches. */
      this.latch.set(slugKey, {
        uuid: newest.uuid,
        mtimeMs: newest.mtimeMs,
        firstLatchedMs: prior?.uuid === newest.uuid ? prior.firstLatchedMs : this.now(),
      });
      return newest.uuid;
    }
    return prior.uuid;
  }

  /** Drop all latched entries; called on extension deactivate. */
  clear(): void {
    this.latch.clear();
  }

  /** Test seam: snapshot of current latch state. */
  snapshot(): Array<{ slugKey: string; entry: CcSessionLatchEntry }> {
    return Array.from(this.latch.entries()).map(([slugKey, entry]) => ({
      slugKey,
      entry,
    }));
  }
}
