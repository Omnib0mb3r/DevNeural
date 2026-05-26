/**
 * Worker event snippet extractor (Fix 34d.1 addendum, 2026-05-26).
 *
 * The extractor produces high-signal per-event-type payloads from a
 * raw jsonl tail. Pre-addendum behavior shipped the last N bytes
 * directly, which on SessionStart was the skill-catalog blob and on
 * any hook tick was a hook_additional_context attachment. This file
 * pins the new behavior: meta records are filtered out, per-event
 * formatters produce structured briefs, the empty case never silently
 * swallows.
 */
import { describe, expect, it } from 'vitest';
import {
  extractEventSnippet,
  parseMeaningfulLines,
} from '../src/dashboard/worker-event-snippet.js';

const NOW = 5_000_000;

function userText(text: string, ts?: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: ts ?? new Date(NOW - 60_000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function assistantText(
  text: string,
  ts?: string,
  stop_reason: string = 'end_turn',
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: ts ?? new Date(NOW - 30_000).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason,
    },
  });
}

function assistantToolUse(
  name: string,
  input: unknown,
  toolUseId = 'tu-1',
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(NOW - 20_000).toISOString(),
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name, input, tool_use_id: toolUseId },
      ],
      stop_reason: 'tool_use',
    },
  });
}

function userToolResult(
  text: string,
  opts: { tool_use_id?: string; is_error?: boolean } = {},
): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(NOW - 15_000).toISOString(),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: opts.tool_use_id ?? 'tu-1',
          is_error: !!opts.is_error,
          content: text,
        },
      ],
    },
  });
}

describe('parseMeaningfulLines', () => {
  it('skips attachment records (skill catalog, hook_additional_context)', () => {
    const tail = [
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          content: ['noisy hook fired'],
        },
        uuid: 'h-1',
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'session_init', skillCount: 99, isInitial: true },
        uuid: 'h-2',
      }),
      userText('actual user prompt'),
    ].join('\n');
    const lines = parseMeaningfulLines(tail);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.type).toBe('user');
    expect(lines[0]?.text).toBe('actual user prompt');
  });

  it('skips isMeta and isCompactSummary records', () => {
    const tail = [
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'skipped' },
      }),
      JSON.stringify({
        type: 'assistant',
        isCompactSummary: true,
        message: { role: 'assistant', content: 'skipped too' },
      }),
      assistantText('real reply'),
    ].join('\n');
    const lines = parseMeaningfulLines(tail);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('real reply');
  });

  it('extracts text + tool_use + tool_result parts', () => {
    const tail = [
      assistantToolUse('Bash', { command: 'ls' }, 'tu-x'),
      userToolResult('ok', { tool_use_id: 'tu-x' }),
    ].join('\n');
    const lines = parseMeaningfulLines(tail);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.toolUses).toEqual([
      { name: 'Bash', input: { command: 'ls' }, id: 'tu-x' },
    ]);
    expect(lines[1]?.toolResults).toEqual([
      { tool_use_id: 'tu-x', text: 'ok', is_error: false },
    ]);
  });

  it('tolerates malformed JSON and partial leading lines', () => {
    const tail = '{not valid\n' + userText('hi') + '\n';
    const lines = parseMeaningfulLines(tail);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('hi');
  });
});

describe('extractEventSnippet — idle', () => {
  it('mixes stall + last user + last assistant + skips meta', () => {
    const tail = [
      /* meta noise that pre-addendum behavior would have shipped */
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'hook_additional_context' },
        uuid: 'h-noise',
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'session_init', skillCount: 99 },
        uuid: 'h-init',
      }),
      userText('please rebuild the daemon'),
      assistantText('On it, running build.', undefined, 'tool_use'),
      assistantToolUse('Bash', { command: 'npm run build' }),
      userToolResult('build ok\n123 files', { tool_use_id: 'tu-1' }),
      assistantText(
        'Build completed. All checks pass.',
        new Date(NOW - 10 * 60 * 1000).toISOString(),
      ),
    ].join('\n');
    const snippet = extractEventSnippet('idle', tail, { now: NOW });
    expect(snippet).toMatch(/stall_seconds=600/);
    expect(snippet).toMatch(/last_user: please rebuild the daemon/);
    /* last_assistant skips the pre-tool ack ("On it, running build.")
     * because stop_reason='tool_use' marks it as intermediate; the
     * real reply is the final end_turn assistant line. */
    expect(snippet).toMatch(/last_assistant: Build completed/);
    expect(snippet).not.toMatch(/On it, running build/);
    expect(snippet).toMatch(/last_tool: Bash\(/);
    expect(snippet).toMatch(/last_tool_result: ok build ok/);
    expect(snippet).not.toMatch(/skillCount/);
    expect(snippet).not.toMatch(/hook_additional_context/);
  });

  it('falls back to (no recent activity) when no meaningful lines exist', () => {
    const tail = JSON.stringify({
      type: 'attachment',
      attachment: { type: 'hook_additional_context' },
      uuid: 'h-1',
    });
    const snippet = extractEventSnippet('idle', tail, { now: NOW });
    expect(snippet).toBe('(no recent activity)');
  });

  it('caps output at ~600 chars with middle truncation marker', () => {
    const big = 'x'.repeat(5_000);
    const tail = userText(big);
    const snippet = extractEventSnippet('idle', tail, { now: NOW });
    expect(snippet.length).toBeLessThanOrEqual(601);
  });
});

describe('extractEventSnippet — permission_denied', () => {
  it('produces denied_tool + denied_input + reason from tool_result + matching tool_use', () => {
    const tail = [
      assistantToolUse('Bash', { command: 'rm -rf /' }, 'tu-deny'),
      userToolResult(
        'Permission to use Bash has been denied for safety.',
        { tool_use_id: 'tu-deny', is_error: true },
      ),
    ].join('\n');
    const snippet = extractEventSnippet('permission_denied', tail);
    expect(snippet).toMatch(/denied_tool:\s*Bash/);
    expect(snippet).toMatch(/denied_input:.*rm -rf/);
    expect(snippet).toMatch(/reason: Permission to use Bash has been denied/);
  });

  it('falls back to regex on raw tail when tool_result shape is synthetic', () => {
    const tail = JSON.stringify({
      type: 'tool_result',
      is_error: true,
      content: 'Permission to use Edit has been denied',
    });
    const snippet = extractEventSnippet('permission_denied', tail);
    expect(snippet).toMatch(/denied_tool:\s*Edit/);
    expect(snippet).toMatch(/reason: Permission to use Edit/);
  });
});

describe('extractEventSnippet — commit', () => {
  it('extracts branch + subject + files_changed from a commit tool_result', () => {
    const commitOut =
      '[master 2e0d590] fix(supervisor): route Lex-target injects through queueSessionPrompt\n' +
      ' 3 files changed, 9 insertions(+), 1 deletion(-)';
    const tail = [
      assistantToolUse('Bash', { command: 'git commit -m "..."' }, 'tu-c'),
      userToolResult(commitOut, { tool_use_id: 'tu-c' }),
    ].join('\n');
    const snippet = extractEventSnippet('commit', tail);
    expect(snippet).toMatch(/branch: master/);
    expect(snippet).toMatch(/subject: fix\(supervisor\)/);
    expect(snippet).toMatch(/files_changed: 3/);
  });
});

describe('extractEventSnippet — narrated_success_no_commit (Fix 34d.2)', () => {
  it('renders claim + HEAD-not-advanced + sha_at_claim + recent_commits', () => {
    const snippet = extractEventSnippet(
      'narrated_success_no_commit',
      '',
      {
        narratedSuccess: {
          claimText: 'Bundle shipped.',
          headShaAtClaim: 'deadbeefcafefacefeedface',
          recentCommits: [
            'c2bff48 docs(fixes): record Fix 34d.1 row',
            '318260f fix(supervisor): route Lex injects through pty',
            '2e0d590 fix(supervisor): lex-queue branch',
          ],
        },
      },
    );
    expect(snippet).toMatch(/claim: Bundle shipped\./);
    expect(snippet).toMatch(/git HEAD did not advance/);
    expect(snippet).toMatch(/sha_at_claim: deadbeefcafe/);
    expect(snippet).toMatch(/recent_commits:/);
    expect(snippet).toMatch(/- c2bff48 docs\(fixes\)/);
  });

  it('falls back to (no recent activity) when no narratedSuccess context supplied', () => {
    const snippet = extractEventSnippet(
      'narrated_success_no_commit',
      'tail bytes ignored',
    );
    expect(snippet).toBe('(no recent activity)');
  });
});

describe('extractEventSnippet — expectation_drift', () => {
  it('uses the supervisor-provided drift summary verbatim', () => {
    const snippet = extractEventSnippet(
      'expectation_drift',
      '(jsonl tail not used here)',
      { driftSnippet: 'worker is editing the wrong file' },
    );
    expect(snippet).toBe('drift: worker is editing the wrong file');
  });

  it('falls back to (no recent activity) when both raw + override are empty', () => {
    const snippet = extractEventSnippet('expectation_drift', '   ', {
      driftSnippet: '',
    });
    expect(snippet).toBe('(no recent activity)');
  });
});
