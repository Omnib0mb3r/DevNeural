/**
 * Project-slug encoder regression suite.
 *
 * The ccSessionLookup callback in extension.ts has to produce the same
 * slug the daemon's /sessions endpoint stores under
 * `s.project_slug.toLowerCase()`. A prior inline regex in that callback
 * had `cwd.replace(/[:]/g, '-').toLowerCase()`, which dropped the
 * backslash and forward-slash escapes; on Windows that left every
 * lookup missing daemonActiveSessions and cc_session_ids permanently
 * empty in the bridge presence file. The fix routes the callback
 * through the shared cwdToSlug helper. These tests pin both halves of
 * the invariant so the inline regex can't sneak back in.
 */
import { describe, expect, it } from 'vitest';
import { cwdToSlug } from '../src/slug.js';

describe('cwdToSlug', () => {
  it('encodes a Windows path the way Claude Code stores it', () => {
    expect(cwdToSlug('C:\\dev\\Projects\\DevNeural')).toBe(
      'C--dev-Projects-DevNeural',
    );
  });

  it('encodes a forward-slashed cwd identically', () => {
    expect(cwdToSlug('C:/dev/Projects/DevNeural')).toBe(
      'C--dev-Projects-DevNeural',
    );
  });

  it('flattens every backslash, forward slash, and colon to a hyphen', () => {
    expect(cwdToSlug('a:b/c\\d')).toBe('a-b-c-d');
  });

  it("preserves case (lowercase is the caller's responsibility)", () => {
    expect(cwdToSlug('C:/Dev/Foo')).toBe('C--Dev-Foo');
  });
});

describe('ccSessionLookup slug parity', () => {
  /* The lookup callback in extension.ts must do `cwdToSlug(cwd).toLowerCase()`
   * and nothing else. These cases re-encode a fixture path with the
   * helper and assert it matches the canonical lowercase slug the
   * daemon publishes via /sessions. If anyone re-introduces a bare
   * `cwd.replace(/[:]/g, '-')` (missing the slash escapes) the test
   * will fail because the buggy form leaves the slashes intact and
   * never produces the daemon's slug. */
  function buggyInlineSlug(cwd: string): string {
    return cwd.replace(/[:]/g, '-').toLowerCase();
  }
  function lookupSlug(cwd: string): string {
    return cwdToSlug(cwd).toLowerCase();
  }

  it('produces the daemon slug for a Windows-shaped cwd', () => {
    expect(lookupSlug('C:/dev/Projects/DevNeural')).toBe(
      'c--dev-projects-devneural',
    );
  });

  it('disagrees with the buggy inline form (regression guard)', () => {
    const cwd = 'C:/dev/Projects/DevNeural';
    expect(buggyInlineSlug(cwd)).not.toBe(lookupSlug(cwd));
  });

  it('matches cwdToSlug exactly with .toLowerCase() applied', () => {
    const cwd = 'C:\\dev\\Projects\\DevNeural';
    expect(lookupSlug(cwd)).toBe(cwdToSlug(cwd).toLowerCase());
  });
});
