/* Worker status footer parser.
 *
 * Phase 1 of the autonomous supervisor work. The parser pulls a
 * machine-parsable status record off the END of an assistant
 * message so the supervisor (Phase 2+) can read state instead of
 * inferring it from prose. These tests pin:
 *
 *   - Clean done: every required field present, valid values.
 *   - Options pending: status=needs_input + the message carries a
 *     menu of options, parser still extracts the footer.
 *   - Blocked-on-permission: status=blocked + needs_attention=true.
 *   - Blocked-on-deps: status=blocked + tests=skipped, no commit.
 *   - Mid-turn: assistant emitted text without a footer, parser
 *     returns null so the caller treats it as "no terminal-turn
 *     signal yet".
 *   - Footer-shape edge cases (case, whitespace, both forms).
 *   - extractFooterFromJsonlTail walks back through tool-only
 *     assistant messages to find the last terminal turn.
 */
import { describe, expect, it } from 'vitest';
import {
  WORKER_STATUS_FOOTER_TEMPLATE,
  extractFooterFromJsonlTail,
  parseWorkerStatusFooter,
  type WorkerStatus,
} from '../src/dashboard/worker-status-footer.js';

const CLEAN_DONE = `Landed the worker-clear-handoff change. Tests green, commit pushed.

<!-- worker-status
status=done
backlog_item_id=worker-clear-handoff
commit_sha=62b919c
tests=pass
needs_attention=false
-->`;

const OPTIONS_PENDING = `Two ways to wire this up:

1. Treat the streamdeck virtual-input as the backstop.
2. Drop the backstop entirely and rely on bridge alone.

Which do you want?

\`\`\`worker-status
status=needs_input
backlog_item_id=none
commit_sha=none
tests=none
needs_attention=true
\`\`\``;

const BLOCKED_ON_PERMISSION = `Cannot proceed without a destructive-operation confirmation. The
migration drops a column; need explicit go-ahead before running.

<!-- worker-status
status=blocked
backlog_item_id=drop-legacy-pin-col
commit_sha=none
tests=skipped
needs_attention=true
-->`;

const BLOCKED_ON_DEPS = `Stuck waiting on the bridge VSIX rebuild; nothing to commit until
that lands.

<!-- worker-status
status=blocked
backlog_item_id=lex-bridge-rebuild
commit_sha=none
tests=skipped
needs_attention=false
-->`;

const MID_TURN = `Looking at the diff now, will report when I have something.`;

const IN_PROGRESS = `Mid-refactor on the cross-session-inject path. Will finish next turn.

<!-- worker-status
status=in_progress
backlog_item_id=cross-session-cr-nudge
commit_sha=none
tests=none
needs_attention=false
-->`;

const FOOTER_LOWERCASE_KEYS = `done

<!-- worker-status
STATUS=done
Backlog_Item_Id=abc-123
COMMIT_SHA=deadbeef
Tests=PASS
NEEDS_ATTENTION=FALSE
-->`;

const TWO_FOOTERS_LAST_WINS = `<!-- worker-status
status=in_progress
backlog_item_id=draft-revision
commit_sha=none
tests=none
needs_attention=false
-->

Actually landed it just now.

<!-- worker-status
status=done
backlog_item_id=draft-revision
commit_sha=abcd123
tests=pass
needs_attention=false
-->`;

describe('parseWorkerStatusFooter', () => {
  it('parses the clean-done case end-to-end', () => {
    const result = parseWorkerStatusFooter(CLEAN_DONE);
    expect(result).toEqual<WorkerStatus>({
      status: 'done',
      backlog_item_id: 'worker-clear-handoff',
      commit_sha: '62b919c',
      tests: 'pass',
      needs_attention: false,
    });
  });

  it('parses options-pending in the fenced block form', () => {
    const result = parseWorkerStatusFooter(OPTIONS_PENDING);
    expect(result).toEqual<WorkerStatus>({
      status: 'needs_input',
      backlog_item_id: null,
      commit_sha: null,
      tests: 'none',
      needs_attention: true,
    });
  });

  it('parses blocked-on-permission with needs_attention=true', () => {
    const result = parseWorkerStatusFooter(BLOCKED_ON_PERMISSION);
    expect(result).toEqual<WorkerStatus>({
      status: 'blocked',
      backlog_item_id: 'drop-legacy-pin-col',
      commit_sha: null,
      tests: 'skipped',
      needs_attention: true,
    });
  });

  it('parses blocked-on-deps with needs_attention=false', () => {
    const result = parseWorkerStatusFooter(BLOCKED_ON_DEPS);
    expect(result).toEqual<WorkerStatus>({
      status: 'blocked',
      backlog_item_id: 'lex-bridge-rebuild',
      commit_sha: null,
      tests: 'skipped',
      needs_attention: false,
    });
  });

  it('returns null on mid-turn messages with no footer', () => {
    expect(parseWorkerStatusFooter(MID_TURN)).toBeNull();
  });

  it('parses status=in_progress', () => {
    const result = parseWorkerStatusFooter(IN_PROGRESS);
    expect(result?.status).toBe('in_progress');
    expect(result?.commit_sha).toBeNull();
  });

  it('is case-insensitive on field keys + boolean tokens', () => {
    const result = parseWorkerStatusFooter(FOOTER_LOWERCASE_KEYS);
    expect(result).toEqual<WorkerStatus>({
      status: 'done',
      backlog_item_id: 'abc-123',
      commit_sha: 'deadbeef',
      tests: 'pass',
      needs_attention: false,
    });
  });

  it('takes the LAST footer when the message carries multiple', () => {
    const result = parseWorkerStatusFooter(TWO_FOOTERS_LAST_WINS);
    expect(result?.status).toBe('done');
    expect(result?.commit_sha).toBe('abcd123');
  });

  it('returns null on a footer with an unknown status value', () => {
    const bad = `<!-- worker-status
status=halfway
backlog_item_id=none
commit_sha=none
tests=none
needs_attention=false
-->`;
    expect(parseWorkerStatusFooter(bad)).toBeNull();
  });

  it('returns null when needs_attention is missing or non-boolean', () => {
    const missing = `<!-- worker-status
status=done
backlog_item_id=none
commit_sha=none
tests=none
-->`;
    expect(parseWorkerStatusFooter(missing)).toBeNull();
    const garbage = `<!-- worker-status
status=done
backlog_item_id=none
commit_sha=none
tests=none
needs_attention=maybe
-->`;
    expect(parseWorkerStatusFooter(garbage)).toBeNull();
  });

  it('treats "<id or none>" template placeholders as missing', () => {
    /* A worker that pasted the unfilled reminder template should
     * not surface the literal placeholder string as a real id. */
    const r = parseWorkerStatusFooter(`<!-- worker-status
status=done
backlog_item_id=<id or none>
commit_sha=<sha or none>
tests=none
needs_attention=false
-->`);
    expect(r?.backlog_item_id).toBeNull();
    expect(r?.commit_sha).toBeNull();
  });

  it('returns null on empty / non-string input', () => {
    expect(parseWorkerStatusFooter('')).toBeNull();
    expect(
      parseWorkerStatusFooter(undefined as unknown as string),
    ).toBeNull();
    expect(parseWorkerStatusFooter(null as unknown as string)).toBeNull();
  });

  it('ignores plain ``` fences without the worker-status tag', () => {
    /* A code block that happens to contain status=done text should
     * not be confused for the footer. */
    const r = parseWorkerStatusFooter(`Here is some example output:

\`\`\`
status=done
backlog_item_id=irrelevant
\`\`\`

No real footer in this message.`);
    expect(r).toBeNull();
  });
});

describe('extractFooterFromJsonlTail', () => {
  function asLine(entry: object): string {
    return JSON.stringify(entry);
  }

  it('returns the footer from the LAST assistant message', () => {
    const jsonl = [
      asLine({ type: 'user', message: { content: 'go do the thing' } }),
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: MID_TURN }] },
      }),
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: CLEAN_DONE }] },
      }),
    ].join('\n');
    const result = extractFooterFromJsonlTail(jsonl);
    expect(result?.status).toBe('done');
    expect(result?.commit_sha).toBe('62b919c');
  });

  it('walks back past tool-only assistants without a footer', () => {
    /* Many CC assistant messages carry only tool_use parts; the
     * walker has to skip those and land on the last terminal turn
     * with a real text body. */
    const jsonl = [
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: BLOCKED_ON_DEPS }] },
      }),
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      }),
      asLine({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
      }),
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: MID_TURN }] },
      }),
    ].join('\n');
    /* No assistant message with a footer in the last few entries:
     * MID_TURN has no footer, tool_use has no text, BLOCKED_ON_DEPS
     * sits further back. lastN=5 (default) reaches it. */
    const result = extractFooterFromJsonlTail(jsonl);
    expect(result?.status).toBe('blocked');
    expect(result?.backlog_item_id).toBe('lex-bridge-rebuild');
  });

  it('returns null when no recent assistant carries a footer', () => {
    const jsonl = [
      asLine({ type: 'user', message: { content: 'hello' } }),
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: MID_TURN }] },
      }),
    ].join('\n');
    expect(extractFooterFromJsonlTail(jsonl)).toBeNull();
  });

  it('respects the lastN cap and stops before reaching a deep footer', () => {
    const lines: string[] = [
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: CLEAN_DONE }] },
      }),
    ];
    /* Bury the footer behind a wall of footer-less assistant
     * messages so a lastN=2 walker cannot reach it. */
    for (let i = 0; i < 10; i++) {
      lines.push(
        asLine({
          type: 'assistant',
          message: { content: [{ type: 'text', text: MID_TURN }] },
        }),
      );
    }
    const jsonl = lines.join('\n');
    expect(extractFooterFromJsonlTail(jsonl, 2)).toBeNull();
  });

  it('handles malformed jsonl lines without throwing', () => {
    const jsonl = [
      'not-json{}garbage',
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: CLEAN_DONE }] },
      }),
      'another junk line',
    ].join('\n');
    const result = extractFooterFromJsonlTail(jsonl);
    expect(result?.status).toBe('done');
  });
});

describe('WORKER_STATUS_FOOTER_TEMPLATE', () => {
  it('documents every required field and both forms', () => {
    expect(WORKER_STATUS_FOOTER_TEMPLATE).toMatch(/status=done\|needs_input\|blocked\|in_progress/);
    expect(WORKER_STATUS_FOOTER_TEMPLATE).toMatch(/backlog_item_id=/);
    expect(WORKER_STATUS_FOOTER_TEMPLATE).toMatch(/commit_sha=/);
    expect(WORKER_STATUS_FOOTER_TEMPLATE).toMatch(/tests=pass\|fail\|skipped\|none/);
    expect(WORKER_STATUS_FOOTER_TEMPLATE).toMatch(/needs_attention=true\|false/);
    expect(WORKER_STATUS_FOOTER_TEMPLATE).toMatch(/<!-- worker-status/);
    expect(WORKER_STATUS_FOOTER_TEMPLATE).toMatch(/```worker-status/);
  });
});
