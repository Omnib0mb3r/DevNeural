/**
 * buildLexSpawnPrompt unit tests
 * (PLAN-lex-session-rewrite.md, step 3).
 *
 * Verifies the per-spawn header composition without exercising the
 * archive write or live-state snapshot details (those are owned by
 * buildLexSystemPromptVersioned). archive: false keeps the prompt
 * archive clean during test runs.
 */
import { describe, expect, it } from 'vitest';
import { buildLexSpawnPrompt } from '../src/lex/spawn-prompt.js';

const LEX_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TX1 =
  'C:/Users/fake/.claude/projects/C--dev-data-skill-connections-brainstorm/11111111-1111-1111-1111-111111111111.jsonl';
const TX2 =
  'C:/Users/fake/.claude/projects/C--dev-data-skill-connections-brainstorm/22222222-2222-2222-2222-222222222222.jsonl';

describe('buildLexSpawnPrompt new variant', () => {
  it('selects new variant when transcriptPaths is empty', () => {
    const r = buildLexSpawnPrompt({
      lexSessionId: LEX_ID,
      transcriptPaths: [],
      archive: false,
    });
    expect(r.variant).toBe('new');
    expect(r.prompt).toContain(`lex_session_id: ${LEX_ID}`);
    expect(r.prompt).toContain('session one');
    expect(r.prompt).toContain('transcripts loaded: 0');
    expect(r.prompt).not.toContain('catching up');
    expect(r.prompt).not.toContain('caught up');
  });

  it('selects new variant when transcriptPaths is omitted', () => {
    const r = buildLexSpawnPrompt({
      lexSessionId: LEX_ID,
      archive: false,
    });
    expect(r.variant).toBe('new');
  });
});

describe('buildLexSpawnPrompt reopen variant', () => {
  it('selects reopen variant when transcriptPaths is non-empty', () => {
    const r = buildLexSpawnPrompt({
      lexSessionId: LEX_ID,
      transcriptPaths: [TX1, TX2],
      archive: false,
    });
    expect(r.variant).toBe('reopen');
    expect(r.prompt).toContain(`continuing brainstorm ${LEX_ID}`);
    expect(r.prompt).toContain('catching up, give me a moment.');
    expect(r.prompt).toContain(
      'caught up, what are we working on, sir.',
    );
  });

  it('lists transcripts in numbered order, top to bottom', () => {
    const r = buildLexSpawnPrompt({
      lexSessionId: LEX_ID,
      transcriptPaths: [TX1, TX2],
      archive: false,
    });
    const idx1 = r.prompt.indexOf(`1. ${TX1}`);
    const idx2 = r.prompt.indexOf(`2. ${TX2}`);
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(idx1);
  });

  it('forbids skipping or summarising mid-readback', () => {
    const r = buildLexSpawnPrompt({
      lexSessionId: LEX_ID,
      transcriptPaths: [TX1],
      archive: false,
    });
    expect(r.prompt).toContain('Do not skip lines');
    expect(r.prompt).toContain('Do not summarise');
    expect(r.prompt).toContain('Do not stop early');
  });
});

describe('buildLexSpawnPrompt forwards mode', () => {
  it('passes mode through to the base builder', () => {
    const r = buildLexSpawnPrompt({
      lexSessionId: LEX_ID,
      transcriptPaths: [],
      mode: 'notes',
      archive: false,
    });
    expect(r.mode).toBe('notes');
  });

  it('defaults mode to conversation', () => {
    const r = buildLexSpawnPrompt({
      lexSessionId: LEX_ID,
      transcriptPaths: [],
      archive: false,
    });
    expect(r.mode).toBe('conversation');
  });
});

describe('buildLexSpawnPrompt version stability', () => {
  it('version does not depend on lex_session_id or transcript list', () => {
    const a = buildLexSpawnPrompt({
      lexSessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
      transcriptPaths: [],
      archive: false,
    });
    const b = buildLexSpawnPrompt({
      lexSessionId: 'bbbbbbbb-2222-2222-2222-222222222222',
      transcriptPaths: [TX1, TX2],
      archive: false,
    });
    expect(a.version).toBe(b.version);
  });
});
