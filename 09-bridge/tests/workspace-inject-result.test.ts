/**
 * workspace-inject-result unit tests (WP-H: spawn delivery feedback).
 *
 * Pins the result-file contract the daemon's pollInjectResult
 * (07-daemon src/dashboard/projects-new.ts) depends on:
 *   - the result file path is derived from the CLAIM file path by
 *     string surgery, not by re-deriving the daemon's slug algorithm
 *   - the payload shape is {ok, error?, at, workspace}
 *   - '.result.json' names are recognized as results, never as
 *     pending workspace-inject markers
 *   - staleness uses the same TTL semantics as the marker sweep
 */
import { describe, expect, it } from 'vitest';
import {
  resultFileForClaim,
  buildWorkspaceInjectResultPayload,
  isResultFile,
  isStaleResultFile,
} from '../src/workspace-inject-result.js';

describe('resultFileForClaim', () => {
  it('derives <slug>.result.json from <slug>.json.claim', () => {
    const claim = 'C:/data/session-bridge/.workspace-inject/devneural_ab12cd34.json.claim';
    expect(resultFileForClaim(claim)).toBe(
      'C:/data/session-bridge/.workspace-inject/devneural_ab12cd34.result.json',
    );
  });

  it('normalizes backslashes before deriving the path', () => {
    const claim =
      'C:\\data\\session-bridge\\.workspace-inject\\devneural_ab12cd34.json.claim';
    expect(resultFileForClaim(claim)).toBe(
      'C:/data/session-bridge/.workspace-inject/devneural_ab12cd34.result.json',
    );
  });

  it('falls back gracefully for a path that does not end in .json.claim', () => {
    /* Shouldn't happen given processWorkspaceInjects always renames
     * '<slug>.json' -> '<slug>.json.claim', but must not throw. */
    expect(resultFileForClaim('C:/data/.workspace-inject/weird.claim')).toBe(
      'C:/data/.workspace-inject/weird.result.json',
    );
  });
});

describe('buildWorkspaceInjectResultPayload', () => {
  const fixedNow = () => new Date('2026-07-14T12:00:00.000Z');

  it('omits error on success', () => {
    const payload = buildWorkspaceInjectResultPayload(
      'C:/dev/Projects/DevNeural',
      { ok: true },
      fixedNow,
    );
    expect(payload).toEqual({
      ok: true,
      at: '2026-07-14T12:00:00.000Z',
      workspace: 'C:/dev/Projects/DevNeural',
    });
    expect(payload).not.toHaveProperty('error');
  });

  it('includes the error message on failure', () => {
    const payload = buildWorkspaceInjectResultPayload(
      'C:/dev/Projects/DevNeural',
      { ok: false, error: 'no active terminal' },
      fixedNow,
    );
    expect(payload).toEqual({
      ok: false,
      error: 'no active terminal',
      at: '2026-07-14T12:00:00.000Z',
      workspace: 'C:/dev/Projects/DevNeural',
    });
  });
});

describe('isResultFile', () => {
  it('recognizes .result.json names', () => {
    expect(isResultFile('devneural_ab12cd34.result.json')).toBe(true);
  });

  it('does not mistake a plain marker for a result file', () => {
    expect(isResultFile('devneural_ab12cd34.json')).toBe(false);
  });
});

describe('isStaleResultFile', () => {
  const ttl = 10 * 60_000;

  it('is not stale just under the TTL', () => {
    const mtime = 1_000_000;
    const now = mtime + ttl - 1;
    expect(isStaleResultFile(mtime, now, ttl)).toBe(false);
  });

  it('is stale once the TTL is exceeded', () => {
    const mtime = 1_000_000;
    const now = mtime + ttl + 1;
    expect(isStaleResultFile(mtime, now, ttl)).toBe(true);
  });
});
