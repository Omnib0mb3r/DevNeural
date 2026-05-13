/**
 * Project-slug encoder shared between the bridge's ccSessionLookup and
 * any future call site that needs the same canonical key.
 *
 * Mirrors the daemon's encoding in 07-daemon/src/dashboard/sessions.ts
 * (and Claude Code's own ~/.claude/projects/<slug>/ folder naming):
 * every backslash, forward slash, and colon in the cwd flattens to a
 * hyphen. e.g.
 *
 *   C:\dev\Projects\DevNeural   ->  C--dev-Projects-DevNeural
 *   C:/dev/Projects/DevNeural   ->  C--dev-Projects-DevNeural
 *
 * Case preserved. Call sites that compare against the lowercase /sessions
 * cache key tack `.toLowerCase()` on their end.
 *
 * Lives in its own module so unit tests can import it without pulling
 * the vscode-tied extension.ts into the test runtime, and so the
 * ccSessionLookup callback can't hand-roll a divergent regex (which it
 * had: a previous inline `cwd.replace(/[:]/g, '-').toLowerCase()` was
 * missing the slash escapes, so on Windows the resulting slug never
 * matched anything in daemonActiveSessions and cc_session_ids stayed
 * empty).
 */
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-');
}
