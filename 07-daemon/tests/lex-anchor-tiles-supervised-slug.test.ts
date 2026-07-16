/**
 * Stream Deck nesting link (2026-07-16 operator ask: nest a worker
 * session slightly under its brainstorm session). The deck needs the
 * brainstorm -> worker link on the tile; supervisedSlugFor resolves
 * lex_session.supervises_project_anchor_id to the worker's
 * project_slug through an injected resolver.
 */
import { describe, expect, it } from 'vitest';
import { supervisedSlugFor } from '../src/lex/anchor-tiles.js';

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
