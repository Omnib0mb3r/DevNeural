/**
 * Worker-scoped Lex system prompt (bug: 2026-07-08 Lex sees all
 * workers). When a spawn is scoped to a supervised worker, the
 * prompt's live-snapshot layer must describe exactly that worker
 * (never the global project/session registries) and carry a hard
 * scope contract naming the only permitted inject target. The spawn
 * prompt composer threads the scope through unchanged.
 */
import { describe, expect, it } from 'vitest';
import { buildLexSystemPromptVersioned } from '../src/lex/system-prompt.js';
import { buildLexSpawnPrompt } from '../src/lex/spawn-prompt.js';

const SCOPE = {
  brainstormId: 'bs-mha-anchor',
  projectAnchorId: 'proj-mha',
  projectSlug: 'Material-Handling-Academy',
  workerSessionId: 'cc-mha-1234',
};

describe('buildLexSystemPromptVersioned worker scope', () => {
  it('renders the scoped worker block instead of the global registries', () => {
    const r = buildLexSystemPromptVersioned({ archive: false, scope: SCOPE });
    expect(r.prompt).toContain('Material-Handling-Academy');
    expect(r.prompt).toContain('# Worker scope (hard rule)');
    expect(r.prompt).toContain('exactly one worker');
    expect(r.prompt).not.toContain('## Registered projects');
    expect(r.prompt).not.toContain('## Active Claude Code sessions');
  });

  it('mandates from_anchor_id on every steer/inject call', () => {
    const r = buildLexSystemPromptVersioned({ archive: false, scope: SCOPE });
    expect(r.prompt).toContain('from_anchor_id');
    expect(r.prompt).toContain('bs-mha-anchor');
  });

  it('renders the no-worker contract when the anchor supervises nothing', () => {
    const r = buildLexSystemPromptVersioned({
      archive: false,
      scope: { ...SCOPE, projectAnchorId: null, projectSlug: null, workerSessionId: null },
    });
    expect(r.prompt).toContain('supervises no worker');
    expect(r.prompt).not.toContain('## Registered projects');
    expect(r.prompt).not.toContain('## Active Claude Code sessions');
  });

  it('keeps the legacy global snapshot when no scope is passed', () => {
    const r = buildLexSystemPromptVersioned({ archive: false });
    expect(r.prompt).toContain('## Registered projects');
    expect(r.prompt).toContain('## Active Claude Code sessions');
    expect(r.prompt).not.toContain('# Worker scope (hard rule)');
  });

  it('keeps the hashed stable body identical with and without scope', () => {
    /* The archive version hashes everything BEFORE the live snapshot.
     * The scope contract rides between stable body and snapshot, so
     * stripping both must leave byte-identical text — a scope that
     * leaked into the stable body would fork the archive version on
     * every spawn. (archive:false here so the test never writes to
     * the real on-disk archive; DATA_ROOT is a module-load const.) */
    const a = buildLexSystemPromptVersioned({ archive: false });
    const b = buildLexSystemPromptVersioned({ archive: false, scope: SCOPE });
    const stableOf = (p: string) =>
      p.split('\n\n# Worker scope (hard rule)')[0]!.split('\n\n# Live snapshot')[0]!;
    expect(stableOf(b.prompt)).toBe(stableOf(a.prompt));
    expect(b.prompt).toContain('# Worker scope (hard rule)');
    expect(a.prompt).not.toContain('# Worker scope (hard rule)');
  });
});

describe('buildLexSpawnPrompt worker scope threading', () => {
  it('threads scope through to the composed prompt', () => {
    const r = buildLexSpawnPrompt({
      lexSessionId: 'bs-mha-anchor',
      scope: SCOPE,
    });
    expect(r.prompt).toContain('# Worker scope (hard rule)');
    expect(r.prompt).toContain('Material-Handling-Academy');
    expect(r.prompt).not.toContain('## Registered projects');
  });

  it('stays scope-free when no scope is passed (legacy)', () => {
    const r = buildLexSpawnPrompt({ lexSessionId: 'bs-legacy' });
    expect(r.prompt).not.toContain('# Worker scope (hard rule)');
  });
});
