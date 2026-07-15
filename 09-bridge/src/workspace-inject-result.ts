/**
 * Workspace-inject delivery result helpers (WP-H: spawn delivery
 * feedback).
 *
 * Pure module (no vscode import) so the test suite can pin the
 * result-file contract without spinning a real VS Code instance,
 * mirroring bridge-payload.ts and slug.ts.
 *
 * Background: extension.ts's processWorkspaceInjects loop claims a
 * .workspace-inject/<slug>.json marker by renaming it to
 * <slug>.json.claim, then runWorkspaceInject types the command into a
 * fresh terminal. Before this change that was fire-and-forget: the
 * daemon route that queued the marker (07-daemon
 * src/dashboard/routes.ts POST /projects/:id/start-claude) returned
 * ok:true the instant the marker file was written, with no signal
 * back from the bridge about whether a matching VS Code window ever
 * existed, claimed the marker, or the terminal.sendText call actually
 * succeeded.
 *
 * Now runWorkspaceInject writes a result file next to the claim:
 *   .workspace-inject/<slug>.result.json = {ok, error?, at, workspace}
 * and the daemon's pollInjectResult (07-daemon
 * src/dashboard/projects-new.ts) polls for it.
 */

export interface WorkspaceInjectResultPayload {
  ok: boolean;
  error?: string;
  at: string;
  workspace: string;
}

/* The claim file the bridge holds while running the inject is the
 * original marker's path with '.claim' appended, e.g.
 *   .workspace-inject/<slug>.json.claim
 * The result file lives alongside it as:
 *   .workspace-inject/<slug>.result.json
 * String surgery on the claim path (not a re-derivation of the slug)
 * so this side never needs to duplicate the daemon's
 * injectSlug() sanitization + hash algorithm; whatever the daemon
 * named the marker, the result file mirrors it exactly. */
export function resultFileForClaim(claimFile: string): string {
  const normalized = claimFile.replace(/\\/g, '/');
  if (normalized.endsWith('.json.claim')) {
    return `${normalized.slice(0, -'.json.claim'.length)}.result.json`;
  }
  /* Defensive fallback for any claim path that doesn't match the
   * expected '<slug>.json.claim' shape (shouldn't happen given
   * processWorkspaceInjects always renames '<slug>.json' ->
   * '<slug>.json.claim'). Strip a trailing '.claim' if present so we
   * still produce a plausible sibling path instead of throwing. */
  const withoutClaim = normalized.endsWith('.claim')
    ? normalized.slice(0, -'.claim'.length)
    : normalized;
  return withoutClaim.endsWith('.json')
    ? `${withoutClaim.slice(0, -'.json'.length)}.result.json`
    : `${withoutClaim}.result.json`;
}

export function buildWorkspaceInjectResultPayload(
  workspace: string,
  result: { ok: boolean; error?: string },
  now: () => Date = () => new Date(),
): WorkspaceInjectResultPayload {
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    at: now().toISOString(),
    workspace,
  };
}

/** A file whose name ends in '.result.json' is a delivery-result
 * artifact, never a workspace-inject marker awaiting a command. The
 * marker-processing loop in extension.ts must exclude these — both
 * end in '.json', and without this guard a stray result file would
 * get parsed as a WorkspaceInjectMarker (undefined .command,
 * undefined .queued_at) and claimed/run as if it were real work. */
export function isResultFile(name: string): boolean {
  return name.endsWith('.result.json');
}

/** TTL check shared with the marker sweep's own staleness test, so
 * result files get swept up by the same tick instead of needing a
 * second timer. */
export function isStaleResultFile(mtimeMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - mtimeMs > ttlMs;
}
