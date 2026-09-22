/* Plan approval by voice (LAYER-1-CONTROL Phase B): pure helpers behind
 * the ExitPlanMode detect / read / answer loop.
 *
 * The brain (L2) runs headless in --permission-mode plan. When it calls
 * ExitPlanMode the TUI raises "Would you like to proceed?" and nobody is
 * there to answer, so the daemon must (1) recognise the Notification hook
 * post as THAT prompt, (2) pull the plan text out of the session jsonl,
 * (3) park it per anchor until the operator answers by voice, then
 * (4) press Enter (approve) or Escape + a reason prompt (reject) on the
 * PTY. Each step is pinned here in isolation; the route owns the real
 * PTY writes and file reads.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PlanApprovalRegistry,
  approvePlan,
  extractPendingPlan,
  isPlanApprovalPrompt,
  rejectPlan,
  type PendingPlan,
} from '../src/lex/plan-approval.js';

/* jsonl record builders. Shapes mirror what Claude Code writes: a top
 * level `type` plus a `message` carrying the API content blocks. */
function assistantExitPlanMode(id: string, plan: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${id}`,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here is the plan.' },
        { type: 'tool_use', id, name: 'ExitPlanMode', input: { plan } },
      ],
    },
  });
}

function userToolResult(toolUseId: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'User has approved your plan. You can now start coding.',
        },
      ],
    },
  });
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function assistantOtherTool(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'Read', input: { file_path: 'x.ts' } },
      ],
    },
  });
}

function userStringContent(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  });
}

const PLAN = '# Plan\n1. do x';

describe('isPlanApprovalPrompt', () => {
  it('accepts the current permission_prompt kind naming ExitPlanMode', () => {
    expect(
      isPlanApprovalPrompt(
        'permission_prompt',
        'Claude needs your permission to use ExitPlanMode',
      ),
    ).toBe(true);
  });

  it('accepts the older bare permission kind', () => {
    expect(isPlanApprovalPrompt('permission', 'ExitPlanMode')).toBe(true);
  });

  it('rejects idle_prompt even when the message mentions ExitPlanMode', () => {
    expect(isPlanApprovalPrompt('idle_prompt', 'ExitPlanMode')).toBe(false);
  });

  it('rejects a permission prompt for a different tool', () => {
    expect(
      isPlanApprovalPrompt(
        'permission_prompt',
        'Claude needs your permission to use Bash',
      ),
    ).toBe(false);
  });
});

describe('extractPendingPlan', () => {
  it('returns the plan of an unanswered ExitPlanMode call', () => {
    const tail = [assistantText('thinking...'), assistantExitPlanMode('tu1', PLAN)].join('\n');
    expect(extractPendingPlan(tail)).toBe(PLAN);
  });

  it('returns null once a tool_result answers that call', () => {
    const tail = [
      assistantText('thinking...'),
      assistantExitPlanMode('tu1', PLAN),
      userToolResult('tu1'),
    ].join('\n');
    expect(extractPendingPlan(tail)).toBeNull();
  });

  it('keeps the plan pending when the tool_result is for another id', () => {
    const tail = [
      assistantOtherTool('tuRead'),
      userToolResult('tuRead'),
      assistantExitPlanMode('tu1', PLAN),
      assistantOtherTool('tu2'),
      userToolResult('tu2'),
    ].join('\n');
    expect(extractPendingPlan(tail)).toBe(PLAN);
  });

  it('returns null for a tail with only text blocks', () => {
    const tail = [assistantText('a'), assistantText('b')].join('\n');
    expect(extractPendingPlan(tail)).toBeNull();
  });

  it('returns null for an empty tail', () => {
    expect(extractPendingPlan('')).toBeNull();
  });

  it('returns the second plan when only the first ExitPlanMode was answered', () => {
    const tail = [
      assistantExitPlanMode('tu1', '# First\n1. old'),
      userToolResult('tu1'),
      assistantText('revising'),
      assistantExitPlanMode('tu2', '# Second\n1. new'),
    ].join('\n');
    expect(extractPendingPlan(tail)).toBe('# Second\n1. new');
  });

  it('returns an empty string when input.plan is not a string', () => {
    expect(extractPendingPlan(assistantExitPlanMode('tu1', { nested: true }))).toBe('');
    expect(extractPendingPlan(assistantExitPlanMode('tu2', undefined))).toBe('');
  });

  it('skips blank and unparseable lines', () => {
    const tail = [
      '',
      '   ',
      'not json {',
      '42',
      'null',
      '"just a string"',
      assistantExitPlanMode('tu1', PLAN),
      '{"type":"user","message":',
      '',
    ].join('\n');
    expect(extractPendingPlan(tail)).toBe(PLAN);
  });

  it('tolerates message.content given as a plain string', () => {
    const tail = [
      userStringContent('please plan this'),
      assistantExitPlanMode('tu1', PLAN),
      userStringContent('typed while waiting'),
    ].join('\n');
    expect(extractPendingPlan(tail)).toBe(PLAN);
  });

  it('handles CRLF line endings', () => {
    const tail = [assistantExitPlanMode('tu1', PLAN), userToolResult('tu1')].join('\r\n');
    expect(extractPendingPlan(tail)).toBeNull();
  });
});

describe('PlanApprovalRegistry', () => {
  function pending(anchorId: string, plan = PLAN): PendingPlan {
    return {
      anchorId,
      ccSessionId: `cc-${anchorId}`,
      ptyId: `pty-${anchorId}`,
      plan,
      atMs: 1_000,
    };
  }

  it('stores, returns, clears and counts pending plans by anchor', () => {
    const reg = new PlanApprovalRegistry();
    expect(reg.size()).toBe(0);
    expect(reg.get('a1')).toBeNull();

    reg.set(pending('a1'));
    reg.set(pending('a2'));
    expect(reg.size()).toBe(2);
    expect(reg.get('a1')).toEqual(pending('a1'));
    expect(reg.get('a2')?.ptyId).toBe('pty-a2');

    reg.clear('a1');
    expect(reg.get('a1')).toBeNull();
    expect(reg.size()).toBe(1);

    /* clearing an unknown anchor is a no-op */
    reg.clear('nope');
    expect(reg.size()).toBe(1);
  });

  it('replaces an existing entry for the same anchor', () => {
    const reg = new PlanApprovalRegistry();
    reg.set(pending('a1', 'old'));
    reg.set(pending('a1', 'new'));
    expect(reg.size()).toBe(1);
    expect(reg.get('a1')?.plan).toBe('new');
  });

  it('accepts a null ptyId (bridge-only sessions)', () => {
    const reg = new PlanApprovalRegistry();
    reg.set({ ...pending('a1'), ptyId: null });
    expect(reg.get('a1')?.ptyId).toBeNull();
  });
});

describe('approvePlan', () => {
  it('presses a bare Enter once (no text, no commit flag) and returns ok', () => {
    const inject = vi.fn((_ptyId: string, _text: string, _commit: boolean) => ({ ok: true }));
    expect(approvePlan(inject, 'pty9')).toBe(true);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]).toEqual(['pty9', '\r', false]);
  });

  it('returns false when the inject fails', () => {
    const inject = vi.fn(() => ({ ok: false }));
    expect(approvePlan(inject, 'pty9')).toBe(false);
    expect(inject).toHaveBeenCalledTimes(1);
  });
});

describe('rejectPlan', () => {
  function harness() {
    const order: string[] = [];
    const writeRaw = vi.fn((_ptyId: string, _bytes: string) => {
      order.push('writeRaw');
    });
    const inject = vi.fn((_ptyId: string, _text: string, _commit: boolean) => {
      order.push('inject');
      return { ok: true };
    });
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const delay = (fn: () => void, ms: number): void => {
      scheduled.push({ fn, ms });
    };
    return { order, writeRaw, inject, scheduled, delay };
  }

  it('writes Escape first, then injects the reason prompt after a 600ms delay', () => {
    const h = harness();
    rejectPlan(h.writeRaw, h.inject, 'pty-r', 'too risky', h.delay);

    expect(h.writeRaw).toHaveBeenCalledTimes(1);
    expect(h.writeRaw.mock.calls[0]).toEqual(['pty-r', '\x1b']);
    /* The reason prompt is deferred: nothing typed until the TUI has
     * dismissed the permission dialog. */
    expect(h.inject).not.toHaveBeenCalled();
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]?.ms).toBe(600);

    h.scheduled[0]?.fn();
    expect(h.inject).toHaveBeenCalledTimes(1);
    const [ptyId, text, commit] = h.inject.mock.calls[0] ?? [];
    expect(ptyId).toBe('pty-r');
    expect(commit).toBe(true);
    expect(text?.startsWith('[plan-rejected] The operator said no: too risky')).toBe(true);
    expect(text?.endsWith('Keep planning and present a revised plan.')).toBe(true);
    expect(h.order).toEqual(['writeRaw', 'inject']);
  });

  it('omits the colon clause when no reason is given', () => {
    const h = harness();
    rejectPlan(h.writeRaw, h.inject, 'pty-r', '', h.delay);
    h.scheduled[0]?.fn();
    expect(h.inject.mock.calls[0]?.[1]).toBe(
      '[plan-rejected] The operator said no. Keep planning and present a revised plan.',
    );
  });

  it('treats a whitespace-only reason as no reason', () => {
    const h = harness();
    rejectPlan(h.writeRaw, h.inject, 'pty-r', '   ', h.delay);
    h.scheduled[0]?.fn();
    expect(h.inject.mock.calls[0]?.[1]).toBe(
      '[plan-rejected] The operator said no. Keep planning and present a revised plan.',
    );
  });
});
