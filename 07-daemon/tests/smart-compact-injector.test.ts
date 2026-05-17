/**
 * makeSmartCompactInjector — verifies the auto-CR nudge fires on
 * BOTH transports after a successful commit=true inject, mirroring
 * crossSessionInject's bracketed-paste workaround. Without the nudge
 * the scheduler delivers /clear + summary but leaves it sitting in
 * the worker's input box and Enter never fires; the scheduler then
 * re-fires the next tick because ctx_pct never drops.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  makeSmartCompactInjector,
  type InjectorDeps,
  type PtyListEntry,
} from '../src/dashboard/smart-compact-injector.js';

function buildDeps(opts: {
  ptys?: PtyListEntry[];
  ptyInjectResult?: { ok: true } | { ok: false; error: string };
  queuePromptResult?: { ok: boolean; error?: string };
  queueSuggestionResult?: { ok: boolean; error?: string };
}): {
  deps: InjectorDeps;
  scheduled: Array<{ fn: () => void; delayMs: number }>;
  ptyInject: ReturnType<typeof vi.fn>;
  queueSessionPrompt: ReturnType<typeof vi.fn>;
  queueSessionSuggestion: ReturnType<typeof vi.fn>;
} {
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const ptyInject = vi.fn(
    (_id: string, _text: string, _commit: boolean) =>
      opts.ptyInjectResult ?? { ok: true as const },
  );
  const queueSessionPrompt = vi.fn(
    (_s: string, _t: string) => opts.queuePromptResult ?? { ok: true },
  );
  const queueSessionSuggestion = vi.fn(
    (_s: string, _t: string) => opts.queueSuggestionResult ?? { ok: true },
  );
  const deps: InjectorDeps = {
    listPtys: () => opts.ptys ?? [],
    ptyInject,
    queueSessionPrompt,
    queueSessionSuggestion,
    scheduleCommit: (fn, delayMs) => {
      scheduled.push({ fn, delayMs });
    },
    commitDelayMs: 850,
  };
  return { deps, scheduled, ptyInject, queueSessionPrompt, queueSessionSuggestion };
}

describe('makeSmartCompactInjector — pty transport', () => {
  const livePtys: PtyListEntry[] = [
    { ptyId: 'pty-1', sessionId: 'sess-1', exited: false },
  ];

  it('schedules a bare-CR nudge after a successful commit=true pty inject', () => {
    const { deps, scheduled, ptyInject } = buildDeps({ ptys: livePtys });
    const inject = makeSmartCompactInjector(deps);

    const r = inject('sess-1', '/clear\nsummary', true);

    expect(r.ok).toBe(true);
    expect(ptyInject).toHaveBeenCalledTimes(1);
    expect(ptyInject).toHaveBeenNthCalledWith(1, 'pty-1', '/clear\nsummary', true);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(850);

    /* Fire the scheduled nudge and assert it issued a bare CR with
     * commit=false (no double-CR). */
    scheduled[0]!.fn();
    expect(ptyInject).toHaveBeenCalledTimes(2);
    expect(ptyInject).toHaveBeenNthCalledWith(2, 'pty-1', '\r', false);
  });

  it('does NOT schedule a nudge when commit=false', () => {
    const { deps, scheduled, ptyInject } = buildDeps({ ptys: livePtys });
    const inject = makeSmartCompactInjector(deps);

    const r = inject('sess-1', 'suggestion', false);

    expect(r.ok).toBe(true);
    expect(ptyInject).toHaveBeenCalledTimes(1);
    expect(ptyInject).toHaveBeenNthCalledWith(1, 'pty-1', 'suggestion', false);
    expect(scheduled).toHaveLength(0);
  });

  it('does NOT schedule a nudge when the primary pty inject fails', () => {
    const { deps, scheduled } = buildDeps({
      ptys: livePtys,
      ptyInjectResult: { ok: false, error: 'pty_dead' },
    });
    const inject = makeSmartCompactInjector(deps);

    const r = inject('sess-1', '/clear', true);

    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toBe('pty_dead');
    expect(scheduled).toHaveLength(0);
  });

  it('survives a throwing nudge without affecting the primary result', () => {
    const ptyInject = vi
      .fn()
      .mockReturnValueOnce({ ok: true })
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const deps: InjectorDeps = {
      listPtys: () => livePtys,
      ptyInject,
      queueSessionPrompt: vi.fn(() => ({ ok: true })),
      queueSessionSuggestion: vi.fn(() => ({ ok: true })),
      scheduleCommit: (fn, delayMs) => scheduled.push({ fn, delayMs }),
    };
    const inject = makeSmartCompactInjector(deps);

    const r = inject('sess-1', '/clear', true);
    expect(r.ok).toBe(true);
    expect(() => scheduled[0]!.fn()).not.toThrow();
  });
});

describe('makeSmartCompactInjector — bridge transport', () => {
  it('schedules a bare-CR nudge after a successful commit=true bridge prompt', () => {
    const { deps, scheduled, queueSessionPrompt, ptyInject } = buildDeps({
      ptys: [],
    });
    const inject = makeSmartCompactInjector(deps);

    const r = inject('bridge-session-uuid', '/clear\nsummary', true);

    expect(r.ok).toBe(true);
    expect(ptyInject).not.toHaveBeenCalled();
    expect(queueSessionPrompt).toHaveBeenCalledTimes(1);
    expect(queueSessionPrompt).toHaveBeenNthCalledWith(
      1,
      'bridge-session-uuid',
      '/clear\nsummary',
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(850);

    scheduled[0]!.fn();
    expect(queueSessionPrompt).toHaveBeenCalledTimes(2);
    expect(queueSessionPrompt).toHaveBeenNthCalledWith(
      2,
      'bridge-session-uuid',
      '\r',
    );
  });

  it('routes commit=false through queueSessionSuggestion and skips the nudge', () => {
    const { deps, scheduled, queueSessionSuggestion, queueSessionPrompt } =
      buildDeps({ ptys: [] });
    const inject = makeSmartCompactInjector(deps);

    const r = inject('bridge-session-uuid', 'suggestion', false);

    expect(r.ok).toBe(true);
    expect(queueSessionSuggestion).toHaveBeenCalledTimes(1);
    expect(queueSessionPrompt).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });

  it('does NOT schedule a nudge when the bridge prompt fails', () => {
    const { deps, scheduled } = buildDeps({
      ptys: [],
      queuePromptResult: { ok: false, error: 'no session' },
    });
    const inject = makeSmartCompactInjector(deps);

    const r = inject('bridge-session-uuid', '/clear', true);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toBe('no session');
    expect(scheduled).toHaveLength(0);
  });

  it('treats exited ptys as not-live and falls through to bridge', () => {
    const ptys: PtyListEntry[] = [
      { ptyId: 'pty-old', sessionId: 'sess-1', exited: true },
    ];
    const { deps, scheduled, ptyInject, queueSessionPrompt } = buildDeps({
      ptys,
    });
    const inject = makeSmartCompactInjector(deps);

    const r = inject('sess-1', '/clear', true);

    expect(r.ok).toBe(true);
    expect(ptyInject).not.toHaveBeenCalled();
    expect(queueSessionPrompt).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
  });
});

describe('makeSmartCompactInjector — defaults', () => {
  it('uses a setTimeout-based scheduleCommit when none is supplied', () => {
    /* Without scheduleCommit override the nudge must still fire. Use
     * fake timers so the test runs synchronously. */
    vi.useFakeTimers();
    try {
      const ptyInject = vi.fn(() => ({ ok: true as const }));
      const deps: InjectorDeps = {
        listPtys: () => [
          { ptyId: 'pty-1', sessionId: 'sess-1', exited: false },
        ],
        ptyInject,
        queueSessionPrompt: vi.fn(() => ({ ok: true })),
        queueSessionSuggestion: vi.fn(() => ({ ok: true })),
      };
      const inject = makeSmartCompactInjector(deps);

      inject('sess-1', '/clear', true);
      expect(ptyInject).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(850);
      expect(ptyInject).toHaveBeenCalledTimes(2);
      expect(ptyInject).toHaveBeenNthCalledWith(2, 'pty-1', '\r', false);
    } finally {
      vi.useRealTimers();
    }
  });
});
