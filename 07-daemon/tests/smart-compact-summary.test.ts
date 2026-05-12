/**
 * Smart-compact summary assembler (SMART-COMPACT.md "Summary
 * assembly"). Builds the resume prompt from durable sources, not from
 * Lex's own context.
 */
import { describe, expect, it } from 'vitest';
import { assembleSummary } from '../src/lex/smart-compact.js';

describe('assembleSummary', () => {
  it('produces a prompt that opens with the project name and a refresh note', () => {
    const out = assembleSummary({
      projectSlug: 'devneural',
      title: 'DevNeural',
      cwd: 'C:/dev/Projects/DevNeural',
      activeWork:
        'Smart compact: Lex-driven worker context refresh per spec.',
      recentCommits: [
        '111aaaa feat(daemon): panic surface',
        '222bbbb fix(daemon): bridge presence',
      ],
      diffStat: ' 3 files changed, 42 insertions(+), 5 deletions(-)',
      jsonlPath: 'C:/Users/me/.claude/projects/devneural/cc-1.jsonl',
      lastActionSummary: 'Last edited 07-daemon/src/dashboard/panic-routes.ts',
      openAuditFindings: 0,
    });
    expect(out.startsWith('You were working on DevNeural.')).toBe(true);
    expect(out).toMatch(/Context refreshed for capacity/);
  });

  it('falls back to the project slug when title is not set', () => {
    const out = assembleSummary({
      projectSlug: 'devneural',
      title: null,
      cwd: 'C:/dev/Projects/DevNeural',
      activeWork: 'whatever',
      recentCommits: [],
      diffStat: '',
      jsonlPath: '',
      lastActionSummary: '',
      openAuditFindings: 0,
    });
    expect(out.startsWith('You were working on devneural.')).toBe(true);
  });

  it('embeds the active work, recent commits, and diff stat sections', () => {
    const out = assembleSummary({
      projectSlug: 'devneural',
      title: 'DevNeural',
      cwd: 'C:/dev/Projects/DevNeural',
      activeWork: 'Smart compact rollout.',
      recentCommits: ['c1 msg one', 'c2 msg two'],
      diffStat: ' 1 file changed, 9 insertions(+), 1 deletion(-)',
      jsonlPath: 'C:/p/cc.jsonl',
      lastActionSummary: 'Edited routes.ts and ran tests.',
      openAuditFindings: 2,
    });
    expect(out).toMatch(/Active work: Smart compact rollout\./);
    expect(out).toMatch(/c1 msg one/);
    expect(out).toMatch(/c2 msg two/);
    expect(out).toMatch(/1 file changed/);
    expect(out).toMatch(/Edited routes\.ts/);
    expect(out).toMatch(/C:\/p\/cc\.jsonl/);
    expect(out).toMatch(/audit findings.*2/i);
  });

  it('omits the audit findings line when count is 0', () => {
    const out = assembleSummary({
      projectSlug: 'p',
      title: 'P',
      cwd: 'C:/p',
      activeWork: 'x',
      recentCommits: [],
      diffStat: '',
      jsonlPath: '',
      lastActionSummary: '',
      openAuditFindings: 0,
    });
    expect(out).not.toMatch(/audit findings/i);
  });

  it('marks uncommitted=clean when diffStat is empty', () => {
    const out = assembleSummary({
      projectSlug: 'p',
      title: 'P',
      cwd: 'C:/p',
      activeWork: 'x',
      recentCommits: ['c msg'],
      diffStat: '',
      jsonlPath: '',
      lastActionSummary: '',
      openAuditFindings: 0,
    });
    expect(out).toMatch(/Uncommitted:\s*clean/);
  });
});

describe('wrap-and-commit prompt', () => {
  it('is exported as the canonical wrap text from the spec', async () => {
    const { WRAP_AND_COMMIT_PROMPT } = await import(
      '../src/lex/smart-compact.js'
    );
    expect(WRAP_AND_COMMIT_PROMPT).toMatch(/Wrap your current work/);
    expect(WRAP_AND_COMMIT_PROMPT).toMatch(/Reply "ready"/);
    expect(WRAP_AND_COMMIT_PROMPT).toMatch(/context refresh in progress/);
  });
});
