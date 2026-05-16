/**
 * Worker status footer protocol + parser. Phase 1 of the
 * autonomous supervisor work.
 *
 * Per Codex review: prose heuristics are not a control plane.
 * Worker sessions must emit a machine-parsable footer on every
 * terminal turn (the last assistant message before going idle) so
 * the supervisor can read state instead of inferring it from
 * sentence shape.
 *
 * Schema (both forms accepted by the parser):
 *
 *   <!-- worker-status
 *   status=done|needs_input|blocked|in_progress
 *   backlog_item_id=<id or none>
 *   commit_sha=<sha or none>
 *   tests=pass|fail|skipped|none
 *   needs_attention=true|false
 *   -->
 *
 *   OR
 *
 *   ```worker-status
 *   status=done
 *   backlog_item_id=xyz
 *   commit_sha=abc1234
 *   tests=pass
 *   needs_attention=false
 *   ```
 *
 * Phase 1 lands the protocol + parser only. No decision logic
 * consumes the parsed result; the supervisor wiring is a later
 * phase. The reminder template (WORKER_STATUS_FOOTER_TEMPLATE) is
 * injected via the worker-handoff SessionStart context so every
 * fresh worker session sees the protocol on its first turn.
 */

export type WorkerStatusStatus =
  | 'done'
  | 'needs_input'
  | 'blocked'
  | 'in_progress';

export type WorkerStatusTests = 'pass' | 'fail' | 'skipped' | 'none';

export interface WorkerStatus {
  status: WorkerStatusStatus;
  backlog_item_id: string | null;
  commit_sha: string | null;
  tests: WorkerStatusTests;
  needs_attention: boolean;
}

const VALID_STATUS = new Set<WorkerStatusStatus>([
  'done',
  'needs_input',
  'blocked',
  'in_progress',
]);
const VALID_TESTS = new Set<WorkerStatusTests>([
  'pass',
  'fail',
  'skipped',
  'none',
]);

/* The reminder text the SessionStart additionalContext path injects
 * into every worker session. Written once per session; the worker
 * is expected to emit a footer with these fields on every terminal
 * turn. Kept terse on purpose so it doesn't dominate the first-turn
 * context budget. */
export const WORKER_STATUS_FOOTER_TEMPLATE = [
  '## Status footer protocol (required)',
  '',
  'Append a status footer to your LAST assistant message on every',
  'terminal turn (the last message before you go idle). The footer',
  'is a machine-parsable record of where the task stands; the',
  'supervisor reads it instead of inferring state from prose.',
  '',
  'Use either form. Place the footer at the very end of the message.',
  '',
  'HTML comment form:',
  '',
  '<!-- worker-status',
  'status=done|needs_input|blocked|in_progress',
  'backlog_item_id=<id or none>',
  'commit_sha=<sha or none>',
  'tests=pass|fail|skipped|none',
  'needs_attention=true|false',
  '-->',
  '',
  'Or fenced block form:',
  '',
  '```worker-status',
  'status=done',
  'backlog_item_id=worker-clear-handoff',
  'commit_sha=62b919c',
  'tests=pass',
  'needs_attention=false',
  '```',
  '',
  'Field rules:',
  '- status: done = task complete and no follow-up needed.',
  '  needs_input = waiting on the user to answer a question.',
  '  blocked = cannot proceed without external action.',
  '  in_progress = will continue on the next turn.',
  '- backlog_item_id: the id from the active task, or "none".',
  '- commit_sha: short sha of any commit you just landed, or "none".',
  '- tests: pass / fail / skipped (intentionally), or "none" if not',
  '  applicable to this turn.',
  '- needs_attention: true when a human must look before the next',
  '  step (security choice, ambiguous requirement, scope question).',
].join('\n');

interface RawFooter {
  raw: string;
  body: string;
}

function findHtmlCommentFooter(text: string): RawFooter | null {
  /* Walk from the end backward; the LAST <!-- worker-status ... -->
   * wins so a quoted example earlier in the message (or in a prior
   * turn for tail walks) cannot win over the real footer. */
  const re = /<!--\s*worker-status\s*([\s\S]*?)-->/g;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(text)) !== null) {
    last = match;
  }
  if (!last) return null;
  return { raw: last[0], body: last[1] ?? '' };
}

function findFencedFooter(text: string): RawFooter | null {
  /* Same backward-walk semantics for the fenced form. The opening
   * fence must specify the language tag worker-status; plain
   * ```...``` blocks are ignored. */
  const re = /```worker-status\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(text)) !== null) {
    last = match;
  }
  if (!last) return null;
  return { raw: last[0], body: last[1] ?? '' };
}

function parseBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function coerceOptional(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (v.toLowerCase() === 'none') return null;
  /* Accept "<id or none>" template placeholders as missing so a
   * worker that pasted the unfilled template doesn't surface a
   * literal "<id or none>" string. */
  if (/^<.*>$/.test(v)) return null;
  return v;
}

function coerceBool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === '0') return false;
  return null;
}

/**
 * Parse a worker-status footer out of a single message body. Returns
 * null when no footer is present or when required fields are
 * missing / out of range. Never throws.
 */
export function parseWorkerStatusFooter(text: string): WorkerStatus | null {
  if (!text || typeof text !== 'string') return null;
  /* Try fenced form first because it's the more typo-resistant
   * shape (worker writes inside a code block, syntax highlighter
   * keeps them honest). Fall through to HTML-comment. */
  const fenced = findFencedFooter(text);
  const html = findHtmlCommentFooter(text);
  /* If both are present, the LATER one in the message wins; the
   * worker may have rewritten the footer during the turn. */
  let chosen: RawFooter | null = null;
  if (fenced && html) {
    const fencedIdx = text.lastIndexOf(fenced.raw);
    const htmlIdx = text.lastIndexOf(html.raw);
    chosen = fencedIdx > htmlIdx ? fenced : html;
  } else {
    chosen = fenced ?? html;
  }
  if (!chosen) return null;

  const fields = parseBody(chosen.body);
  const status = fields.status?.toLowerCase() as WorkerStatusStatus | undefined;
  if (!status || !VALID_STATUS.has(status)) return null;

  const tests =
    (fields.tests?.toLowerCase() as WorkerStatusTests | undefined) ?? 'none';
  if (!VALID_TESTS.has(tests)) return null;

  const needsAttention = coerceBool(fields.needs_attention);
  if (needsAttention === null) return null;

  return {
    status,
    backlog_item_id: coerceOptional(fields.backlog_item_id),
    commit_sha: coerceOptional(fields.commit_sha),
    tests,
    needs_attention: needsAttention,
  };
}

/**
 * Walk a Claude Code session jsonl tail backwards and return the
 * footer parsed from the LAST assistant message that carries one.
 * Mid-turn assistants without a footer skip; the caller can use
 * null as "no terminal-turn signal yet".
 *
 * lastN caps how many recent assistant messages the walker inspects
 * before giving up. The default (5) is enough to skip a short tail
 * of tool-only assistants and still find the prior terminal turn.
 */
export function extractFooterFromJsonlTail(
  jsonl: string,
  lastN: number = 5,
): WorkerStatus | null {
  if (!jsonl) return null;
  const lines = jsonl.split(/\r?\n/);
  let inspected = 0;
  for (let i = lines.length - 1; i >= 0 && inspected < lastN; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = entry as {
      type?: string;
      message?: {
        content?: unknown;
      };
    };
    if (obj.type !== 'assistant') continue;
    inspected += 1;
    const content = obj.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as { type?: string; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') {
          text += (text ? '\n' : '') + p.text;
        }
      }
    }
    if (!text) continue;
    const parsed = parseWorkerStatusFooter(text);
    if (parsed) return parsed;
  }
  return null;
}
