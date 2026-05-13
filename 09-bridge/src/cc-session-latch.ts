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
 * Supersession rule (Task E, 2026-05-13):
 *
 *   - Same UUID newest by mtime → refresh the latch's stored mtime
 *     so a long-running session that occasionally writes a turn
 *     keeps its firstLatched timestamp but tracks the latest stamp.
 *   - Different UUID newest by mtime → only supersede when the
 *     mtime delta vs the latched entry exceeds SUPERSEDE_WINDOW_MS
 *     (60s). This anti-flap window prevents a transient stat race
 *     or a one-shot tool-driven mtime touch on an unrelated jsonl
 *     from flipping the latch off the still-active session. After
 *     a real /clear inside an active CC session the new jsonl gets
 *     turn writes for at least one tick while the prior jsonl
 *     stays quiet, so the delta crosses the window inside a
 *     minute and the new UUID wins.
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
  /** Anti-flap window (ms) for cross-UUID supersession.
   * Defaults to SUPERSEDE_WINDOW_MS (60s). A different jsonl UUID
   * must have mtime delta > this value vs the latched entry before
   * the latch flips onto it. Exposed for tests so they don't have
   * to back-date files by a full minute. */
  supersedeWindowMs?: number;
}

/* Task E (2026-05-13): minimum mtime divergence between the latched
 * jsonl and a different-UUID candidate before the latch supersedes.
 * The prior code used `newest.uuid !== prior.uuid` as a sufficient
 * condition, which let a transient mtime touch on an unrelated
 * jsonl flip the latch onto a stale session. The 60s gate keeps the
 * latch pinned through quick races but still flips inside a minute
 * for a real /clear-spawned session writing fresh turns. */
export const SUPERSEDE_WINDOW_MS = 60_000;

export class CcSessionLatch {
  private readonly latch = new Map<string, CcSessionLatchEntry>();
  private readonly root: string;
  private readonly now: () => number;
  private readonly supersedeWindowMs: number;

  constructor(deps: CcSessionLatchDeps) {
    this.root = deps.claudeProjectsRoot;
    this.now = deps.now ?? Date.now;
    this.supersedeWindowMs = deps.supersedeWindowMs ?? SUPERSEDE_WINDOW_MS;
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

    /* First sight: latch onto whatever the slug dir shows. */
    if (!prior) {
      this.latch.set(slugKey, {
        uuid: newest.uuid,
        mtimeMs: newest.mtimeMs,
        firstLatchedMs: this.now(),
      });
      return newest.uuid;
    }

    /* Same UUID: track the freshest mtime stamp so the
     * cross-UUID delta check below has the most accurate baseline
     * if a different jsonl appears later. firstLatchedMs is
     * preserved so callers that read it can still see when this
     * session first attached. */
    if (newest.uuid === prior.uuid) {
      if (newest.mtimeMs > prior.mtimeMs) {
        this.latch.set(slugKey, {
          uuid: prior.uuid,
          mtimeMs: newest.mtimeMs,
          firstLatchedMs: prior.firstLatchedMs,
        });
      }
      return prior.uuid;
    }

    /* Task E (2026-05-13): cross-UUID supersession gate.
     *
     * The prior code flipped onto any different-UUID newest by
     * mtime, which let a one-shot stat touch on an unrelated
     * jsonl (e.g. a CC tool reading a sibling transcript) hijack
     * the latch from a still-active worker. The gate requires
     * the new jsonl to be at least supersedeWindowMs (60s by
     * default) fresher than the latched entry before flipping.
     *
     * Real /clear flow: new jsonl receives turn writes
     * continuously while the prior jsonl stays quiet; the delta
     * crosses 60s well inside a minute of operator typing, and
     * the latch flips. Transient races: the unrelated jsonl's
     * mtime touch usually clears within the window, so the
     * latched session keeps owning the slug.
     *
     * Tested in 09-bridge/tests/cc-session-latch.test.ts:
     *   - "re-latches when a different jsonl exceeds the
     *      60s mtime divergence window"
     *   - "ignores a different jsonl whose mtime divergence is
     *      under the window (anti-flap)"
     */
    const delta = newest.mtimeMs - prior.mtimeMs;
    if (delta > this.supersedeWindowMs) {
      this.latch.set(slugKey, {
        uuid: newest.uuid,
        mtimeMs: newest.mtimeMs,
        firstLatchedMs: this.now(),
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
