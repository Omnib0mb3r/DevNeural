/**
 * Stream Deck nesting link (2026-07-16 operator ask: nest a worker
 * session slightly under its brainstorm session). The deck needs the
 * brainstorm -> worker link on the tile; supervisedSlugFor resolves
 * lex_session.supervises_project_anchor_id to the worker's
 * project_slug through an injected resolver.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  lexCtxPctFor,
  supervisedSlugFor,
  supervisedWorkerSessionIdFor,
  workerCtxPctFor,
} from '../src/lex/anchor-tiles.js';
import { transcriptPathFor } from '../src/lex/spawn-lex-session.js';

describe('supervisedSlugFor', () => {
  it('resolves the supervised anchor to its project slug', () => {
    const slug = supervisedSlugFor(
      { supervises_project_anchor_id: 'anchor-1' },
      (id) => (id === 'anchor-1' ? 'devneural' : null),
    );
    expect(slug).toBe('devneural');
  });

  it('returns null when unbound, resolver missing, or anchor unknown', () => {
    expect(supervisedSlugFor({ supervises_project_anchor_id: null })).toBeNull();
    expect(
      supervisedSlugFor({ supervises_project_anchor_id: 'anchor-1' }),
    ).toBeNull();
    expect(
      supervisedSlugFor(
        { supervises_project_anchor_id: 'gone' },
        () => null,
      ),
    ).toBeNull();
  });

  it('never throws on a throwing resolver', () => {
    expect(
      supervisedSlugFor({ supervises_project_anchor_id: 'x' }, () => {
        throw new Error('db closed');
      }),
    ).toBeNull();
  });
});

/* The deck nests by the supervised worker's SESSION ID, not the slug:
 * the tile-side project_slug (short name, e.g. "DevNeural") and the
 * session-side group slug (the ~/.claude/projects dir, e.g.
 * "c--dev-Projects-DevNeural") are different formats and never ===.
 * supervisedWorkerSessionIdFor resolves the anchor's live worker
 * session id (project_session.current_session_id) so the deck can match
 * on the authoritative id the binding already knows. */
describe('supervisedWorkerSessionIdFor', () => {
  it('resolves the supervised anchor to its live worker session id', () => {
    const sid = supervisedWorkerSessionIdFor(
      { supervises_project_anchor_id: 'anchor-1' },
      (id) => (id === 'anchor-1' ? '2994e119-worker' : null),
    );
    expect(sid).toBe('2994e119-worker');
  });

  it('returns null when unbound, resolver missing, or session id absent', () => {
    expect(
      supervisedWorkerSessionIdFor({ supervises_project_anchor_id: null }),
    ).toBeNull();
    expect(
      supervisedWorkerSessionIdFor({ supervises_project_anchor_id: 'anchor-1' }),
    ).toBeNull();
    expect(
      supervisedWorkerSessionIdFor(
        { supervises_project_anchor_id: 'fresh-anchor-no-session' },
        () => null,
      ),
    ).toBeNull();
  });

  it('never throws on a throwing resolver', () => {
    expect(
      supervisedWorkerSessionIdFor({ supervises_project_anchor_id: 'x' }, () => {
        throw new Error('db closed');
      }),
    ).toBeNull();
  });
});

/* Context gauge (2026-09-22 plan, Task 10). A brainstorm tile carries
 * the supervised worker's context usage so the deck can draw the gauge
 * with the smart-clear trip marks. The worker pct derives from the
 * worker's own jsonl, located exactly where Claude Code writes it:
 * transcriptPathFor({ cwd: project_session.cwd, ccSessionId:
 * project_session.current_session_id }). Every failure mode (unbound,
 * no live worker session, no cwd, no usage record yet, throwing
 * resolver) is null, never a fake 0, so the gauge reads "unknown"
 * instead of "empty". */
describe('workerCtxPctFor', () => {
  const cwd = 'C:/dev/Projects/foo';
  const sid = (id: string) => (id === 'anchor-1' ? 'cc-worker-1' : null);
  const cwdOf = (id: string) => (id === 'anchor-1' ? cwd : null);

  it('derives the pct from the worker jsonl at transcriptPathFor(cwd, current_session_id)', () => {
    const derive = vi.fn((_p: string) => ({ tokens: 420_000, max: 1_000_000 }));
    const pct = workerCtxPctFor(
      { supervises_project_anchor_id: 'anchor-1' },
      sid,
      cwdOf,
      derive,
    );
    expect(pct).toBe(42);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith(
      transcriptPathFor({ cwd, ccSessionId: 'cc-worker-1' }),
    );
  });

  it('is null when unbound, and never touches the jsonl', () => {
    const derive = vi.fn((_p: string) => ({ tokens: 1, max: 2 }));
    expect(
      workerCtxPctFor({ supervises_project_anchor_id: null }, sid, cwdOf, derive),
    ).toBeNull();
    expect(derive).not.toHaveBeenCalled();
  });

  it('is null when the worker has no live session id or no cwd', () => {
    const derive = vi.fn((_p: string) => ({ tokens: 1, max: 2 }));
    expect(
      workerCtxPctFor(
        { supervises_project_anchor_id: 'fresh-anchor' },
        () => null,
        cwdOf,
        derive,
      ),
    ).toBeNull();
    expect(
      workerCtxPctFor(
        { supervises_project_anchor_id: 'anchor-1' },
        sid,
        () => null,
        derive,
      ),
    ).toBeNull();
    expect(
      workerCtxPctFor({ supervises_project_anchor_id: 'anchor-1' }, sid, undefined, derive),
    ).toBeNull();
    expect(derive).not.toHaveBeenCalled();
  });

  it('is null when the jsonl carries no usage record yet', () => {
    expect(
      workerCtxPctFor(
        { supervises_project_anchor_id: 'anchor-1' },
        sid,
        cwdOf,
        () => null,
      ),
    ).toBeNull();
  });

  it('never throws on a throwing resolver or deriver', () => {
    expect(
      workerCtxPctFor(
        { supervises_project_anchor_id: 'anchor-1' },
        () => {
          throw new Error('db closed');
        },
        cwdOf,
        () => ({ tokens: 1, max: 2 }),
      ),
    ).toBeNull();
    expect(
      workerCtxPctFor({ supervises_project_anchor_id: 'anchor-1' }, sid, cwdOf, () => {
        throw new Error('EACCES');
      }),
    ).toBeNull();
  });

  it('clamps to 0..100 and rounds to a whole percent', () => {
    expect(
      workerCtxPctFor(
        { supervises_project_anchor_id: 'anchor-1' },
        sid,
        cwdOf,
        () => ({ tokens: 1_200_000, max: 1_000_000 }),
      ),
    ).toBe(100);
    expect(
      workerCtxPctFor(
        { supervises_project_anchor_id: 'anchor-1' },
        sid,
        cwdOf,
        () => ({ tokens: 4_240, max: 10_000 }),
      ),
    ).toBe(42);
  });
});

describe('lexCtxPctFor', () => {
  it("derives Lex's own pct from the anchor's current transcript", () => {
    const derive = vi.fn((_p: string) => ({ tokens: 250_000, max: 1_000_000 }));
    expect(lexCtxPctFor('C:/u/.claude/projects/x/cc-lex.jsonl', derive)).toBe(25);
    expect(derive).toHaveBeenCalledWith('C:/u/.claude/projects/x/cc-lex.jsonl');
  });

  it('is null without a transcript, without a usage record, or on a throwing deriver', () => {
    const derive = vi.fn((_p: string) => ({ tokens: 1, max: 2 }));
    expect(lexCtxPctFor(null, derive)).toBeNull();
    expect(lexCtxPctFor(undefined, derive)).toBeNull();
    expect(derive).not.toHaveBeenCalled();
    expect(lexCtxPctFor('C:/t.jsonl', () => null)).toBeNull();
    expect(
      lexCtxPctFor('C:/t.jsonl', () => {
        throw new Error('EBUSY');
      }),
    ).toBeNull();
  });
});
