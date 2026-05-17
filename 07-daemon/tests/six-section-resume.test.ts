/**
 * Six-section resume builder tests.
 *
 * Each section's drop-vs-include path is pinned with a fixture
 * input. The failed-attempts extractor has a dedicated low-confidence
 * fixture to verify the gate actually drops hallucinated content.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSixSectionResume,
  type FailedAttemptsResult,
  type SixSectionResumeInput,
} from '../src/lex/six-section-resume.js';

function baseInput(over: Partial<SixSectionResumeInput> = {}): SixSectionResumeInput {
  return {
    projectName: 'DevNeural',
    activeWork: '',
    lastActionSummary: '',
    diffStatShort: [],
    recentToolPaths: [],
    recentCommits: [],
    nextStepFromAwaySummary: '',
    openAuditFindings: 0,
    jsonlPath: '/tmp/x.jsonl',
    recentAssistantTurns: [],
    ...over,
  };
}

describe('buildSixSectionResume', () => {
  it('drops every section when input is empty and emits only header + transcript pointer', async () => {
    const r = await buildSixSectionResume(baseInput());
    expect(r.text).toMatch(/Context refreshed/);
    expect(r.text).toMatch(/Resume from where you left off\. Full transcript:/);
    expect(r.text).not.toMatch(/##/); // no section headers rendered
    /* Every section reports its drop reason. */
    expect(r.dropped.length).toBe(6);
    expect(r.dropped).toContain('goal:empty-active-work');
    expect(r.dropped).toContain('current_state:no-last-action-or-findings');
    expect(r.dropped).toContain('files_in_flight:no-status-no-tool-paths');
    expect(r.dropped).toContain('changed:no-recent-commits');
    expect(r.dropped).toContain('failed_attempts:no-extractor');
    expect(r.dropped).toContain('next_step:no-next-line');
  });

  it('renders Goal when activeWork is set', async () => {
    const r = await buildSixSectionResume(
      baseInput({ activeWork: 'finish smart-compact race fix' }),
    );
    expect(r.text).toMatch(/## Goal\n.*finish smart-compact race fix/);
    expect(r.dropped).not.toContain('goal:empty-active-work');
  });

  it('renders Current state with last action + open findings', async () => {
    const r = await buildSixSectionResume(
      baseInput({
        lastActionSummary: 'Reading 07-daemon/src/lex/foo.ts',
        openAuditFindings: 3,
      }),
    );
    expect(r.text).toMatch(/## Current state/);
    expect(r.text).toMatch(/Last action: Reading 07-daemon/);
    expect(r.text).toMatch(/Open audit findings for this project: 3\./);
  });

  it('renders Files in flight with git status + tool paths, dedupes + caps to 8', async () => {
    /* 10 tool paths, two of them duplicates of newer entries. */
    const paths = [
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
      'e.ts',
      'f.ts',
      'g.ts',
      'h.ts',
      'a.ts',
      'i.ts',
    ];
    const r = await buildSixSectionResume(
      baseInput({
        diffStatShort: [' M 07-daemon/src/lex/foo.ts', '?? scratch.md'],
        recentToolPaths: paths,
      }),
    );
    expect(r.text).toMatch(/## Files in flight/);
    expect(r.text).toMatch(/Working tree:/);
    expect(r.text).toMatch(/scratch\.md/);
    expect(r.text).toMatch(/Recent tool touches:/);
    const toolBlock = r.text.split('Recent tool touches:')[1] ?? '';
    /* Cap = 8 distinct, newest-last preferred. a.ts appears as the later
     * dedupe survivor. */
    const count = toolBlock.split('\n').filter((l) => /\.ts$/.test(l)).length;
    expect(count).toBe(8);
    expect(toolBlock).toContain('i.ts');
  });

  it('renders Changed when recent commits are present, drops when empty', async () => {
    const r = await buildSixSectionResume(
      baseInput({ recentCommits: ['abc def fix foo', 'def 123 refactor bar'] }),
    );
    expect(r.text).toMatch(/## Changed since last resume/);
    expect(r.text).toMatch(/abc def fix foo/);

    const empty = await buildSixSectionResume(baseInput({ recentCommits: [] }));
    expect(empty.dropped).toContain('changed:no-recent-commits');
  });

  it('renders Next step from explicit away-summary line', async () => {
    const r = await buildSixSectionResume(
      baseInput({ nextStepFromAwaySummary: 'wire the LLM extractor' }),
    );
    expect(r.text).toMatch(/## Next step\nwire the LLM extractor/);
  });

  it('drops Failed attempts when extractor returns low confidence', async () => {
    const garbageExtractor = async (): Promise<FailedAttemptsResult> => ({
      items: ['hallucinated item'],
      confidence: 0.2,
    });
    const r = await buildSixSectionResume(
      baseInput({ recentAssistantTurns: ['some turn text'] }),
      { extractFailedAttempts: garbageExtractor, failedAttemptsConfidenceFloor: 0.6 },
    );
    expect(r.text).not.toMatch(/## Failed attempts/);
    expect(r.dropped.some((d) => d.startsWith('failed_attempts:low-confidence'))).toBe(
      true,
    );
  });

  it('keeps Failed attempts when extractor returns high-confidence items', async () => {
    const goodExtractor = async (): Promise<FailedAttemptsResult> => ({
      items: ['tried X, hit timeout', 'tried Y, schema mismatch'],
      confidence: 0.85,
    });
    const r = await buildSixSectionResume(
      baseInput({ recentAssistantTurns: ['turn 1'] }),
      { extractFailedAttempts: goodExtractor },
    );
    expect(r.text).toMatch(/## Failed attempts/);
    expect(r.text).toMatch(/- tried X, hit timeout/);
    expect(r.text).toMatch(/- tried Y, schema mismatch/);
  });

  it('drops Failed attempts when extractor is wired but transcript is empty', async () => {
    const r = await buildSixSectionResume(baseInput({ recentAssistantTurns: [] }), {
      extractFailedAttempts: async () => ({ items: ['x'], confidence: 0.9 }),
    });
    expect(r.dropped).toContain('failed_attempts:no-transcript');
  });

  it('catches extractor exceptions and drops the section without throwing', async () => {
    const r = await buildSixSectionResume(
      baseInput({ recentAssistantTurns: ['turn'] }),
      {
        extractFailedAttempts: async () => {
          throw new Error('llm dead');
        },
      },
    );
    expect(r.text).not.toMatch(/## Failed attempts/);
    expect(r.dropped.some((d) => d.startsWith('failed_attempts:extractor-error'))).toBe(
      true,
    );
  });

  it('preserves section order Goal -> Current state -> Files -> Changed -> Failed -> Next', async () => {
    const r = await buildSixSectionResume(
      baseInput({
        activeWork: 'g',
        lastActionSummary: 'l',
        diffStatShort: [' M foo'],
        recentCommits: ['c1'],
        recentAssistantTurns: ['t'],
        nextStepFromAwaySummary: 'n',
      }),
      {
        extractFailedAttempts: async () => ({
          items: ['attempt'],
          confidence: 0.9,
        }),
      },
    );
    const order = [
      '## Goal',
      '## Current state',
      '## Files in flight',
      '## Changed since last resume',
      '## Failed attempts',
      '## Next step',
    ];
    let lastIdx = -1;
    for (const header of order) {
      const idx = r.text.indexOf(header);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});
