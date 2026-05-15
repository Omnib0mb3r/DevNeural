/**
 * worker-stall-watch unit tests.
 *
 * Pin classifyStall + runWorkerStallTick branches without touching
 * the filesystem or the real notifications pipeline. The runtime
 * wiring (readTail + jsonlForAnchor + fireForStall) gets exercised
 * indirectly through the daemon boot path; this suite only proves
 * the pure decision logic.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyStall,
  runWorkerStallTick,
  type AnchorTailSummary,
  type StallWatchDeps,
} from '../src/dashboard/worker-stall-watch.js';

const NOW = 1_700_000_000_000;
const TOOL_MS = 300_000;
const USER_MS = 180_000;

describe('classifyStall', () => {
  it('returns null when the tail has no record timestamp', () => {
    const summary: AnchorTailSummary = {
      lastRole: 'assistant',
      lastRecordMs: null,
      lastAssistantWasTool: true,
    };
    expect(classifyStall(summary, NOW, TOOL_MS, USER_MS)).toBeNull();
  });

  it('fires tool-stall when an assistant tool_use is older than toolStallMs', () => {
    const summary: AnchorTailSummary = {
      lastRole: 'assistant',
      lastRecordMs: NOW - TOOL_MS - 1_000,
      lastAssistantWasTool: true,
    };
    const r = classifyStall(summary, NOW, TOOL_MS, USER_MS);
    expect(r?.kind).toBe('tool-stall');
    expect(r?.ageMs).toBeGreaterThanOrEqual(TOOL_MS);
  });

  it('stays silent when an assistant tool_use is still within the window', () => {
    const summary: AnchorTailSummary = {
      lastRole: 'assistant',
      lastRecordMs: NOW - TOOL_MS + 1_000,
      lastAssistantWasTool: true,
    };
    expect(classifyStall(summary, NOW, TOOL_MS, USER_MS)).toBeNull();
  });

  it('stays silent when the last assistant record is plain text (turn finished)', () => {
    /* Idle is the worker-finished state; stall watch should never
     * fire on it because there is no waiting work. */
    const summary: AnchorTailSummary = {
      lastRole: 'assistant',
      lastRecordMs: NOW - TOOL_MS - 60_000,
      lastAssistantWasTool: false,
    };
    expect(classifyStall(summary, NOW, TOOL_MS, USER_MS)).toBeNull();
  });

  it('fires no-response when a user message has waited past userStallMs', () => {
    const summary: AnchorTailSummary = {
      lastRole: 'user',
      lastRecordMs: NOW - USER_MS - 1_000,
      lastAssistantWasTool: false,
    };
    const r = classifyStall(summary, NOW, TOOL_MS, USER_MS);
    expect(r?.kind).toBe('no-response');
  });

  it('stays silent for a recent user message', () => {
    const summary: AnchorTailSummary = {
      lastRole: 'user',
      lastRecordMs: NOW - USER_MS + 1_000,
      lastAssistantWasTool: false,
    };
    expect(classifyStall(summary, NOW, TOOL_MS, USER_MS)).toBeNull();
  });
});

interface FakeAnchor {
  id: string;
  jsonl: string | null;
  tail: AnchorTailSummary | null;
}

function makeDeps(
  anchors: FakeAnchor[],
  state: Map<string, number> = new Map(),
  fire = vi.fn(() => ({
    outcome: 'fired' as const,
    notification: { id: 'n', severity: 'alert' } as never,
  })),
): { deps: StallWatchDeps; fire: typeof fire } {
  const db = {
    listProjectSessions: () =>
      anchors.map((a) => ({
        id: a.id,
        project_slug: a.id,
        cwd: '',
        title: null,
        status: 'live' as const,
        current_session_id: null,
        current_bridge_id: null,
        current_pty_id: null,
        created_ms: 0,
        last_seen_ms: 0,
      })),
  } as never;
  const jsonlForAnchor = (_db: unknown, anchorId: string): string | null => {
    return anchors.find((a) => a.id === anchorId)?.jsonl ?? null;
  };
  const readTail = (jsonlPath: string): AnchorTailSummary | null => {
    return anchors.find((a) => a.jsonl === jsonlPath)?.tail ?? null;
  };
  return {
    deps: {
      db,
      jsonlForAnchor,
      readTail,
      fire,
      log: () => undefined,
      now: () => NOW,
      toolStallMs: TOOL_MS,
      userStallMs: USER_MS,
      cooldownMs: 600_000,
      state,
    },
    fire,
  };
}

describe('runWorkerStallTick', () => {
  it('fires for an anchor whose tool_use is past the stall threshold', async () => {
    const { deps, fire } = makeDeps([
      {
        id: 'anchor-a',
        jsonl: '/fake/a.jsonl',
        tail: {
          lastRole: 'assistant',
          lastRecordMs: NOW - TOOL_MS - 60_000,
          lastAssistantWasTool: true,
        },
      },
    ]);
    const r = await runWorkerStallTick(deps);
    expect(r.fired).toEqual(['anchor-a']);
    expect(r.stalls[0]?.kind).toBe('tool-stall');
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('honors the cooldown so a still-stalled anchor does not double-fire', async () => {
    const state = new Map<string, number>();
    const { deps, fire } = makeDeps(
      [
        {
          id: 'anchor-b',
          jsonl: '/fake/b.jsonl',
          tail: {
            lastRole: 'user',
            lastRecordMs: NOW - USER_MS - 30_000,
            lastAssistantWasTool: false,
          },
        },
      ],
      state,
    );
    const first = await runWorkerStallTick(deps);
    expect(first.fired).toEqual(['anchor-b']);
    const second = await runWorkerStallTick(deps);
    expect(second.fired).toEqual([]);
    expect(second.cooldown).toEqual(['anchor-b']);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('re-fires once the cooldown has elapsed', async () => {
    const state = new Map<string, number>();
    const { deps, fire } = makeDeps(
      [
        {
          id: 'anchor-c',
          jsonl: '/fake/c.jsonl',
          tail: {
            lastRole: 'user',
            lastRecordMs: NOW - USER_MS - 1_000,
            lastAssistantWasTool: false,
          },
        },
      ],
      state,
      vi.fn(() => ({
        outcome: 'fired' as const,
        notification: { id: 'n', severity: 'alert' } as never,
      })),
    );
    await runWorkerStallTick(deps);
    /* Move the clock past cooldownMs (600_000) so the same anchor
     * is allowed to fire again. The injected stall summary still
     * says "user waited 181s ago" relative to the initial NOW, so
     * after the cooldown the age is even bigger -- still stalled. */
    const later: StallWatchDeps = { ...deps, now: () => NOW + 700_000 };
    const r = await runWorkerStallTick(later);
    expect(r.fired).toEqual(['anchor-c']);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('skips anchors with no jsonl path (cold spawn pre-binding)', async () => {
    const { deps, fire } = makeDeps([
      { id: 'anchor-cold', jsonl: null, tail: null },
    ]);
    const r = await runWorkerStallTick(deps);
    expect(r.evaluated).toBe(1);
    expect(r.fired).toEqual([]);
    expect(fire).not.toHaveBeenCalled();
  });
});
