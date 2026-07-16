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
  awaitNewSessionReady,
  capturePreClearJsonlSet,
  ccProjectsDirForCwd,
  makeSmartCompactInjector,
  type InjectorDeps,
  type PtyListEntry,
  type SessionReadyIO,
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

/* ---------------------------------------------------------------- *
 *  awaitNewSessionReady - event-driven gate for /clear + resume     *
 * ---------------------------------------------------------------- */

interface VirtualFs {
  files: Map<string, string>;
  dir: string;
}

function makeVirtualFsIO(vfs: VirtualFs, clock: { ms: number }): SessionReadyIO {
  const sleeps: Array<{ resolve: () => void; readyAt: number }> = [];
  return {
    existsSync: (p: string) => p === vfs.dir || vfs.files.has(p),
    readdirSync: (d: string) => {
      if (d !== vfs.dir) throw new Error(`unexpected readdir ${d}`);
      const prefix = vfs.dir.replace(/\\/g, '/') + '/';
      const out: string[] = [];
      for (const k of vfs.files.keys()) {
        const norm = k.replace(/\\/g, '/');
        if (norm.startsWith(prefix)) out.push(norm.slice(prefix.length));
      }
      return out;
    },
    statSync: (p: string) => {
      const content = vfs.files.get(p);
      if (content === undefined) throw new Error(`stat: ${p} not found`);
      return { size: Buffer.byteLength(content, 'utf-8') };
    },
    openSync: () => 1,
    readSync: (_fd, buf, _off, len, pos) => {
      // Find the file currently being read by scanning every file
      // whose size matches the recorded offset+len request. Tests
      // only tail one file at a time, so we cheat and read the
      // newest jsonl in the vfs map.
      let target: string | null = null;
      for (const k of vfs.files.keys()) {
        if (k.endsWith('.jsonl')) target = k;
      }
      if (!target) return 0;
      const content = vfs.files.get(target)!;
      const slice = Buffer.from(content, 'utf-8').subarray(pos, pos + len);
      slice.copy(buf, 0);
      return slice.length;
    },
    closeSync: () => undefined,
    now: () => clock.ms,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push({ resolve, readyAt: clock.ms + ms });
        // Advance virtual clock immediately and flush ready sleeps so
        // the await chain progresses without real timers.
        clock.ms += ms;
        for (let i = sleeps.length - 1; i >= 0; i--) {
          const s = sleeps[i]!;
          if (s.readyAt <= clock.ms) {
            sleeps.splice(i, 1);
            s.resolve();
          }
        }
      }),
    log: () => undefined,
  };
}

describe('ccProjectsDirForCwd', () => {
  it('builds the slug the same way CC does (forward + back slashes + colon)', () => {
    expect(
      ccProjectsDirForCwd('C:/Users/m', 'C:\\dev\\Projects\\DevNeural'),
    ).toBe('C:/Users/m/.claude/projects/C--dev-Projects-DevNeural');
  });
});

describe('capturePreClearJsonlSet', () => {
  it('returns empty set when projects dir does not exist', () => {
    const set = capturePreClearJsonlSet('/does/not/exist', {
      existsSync: () => false,
      readdirSync: () => {
        throw new Error('should not be called');
      },
    });
    expect(set.size).toBe(0);
  });
  it('captures only .jsonl filenames', () => {
    const set = capturePreClearJsonlSet('/p', {
      existsSync: () => true,
      readdirSync: () => ['old.jsonl', 'notes.txt', 'another.jsonl'],
    });
    expect(set.has('old.jsonl')).toBe(true);
    expect(set.has('another.jsonl')).toBe(true);
    expect(set.has('notes.txt')).toBe(false);
  });
});

describe('awaitNewSessionReady', () => {
  it('returns no-projects-dir when ccProjectsDir is absent', async () => {
    const r = await awaitNewSessionReady({
      ccProjectsDir: '/missing',
      preClearFiles: new Set(),
      io: { existsSync: () => false },
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('no-projects-dir');
  });

  it('returns timeout-new-jsonl when no fresh jsonl appears within budget', async () => {
    const vfs: VirtualFs = {
      dir: '/p',
      files: new Map([['/p/old.jsonl', '']]),
    };
    const clock = { ms: 1_000_000 };
    const io = makeVirtualFsIO(vfs, clock);
    const r = await awaitNewSessionReady({
      ccProjectsDir: '/p',
      preClearFiles: new Set(['old.jsonl']),
      readyTimeoutMs: 1000,
      pollIntervalMs: 200,
      io,
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('timeout-new-jsonl');
  });

  it('reports ready once a new jsonl + SessionStart attachment chain settles', async () => {
    const vfs: VirtualFs = {
      dir: '/p',
      files: new Map([['/p/old.jsonl', '']]),
    };
    const clock = { ms: 1_000_000 };
    /* Simulate the 7s new-session init: tick 0 to 7000ms only the old
     * jsonl exists, then the new one appears, then a SessionStart
     * attachment chain lands within ~50ms, then 400ms of quiescence
     * proves CC settled. The virtual clock advances inside sleep(),
     * and we splice file-system events on each tick via a queue. */
    const tickEvents: Array<{ atMs: number; fn: () => void }> = [
      {
        atMs: 1_007_000,
        fn: () => {
          vfs.files.set('/p/new.jsonl', '');
        },
      },
      {
        atMs: 1_007_200,
        fn: () => {
          vfs.files.set(
            '/p/new.jsonl',
            JSON.stringify({
              type: 'attachment',
              attachment: { hookEvent: 'SessionStart' },
            }) + '\n',
          );
        },
      },
      {
        atMs: 1_007_250,
        fn: () => {
          const prev = vfs.files.get('/p/new.jsonl') ?? '';
          vfs.files.set(
            '/p/new.jsonl',
            prev +
              JSON.stringify({
                type: 'attachment',
                attachment: { hookName: 'SessionStart:clear' },
              }) +
              '\n',
          );
        },
      },
    ];
    const baseIo = makeVirtualFsIO(vfs, clock);
    const io: SessionReadyIO = {
      ...baseIo,
      sleep: async (ms) => {
        await baseIo.sleep!(ms);
        for (const ev of [...tickEvents]) {
          if (ev.atMs <= clock.ms) {
            ev.fn();
            tickEvents.splice(tickEvents.indexOf(ev), 1);
          }
        }
      },
    };
    const r = await awaitNewSessionReady({
      ccProjectsDir: '/p',
      preClearFiles: new Set(['old.jsonl']),
      readyTimeoutMs: 15_000,
      pollIntervalMs: 200,
      quiescenceMs: 400,
      io,
    });
    expect(r.ready).toBe(true);
    expect(r.reason).toBe('ready');
    expect(r.new_jsonl).toContain('new.jsonl');
    /* Total elapsed must cover the 7s spawn gap + quiescence. */
    expect(r.elapsed_ms).toBeGreaterThanOrEqual(7_000);
  });

  it('default budget covers the observed real-world spawn window (~20s to a new jsonl, 2026-07-16 live)', async () => {
    /* Live evidence 05:14:05Z: session-ready-wait-timeout at 15078ms
     * with the new jsonl appearing ~20s after fire; the resume only
     * shipped via the fallback. The DEFAULT budget (no readyTimeoutMs
     * passed) must ride out a 20s spawn and still settle on the
     * SessionStart chain. */
    const vfs: VirtualFs = {
      dir: '/p',
      files: new Map([['/p/old.jsonl', '']]),
    };
    const clock = { ms: 1_000_000 };
    const tickEvents: Array<{ atMs: number; fn: () => void }> = [
      {
        atMs: 1_020_000,
        fn: () => {
          vfs.files.set('/p/new.jsonl', '');
        },
      },
      {
        atMs: 1_020_200,
        fn: () => {
          vfs.files.set(
            '/p/new.jsonl',
            JSON.stringify({
              type: 'attachment',
              attachment: { hookEvent: 'SessionStart' },
            }) + '\n',
          );
        },
      },
    ];
    const baseIo = makeVirtualFsIO(vfs, clock);
    const io: SessionReadyIO = {
      ...baseIo,
      sleep: async (ms) => {
        await baseIo.sleep!(ms);
        for (const ev of [...tickEvents]) {
          if (ev.atMs <= clock.ms) {
            ev.fn();
            tickEvents.splice(tickEvents.indexOf(ev), 1);
          }
        }
      },
    };
    const r = await awaitNewSessionReady({
      ccProjectsDir: '/p',
      preClearFiles: new Set(['old.jsonl']),
      pollIntervalMs: 200,
      quiescenceMs: 400,
      io,
    });
    expect(r.ready).toBe(true);
    expect(r.reason).toBe('ready');
    expect(r.elapsed_ms).toBeGreaterThanOrEqual(20_000);
  });

  it('DEVNEURAL_SMART_COMPACT_READY_TIMEOUT_MS overrides the default budget', async () => {
    const vfs: VirtualFs = {
      dir: '/p',
      files: new Map([['/p/old.jsonl', '']]),
    };
    const clock = { ms: 1_000_000 };
    const io = makeVirtualFsIO(vfs, clock);
    process.env.DEVNEURAL_SMART_COMPACT_READY_TIMEOUT_MS = '2000';
    try {
      const r = await awaitNewSessionReady({
        ccProjectsDir: '/p',
        preClearFiles: new Set(['old.jsonl']),
        pollIntervalMs: 200,
        io,
      });
      expect(r.ready).toBe(false);
      expect(r.reason).toBe('timeout-new-jsonl');
      expect(r.elapsed_ms).toBeLessThan(3_000);
    } finally {
      delete process.env.DEVNEURAL_SMART_COMPACT_READY_TIMEOUT_MS;
    }
  });

  it('falls back to timeout-session-start when SessionStart attachments never arrive', async () => {
    const vfs: VirtualFs = {
      dir: '/p',
      files: new Map([['/p/new.jsonl', '{"type":"user","message":"hi"}\n']]),
    };
    const clock = { ms: 1_000_000 };
    const io = makeVirtualFsIO(vfs, clock);
    const r = await awaitNewSessionReady({
      ccProjectsDir: '/p',
      preClearFiles: new Set(),
      readyTimeoutMs: 2_000,
      pollIntervalMs: 200,
      io,
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('timeout-session-start');
    expect(r.new_jsonl).toContain('new.jsonl');
  });
});

describe('fireSmartCompact event-driven resume gate', () => {
  /* End-to-end check that with awaitSessionReady wired, the summary
   * inject only fires AFTER the gate resolves ready. Uses the public
   * fireSmartCompact surface so we exercise the FireOptions plumbing
   * end-to-end. */
  it('defers summary inject until awaitSessionReady resolves ready=true', async () => {
    const { fireSmartCompact } = await import(
      '../src/dashboard/smart-compact-routes.js'
    );
    const { IndexDb } = await import('../src/store/index-db.js');
    const { runMigrations } = await import('../src/db/migrate.js');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { fileURLToPath } = await import('node:url');
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const MIG_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-gate-'));
    const priorEnabled = process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
    const priorShadowN = process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N;
    process.env.DEVNEURAL_SMART_COMPACT_ENABLED = 'live';
    process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = '0';
    const dbFile = path.join(tmp, 'idx.db');
    {
      const idx = new IndexDb(dbFile);
      idx.close();
    }
    await runMigrations({ dbPath: dbFile, migrationsDir: MIG_DIR });
    const db = new IndexDb(dbFile);
    try {
      db.insertProjectSession({
        id: 'anchor-1',
        project_slug: 'p',
        cwd: 'C:/fake/cwd',
        title: null,
        status: 'live',
        current_session_id: 'sess-A',
        current_bridge_id: null,
        current_pty_id: 'pty-A',
        created_ms: Date.now(),
        last_seen_ms: Date.now(),
      });
      const calls: Array<{ target: string; text: string; commit: boolean }> =
        [];
      const injector = (target: string, text: string, commit: boolean) => {
        calls.push({ target, text, commit });
        return { ok: true as const };
      };
      let resolveGate!: (v: {
        ready: boolean;
        reason: 'ready';
        elapsed_ms: number;
      }) => void;
      const gate = new Promise<{
        ready: boolean;
        reason: 'ready';
        elapsed_ms: number;
      }>((resolve) => {
        resolveGate = resolve;
      });
      let resumeCompleted: { ship_ok: boolean } | null = null;
      const r = fireSmartCompact(db, 'anchor-1', {
        caller: 'lex',
        reason: 'manual',
        action: 'fire',
        ctxPct: 60,
        summary: 'resume payload',
        injector,
        force: true,
        awaitSessionReady: () => gate,
        onResumeComplete: (info) => {
          resumeCompleted = { ship_ok: info.ship_ok };
        },
      });
      expect(r.action).toBe('fire');
      expect(r.inject_result).toBe('accepted-pending-ready');
      /* /clear should have fired synchronously; summary must NOT have
       * fired yet because the gate is unresolved. */
      expect(calls).toEqual([
        { target: 'pty-A', text: '/clear', commit: true },
      ]);

      /* Resolve the gate. The summary inject is awaited inside a
       * microtask; flushing the microtask queue lets it land. */
      resolveGate({ ready: true, reason: 'ready', elapsed_ms: 7200 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(calls).toEqual([
        { target: 'pty-A', text: '/clear', commit: true },
        { target: 'pty-A', text: 'resume payload', commit: true },
      ]);
      expect(resumeCompleted).toEqual({ ship_ok: true });
    } finally {
      db.close();
      if (priorEnabled === undefined) {
        delete process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
      } else {
        process.env.DEVNEURAL_SMART_COMPACT_ENABLED = priorEnabled;
      }
      if (priorShadowN === undefined) {
        delete process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N;
      } else {
        process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = priorShadowN;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
