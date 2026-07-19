/**
 * Stream Deck nesting link (2026-07-16 operator ask: nest a worker
 * session slightly under its brainstorm session). The deck needs the
 * brainstorm -> worker link on the tile; supervisedSlugFor resolves
 * lex_session.supervises_project_anchor_id to the worker's
 * project_slug through an injected resolver.
 */
import { describe, expect, it } from 'vitest';
import {
  supervisedSlugFor,
  supervisedWorkerSessionIdFor,
} from '../src/lex/anchor-tiles.js';

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
