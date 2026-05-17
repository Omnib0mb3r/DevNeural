/**
 * Feedback-memory loader (Fix 12).
 *
 * Confirms the loader:
 *   - returns status='no-memory-dir' when the cwd has no memory/ dir
 *   - skips files without `type: feedback` frontmatter
 *   - skips non-.md files
 *   - returns the parsed body with frontmatter stripped
 *   - falls back to filename when frontmatter `name` is absent
 *   - sorts entries newest-first by mtime
 *   - caps at the configured limit + reports 'over-cap' status
 *   - rendered block reads as a Hard rules from operator section
 */
import { describe, expect, it } from 'vitest';
import {
  loadFeedbackMemories,
  renderFeedbackMemoriesBlock,
  DEFAULT_FEEDBACK_RULE_CAP,
} from '../src/lex/feedback-memories.js';

interface FakeFs {
  dir: string;
  files: Map<string, { content: string; mtime: number }>;
}

function fakeOpts(fs: FakeFs): Parameters<typeof loadFeedbackMemories>[1] {
  return {
    existsSync: (p) => p === fs.dir || fs.files.has(p),
    readdirSync: (p) => {
      if (p !== fs.dir) throw new Error(`unexpected readdir ${p}`);
      const out: string[] = [];
      const prefix = fs.dir + '/';
      for (const k of fs.files.keys()) {
        if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
      return out;
    },
    statSync: (p) => {
      const f = fs.files.get(p);
      if (!f) throw new Error(`stat: ${p} not found`);
      return { mtimeMs: f.mtime };
    },
    readFileSync: (p) => {
      const f = fs.files.get(p);
      if (!f) throw new Error(`read: ${p} not found`);
      return f.content;
    },
  };
}

describe('loadFeedbackMemories', () => {
  it('returns no-memory-dir when the memory directory is absent', () => {
    const r = loadFeedbackMemories('/fake/cwd', {
      existsSync: () => false,
      readdirSync: () => {
        throw new Error('should not be called');
      },
    });
    expect(r.status).toBe('no-memory-dir');
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([]);
  });

  it('returns no-memory-dir when cwd is empty', () => {
    const r = loadFeedbackMemories('');
    expect(r.status).toBe('no-memory-dir');
  });

  it('skips files without type: feedback frontmatter', () => {
    const fs: FakeFs = {
      dir: '/c/memory',
      files: new Map([
        [
          '/c/memory/rule.md',
          {
            content:
              '---\ntype: feedback\nname: be terse\n---\nKeep replies short.\n',
            mtime: 1000,
          },
        ],
        [
          '/c/memory/note.md',
          {
            content: '---\ntype: user\nname: profile\n---\nuser is X\n',
            mtime: 999,
          },
        ],
        [
          '/c/memory/readme.txt',
          { content: 'not markdown', mtime: 990 },
        ],
      ]),
    };
    const r = loadFeedbackMemories('/c', fakeOpts(fs));
    expect(r.status).toBe('ok');
    expect(r.kept.length).toBe(1);
    expect(r.kept[0]?.title).toBe('be terse');
    expect(r.kept[0]?.body).toBe('Keep replies short.');
  });

  it('falls back to filename when frontmatter name is missing', () => {
    const fs: FakeFs = {
      dir: '/c/memory',
      files: new Map([
        [
          '/c/memory/no-em-dashes.md',
          {
            content: '---\ntype: feedback\n---\nNever use em dashes.\n',
            mtime: 1500,
          },
        ],
      ]),
    };
    const r = loadFeedbackMemories('/c', fakeOpts(fs));
    expect(r.kept[0]?.title).toBe('no-em-dashes');
  });

  it('sorts by mtime descending (freshest first)', () => {
    const fs: FakeFs = {
      dir: '/c/memory',
      files: new Map([
        [
          '/c/memory/old.md',
          { content: '---\ntype: feedback\nname: old\n---\nold rule', mtime: 100 },
        ],
        [
          '/c/memory/mid.md',
          { content: '---\ntype: feedback\nname: mid\n---\nmid rule', mtime: 500 },
        ],
        [
          '/c/memory/new.md',
          { content: '---\ntype: feedback\nname: new\n---\nnew rule', mtime: 1000 },
        ],
      ]),
    };
    const r = loadFeedbackMemories('/c', fakeOpts(fs));
    expect(r.kept.map((k) => k.title)).toEqual(['new', 'mid', 'old']);
  });

  it('truncates over the cap and reports over-cap status', () => {
    const files = new Map<string, { content: string; mtime: number }>();
    for (let i = 0; i < 5; i++) {
      files.set(`/c/memory/rule-${i}.md`, {
        content: `---\ntype: feedback\nname: r${i}\n---\nbody ${i}`,
        mtime: i,
      });
    }
    const fs: FakeFs = { dir: '/c/memory', files };
    const r = loadFeedbackMemories('/c', { ...fakeOpts(fs), cap: 3 });
    expect(r.status).toBe('over-cap');
    expect(r.kept.length).toBe(3);
    expect(r.dropped.length).toBe(2);
    /* freshest 3 (mtime 4, 3, 2) survive */
    expect(r.kept.map((k) => k.title)).toEqual(['r4', 'r3', 'r2']);
  });

  it('default cap is DEFAULT_FEEDBACK_RULE_CAP', () => {
    expect(DEFAULT_FEEDBACK_RULE_CAP).toBe(30);
  });

  it('matches type case-insensitively', () => {
    const fs: FakeFs = {
      dir: '/c/memory',
      files: new Map([
        [
          '/c/memory/r.md',
          {
            content: '---\ntype: Feedback\nname: case\n---\ncase rule',
            mtime: 1,
          },
        ],
      ]),
    };
    const r = loadFeedbackMemories('/c', fakeOpts(fs));
    expect(r.kept.length).toBe(1);
  });
});

describe('renderFeedbackMemoriesBlock', () => {
  it('returns empty string when no rules are loaded', () => {
    expect(
      renderFeedbackMemoriesBlock({ kept: [], dropped: [], status: 'ok' }),
    ).toBe('');
  });

  it('renders rules as Hard rules section with ### per rule', () => {
    const block = renderFeedbackMemoriesBlock({
      status: 'ok',
      dropped: [],
      kept: [
        {
          path: '/c/memory/no-em-dashes.md',
          filename: 'no-em-dashes',
          title: 'No em dashes',
          body: 'Never use em dashes anywhere.',
          mtime_ms: 1000,
        },
        {
          path: '/c/memory/no-cosign.md',
          filename: 'no-cosign',
          title: 'No Claude co-author',
          body: "Don't add Co-Authored-By tags.",
          mtime_ms: 999,
        },
      ],
    });
    expect(block).toMatch(/^## Hard rules from operator/);
    expect(block).toMatch(/### No em dashes/);
    expect(block).toMatch(/Never use em dashes anywhere\./);
    expect(block).toMatch(/### No Claude co-author/);
  });
});
