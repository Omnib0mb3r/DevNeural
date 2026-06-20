/**
 * Markdown corpus chunker (Unified Knowledge Index, first slice). Pure
 * module; pins heading-section chunking with store/path/heading/line/
 * snippet tags, recursive vs flat walks, and project scoping by store-set.
 */
import { describe, expect, it } from 'vitest';
import {
  chunkMarkdown,
  collectMarkdownCorpus,
  type CorpusDeps,
} from '../src/lex/markdown-corpus.js';

describe('chunkMarkdown', () => {
  it('splits by heading and tags line + heading + snippet', () => {
    const body = [
      '# Title',
      'intro line',
      '',
      '## Section A',
      'body of A about haiku canned responses',
      '',
      '## Section B',
      'body of B',
    ].join('\n');
    const chunks = chunkMarkdown('docs', '/p/doc.md', body);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toEqual(['Title', 'Section A', 'Section B']);
    const a = chunks.find((c) => c.heading === 'Section A')!;
    expect(a.line).toBe(4); // 1-based heading line
    expect(a.store).toBe('docs');
    expect(a.path).toBe('/p/doc.md');
    expect(a.snippet).toContain('haiku canned responses');
    expect(a.text).toContain('body of A');
  });

  it('captures preamble before the first heading', () => {
    const chunks = chunkMarkdown('memory', '/m/x.md', 'loose preamble\nmore');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe('');
    expect(chunks[0]!.line).toBe(1);
    expect(chunks[0]!.text).toContain('loose preamble');
  });

  it('drops empty sections', () => {
    const chunks = chunkMarkdown('docs', '/p/empty.md', '# A\n\n# B\nreal');
    /* A has no body -> still emitted as a heading-only chunk; B has body.
     * An entirely blank file yields nothing. */
    expect(chunkMarkdown('docs', '/p/blank.md', '\n\n   \n')).toEqual([]);
    expect(chunks.map((c) => c.heading)).toEqual(['A', 'B']);
  });
});

function fakeFs(tree: Record<string, string | null>): Partial<CorpusDeps> {
  /* tree: path -> file content; dirs are inferred from path prefixes. */
  const dirs = new Set<string>();
  for (const p of Object.keys(tree)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    isDir: (p) => dirs.has(p),
    listDir: (p) => {
      const names = new Set<string>();
      for (const full of [...Object.keys(tree), ...dirs]) {
        if (full === p) continue;
        if (full.startsWith(p + '/')) {
          const rest = full.slice(p.length + 1).split('/')[0]!;
          names.add(rest);
        }
      }
      return [...names];
    },
    readFile: (p) => tree[p] ?? null,
  };
}

describe('collectMarkdownCorpus', () => {
  it('walks flat + recursive stores, scoped to the given dirs only', () => {
    const deps = fakeFs({
      '/proj/memory/m1.md': '# Mem\nrule one',
      '/proj/docs/d1.md': '# Doc\ndoc one',
      '/proj/docs/sub/d2.md': '# Deep\ndeep doc',
      '/proj/docs/notes.txt': 'ignored non-md',
      '/other/docs/x.md': '# Other\nother project', // must NOT appear
    });
    const corpus = collectMarkdownCorpus(
      [
        { store: 'memory', dir: '/proj/memory' },
        { store: 'docs', dir: '/proj/docs', recursive: true },
      ],
      deps,
    );
    const paths = corpus.map((c) => c.path).sort();
    expect(paths).toEqual([
      '/proj/docs/d1.md',
      '/proj/docs/sub/d2.md',
      '/proj/memory/m1.md',
    ]);
    /* scope: nothing from /other */
    expect(corpus.some((c) => c.path.startsWith('/other'))).toBe(false);
    /* non-recursive store would not descend */
    const flat = collectMarkdownCorpus(
      [{ store: 'docs', dir: '/proj/docs' }],
      deps,
    );
    expect(flat.some((c) => c.path.includes('/sub/'))).toBe(false);
  });

  it('carries the store label onto every chunk', () => {
    const deps = fakeFs({ '/p/brainstorm/b.md': '# B\nidea' });
    const corpus = collectMarkdownCorpus(
      [{ store: 'brainstorm', dir: '/p/brainstorm' }],
      deps,
    );
    expect(corpus.every((c) => c.store === 'brainstorm')).toBe(true);
  });
});
