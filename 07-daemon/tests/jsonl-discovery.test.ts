/**
 * Deterministic jsonl session discovery (bug: 2026-07-08 brainstorm
 * cross-bind). All Lex brainstorm PTYs share one cwd, so they share
 * one ~/.claude/projects/<slug>/ directory. The old picker filtered
 * on ctimeMs, but on Windows libuv maps ctime to ftLastWriteTime, so
 * an OLDER still-active session's jsonl "qualifies" the moment it
 * receives a write after the new PTY spawns — and the new PTY binds
 * to another session's transcript. pickDiscoveryJsonl is the pure
 * replacement: creation-time based, claimed-session aware.
 */
import { describe, expect, it } from 'vitest';
import { pickDiscoveryJsonl } from '../src/dashboard/jsonl-discovery.js';

function entry(
  name: string,
  birthtimeMs: number,
  ctimeMs = birthtimeMs,
  mtimeMs = birthtimeMs,
) {
  return { name, birthtimeMs, ctimeMs, mtimeMs };
}

const SPAWN = 1_000_000;

describe('pickDiscoveryJsonl', () => {
  it('picks the jsonl created after spawn', () => {
    const picked = pickDiscoveryJsonl(
      [entry('new-session.jsonl', SPAWN + 500)],
      SPAWN,
      new Set(),
    );
    expect(picked).toBe('new-session');
  });

  it('ignores a pre-existing jsonl whose ctime moved after spawn (Windows write bump)', () => {
    /* old-active was created long before this PTY spawned but is
     * still receiving writes, so its ctime/mtime are fresh. The old
     * ctime-based filter picked it; the birthtime filter must not. */
    const picked = pickDiscoveryJsonl(
      [
        entry('old-active.jsonl', SPAWN - 240_000, SPAWN + 100, SPAWN + 100),
        entry('mine.jsonl', SPAWN + 900),
      ],
      SPAWN,
      new Set(),
    );
    expect(picked).toBe('mine');
  });

  it('skips sessions already claimed by another PTY', () => {
    const picked = pickDiscoveryJsonl(
      [
        entry('claimed.jsonl', SPAWN + 100),
        entry('mine.jsonl', SPAWN + 400),
      ],
      SPAWN,
      new Set(['claimed']),
    );
    expect(picked).toBe('mine');
  });

  it('returns null when every candidate is claimed or too old', () => {
    const picked = pickDiscoveryJsonl(
      [
        entry('claimed.jsonl', SPAWN + 100),
        entry('ancient.jsonl', SPAWN - 500_000),
      ],
      SPAWN,
      new Set(['claimed']),
    );
    expect(picked).toBeNull();
  });

  it('prefers the earliest-created qualifying jsonl', () => {
    const picked = pickDiscoveryJsonl(
      [
        entry('later.jsonl', SPAWN + 5_000),
        entry('earlier.jsonl', SPAWN + 1_000),
      ],
      SPAWN,
      new Set(),
    );
    expect(picked).toBe('earlier');
  });

  it('allows small clock skew before spawn', () => {
    const picked = pickDiscoveryJsonl(
      [entry('skewed.jsonl', SPAWN - 1_500)],
      SPAWN,
      new Set(),
    );
    expect(picked).toBe('skewed');
  });

  it('falls back to the min of ctime/mtime when birthtime is unset', () => {
    /* Some filesystems report birthtimeMs=0. Fall back to the least
     * recently moving stamp rather than dropping the candidate. */
    const picked = pickDiscoveryJsonl(
      [entry('no-birth.jsonl', 0, SPAWN + 700, SPAWN + 300)],
      SPAWN,
      new Set(),
    );
    expect(picked).toBe('no-birth');
  });

  it('ignores non-jsonl names defensively', () => {
    const picked = pickDiscoveryJsonl(
      [entry('notes.txt', SPAWN + 500)],
      SPAWN,
      new Set(),
    );
    expect(picked).toBeNull();
  });
});
