/**
 * Deterministic jsonl session discovery for shared-cwd PTY spawns.
 *
 * Bug 2026-07-08 (brainstorm cross-bind): every Lex brainstorm PTY
 * shares one cwd, so they all watch the same
 * ~/.claude/projects/<slug>/ directory. The old picker inside
 * pty-host filtered candidates on ctimeMs >= startedAt, but on
 * Windows libuv maps st_ctim to ftLastWriteTime — ctime moves on
 * every data write. An OLDER still-active session's jsonl therefore
 * "qualified" the moment it received a write after the new PTY
 * spawned, and the new PTY bound to another session's transcript
 * (evidence: Bridger's row pointing at MHA's cc session id, chunks
 * ingested under the wrong anchor).
 *
 * This picker is pure and testable:
 *   - creation-time based (birthtimeMs; falls back to
 *     min(ctimeMs, mtimeMs) when the fs reports no birthtime),
 *   - skips session ids already claimed by another live PTY,
 *   - earliest-created qualifying file wins (stable under polling).
 */
export interface JsonlCandidate {
  /** Bare file name, e.g. "<uuid>.jsonl". */
  name: string;
  birthtimeMs: number;
  ctimeMs: number;
  mtimeMs: number;
}

/** Clock-skew slack applied before the spawn timestamp. */
const SKEW_MS = 2_000;

function creationMs(c: JsonlCandidate): number {
  if (c.birthtimeMs && c.birthtimeMs > 0) return c.birthtimeMs;
  /* No birthtime: the least recently moving stamp is the closest
   * available proxy for creation. ctime/mtime both advance with
   * writes, so min() is the conservative choice. */
  return Math.min(c.ctimeMs || Infinity, c.mtimeMs || Infinity);
}

/**
 * Pick the session id (jsonl basename without extension) the PTY
 * spawned at `startedAtMs` should bind to, or null when no candidate
 * qualifies yet (claude has not written its first turn).
 */
export function pickDiscoveryJsonl(
  candidates: JsonlCandidate[],
  startedAtMs: number,
  claimedSessionIds: ReadonlySet<string>,
): string | null {
  const qualifying = candidates
    .filter((c) => c.name.endsWith('.jsonl'))
    .map((c) => ({
      sessionId: c.name.replace(/\.jsonl$/, ''),
      createdMs: creationMs(c),
    }))
    .filter((c) => Number.isFinite(c.createdMs))
    .filter((c) => c.createdMs >= startedAtMs - SKEW_MS)
    .filter((c) => !claimedSessionIds.has(c.sessionId))
    .sort((a, b) => a.createdMs - b.createdMs);
  return qualifying[0]?.sessionId ?? null;
}
