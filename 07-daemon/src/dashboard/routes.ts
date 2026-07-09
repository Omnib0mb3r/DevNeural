/**
 * Dashboard routes registration.
 *
 * One function that wires every Phase 3 endpoint onto the existing
 * Fastify instance owned by the daemon. Auth middleware applied to
 * No auth gate: dashboard binds to localhost/Tailscale, trust is at the
 * network layer. The /auth/cross-session-token endpoint below issues
 * short-lived HMACs for prompt-injection and is the only remaining
 * remnant of the old auth surface.
 */
import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import type { Store } from '../store/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DATA_ROOT,
  wikiPagesDir,
  wikiPendingDir,
  wikiArchiveDir,
  brainstormAudioFile,
  brainstormCuesFile,
} from '../paths.js';
import { triggerShutdown, hasShutdownHook } from '../lifecycle/shutdown-hook.js';
import { ReferenceStore } from '../reference/store.js';
import { ingestUpload } from '../reference/process.js';
import { getSystemMetrics } from './system-metrics.js';
import { checkAll, rollupStatus } from './services.js';
import {
  listSessions,
  getSessionDetail,
  queueSessionPrompt,
  queueSessionSuggestion,
  queueSessionFocus,
  queueSessionKey,
  isNavKey,
  bridgeStatus,
  recordClearSupersede,
  buildLexPulseFromTail,
  deriveContextFromTail,
} from './sessions.js';
import { setPhase, type SessionPhase } from './session-phase.js';
import { setPending, clearPending, getPending } from './pending-prompt.js';
import {
  pushTerminalData,
  getTerminalReplay,
  subscribeTerminal,
} from './terminal-stream.js';
import {
  spawnLex,
  ptyInject,
  ptyKill,
  ptyResize,
  listPtys,
  getPtyOutput,
  startSessionDiscoveryProbe,
  seedFirstTurn,
  getLivePtyIds,
} from './pty-host.js';
import {
  buildLexSystemPrompt,
  buildLexSystemPromptVersioned,
} from '../lex/system-prompt.js';
import { buildLexSpawnPrompt } from '../lex/spawn-prompt.js';
import { spawnLexSession } from '../lex/spawn-lex-session.js';
import { listAnchorTiles } from '../lex/anchor-tiles.js';
import {
  getLexSession,
  listLexSessions,
  setLexSessionTitle,
  setLexSessionStatus,
  deleteLexSession,
  listTranscriptRefs,
} from '../lex/lex-session-store.js';
import {
  listBrainstorms,
  getBrainstorm,
  endBrainstorm,
  appendArtifact as appendBrainstormArtifact,
  setStore as setBrainstormStore,
  reapAllActive as reapAllActiveBrainstorms,
  reapOrphansAgainstLivePtys,
  createStandaloneBrainstorm,
  attachWorkerSession,
  detachWorkerSession,
} from '../lex/brainstorm-store.js';
import {
  ensureServer as ensureWhisper,
  transcribeWav,
  whisperStatus,
  pcm16ToWav,
} from '../voice/whisper.js';
import {
  piperStatus,
  synthesize,
  synthesizeToBuffer,
  pcmToWav,
  setActiveVoice,
  setActiveSpeed,
  setBargeCooldownMs,
  setMicGain,
  setVadSensitivity,
  setVadRedemptionMs,
} from '../voice/piper.js';
import {
  attachLexVoiceWs,
  broadcastVoiceControl,
  type VoiceControlKind,
} from '../voice/lex-voice-ws.js';
import { lintQueueStatus } from '../wiki/lint-queue.js';
import { providerStatus } from '../llm/index.js';
import { embedderStats } from '../embedder/index.js';
import {
  runBackfillRaw,
  runBackfillWiki,
  getBackfillStatus,
  requestBackfillCancel,
  resetBackfill,
} from '../wiki/backfill.js';
import { repairWikiCrossRefs } from '../wiki/repair.js';
import { getDailyBrief } from './daily-brief.js';
import { searchAll } from './search-all.js';
import {
  listReminders,
  createReminder,
  updateReminder,
  completeReminder,
  uncompleteReminder,
  archiveReminder,
  deleteReminder,
} from './reminders.js';
import {
  listNotifications,
  dismissNotification,
  emitNotification,
  unreadCount,
  events as notificationEvents,
  type Notification,
} from './notifications.js';
import { createProject } from './projects-new.js';
import { buildGraph } from './graph.js';
import { buildUnifiedGraph } from './unified-graph.js';
import {
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  listSubscriptions,
} from './push.js';
import { writePage, parsePage } from '../wiki/schema.js';

export async function registerDashboardRoutes(
  app: FastifyInstance,
  store: Store,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const referenceStore = await ReferenceStore.open(log);

  /* Project anchor REST surface (PROJECT-ANCHORS.md step 3 of 6).
   * Registered up front so route ordering is independent of the rest
   * of this file. */
  const { registerProjectAnchorRoutes } = await import('./projects-routes.js');
  registerProjectAnchorRoutes(app, store.db, log);
  const { decodeBridgeMarker } = await import('./bridge-presence.js');

  /* Panic button surface (PANIC-BUTTON.md). POST /panic, POST
   * /projects/:id/interrupt, GET /panic/recent. Bound to the real
   * ptyInject so a button press lands as \x1b\x1b on the target PTY. */
  const { registerPanicRoutes } = await import('./panic-routes.js');
  registerPanicRoutes(app, store.db, ptyInject, log);

  /* Smart-compact surface (SMART-COMPACT.md). Lex polls evaluate,
   * decides to fire, daemon executes /clear + resume summary via the
   * existing PTY transport. Shadow mode for the first N attempts per
   * anchor; audit row on every decision.
   *
   * Injector is the shared bridge-fallback resolver from
   * smart-compact-injector.ts: listPtys → ptyInject for daemon-owned
   * sessions, queueSessionPrompt for bridge-only sessions. Sharing
   * the helper with the daemon's 60s scheduler tick guarantees both
   * code paths resolve targets the same way. */
  const { makeSmartCompactInjector } = await import('./smart-compact-injector.js');
  const smartCompactInjector = makeSmartCompactInjector({
    listPtys,
    ptyInject,
    queueSessionPrompt,
    queueSessionSuggestion,
  });
  const { registerSmartCompactRoutes } = await import('./smart-compact-routes.js');
  /* Fix 41 Stage 1 — pass the ctxProvider through so the new
   * /lex/smart-compact/state endpoint can return real ctx_pct. Mirrors
   * the binding used by the scheduler in daemon.ts; share a single
   * derivation path so /state and the scheduler report identical
   * numbers for the same jsonl tail. */
  const smartCompactCtxProvider = (jsonlPath: string): number | null => {
    const ctx = deriveContextFromTail(jsonlPath);
    if (!ctx || ctx.max <= 0) return null;
    return Math.round((ctx.tokens / ctx.max) * 1000) / 10;
  };
  registerSmartCompactRoutes(app, store.db, smartCompactInjector, log, {
    ctxProvider: smartCompactCtxProvider,
  });
  /* DRIVE-QUEUE 4: smart-clear trigger surface. Shares the same ctx
   * derivation so /smart-clear/state and /smart-compact/state report
   * identical ctx_pct. Inert until smart_clear_mode is flipped. */
  const { registerSmartClearRoutes } = await import('./smart-clear-routes.js');
  registerSmartClearRoutes(app, store.db, log, {
    ctxProvider: smartCompactCtxProvider,
  });

  /* Background poll that binds a daemon-owned PTY to its claude
   * session_id once the .jsonl file appears. Single global timer; no
   * cost when no PTYs are unbound. */
  startSessionDiscoveryProbe();

  /* Hand the brainstorm-store the live Store reference so its helper
   * functions (used by pty-host on spawn, used by /lex/sessions
   * routes, eventually used by voice WS) can talk to SQLite without
   * threading the store through every layer. */
  setBrainstormStore(store);

  /* Bind the lex_backlog_items store to the same daemon Store
   * reference so the REST surface (GET/POST/PATCH /lex/backlog)
   * and any future supervisor logic share one canonical handle.
   * Migration 026 created the table; the seed script
   * (scripts/seed-lex-backlog.ts) does a one-shot import from the
   * legacy c:/tmp/lex-backlog-queue.json file. */
  const { setStore: setBacklogStore } = await import('../lex/backlog-store.js');
  setBacklogStore(store);

  /* Autonomous supervisor auto-advance loop (phase 3). Default
   * mode is 'off' so a daemon boot is a no-op until the operator
   * flips auto_advance_mode via runtime_config. The tick itself
   * re-reads the mode every fire so an operator flip is picked up
   * without a restart. */
  try {
    const {
      registerAutoAdvanceLoop,
      getAutoAdvanceMode,
    } = await import('../lex/auto-advance-supervisor.js');
    const initialMode = getAutoAdvanceMode(store.db);
    if (initialMode === 'off') {
      log('auto-advance: mode=off; loop dormant (use runtime_config to enable)');
    } else {
      log(`auto-advance: starting loop in mode=${initialMode}`);
    }
    const { claimBacklogItem, listBacklog } = await import(
      '../lex/backlog-store.js'
    );
    const { listProjectSessions: listAnchors } = store.db;
    registerAutoAdvanceLoop({
      deps: {
        db: store.db,
        listAnchors: (opts) => store.db.listProjectSessions(opts),
        listBacklog,
        claimBacklog: (input) => claimBacklogItem(input),
        listPtys,
        log,
      },
    });
    void listAnchors;
  } catch (err) {
    log(`auto-advance: bootstrap failed: ${(err as Error).message}`);
  }

  /* Boot reaper. PTY exit hook in pty-host closes brainstorm rows on
   * normal exit; a daemon crash (SIGKILL, fatal SqliteError, etc.)
   * skips that path and leaves rows stuck at status='active'. Reap
   * once now so /lex/sessions?status=active returns only the brainstorms
   * the current daemon will actually re-attach to (which is none, until
   * the user spawns a new Lex). */
  try {
    const reaped = reapAllActiveBrainstorms('daemon restart: orphaned active session');
    if (reaped > 0) log(`brainstorm reaper: ended ${reaped} orphaned active session(s)`);
  } catch (err) {
    log(`brainstorm reaper failed: ${(err as Error).message}`);
  }

  /* Continuous reaper. Sweeps active brainstorm rows whose pty_id
   * is not in the live PTY map and marks them ended. Catches PTY
   * deaths that bypassed the onExit handler (SIGKILL, daemon crash,
   * OS teardown) without forcing a daemon restart. 30s cadence keeps
   * the database honest while staying way under any user-visible
   * latency cost. */
  setInterval(() => {
    try {
      const live = getLivePtyIds();
      const ended = reapOrphansAgainstLivePtys(
        live,
        'continuous reaper: pty no longer alive',
      );
      if (ended > 0) {
        log(`brainstorm reaper: ended ${ended} orphan active row(s)`);
      }
    } catch (err) {
      log(`continuous reaper failed: ${(err as Error).message}`);
    }
  }, 30_000);

  // ── Dashboard surface ─────────────────────────────────────────────
  app.get('/dashboard/health', async () => {
    const metrics = await getSystemMetrics();
    const services = await checkAll();
    return {
      ok: true,
      rollup: rollupStatus(services),
      services_total: services.length,
      services_failing: services.filter((s) => s.status === 'fail').length,
      unread_notifications: unreadCount(),
      cpu_percent: metrics.cpu.usage_percent,
      memory_percent: metrics.memory.used_percent,
      generated_at: metrics.timestamp,
    };
  });

  app.get('/dashboard/daily-brief', async () => getDailyBrief());

  /* Fix 34 diagnostics. Per-stage counters + recent 20 rows from the
   * worker_event_diagnostic_log so an operator can curl the wire and
   * tell whether the event-driven supervisor pipeline is alive.
   * 'health' field collapses the counters into one of six verdicts so
   * a probe does not have to do the math. */
  app.get('/dashboard/worker-event-stats', async () => {
    const { getWorkerEventStats } = await import('./worker-event-diagnostics.js');
    return { ok: true, ...getWorkerEventStats(store.db) };
  });

  /* Coarse supervisor health for the /health surface. Mirrors the
   * voice / audio block so a single curl /dashboard/health-supervisor
   * answers "is the wire alive?" without joining the per-stage
   * counters. */
  app.get('/dashboard/health-supervisor', async () => {
    const { getWorkerEventStats } = await import('./worker-event-diagnostics.js');
    const stats = getWorkerEventStats(store.db);
    return {
      ok: stats.health === 'ok',
      health: stats.health,
      counters: stats.counters,
      uptime_ms: stats.uptime_ms,
    };
  });

  /* Server-Sent Events stream for cross-tab state push.
   *
   * One connection per dashboard tab. Publishers call
   * publishDashboardEvent() in event-bus.ts; this handler fans the
   * payload out to every live client. Tabs use the stream to invalidate
   * react-query caches without waiting for the 5s polling tick (eg
   * brainstorm-ended flips the StreamDeck tile within ~100ms instead
   * of up to 5s). Comments + 15s ping keep proxies from closing the
   * idle stream. */
  app.get('/dashboard/events', async (req, reply) => {
    const { dashboardEvents } = await import('./event-bus.js');
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);
    const onEvent = (ev: unknown): void => {
      try {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        /* socket may have closed mid-write */
      }
    };
    dashboardEvents.on('event', onEvent);
    const keepalive = setInterval(() => {
      try {
        reply.raw.write(`: ping ${Date.now()}\n\n`);
      } catch {
        /* socket may have closed */
      }
    }, 15_000);
    const cleanup = (): void => {
      clearInterval(keepalive);
      dashboardEvents.off('event', onEvent);
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    return reply;
  });

  /* Live reinforcement-log tail. Returns the last N events from
   * reinforcement.log.jsonl in newest-first order so the dashboard
   * can render injection / hit / no-hit / raw-hit / raw-hit-ingest /
   * correction events as they happen. Polled every few seconds by the
   * ReinforcementPanel. Reads bytes from the tail of the file rather
   * than slurping the whole thing so a long-lived install with megabytes
   * of history stays cheap. */
  app.get('/dashboard/reinforcement', async (req) => {
    const fsLib = await import('node:fs');
    const pathLib = await import('node:path');
    const { DATA_ROOT } = await import('../paths.js');
    const file = pathLib.posix.join(DATA_ROOT, 'reinforcement.log.jsonl');
    const limit = Math.min(
      Number((req.query as { limit?: string }).limit ?? 50),
      500,
    );
    if (!fsLib.existsSync(file)) {
      return { ok: true, events: [], total_bytes: 0 };
    }
    let stat: import('node:fs').Stats;
    try {
      stat = fsLib.statSync(file);
    } catch {
      return { ok: true, events: [], total_bytes: 0 };
    }
    const tailBytes = Math.min(stat.size, 64 * 1024);
    const fd = fsLib.openSync(file, 'r');
    let text = '';
    try {
      const buf = Buffer.alloc(tailBytes);
      fsLib.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      text = buf.toString('utf-8');
    } finally {
      fsLib.closeSync(fd);
    }
    if (stat.size > tailBytes) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        /* skip malformed line */
      }
    }
    events.reverse();
    return {
      ok: true,
      events: events.slice(0, limit),
      total_bytes: stat.size,
    };
  });

  app.get('/dashboard/system-metrics', async () => {
    return getSystemMetrics();
  });

  /* Consolidated diagnostics: store sizes, lint queue, provider, embedder
   * stats, active session counts. Polled by the System tab (~8s) so we
   * surface the brain's actual state, not just host vitals. Cheap: every
   * field is in-memory or a single fs.statSync. */
  app.get('/dashboard/diagnostics', async () => {
    const sessions = listSessions();
    const active = sessions.filter((s) => s.active);
    const byPhase: Record<string, number> = {
      thinking: 0, tool: 0, permission: 0, idle: 0, unknown: 0,
    };
    for (const s of active) {
      byPhase[s.phase] = (byPhase[s.phase] ?? 0) + 1;
    }
    return {
      ok: true,
      store: {
        raw_chunks: store.rawChunks.stats(),
        wiki_pages: store.wikiPages.stats(),
        reference_chunks: referenceStore.chunks.stats(),
      },
      lint_queue: lintQueueStatus(),
      llm: providerStatus(),
      embedder: embedderStats(),
      sessions: {
        total: sessions.length,
        active: active.length,
        by_phase: byPhase,
      },
      generated_at: new Date().toISOString(),
    };
  });

  /* Daemon log tail. Reads the last ~64KB of daemon.log and returns the
   * last N lines, newest last. 64KB cap keeps it cheap; the daemon log
   * grows but log lines are short so 64KB is comfortably > 200 lines.
   * Filter param trims by substring match (case-insensitive). */
  app.get('/dashboard/log-tail', async (req) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { DATA_ROOT } = await import('../paths.js');
    const logFile = path.posix.join(DATA_ROOT, 'daemon.log');
    const query = req.query as { n?: string; filter?: string };
    const n = Math.min(Math.max(Number(query.n ?? '200') || 200, 10), 1000);
    const filter = (query.filter ?? '').toLowerCase();
    if (!fs.existsSync(logFile)) {
      return { ok: true, lines: [], total_bytes: 0 };
    }
    const stat = fs.statSync(logFile);
    const READ = 64 * 1024;
    const start = Math.max(0, stat.size - READ);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf-8');
      const firstNl = start === 0 ? -1 : text.indexOf('\n');
      const usable = firstNl === -1 ? text : text.slice(firstNl + 1);
      let lines = usable.split('\n').filter((l) => l.length > 0);
      if (filter) lines = lines.filter((l) => l.toLowerCase().includes(filter));
      return {
        ok: true,
        lines: lines.slice(-n),
        total_bytes: stat.size,
        truncated: start > 0,
      };
    } finally {
      fs.closeSync(fd);
    }
  });

  /* Voice-output watchdog telemetry sink + tail. The dashboard's
   * 10s probe ships a batch of rows on each iteration that produced
   * an interesting event (failed check or heal attempt). The GET
   * surfaces the trailing N rows so the Voice settings panel can
   * render the last 5 events without round-tripping through the
   * full diagnostics endpoint. */
  app.post('/dashboard/voice-health', async (req, reply) => {
    const body = (req.body ?? {}) as {
      events?: Array<{
        ts_ms?: number;
        check_kind?: string;
        status?: string;
        heal_attempt?: number;
        recovered?: number | boolean;
      }>;
    };
    const events = Array.isArray(body.events) ? body.events : [];
    let written = 0;
    for (const ev of events) {
      const ts = Number(ev?.ts_ms);
      const kind = typeof ev?.check_kind === 'string' ? ev.check_kind : '';
      const status = typeof ev?.status === 'string' ? ev.status : '';
      if (!Number.isFinite(ts) || !kind || !status) continue;
      const healAttempt = Number.isFinite(Number(ev?.heal_attempt))
        ? Math.max(0, Math.min(9, Number(ev.heal_attempt)))
        : 0;
      const recovered = ev?.recovered === true || Number(ev?.recovered) === 1 ? 1 : 0;
      try {
        store.db.insertVoiceHealthRow({
          ts_ms: ts,
          check_kind: kind.slice(0, 64),
          status: status.slice(0, 32),
          heal_attempt: healAttempt,
          recovered,
        });
        written += 1;
      } catch (err) {
        log(`voice-health insert failed: ${(err as Error).message}`);
      }
    }
    reply.code(200);
    return { ok: true, written };
  });

  app.get('/dashboard/voice-health', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? '5') || 5, 1), 200);
    const rows = store.db.listVoiceHealthRows(limit);
    return { ok: true, events: rows };
  });

  // ── Wiki graph for the orb ───────────────────────────────────────
  app.get('/graph', async () => buildGraph());

  // ── Unified graph (all 4 node kinds) for the unified orb ─────────
  app.get('/graph/unified', async () => buildUnifiedGraph(store.db));

  // ── Single wiki page fetch (for the search-result modal) ─────────
  app.get('/wiki/page/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-z0-9][a-z0-9-]+$/.test(id)) {
      reply.code(400);
      return { ok: false, error: 'invalid id' };
    }
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { wikiPagesDir, wikiPendingDir, wikiArchiveDir } = await import('../paths.js');
    const { readPage } = await import('../wiki/schema.js');
    const candidates: Array<{ dir: string; status: 'canonical' | 'pending' | 'archived' }> = [
      { dir: wikiPagesDir(), status: 'canonical' },
      { dir: wikiPendingDir(), status: 'pending' },
      { dir: wikiArchiveDir(), status: 'archived' },
    ];
    for (const c of candidates) {
      const file = path.posix.join(c.dir, `${id}.md`);
      if (!fs.existsSync(file)) continue;
      try {
        const page = readPage(file);
        return {
          ok: true,
          page: {
            id: page.frontmatter.id,
            title: page.frontmatter.title,
            trigger: page.frontmatter.trigger,
            insight: page.frontmatter.insight,
            summary: page.frontmatter.summary,
            status: c.status,
            weight: page.frontmatter.weight,
            hits: page.frontmatter.hits,
            corrections: page.frontmatter.corrections,
            created: page.frontmatter.created,
            last_touched: page.frontmatter.last_touched,
            projects: page.frontmatter.projects,
            pattern: page.sections.pattern,
            cross_refs: page.sections.crossRefs,
            evidence: page.sections.evidence,
            log: page.sections.log,
            /* Phase Two frontmatter (Wave 2 day 3 step 12 lineage panel
             * + WI-3 last_verified + WI-1 frozen). Optional in the
             * frontmatter parser; surface the raw arrays / flags so
             * the dashboard can render the source-brainstorms section
             * and the verification-state pill. */
            schema_version: page.frontmatter.schema_version ?? null,
            last_verified: page.frontmatter.last_verified ?? null,
            frozen: page.frontmatter.frozen === true,
            source_brainstorms: page.frontmatter.source_brainstorms ?? [],
            source_meetings: page.frontmatter.source_meetings ?? [],
            derived_from_brainstorm:
              page.frontmatter.derived_from_brainstorm === true,
            derived_from_meeting:
              page.frontmatter.derived_from_meeting === true,
          },
        };
      } catch (err) {
        reply.code(500);
        return { ok: false, error: `parse failed: ${(err as Error).message}` };
      }
    }
    reply.code(404);
    return { ok: false, error: 'page not found' };
  });

  // ── Services manifest ─────────────────────────────────────────────
  app.get('/services', async () => {
    const services = await checkAll();
    return { ok: true, services, rollup: rollupStatus(services) };
  });

  // ── Sessions ─────────────────────────────────────────────────────
  app.get('/sessions', async () => {
    const sessions = listSessions();
    /* Surface "ready to start" projects so the dashboard's Sessions
     * page can offer Start Claude buttons for any registered project
     * that doesn't currently have a live session. Match each project
     * root against the project_slug Claude Code uses for its jsonl
     * directory, which is the cwd with `:`, `\`, `/` flattened to `-`. */
    const { listProjects } = await import('../identity/registry.js');
    const projects = listProjects();
    /* "Live" for idle-project filtering means the daemon owns a PTY
     * for that session. Externally-launched claude.exe sessions (e.g.,
     * VS Code terminal) show up as active in the registry but cannot
     * be steered via /sessions/:id/inject or /lex/inject-cross-session
     * because the daemon has no PTY handle. Treat those projects as
     * still idle so the dashboard offers Start Claude buttons that
     * spawn a daemon-owned session. */
    const daemonOwnedSessionIds = new Set(
      listPtys()
        .filter((p) => !p.exited && p.sessionId)
        .map((p) => p.sessionId as string),
    );
    const liveSlugs = new Set(
      sessions
        .filter((s) => s.active && daemonOwnedSessionIds.has(s.session_id))
        .map((s) => s.project_slug.toLowerCase()),
    );
    /* Mirror the bridge's path canonicalisation so a registry root
     * with a trailing slash, doubled separators, or differing drive-
     * letter case doesn't get mis-classified as idle when its session
     * is actually live. Steps: backslashes → forward, collapse runs of
     * slashes, lowercase, strip trailing slash, then convert path
     * separators + colons to hyphens to match Claude Code's project
     * directory naming. */
    const rootToSlug = (root: string): string =>
      root
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .toLowerCase()
        .replace(/\/$/, '')
        .replace(/[\\/:]/g, '-');
    /* Dedup by normalised root. The registry can carry two ids for
     * the same folder when the project was first seen as a path-only
     * entry and later resolved a git remote (different scope, different
     * hash). Render a single tile per folder, preferring the most
     * recently seen one so its last_seen timestamp is meaningful. */
    interface IdleEntry {
      id: string;
      name: string;
      root: string;
      last_seen: string;
    }
    const seenRoots = new Map<string, IdleEntry>();
    const normRoot = (r: string) =>
      r.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase().replace(/\/$/, '');
    for (const p of projects) {
      if (!p.root) continue;
      if (liveSlugs.has(rootToSlug(p.root))) continue;
      const key = normRoot(p.root);
      const existing = seenRoots.get(key);
      const candidate: IdleEntry = {
        id: p.id,
        name: p.name,
        root: p.root,
        last_seen: p.last_seen,
      };
      if (
        !existing ||
        Date.parse(candidate.last_seen) > Date.parse(existing.last_seen)
      ) {
        seenRoots.set(key, candidate);
      }
    }
    const idle = [...seenRoots.values()].sort(
      (a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen),
    );
    return { ok: true, sessions, idle_projects: idle };
  });

  app.get('/sessions/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const query = (req.query as { q?: string }).q ?? '';
    const opts = query
      ? { recentLimit: 200, query }
      : { recentLimit: 30 };
    const detail = getSessionDetail(id, opts);
    if (!detail) {
      reply.code(404);
      return { ok: false, error: 'session not found' };
    }
    return { ok: true, session: detail };
  });

  app.get('/sessions/:id/transcript', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const limit = Number(
      (req.query as { limit?: string }).limit ?? '60',
    );
    const detail = getSessionDetail(id, { recentLimit: limit });
    if (!detail) {
      reply.code(404);
      return { ok: false, error: 'session not found' };
    }
    return { ok: true, chunks: detail.recent_chunks };
  });

  app.post('/sessions/:id/prompt', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as { text?: string; from_anchor_id?: string };
    if (!body.text || typeof body.text !== 'string') {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    /* Worker scope (2026-07-08 review finding): this queue route was
     * the taught alternative to /lex/steer and skipped the scope
     * check entirely. Same contract as steer: a caller declaring a
     * Lex anchor only reaches that anchor's supervised worker. */
    if (typeof body.from_anchor_id === 'string' && body.from_anchor_id) {
      const { checkLexScope } = await import('../lex/cross-session-inject.js');
      const scope = checkLexScope(store.db, body.from_anchor_id, id);
      if (!scope.allowed) {
        reply.code(403);
        return {
          ok: false,
          decision: 'rejected_scope',
          error: scope.reason ?? 'target outside this brainstorm worker scope',
        };
      }
    }
    const r = queueSessionPrompt(id, body.text);
    if (!r.ok) {
      // Bridge offline: refuse the queue and surface the reason so the
      // dashboard can show a fail toast instead of silently buffering.
      reply.code(503);
      log(`[dashboard] prompt rejected for session ${id}: ${r.error}`);
      return r;
    }
    log(`[dashboard] prompt queued for session ${id}`);
    return r;
  });

  app.get('/dashboard/bridge-status', async () => {
    return { ok: true, ...bridgeStatus() };
  });

  /* Soft-prompt suggestion. Drops text into Claude's input buffer
   * without hitting Enter; the user reviews and commits manually.
   * Curator + reminder paths can use this to nudge the user without
   * claiming the next prompt outright. */
  app.post('/sessions/:id/suggest', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as { text?: string; from_anchor_id?: string };
    if (!body.text || typeof body.text !== 'string') {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    /* Worker scope (2026-07-08): same gate as /sessions/:id/prompt. */
    if (typeof body.from_anchor_id === 'string' && body.from_anchor_id) {
      const { checkLexScope } = await import('../lex/cross-session-inject.js');
      const scope = checkLexScope(store.db, body.from_anchor_id, id);
      if (!scope.allowed) {
        reply.code(403);
        return {
          ok: false,
          decision: 'rejected_scope',
          error: scope.reason ?? 'target outside this brainstorm worker scope',
        };
      }
    }
    const r = queueSessionSuggestion(id, body.text);
    if (!r.ok) {
      reply.code(503);
      log(`[dashboard] suggestion rejected for session ${id}: ${r.error}`);
      return r;
    }
    log(`[dashboard] suggestion queued for session ${id}`);
    return r;
  });

  app.post('/sessions/:id/focus', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = queueSessionFocus(id);
    if (!r.ok) reply.code(503);
    return r;
  });

  /* Nav-mode key injection. The dashboard's Stream Deck rail enters Nav
   * mode on a re-tap of the already-focused tile and exposes the same
   * 5x3 grid the hardware deck does. Each press POSTs here, daemon
   * queues for the bridge, bridge SendInputs into the focused window. */
  app.post('/sessions/:id/key', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { key?: unknown };
    if (!isNavKey(body.key)) {
      reply.code(400);
      return {
        ok: false,
        error:
          'key must be one of: up, down, left, right, enter, backspace, 1-5, mic',
      };
    }
    const r = queueSessionKey(id, body.key);
    if (!r.ok) reply.code(503);
    return r;
  });

  /* Phase ping. Hook-runner POSTs here on every Pre/Post/Prompt/Stop so
   * the dashboard's Stream Deck rail can paint the live tile color. */
  app.post('/sessions/:id/phase', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as { phase?: string };
    const valid: SessionPhase[] = ['thinking', 'tool', 'permission', 'idle', 'unknown'];
    const phase = (valid as string[]).includes(body.phase ?? '')
      ? (body.phase as SessionPhase)
      : 'idle';
    setPhase(id, phase);
    reply.code(200);
    return { ok: true };
  });

  /* Pending permission/elicitation prompt.
   *
   * POST: hook-runner forwards Claude's notification message so the
   *   dashboard can render the question + numbered answer buttons.
   * DELETE: dashboard calls this after the user answers (or after the
   *   bridge confirms the answer landed) so the badge clears.
   * GET (under /sessions/:id detail): not a separate endpoint; the
   *   pending struct rides on the session list/detail responses. */
  app.post('/sessions/:id/pending-prompt', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { message?: string; kind?: string };
    if (!body.message || typeof body.message !== 'string') {
      reply.code(400);
      return { ok: false, error: 'message required' };
    }
    setPending(id, body.message, body.kind ?? 'notification');
    // Also surface in the live activity feed so the user sees CC waiting
    // even when not on /sessions. warn-level because it blocks Claude
    // until the user answers; this severity also triggers web push.
    emitNotification({
      severity: 'warn',
      source: 'permission',
      notify_class: 'followup',
      title: `Claude waiting on you (${body.kind ?? 'notification'})`,
      body: body.message.slice(0, 200),
      link: `/sessions/detail?id=${encodeURIComponent(id)}`,
    });
    return { ok: true };
  });

  app.delete('/sessions/:id/pending-prompt', async (req) => {
    const id = (req.params as { id: string }).id;
    clearPending(id);
    return { ok: true };
  });

  app.get('/sessions/:id/pending-prompt', async (req) => {
    const id = (req.params as { id: string }).id;
    const p = getPending(id);
    return { ok: true, pending: p };
  });

  /* /clear (and /compact) supersession.
   *
   * Hook-runner POSTs here when the SessionStart hook fires with
   * source=clear or source=compact. We resolve the previous session
   * in the same workspace and add it to the superseded store so the
   * Stream Deck rail stops rendering a phantom tile for the cleared
   * session. */
  /* Lex pulse.
   *
   * Hook-runner POSTs here on Stop so the dashboard sees what Claude
   * just said in plain English. Daemon tail-reads the session jsonl,
   * extracts the most recent assistant text turn, and emits an
   * activity-rail notification with a heuristic severity:
   *   - ends with '?' -> warn (Lex needs an answer)
   *   - >= 80 chars   -> info (Lex finished a meaningful turn)
   *   - else          -> skipped (trivial ack, not worth a card)
   *
   * Dedupe: the last-seen text is hashed per session in memory so
   * repeated Stop fires (CC sometimes fires twice for the same turn)
   * don't double-post. */
  const lastLexPulseHash = new Map<string, string>();

  function hashStr(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0;
    return String(h);
  }

  app.post('/sessions/:id/lex-pulse', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { cwd?: string };
    const pulse = buildLexPulseFromTail(id, body.cwd);
    if (!pulse) {
      reply.code(204);
      return null;
    }
    const sig = hashStr(pulse.body);
    if (lastLexPulseHash.get(id) === sig) {
      reply.code(204);
      return null;
    }
    lastLexPulseHash.set(id, sig);
    /* lex-pulse is the "Lex finished a turn" surface. By definition
     * every fire is conversational. Per Fix 9, conversational
     * notifications are filtered out of the bell so the bell stays
     * a high-signal stream. The activity rail (RightRail) still
     * renders these because its listing call passes surface='activity'
     * which bypasses the bell filter. */
    const n = emitNotification({
      severity: pulse.severity,
      source: 'lex',
      notify_class: 'conversation',
      title: pulse.title,
      body: pulse.body,
      link: `/sessions/detail?id=${encodeURIComponent(id)}`,
    });
    return { ok: true, notification: n };
  });

  /* Terminal-output mirror.
   *
   * Bridge POSTs every chunk of rendered terminal data here. We push
   * into the per-session ring and fan out to live WebSocket clients.
   * Body: { data: string }. Empty body = 204 (no-op). */
  app.post('/sessions/:id/terminal-stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      data?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    if (typeof body.data !== 'string' || !body.data) {
      reply.code(204);
      return null;
    }
    const cols = typeof body.cols === 'number' ? body.cols : undefined;
    const rows = typeof body.rows === 'number' ? body.rows : undefined;
    pushTerminalData(id, body.data, cols, rows);
    reply.code(204);
    return null;
  });

  /* Late-join replay: GET returns the current ring snapshot plus the
   * last known source grid dimensions so the mirror can resize before
   * writing the replay. JSON envelope: { data, cols?, rows? }. */
  app.get('/sessions/:id/terminal-replay', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    return getTerminalReplay(id);
  });

  /* Live mirror via WebSocket. Each connected client gets every
   * subsequent chunk pushed to the session's ring. The replay GET
   * above seeds the initial screen; this carries the live updates. */
  app.get(
    '/sessions/:id/terminal-ws',
    { websocket: true },
    (socket, req) => {
      const id = (req.params as { id: string }).id;
      const unsubscribe = subscribeTerminal(id, (data) => {
        try {
          socket.send(data);
        } catch {
          /* socket may have closed mid-broadcast */
        }
      });
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
    },
  );

  /* Daemon-PTY endpoints. The PTY host owns a `claude` (or any other)
   * child process directly so the dashboard can mirror + steer
   * without VS Code or the bridge in the loop. /pty/:id/inject is
   * the analogue of the bridge-mediated /sessions/:id/prompt; it
   * accepts both the ephemeral ptyId (returned at spawn time, valid
   * before claude has written its session-id jsonl) and the bound
   * session-id (after binding). */
  app.get('/pty', async () => ({ ok: true, ptys: listPtys() }));

  /* ── Lex anchor endpoints (PLAN-lex-session-rewrite.md, step 4)
   *
   * These are the new past-sessions surface. Each anchor is the
   * durable identity returned by GET /lex/anchors. Click-to-open
   * (POST /lex/anchors/:id/open) spawns a fresh CC PTY when the
   * anchor is dormant (with the reopen-variant system prompt that
   * lists every prior transcript jsonl + a Read instruction), or
   * returns the live PTY when the anchor is already alive — voice
   * WS bind follows the live PTY automatically since both endpoints
   * resolve the active brainstorm by the same pty-list query the
   * dashboard already uses.
   *
   * The legacy /lex/sessions block below stays in place during the
   * migration window and will be retired in step 6.
   */
  /* In-flight open guard. Per-anchor promise memoisation collapses
   * concurrent POST /lex/anchors/:id/open calls into a single spawn.
   * Without this two callers can both observe "not live" and both
   * spawn (codex finding #3). */
  const openInFlight = new Map<string, Promise<unknown>>();

  app.get('/lex/anchors', async (req) => {
    const q = (req.query ?? {}) as { status?: string; limit?: string };
    const status =
      q.status === 'live' || q.status === 'dormant' ? q.status : undefined;
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 50;
    const rows = listLexSessions({ status, limit });
    const liveSet = getLivePtyIds();
    const out = rows.map((row) => {
      const refs = listTranscriptRefs(row.id);
      const last =
        refs.reduce<number>((acc, r) => {
          const t = r.ended_ms ?? r.started_ms;
          return t > acc ? t : acc;
        }, 0) || row.created_ms;
      const live = Boolean(
        row.current_pty_id && liveSet.has(row.current_pty_id),
      );
      /* Brainstorm-as-durable-primary-entity (2026-05-22 reconcile).
       * Surface the bound brainstorm's runtime_mode so LexSessionList's
       * resume button can branch: cc-pty does the existing kill-then-
       * spawn dance; direct-llm just voice-connects via brainstorm_id
       * with no PTY churn. The lookup is best-effort: legacy anchors
       * 1:1 with brainstorm rows by id; absent row returns undefined
       * which the dashboard treats as cc-pty (default). */
      let runtime_mode: 'cc-pty' | 'direct-llm' | 'detached' | undefined;
      try {
        const bs = store.db.getBrainstorm(row.id);
        if (bs && bs.runtime_mode) runtime_mode = bs.runtime_mode;
      } catch {
        /* observational */
      }
      return {
        id: row.id,
        title: row.title,
        derived_title: row.derived_title,
        status: live ? 'live' : 'dormant',
        current_pty_id: live ? row.current_pty_id : null,
        cwd: row.cwd,
        created_ms: row.created_ms,
        last_activity_ms: last,
        transcript_count: refs.length,
        /* Phase C: surface the brainstorm-to-project binding so
         * the dashboard's SupervisesPicker can read its current
         * value from the same row it just PATCH'd. Without this
         * column the controlled <select> bounced back to
         * '(no project)' on every refetch tick because
         * row.supervises_project_anchor_id was undefined. */
        supervises_project_anchor_id: row.supervises_project_anchor_id ?? null,
        runtime_mode,
      };
    });
    return { ok: true, anchors: out };
  });

  app.get('/lex/anchors/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getLexSession(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    const refs = listTranscriptRefs(id);
    const liveSet = getLivePtyIds();
    const live = Boolean(
      row.current_pty_id && liveSet.has(row.current_pty_id),
    );
    return {
      ok: true,
      anchor: {
        id: row.id,
        title: row.title,
        derived_title: row.derived_title,
        status: live ? 'live' : 'dormant',
        current_pty_id: live ? row.current_pty_id : null,
        cwd: row.cwd,
        created_ms: row.created_ms,
        transcripts: refs,
        /* Phase C: see the matching note in GET /lex/anchors. The
         * BrainstormDetail SupervisesSection reads
         * q.data?.anchor?.supervises_project_anchor_id to seed
         * its picker; omitting the field here broke the same
         * round-trip the list endpoint did. */
        supervises_project_anchor_id: row.supervises_project_anchor_id ?? null,
      },
    };
  });

  /* Create a fresh anchor and spawn its first CC session. Body:
   *   { cwd?, title? }
   * cwd defaults to <DATA_ROOT>/brainstorm. Returns the new anchor +
   * spawned PTY id so the dashboard can immediately route to it. */
  app.post('/lex/anchors', async (req, reply) => {
    const body = (req.body ?? {}) as {
      cwd?: string;
      title?: string;
      supervises_project_anchor_id?: string | null;
    };
    const cwd =
      body.cwd ?? path.posix.join(DATA_ROOT.replace(/\\/g, '/'), 'brainstorm');
    if (!fs.existsSync(cwd)) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch (err) {
        reply.code(400);
        return {
          ok: false,
          error: `cannot create cwd: ${(err as Error).message}`,
        };
      }
    }
    /* Validate the supervises target up front so a bad id never
     * leaves a half-bound anchor behind. Mirrors the PATCH
     * validation; null is accepted (no binding). */
    if (body.supervises_project_anchor_id !== undefined && body.supervises_project_anchor_id !== null) {
      const target = body.supervises_project_anchor_id;
      if (typeof target !== 'string' || !target) {
        reply.code(422);
        return {
          ok: false,
          error: 'supervises_project_anchor_id must be a non-empty string or null',
        };
      }
      const exists = store.db.getProjectSession(target);
      if (!exists) {
        reply.code(422);
        return {
          ok: false,
          error: `project_session ${target} not found`,
        };
      }
    }
    try {
      /* Worker scope (2026-07-08): the scope contract needs the REAL
       * anchor id (from_anchor_id) inside the prompt, but the row is
       * only minted inside spawnLexSession. Late-bind the prompt via
       * the buildSystemPrompt factory, which receives the prepared
       * anchor. The supervises target is known from the body up
       * front, so the scoped worker block resolves here. */
      let built: ReturnType<typeof buildLexSpawnPrompt> | null = null;
      const supervisesId = body.supervises_project_anchor_id ?? null;
      const supervisedProj = supervisesId
        ? store.db.getProjectSession(supervisesId)
        : null;
      const r = spawnLexSession({
        cwd,
        title: body.title,
        extraArgs: ['--dangerously-skip-permissions'],
        buildSystemPrompt: (prep) => {
          built = buildLexSpawnPrompt({
            lexSessionId: prep.lexSession.id,
            transcriptPaths: [],
            cwd,
            scope: {
              brainstormId: prep.lexSession.id,
              projectAnchorId: supervisesId,
              projectSlug: supervisedProj?.project_slug ?? null,
              workerSessionId: supervisedProj?.current_session_id ?? null,
            },
          });
          return built.prompt;
        },
      });
      if (!built) {
        throw new Error('system prompt factory did not run');
      }
      built = built as ReturnType<typeof buildLexSpawnPrompt>;
      /* Fix 12 audit: log which feedback rules were baked into the
       * system prompt for this anchor at session start. Reads
       * cleanly off the brainstorm CWD so two anchors in different
       * directories never cross-pollinate. */
      if (built.feedback_memories.kept.length > 0 || built.feedback_memories.status === 'over-cap') {
        log(
          `[lex-anchor] hard-rules cwd=${cwd} kept=${built.feedback_memories.kept.length} dropped=${built.feedback_memories.dropped.length} status=${built.feedback_memories.status} titles=${JSON.stringify(built.feedback_memories.kept.map((r) => r.title))}`,
        );
      }
      if (built.feedback_memories.status === 'over-cap') {
        log(
          `[lex-anchor] WARN hard-rules over cap; truncated ${built.feedback_memories.dropped.length} oldest rules`,
        );
      }
      log(
        `[lex-anchor] new anchor=${r.lexSessionId} cc=${r.ccSessionId} pty=${r.ptyId} cwd=${cwd}`,
      );
      /* Stamp the binding immediately after the row is created so
       * the first call to /lex/voice-snapshot or
       * /lex/inject-cross-session sees the supervises target without
       * needing a follow-up PATCH from the client. */
      if (
        body.supervises_project_anchor_id !== undefined &&
        body.supervises_project_anchor_id !== null
      ) {
        store.db.setLexSessionSupervises(
          r.lexSessionId,
          body.supervises_project_anchor_id,
        );
      }
      return {
        ok: true,
        anchor_id: r.lexSessionId,
        cc_session_id: r.ccSessionId,
        pty_id: r.ptyId,
        transcript_path: r.transcriptPath,
        prompt_version: built.version,
        supervises_project_anchor_id: body.supervises_project_anchor_id ?? null,
      };
    } catch (err) {
      log(`[lex-anchor] new failed: ${(err as Error).message}`);
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  /* Spawn-or-bind. If the anchor is already live, return the live
   * PTY (voice + terminal mirror reconnect via the existing pty-list
   * query). If dormant, spawn a fresh CC session under the SAME
   * anchor with the reopen-variant system prompt that lists every
   * prior transcript path and instructs Lex to Read each in order.
   *
   * Concurrency guard: openInFlight memoises the in-progress spawn
   * promise per anchor. Codex flagged that two callers could both
   * observe "not live" and both spawn, leaving two PTYs + two
   * transcript refs against one anchor. Memoising the promise so a
   * second caller awaits the first closes that race entirely. */
  app.post('/lex/anchors/:id/open', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getLexSession(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    const liveSet = getLivePtyIds();
    if (row.current_pty_id && liveSet.has(row.current_pty_id)) {
      return {
        ok: true,
        mode: 'bind',
        anchor_id: id,
        pty_id: row.current_pty_id,
      };
    }
    const existing = openInFlight.get(id);
    if (existing) return existing;
    const inflight = (async () => {
      try {
        const refs = listTranscriptRefs(id);
        /* Worker scope (2026-07-08): reopen rebuilds the prompt with
         * the anchor's current supervises binding so a rebound anchor
         * comes back scope-locked to the right worker. Same fallback
         * chain as every other scope surface (supervisedAnchorIdFor:
         * lex_session first, legacy project_scope_id mirror second). */
        const { supervisedAnchorIdFor } = await import(
          '../lex/cross-session-inject.js'
        );
        const supervisedId = supervisedAnchorIdFor(store.db, id);
        const supervisedProj = supervisedId
          ? store.db.getProjectSession(supervisedId)
          : null;
        const built = buildLexSpawnPrompt({
          lexSessionId: id,
          transcriptPaths: refs.map((r) => r.transcript_path),
          cwd: row.cwd,
          scope: {
            brainstormId: id,
            projectAnchorId: supervisedId,
            projectSlug: supervisedProj?.project_slug ?? null,
            workerSessionId: supervisedProj?.current_session_id ?? null,
          },
        });
        /* Fix 12 audit on reopen path. Same logging shape as the
         * new-anchor route above so /admin/logs can grep both. */
        if (
          built.feedback_memories.kept.length > 0 ||
          built.feedback_memories.status === 'over-cap'
        ) {
          log(
            `[lex-anchor] hard-rules cwd=${row.cwd} kept=${built.feedback_memories.kept.length} dropped=${built.feedback_memories.dropped.length} status=${built.feedback_memories.status} titles=${JSON.stringify(built.feedback_memories.kept.map((r) => r.title))}`,
          );
        }
        if (built.feedback_memories.status === 'over-cap') {
          log(
            `[lex-anchor] WARN hard-rules over cap; truncated ${built.feedback_memories.dropped.length} oldest rules`,
          );
        }
        const r = spawnLexSession({
          lexSessionId: id,
          cwd: row.cwd,
          extraArgs: ['--dangerously-skip-permissions'],
          systemPrompt: built.prompt,
        });
        log(
          `[lex-anchor] reopen anchor=${id} cc=${r.ccSessionId} pty=${r.ptyId} transcripts=${refs.length}`,
        );
        return {
          ok: true as const,
          mode: 'spawn' as const,
          anchor_id: id,
          cc_session_id: r.ccSessionId,
          pty_id: r.ptyId,
          transcript_path: r.transcriptPath,
          prompt_version: built.version,
          prior_transcript_count: refs.length,
        };
      } catch (err) {
        log(`[lex-anchor] reopen failed for ${id}: ${(err as Error).message}`);
        reply.code(500);
        return { ok: false as const, error: (err as Error).message };
      }
    })();
    openInFlight.set(id, inflight);
    try {
      return await inflight;
    } finally {
      openInFlight.delete(id);
    }
  });

  /* Rename / mark dormant. Body: { title?, derived_title?,
   *   supervises_project_anchor_id? } */
  app.patch('/lex/anchors/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      title?: string | null;
      derived_title?: string | null;
      supervises_project_anchor_id?: string | null;
    };
    const row = getLexSession(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    /* Validate supervises target before touching anything. Null is
     * allowed to clear an existing binding; non-null must reference
     * a real project_session row. */
    if (body.supervises_project_anchor_id !== undefined) {
      const target = body.supervises_project_anchor_id;
      if (target !== null) {
        if (typeof target !== 'string' || !target) {
          reply.code(422);
          return {
            ok: false,
            error: 'supervises_project_anchor_id must be a non-empty string or null',
          };
        }
        const exists = store.db.getProjectSession(target);
        if (!exists) {
          reply.code(422);
          return {
            ok: false,
            error: `project_session ${target} not found`,
          };
        }
      }
      store.db.setLexSessionSupervises(id, target);
    }
    let updated = store.db.getLexSession(id);
    if (body.title !== undefined || body.derived_title !== undefined) {
      updated = setLexSessionTitle(id, {
        title: body.title,
        derivedTitle: body.derived_title,
      });
    }
    return { ok: true, anchor: updated };
  });

  /* End the live PTY for an anchor and mark it dormant. The
   * ON-EXIT handler in pty-host already flips status, but the user
   * might click "end" on a row whose PTY died without firing the
   * handler — flip it explicitly here so the UI is honest. */
  app.post('/lex/anchors/:id/end', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getLexSession(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    /* Dashboard "End" button must behave identically to the spoken
     * "Lex end session" voice command: both fire the full session-end
     * pipeline (distillation, ref_summary write, last_summary refresh,
     * RAG embed, thread-doc) on the active transcript before the PTY
     * is killed. Prior behaviour skipped the pipeline entirely, which
     * left ended sessions with NULL ref_summary and broke smoke step
     * 3.1/3.2/3.3. */
    try {
      const refs = listTranscriptRefs(id);
      const active = refs.find((r) => !r.ended_ms);
      if (active) {
        const bs = getBrainstorm(id);
        const { runSessionEndPipeline } = await import('../lex/session-end-pipeline.js');
        const mode = (bs?.mode ?? 'conversation') as
          | 'conversation'
          | 'notes'
          | 'push-to-talk'
          | string;
        log(
          `[lex-anchor] /end: firing session-end pipeline anchor=${id} cc=${active.cc_session_id} reason=dashboard-end-button`,
        );
        await runSessionEndPipeline(
          store,
          {
            brainstormId: id,
            claudeSessionId: active.cc_session_id,
            mode,
            reason: 'dashboard-end-button',
          },
          (msg) => log(msg),
        );
      } else {
        log(
          `[lex-anchor] /end: no active transcript for anchor=${id}; skipping pipeline`,
        );
      }
    } catch (err) {
      log(
        `[lex-anchor] /end: pipeline failed for ${id}: ${(err as Error).message}`,
      );
    }
    if (row.current_pty_id) {
      try {
        ptyKill(row.current_pty_id);
      } catch {
        /* best-effort; the status flip below still happens */
      }
    }
    setLexSessionStatus(id, { status: 'dormant', currentPtyId: null });
    return { ok: true };
  });

  /* Stream Deck tile feed for live anchors. Read-only; no tap
   * action on the deck side. Phase reuses the /sessions vocab so
   * the deck's existing tile colour mapping just works. */
  app.get('/lex/anchor-tiles', async () => {
    return { ok: true, tiles: listAnchorTiles() };
  });

  app.delete('/lex/anchors/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getLexSession(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    if (row.current_pty_id) {
      try {
        ptyKill(row.current_pty_id);
      } catch {
        /* best-effort */
      }
    }
    deleteLexSession(id);
    return { ok: true };
  });

  /* Legacy /lex/sessions list / get / patch endpoints retired in
   * step 6 of PLAN-lex-session-rewrite.md. The canonical
   * past-sessions surface is /lex/anchors above; renames now go
   * through PATCH /lex/anchors/:id, status flips through
   * /lex/anchors/:id/end, and the row id == lex_session.id thanks
   * to the write-through in spawn-lex-session.ts so any caller
   * hitting the old endpoints can swap to the new ones without an
   * id translation step.
   *
   * The /lex/sessions/:id/artifacts subresource below is preserved
   * intentionally — artifact storage still lives under the legacy
   * brainstorm_sessions.artifacts_json column, and the lex_session
   * id matches the brainstorm row id, so the same path keeps
   * working transparently. */

  /* List artifacts attached to a brainstorm session.
   *
   * Reads the artifacts manifest off the brainstorm row, then walks
   * each referenced JSON file under <DATA_ROOT>/lex/artifacts/<kind>/.
   * Returns lightweight metadata + a preview slice so the dashboard
   * can render a list without slurping every file when the user is
   * just scrolling. The artifact JSON envelope is { id, kind,
   * brainstorm_id, created_ms, data } (see artifact-parser.ts). */
  app.get('/lex/sessions/:id/artifacts', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getBrainstorm(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'session not found' };
    }
    interface ArtifactManifestRef {
      id: string;
      title?: string;
      added_ms?: number;
      turn_id?: string;
    }
    interface ArtifactManifest {
      research_notes: ArtifactManifestRef[];
      wiki_drafts: ArtifactManifestRef[];
      reminders: ArtifactManifestRef[];
      spawned_projects: ArtifactManifestRef[];
    }
    let manifest: ArtifactManifest;
    try {
      const parsed = JSON.parse(row.artifacts_json) as Partial<ArtifactManifest>;
      manifest = {
        research_notes: parsed.research_notes ?? [],
        wiki_drafts: parsed.wiki_drafts ?? [],
        reminders: parsed.reminders ?? [],
        spawned_projects: parsed.spawned_projects ?? [],
      };
    } catch {
      manifest = { research_notes: [], wiki_drafts: [], reminders: [], spawned_projects: [] };
    }
    const artifactsRoot = path.posix.join(
      DATA_ROOT.replace(/\\/g, '/'),
      'lex',
      'artifacts',
    );
    /* Reminders entries point at the reminder system, not at on-disk
     * artifact JSON, so they're excluded from this listing. The kinds
     * with files on disk are research-note, wiki-draft, project-intent,
     * notes-summary; the manifest uses category names so we map back
     * to the on-disk subdirectory by trying each candidate kind. */
    const KIND_DIRS_BY_CATEGORY: Record<string, string[]> = {
      research_notes: ['research-note', 'notes-summary'],
      wiki_drafts: ['wiki-draft'],
      spawned_projects: ['project-intent'],
    };
    interface ArtifactItem {
      kind: string;
      category: string;
      id: string;
      title: string;
      created_ms: number;
      path: string;
      preview: string;
      turn_id?: string;
    }
    const items: ArtifactItem[] = [];
    const categories: Array<keyof ArtifactManifest> = [
      'research_notes',
      'wiki_drafts',
      'spawned_projects',
    ];
    for (const category of categories) {
      const refs = manifest[category];
      const candidateKinds = KIND_DIRS_BY_CATEGORY[category] ?? [];
      for (const ref of refs) {
        if (!ref?.id) continue;
        let resolved: { kind: string; file: string } | null = null;
        for (const kind of candidateKinds) {
          const file = path.posix.join(artifactsRoot, kind, `${ref.id}.json`);
          if (fs.existsSync(file)) {
            resolved = { kind, file };
            break;
          }
        }
        if (!resolved) continue;
        try {
          const raw = fs.readFileSync(resolved.file, 'utf-8');
          const parsed = JSON.parse(raw) as {
            id?: string;
            kind?: string;
            created_ms?: number;
            data?: Record<string, unknown>;
          };
          /* Build a preview by stringifying the data block. Trim hard
           * so the list payload stays small when a session has many
           * artifacts; clients can fetch the file path for the full
           * body if they need it. */
          const dataStr = JSON.stringify(parsed.data ?? {}, null, 2);
          const preview = dataStr.length > 400 ? dataStr.slice(0, 400) : dataStr;
          items.push({
            kind: parsed.kind ?? resolved.kind,
            category,
            id: ref.id,
            title: ref.title ?? ref.id,
            created_ms: parsed.created_ms ?? ref.added_ms ?? 0,
            path: resolved.file,
            preview,
            ...(ref.turn_id ? { turn_id: ref.turn_id } : {}),
          });
        } catch {
          /* Skip unreadable / malformed artifact file. */
        }
      }
    }
    items.sort((a, b) => b.created_ms - a.created_ms);
    return {
      ok: true,
      artifacts: items,
      ...(row.prompt_version
        ? { session_prompt_version: row.prompt_version }
        : {}),
    };
  });

  /* Full artifact body. Used by the dashboard when the user expands
   * an artifact row to read the entire JSON instead of just the
   * preview slice returned by the list endpoint. */
  app.get('/lex/artifacts/:kind/:id', async (req, reply) => {
    const params = req.params as { kind: string; id: string };
    if (!/^[a-z][a-z-]+$/.test(params.kind) || !/^[a-zA-Z0-9-]+$/.test(params.id)) {
      reply.code(400);
      return { ok: false, error: 'invalid kind or id' };
    }
    const file = path.posix.join(
      DATA_ROOT.replace(/\\/g, '/'),
      'lex',
      'artifacts',
      params.kind,
      `${params.id}.json`,
    );
    if (!fs.existsSync(file)) {
      reply.code(404);
      return { ok: false, error: 'artifact not found' };
    }
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ok: true, artifact: parsed };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: `read failed: ${(err as Error).message}` };
    }
  });

  app.post('/lex/sessions/:id/artifacts', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      category?: 'research_notes' | 'wiki_drafts' | 'reminders' | 'spawned_projects';
      ref?: { id: string; title?: string };
    };
    if (!body.category || !body.ref?.id) {
      reply.code(400);
      return { ok: false, error: 'category and ref.id required' };
    }
    const row = appendBrainstormArtifact(id, body.category, body.ref);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'session not found' };
    }
    return { ok: true, session: row };
  });

  /* Voice / STT. Lazy-spawns whisper-server (cuBLAS build, RTX 5080)
   * on first call; subsequent transcriptions reuse the persistent
   * process so the model load (~1s) is amortised. Body accepts
   * either { wav: base64 } or { pcm: base64, sampleRate }.
   * Used by the Brainstorming voice client; future: stand-alone
   * transcription endpoint for any consumer. */
  app.get('/voice/whisper-status', async () => ({
    ok: true,
    ...whisperStatus(),
  }));

  app.post('/voice/whisper-prewarm', async () => {
    try {
      await ensureWhisper();
      return { ok: true, ...whisperStatus() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  app.get('/voice/piper-status', async () => ({
    ok: true,
    ...piperStatus(),
  }));

  app.post('/voice/set-voice', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    if (!body.name) {
      reply.code(400);
      return { ok: false, error: 'name required' };
    }
    const r = setActiveVoice(body.name);
    if (!r.ok) {
      reply.code(404);
      return r;
    }
    return { ok: true, ...piperStatus() };
  });

  /* Persisted global speech-rate control. Body: { speed: number } where
   * 1.0 = baseline (current default), 0.5 = half speed, 1.5 = 1.5x.
   * Stored as length_scale in voice-preferences.json so it survives
   * daemon restarts and applies to every voice consumer. */
  app.post('/voice/set-speed', async (req, reply) => {
    const body = (req.body ?? {}) as { speed?: number };
    const r = setActiveSpeed(Number(body.speed));
    if (!r.ok) {
      reply.code(400);
      return { ok: false, error: 'speed must be a positive number' };
    }
    return { ok: true, ...piperStatus() };
  });

  /* Persisted barge-in cooldown after tts-start. Suppresses VAD
   * speech-start handlers on the client for this many ms so Lex's own
   * audio bleeding into the mic does not trigger a self-interrupt.
   * Body: { ms: number } clamped 0-2000. Stored in voice-preferences.json. */
  app.post('/voice/set-barge-cooldown', async (req, reply) => {
    const body = (req.body ?? {}) as { ms?: number };
    const r = setBargeCooldownMs(Number(body.ms));
    if (!r.ok) {
      reply.code(400);
      return { ok: false, error: 'ms must be a non-negative number' };
    }
    return { ok: true, ...piperStatus() };
  });

  /* Persisted mic VAD sensitivity. Body: { value: number } in [0, 1].
   * 0 = least sensitive (high silero threshold, ignores room noise);
   * 1 = most sensitive (low threshold, fires on any speech-like sound).
   * 0.5 reproduces the legacy hardcoded thresholds. The client maps
   * this to silero positive/negative speech thresholds at VAD init. */
  app.post('/voice/set-vad-sensitivity', async (req, reply) => {
    const body = (req.body ?? {}) as { value?: number };
    const r = setVadSensitivity(Number(body.value));
    if (!r.ok) {
      reply.code(400);
      return { ok: false, error: 'value must be a finite number' };
    }
    return { ok: true, ...piperStatus() };
  });

  /* Persisted VAD end-of-utterance redemption window in ms. Higher
   * values give the user more tolerance for mid-sentence pauses
   * before silero declares end-of-utterance and ships the buffer to
   * whisper. The client converts ms to silero frames (32ms each at
   * 16kHz) at VAD init time. Range: 200-3000ms; default 768. */
  app.post('/voice/set-vad-redemption', async (req, reply) => {
    const body = (req.body ?? {}) as { ms?: number };
    const r = setVadRedemptionMs(Number(body.ms));
    if (!r.ok) {
      reply.code(400);
      return { ok: false, error: 'ms must be a positive number' };
    }
    return { ok: true, ...piperStatus() };
  });

  /* Persisted mic input gain. Body: { value: number } in [0, 3.0].
   * 1.0 = passthrough; <1 attenuates; >1 amplifies. The client applies
   * this multiplier to captured float samples before int16 conversion,
   * so it affects what whisper hears (lets the user turn down a hot
   * mic or boost a quiet one without touching OS-level controls). */
  app.post('/voice/set-mic-gain', async (req, reply) => {
    const body = (req.body ?? {}) as { value?: number };
    const r = setMicGain(Number(body.value));
    if (!r.ok) {
      reply.code(400);
      return { ok: false, error: 'value must be a non-negative number' };
    }
    return { ok: true, ...piperStatus() };
  });

  /* Smoke-test endpoint: returns a WAV. Production voice uses the
   * streaming WS path which buffers PCM directly into the browser. */
  app.post('/voice/synthesize', async (req, reply) => {
    const body = (req.body ?? {}) as { text?: string };
    if (!body.text || typeof body.text !== 'string') {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    try {
      const r = await synthesizeToBuffer(body.text);
      const wav = pcmToWav(r.pcm, r.sampleRate);
      reply.type('audio/wav');
      reply.header('X-Synth-Ms', String(r.ms));
      reply.header('X-Synth-Rate', String(r.sampleRate));
      return reply.send(wav);
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  /* Lex voice WebSocket. Single bidirectional channel for the full
   * conversational loop: mic PCM in, transcript + Lex response audio
   * out. See lex-voice-ws.ts for protocol. */
  app.get('/voice/lex-ws', { websocket: true }, (socket) => {
    attachLexVoiceWs(socket as unknown as Parameters<typeof attachLexVoiceWs>[0]);
  });

  /* Lex-callable voice control endpoints. Each one fans out a single
   * frame to every active voice WS (or the bindKey-targeted one) so
   * Lex can mute itself or stop the voice session from a tool call.
   * The browser handles each frame identically to the same-named
   * voice command (mute/unmute/disable). Reasoning: hands-busy
   * control without touching the UI. */
  const handleVoiceControl = (kind: VoiceControlKind) =>
    async (req: { body?: unknown }, reply: { code(c: number): { send(b: unknown): void } | unknown }): Promise<unknown> => {
      const body = (req.body ?? {}) as { bind_key?: string; reason?: string };
      const bindKey = typeof body.bind_key === 'string' && body.bind_key ? body.bind_key : null;
      const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'http-request';
      const r = broadcastVoiceControl(kind, { bindKey, reason });
      /* 200 OK even when delivered=0 so a script that fires a stop
       * during a silent gap does not have to special-case "no client
       * connected" as an error. The delivered counter is the truth. */
      void reply;
      return r;
    };
  app.post('/voice/mute', handleVoiceControl('mute'));
  app.post('/voice/unmute', handleVoiceControl('unmute'));
  app.post('/voice/stop', handleVoiceControl('stop'));

  app.post('/voice/transcribe', async (req, reply) => {
    const body = (req.body ?? {}) as {
      wav?: string;
      pcm?: string;
      sampleRate?: number;
    };
    let wav: Buffer | null = null;
    if (typeof body.wav === 'string' && body.wav.length > 0) {
      try {
        wav = Buffer.from(body.wav, 'base64');
      } catch {
        reply.code(400);
        return { ok: false, error: 'wav not valid base64' };
      }
    } else if (typeof body.pcm === 'string' && body.pcm.length > 0) {
      const pcm = Buffer.from(body.pcm, 'base64');
      const int16 = new Int16Array(
        pcm.buffer,
        pcm.byteOffset,
        pcm.byteLength / 2,
      );
      wav = pcm16ToWav(int16, body.sampleRate ?? 16000);
    }
    if (!wav) {
      reply.code(400);
      return { ok: false, error: 'wav or pcm required (base64)' };
    }
    try {
      const r = await transcribeWav(wav);
      return { ok: true, text: r.text, ms: r.ms };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.get('/pty/:id/output', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const out = getPtyOutput(id);
    reply.type('text/plain; charset=utf-8');
    return out;
  });

  app.post('/pty/spawn-lex', async (req, reply) => {
    const body = (req.body ?? {}) as {
      cwd?: string;
      command?: string;
      args?: string[];
      cols?: number;
      rows?: number;
      /* When set, claude is launched with --resume <id> so the past
       * conversation is restored verbatim. The CLI may reject an
       * unknown / stale id and mint a fresh one; either way the
       * brainstorm row identified by brainstorm_id below gets its
       * claude_session_id pointer updated to whatever actually
       * lands in the jsonl, so the row itself is never duplicated. */
      resume_session_id?: string;
      /* Brainstorm row uuid the new PTY should be bound to. Passed
       * by the past-sessions "switch to" flow so the row the user
       * clicked is the one that comes back to life. When omitted,
       * the daemon mints a fresh row and returns its id so the
       * dashboard can address it for renames etc. */
      brainstorm_id?: string;
    };
    const cwd =
      body.cwd ?? path.posix.join(DATA_ROOT.replace(/\\/g, '/'), 'brainstorm');
    if (!fs.existsSync(cwd)) {
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch (err) {
        reply.code(500);
        return {
          ok: false,
          error: `cannot create cwd: ${(err as Error).message}`,
        };
      }
    }
    try {
      const built = buildLexSystemPromptVersioned();
      const systemPrompt = built.prompt;
      const promptVersion = built.version;
      /* Lex's brainstorm cwd is daemon-owned scratch space with no real
       * project files, so Claude Code's permissions onboarding wizard
       * just blocks the seed greeting and the SessionStart hook from
       * firing (which in turn means no identity file, no Stream Deck
       * tile, and no claude_session_id binding). Skip permissions by
       * default; callers can override by passing explicit args. */
      const baseArgs = body.args ?? ['--dangerously-skip-permissions'];
      /* Real conversational resume via claude --resume <session-id>.
       * Validate the session id shape so we don't shell-inject; CLI
       * just ignores unknown ids but a malformed one could escape
       * quoting on Windows. */
      const resumeId =
        typeof body.resume_session_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          body.resume_session_id,
        )
          ? body.resume_session_id
          : null;
      if (resumeId) {
        baseArgs.push('--resume', resumeId);
      }
      const r = spawnLex({
        cwd,
        command: body.command,
        args: baseArgs,
        cols: body.cols,
        rows: body.rows,
        systemPrompt,
        brainstormId:
          typeof body.brainstorm_id === 'string' && body.brainstorm_id.length > 0
            ? body.brainstorm_id
            : undefined,
      });
      log(
        `[lex] spawn ptyId=${r.ptyId} pid=${r.pid} cwd=${cwd}${
          resumeId ? ` resume=${resumeId}` : ''
        }${r.brainstormId ? ` brainstorm=${r.brainstormId}` : ''}`,
      );
      /* Wave 2 carry-over #1: pin the system-prompt version onto the
       * brainstorm row that pty-host registered. setBrainstormPhaseTwo
       * is the safe writer (insertBrainstorm/updateBrainstorm round-
       * trip resets Phase Two columns to defaults). Best-effort; PTY
       * spawn for a non-brainstorm cwd has no row to patch. */
      try {
        const bs = store.db.getBrainstormByPty(r.ptyId);
        if (bs) {
          store.db.setBrainstormPhaseTwo(bs.id, {
            prompt_version: promptVersion,
          });
        }
      } catch {
        /* observability only; never block spawn */
      }
      /* Fresh spawns get an autonomous first-turn greeting via the
       * [seed] protocol. Resumed spawns SKIP the seed: claude is
       * already restoring the prior conversation and a synthetic
       * greeting on top would confuse both Lex and the user. */
      if (!resumeId) {
        seedFirstTurn(r.ptyId);
      }
      return {
        ok: true,
        ...r,
        brainstorm_id: r.brainstormId,
        cwd,
        resumed: Boolean(resumeId),
        prompt_version: promptVersion,
      };
    } catch (err) {
      const message = (err as Error).message;
      log(`[lex] spawn failed: ${message}`);
      reply.code(500);
      return { ok: false, error: message };
    }
  });

  app.post('/pty/:id/inject', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { text?: string; commit?: boolean };
    if (typeof body.text !== 'string' || body.text.length === 0) {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    const commit = body.commit !== false;
    const r = ptyInject(id, body.text, commit);
    if (!r.ok) {
      reply.code(404);
      return r;
    }
    return r;
  });

  app.post('/pty/:id/resize', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { cols?: number; rows?: number };
    if (
      typeof body.cols !== 'number' ||
      typeof body.rows !== 'number' ||
      body.cols < 4 ||
      body.rows < 4
    ) {
      reply.code(400);
      return { ok: false, error: 'cols/rows required (number >= 4)' };
    }
    const ok = ptyResize(id, body.cols, body.rows);
    if (!ok) {
      reply.code(404);
      return { ok: false, error: 'pty not found' };
    }
    return { ok: true };
  });

  app.delete('/pty/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = ptyKill(id);
    if (!ok) {
      reply.code(404);
      return { ok: false, error: 'pty not found' };
    }
    return { ok: true };
  });

  /* Session-id-keyed inject. Once a daemon-PTY session has been bound
   * to its claude session-id, this endpoint is the supported path for
   * the dashboard's Steer panel to send prompts. Mirror of the
   * existing /sessions/:id/prompt but writes directly to PTY stdin
   * instead of dropping a marker for the bridge to pick up. */
  app.post('/sessions/:id/inject', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      text?: string;
      commit?: boolean;
      from_anchor_id?: string;
    };
    if (typeof body.text !== 'string' || body.text.length === 0) {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    /* Worker scope (2026-07-08): same gate as /lex/steer. */
    if (typeof body.from_anchor_id === 'string' && body.from_anchor_id) {
      const { checkLexScope } = await import('../lex/cross-session-inject.js');
      const scope = checkLexScope(store.db, body.from_anchor_id, id);
      if (!scope.allowed) {
        reply.code(403);
        return {
          ok: false,
          decision: 'rejected_scope',
          error: scope.reason ?? 'target outside this brainstorm worker scope',
        };
      }
    }
    const commit = body.commit !== false;
    const r = ptyInject(id, body.text, commit);
    if (!r.ok) {
      reply.code(404);
      return r;
    }
    return r;
  });

  app.post('/sessions/clear-supersede', async (req, reply) => {
    const body = (req.body ?? {}) as { session_id?: string; cwd?: string };
    if (!body.session_id || typeof body.session_id !== 'string') {
      reply.code(400);
      return { ok: false, error: 'session_id required' };
    }
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
    const result = recordClearSupersede(body.session_id, cwd);
    if (!result.ok) {
      reply.code(500);
      return result;
    }
    return result;
  });

  // ── Search across all collections ────────────────────────────────
  app.post('/search/all', async (req) => {
    const body = (req.body ?? {}) as {
      q?: string;
      project_id?: string;
      collections?: Array<'wiki_page' | 'raw_chunk' | 'reference_chunk'>;
      top_k?: number;
      limit?: number;
      offset?: number;
      group_by_session?: boolean;
    };
    if (!body.q) return { ok: false, error: 'q required' };
    const page = await searchAll(
      store,
      {
        query: body.q,
        ...(body.project_id ? { project_id: body.project_id } : {}),
        ...(body.collections ? { collections: body.collections } : {}),
        ...(body.top_k ? { top_k: body.top_k } : {}),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        ...(typeof body.offset === 'number' ? { offset: body.offset } : {}),
        ...(body.group_by_session ? { group_by_session: true } : {}),
      },
      referenceStore,
    );
    return {
      ok: true,
      results: page.results,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      ...(page.groups ? { groups: page.groups } : {}),
    };
  });

  /* Lex retrieval helper. Wraps /search/all with brainstorm-priority
   * defaults so Lex can curl one URL and get session-grouped, source-
   * classified results without having to know the underlying flags.
   * scope='recent' restricts raw_chunks to the most recent N days
   * via project filter (omitted for now — recency window lives in
   * Slice C tagging). scope='all' is the default. */
  app.post('/lex/recall', async (req, reply) => {
    const body = (req.body ?? {}) as {
      q?: string;
      scope?: 'recent' | 'all';
      project_id?: string;
      limit?: number;
      project_docs?: boolean;
    };
    if (!body.q) {
      reply.code(400);
      return { ok: false, error: 'q required' };
    }
    const page = await searchAll(
      store,
      {
        query: body.q,
        ...(body.project_id ? { project_id: body.project_id } : {}),
        limit: typeof body.limit === 'number' ? body.limit : 12,
        group_by_session: true,
      },
      referenceStore,
    );
    /* Slice E conflict signal. When the same query surfaces both a
     * canonical wiki page and a brainstorm session, Lex must compare
     * the two before answering (the prompt's retrieval contract). We
     * don't run a real semantic contradiction check here; we mark
     * the overlap so Lex knows to look. */
    const hasCanonical = page.results.some(
      (r) => r.source_class === 'wiki',
    );
    const hasBrainstorm = (page.groups?.length ?? 0) > 0;
    const conflictCheckRequired = hasCanonical && hasBrainstorm;
    /* Additive Unified-Knowledge-Index branch: when project_docs is
     * requested with a project_id, attach strictly scoped doc pointers
     * alongside the existing recall envelope. Every pre-existing field
     * is unchanged; callers that don't ask for docs see no difference. */
    let docPointers:
      | import('../lex/project-doc-index.js').DocPointerHit[]
      | undefined;
    if (body.project_docs && body.project_id) {
      const { projectDocSearch } = await import('../lex/project-doc-index.js');
      const docs = await projectDocSearch(store, body.q, {
        project_id: body.project_id,
        limit: typeof body.limit === 'number' ? body.limit : 5,
      });
      docPointers = docs.hits;
    }
    return {
      ok: true,
      scope: body.scope ?? 'all',
      results: page.results,
      groups: page.groups ?? [],
      total: page.total,
      limit: page.limit,
      ...(docPointers !== undefined ? { doc_pointers: docPointers } : {}),
      conflict_check_required: conflictCheckRequired,
      conflict_overlap: conflictCheckRequired
        ? {
            canonical: page.results
              .filter((r) => r.source_class === 'wiki')
              .slice(0, 3)
              .map((r) => ({
                id: r.id,
                title: (r.metadata.title as string) ?? r.id,
                score: r.score,
              })),
            brainstorm_sessions: (page.groups ?? []).slice(0, 3).map((g) => ({
              id: g.session.id,
              label: g.session.user_label ?? g.session.derived_label,
              top_score: g.top_score,
            })),
          }
        : null,
    };
  });

  /* Wave 3 Lane B step 31 (LX-10): bounded brainstorm-chunk search.
   * POST /lex/chunk-search { q, limit?, brainstorm_id? }
   * Returns top-N brainstorm_chunks rows by cosine similarity using
   * the Xenova embedder pipeline. Falls back to FTS when no embeddings
   * are available for a session. Lex uses this to ground answers in
   * prior brainstorm content before resorting to web search. */
  app.post('/lex/chunk-search', async (req, reply) => {
    const body = (req.body ?? {}) as {
      q?: string;
      limit?: number;
      brainstorm_id?: string;
      project_id?: string;
      docs?: boolean;
    };
    if (!body.q || !body.q.trim()) {
      reply.code(400);
      return { ok: false, error: 'q required' };
    }
    const q = body.q.trim();
    const { chunkSearch } = await import('../lex/chunk-retrieval.js');
    const result = await chunkSearch(store, q, {
      limit: typeof body.limit === 'number' ? body.limit : 3,
      brainstorm_id: body.brainstorm_id,
    });
    /* Additive Unified-Knowledge-Index branch: when docs is requested
     * with a project_id, also return strictly project-scoped doc
     * pointers under a separate doc_hits field. The brainstorm-chunk
     * `hits` array (and every other field) is untouched. */
    let docHits: import('../lex/project-doc-index.js').DocPointerHit[] | undefined;
    if (body.docs && body.project_id) {
      const { projectDocSearch } = await import('../lex/project-doc-index.js');
      const docs = await projectDocSearch(store, q, {
        project_id: body.project_id,
        limit: typeof body.limit === 'number' ? body.limit : 5,
      });
      docHits = docs.hits;
    }
    return {
      ok: true,
      ...result,
      ...(docHits !== undefined ? { doc_hits: docHits } : {}),
    };
  });

  /* Knowledge Index piece 2: build/refresh the project-doc index for
   * one project. Accepts an explicit store-set ({store, dir,
   * recursive?}) so the caller owns the disjoint dir layout (the
   * auto-resolver + file-watcher land with a later piece). Embeds the
   * markdown corpus into raw_chunks under PROJECT_DOC_KIND with
   * deterministic ids (re-run = in-place update) and flushes so the
   * vectors survive a restart. */
  /* Store-set auto-resolver (Knowledge Index final piece). When the
   * caller omits stores, resolve them from the project's cwd so Lex
   * and the dashboard never hand-pass absolute dirs. Explicit stores
   * still win (the brainstorm dir, custom layouts). */
  async function resolveStoresOrError(
    projectId: string,
    bodyStores:
      | Array<{ store?: string; dir?: string; recursive?: boolean }>
      | undefined,
  ): Promise<
    | { ok: true; stores: Array<{ store: string; dir: string; recursive?: boolean }> }
    | { ok: false; code: number; error: string }
  > {
    if (Array.isArray(bodyStores) && bodyStores.length > 0) {
      const stores = bodyStores
        .filter(
          (s) => s && typeof s.store === 'string' && typeof s.dir === 'string',
        )
        .map((s) => ({
          store: s.store as string,
          dir: s.dir as string,
          ...(s.recursive ? { recursive: true } : {}),
        }));
      if (stores.length === 0) {
        return { ok: false, code: 400, error: 'stores must each have {store, dir}' };
      }
      return { ok: true, stores };
    }
    const anchor = store.db.getProjectSession(projectId);
    if (!anchor) {
      return {
        ok: false,
        code: 404,
        error: `project_session ${projectId} not found (pass explicit stores for non-anchor projects)`,
      };
    }
    const { resolveProjectDocStores } = await import(
      '../lex/doc-store-resolver.js'
    );
    const stores = resolveProjectDocStores({ cwd: anchor.cwd });
    if (stores.length === 0) {
      return {
        ok: false,
        code: 422,
        error: `no markdown stores found under ${anchor.cwd}`,
      };
    }
    return { ok: true, stores };
  }

  app.post('/lex/index-docs', async (req, reply) => {
    const body = (req.body ?? {}) as {
      project_id?: string;
      stores?: Array<{ store?: string; dir?: string; recursive?: boolean }>;
    };
    if (!body.project_id || !body.project_id.trim()) {
      reply.code(400);
      return { ok: false, error: 'project_id required' };
    }
    const resolved = await resolveStoresOrError(
      body.project_id.trim(),
      body.stores,
    );
    if (!resolved.ok) {
      reply.code(resolved.code);
      return { ok: false, error: resolved.error };
    }
    const stores = resolved.stores;
    const { indexProjectDocs } = await import('../lex/project-doc-index.js');
    const result = await indexProjectDocs(store, {
      project_id: body.project_id.trim(),
      stores,
    });
    await store.rawChunks.flush();
    return { ok: true, ...result };
  });

  /* DRIVE-QUEUE 2A: incremental knowledge-index watcher lifecycle.
   * POST /lex/watch-docs { project_id, action: 'start'|'stop', stores? }
   * start: (re)create an fs.watch-backed watcher that re-indexes a
   * changed / added / deleted markdown file within seconds (debounced),
   * reusing the per-file reindex path so "where is X" stays current
   * without a full manual /lex/index-docs run. Idempotent: starting
   * again replaces the prior watcher for that project. stop: tear it
   * down. stores may be omitted: the store-set auto-resolver derives
   * root/memory/docs/spec/bugs from the project anchor's cwd. */
  const docWatchers = new Map<
    string,
    import('../lex/project-doc-watcher.js').DocWatchCoordinator
  >();
  app.post('/lex/watch-docs', async (req, reply) => {
    const body = (req.body ?? {}) as {
      project_id?: string;
      action?: string;
      stores?: Array<{ store?: string; dir?: string; recursive?: boolean }>;
    };
    const projectId = body.project_id?.trim();
    if (!projectId) {
      reply.code(400);
      return { ok: false, error: 'project_id required' };
    }
    const action = (body.action ?? 'start').toLowerCase();
    if (action === 'stop') {
      const existing = docWatchers.get(projectId);
      if (existing) {
        existing.close();
        docWatchers.delete(projectId);
      }
      return { ok: true, project_id: projectId, watching: false };
    }
    if (action !== 'start') {
      reply.code(400);
      return { ok: false, error: "action must be 'start' or 'stop'" };
    }
    /* Same auto-resolution as /lex/index-docs: omitted stores resolve
     * from the project anchor's cwd. */
    const resolved = await resolveStoresOrError(projectId, body.stores);
    if (!resolved.ok) {
      reply.code(resolved.code);
      return { ok: false, error: resolved.error };
    }
    const stores = resolved.stores;
    /* Idempotent (re)start: replace any prior watcher for this project. */
    const prior = docWatchers.get(projectId);
    if (prior) prior.close();
    const { startProjectDocWatch } = await import(
      '../lex/project-doc-watcher.js'
    );
    const coord = startProjectDocWatch(store, {
      project_id: projectId,
      stores,
    });
    docWatchers.set(projectId, coord);
    return {
      ok: true,
      project_id: projectId,
      watching: true,
      stores: stores.length,
    };
  });

  /* DRIVE-QUEUE 2B: browse the project-doc index for the orb's visual
   * front. GET /lex/doc-index?project_id=... returns the project's
   * indexed files grouped by store, each with its chunk pointers
   * (heading / line / snippet). Strict project scope: another project's
   * chunks are never included. Read-only; no embedding. */
  app.get('/lex/doc-index', async (req, reply) => {
    const projectId = String(
      (req.query as { project_id?: string }).project_id ?? '',
    ).trim();
    if (!projectId) {
      reply.code(400);
      return { ok: false, error: 'project_id required' };
    }
    const { listProjectDocs } = await import('../lex/project-doc-index.js');
    const files = listProjectDocs(store, projectId);
    const totalChunks = files.reduce((n, f) => n + f.chunks.length, 0);
    return {
      ok: true,
      project_id: projectId,
      total_files: files.length,
      total_chunks: totalChunks,
      files,
    };
  });

  /* DRIVE-QUEUE 3: project lifecycle stage. GET resolves a project's
   * effective stage (NULL rows default: live -> execution, else
   * new_project) + the RUNNABLE gate probe for that stage. Cheap fs
   * probes by default; pass run_tests=1 to actually run the suite for
   * the test / bug_handling gate (skipped otherwise so a GET never kicks
   * off a multi-minute build). Resolve by project_session_id or by cwd
   * (an unregistered cwd is treated as a dormant cold start). */
  app.get('/lex/lifecycle', async (req, reply) => {
    const qp = req.query as {
      project_session_id?: string;
      cwd?: string;
      run_tests?: string;
    };
    const lifecycle = await import('../lex/project-lifecycle.js');
    const { gatherGateSignals } = await import(
      '../lex/project-lifecycle-probes.js'
    );
    let row = null as ReturnType<typeof store.db.getProjectSession>;
    if (qp.project_session_id) {
      row = store.db.getProjectSession(qp.project_session_id);
    } else if (qp.cwd) {
      row = store.db.getProjectSessionByCwd(qp.cwd.replace(/\\/g, '/'));
    }
    const cwd = (row?.cwd ?? qp.cwd ?? '').replace(/\\/g, '/');
    if (!row && !cwd) {
      reply.code(400);
      return { ok: false, error: 'project_session_id or cwd required' };
    }
    const stageRow = row ?? { stage: null, status: 'dormant', cwd };
    const stage = lifecycle.effectiveStage(stageRow);
    const signals = cwd
      ? gatherGateSignals(cwd, { runTests: qp.run_tests === '1' })
      : {
          hasIntake: false,
          hasSpecDoc: false,
          hasTests: false,
          hasTestRunner: false,
          suiteGreen: null,
          openBugs: null,
        };
    const gate = lifecycle.gateProbe(stage, signals);
    const next = lifecycle.nextStage(stage);
    return {
      ok: true,
      project_session_id: row?.id ?? null,
      cwd,
      stage,
      stage_label: lifecycle.STAGE_LABEL[stage],
      gate,
      can_advance: gate.satisfied && next !== null,
      next_stage: next,
      next_label: next ? lifecycle.STAGE_LABEL[next] : null,
      needs: lifecycle.gateNeeds(stage),
      signals,
    };
  });

  /* SET a project's stage. POST /lex/lifecycle { project_session_id |
   * cwd, stage, force? }. The state machine validates the transition:
   * setting the current effective stage is idempotent (initializes a
   * NULL row); any other change must be a legal forward / rework
   * transition unless force=true (operator override). Persists via the
   * existing project_session.stage column. */
  app.post('/lex/lifecycle', async (req, reply) => {
    const body = (req.body ?? {}) as {
      project_session_id?: string;
      cwd?: string;
      stage?: string;
      force?: boolean;
    };
    const lifecycle = await import('../lex/project-lifecycle.js');
    if (!lifecycle.isProjectStage(body.stage)) {
      reply.code(400);
      return { ok: false, error: 'valid stage required' };
    }
    const row = body.project_session_id
      ? store.db.getProjectSession(body.project_session_id)
      : body.cwd
        ? store.db.getProjectSessionByCwd(body.cwd.replace(/\\/g, '/'))
        : null;
    if (!row) {
      reply.code(404);
      return {
        ok: false,
        error: 'no project_session for the given id / cwd',
      };
    }
    const from = lifecycle.effectiveStage(row);
    const to = body.stage;
    if (to !== from && !body.force && !lifecycle.canTransition(from, to)) {
      reply.code(409);
      return {
        ok: false,
        error: `illegal transition ${from} -> ${to}`,
        from,
        allowed: lifecycle.STAGE_TRANSITIONS[from],
      };
    }
    store.db.updateProjectSession(row.id, { stage: to });
    return {
      ok: true,
      project_session_id: row.id,
      stage: to,
      stage_label: lifecycle.STAGE_LABEL[to],
      previous: from,
    };
  });

  /* Slice E: Lex supervisor primitives. /lex/steer wraps ptyInject
   * so Lex can direct a worker session by either session_id or
   * pty_id without going through the lower-level /sessions or /pty
   * endpoints. /lex/capture is a one-call mid-conversation capture
   * for reminders / next-actions; if a brainstorm_id is supplied,
   * the new reminder is also linked into that brainstorm row's
   * artifact manifest. /lex/snapshot returns a small env+state
   * envelope so the system prompt can avoid hardcoding GPU/path
   * facts that drift over time. */
  app.post('/lex/steer/:sessionOrPty', async (req, reply) => {
    const target = (req.params as { sessionOrPty: string }).sessionOrPty;
    const body = (req.body ?? {}) as {
      text?: string;
      commit?: boolean;
      /* Worker scope (2026-07-08). Scoped Lex spawns must declare
       * which anchor they speak for; the steer then only reaches
       * that anchor's supervised worker or its own brainstorm. */
      from_anchor_id?: string;
    };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    if (typeof body.from_anchor_id === 'string' && body.from_anchor_id) {
      const { checkLexScope } = await import('../lex/cross-session-inject.js');
      const scope = checkLexScope(store.db, body.from_anchor_id, target);
      if (!scope.allowed) {
        reply.code(403);
        return {
          ok: false,
          decision: 'rejected_scope',
          error: scope.reason ?? 'target outside this brainstorm worker scope',
        };
      }
    }
    const result = ptyInject(
      target,
      body.text,
      body.commit !== false,
    );
    if (!result.ok) {
      reply.code(404);
      return result;
    }
    return { ok: true, target };
  });

  app.post('/lex/capture', async (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: 'reminder' | 'next-action';
      title?: string;
      due_at?: string;
      project_id?: string;
      brainstorm_id?: string;
      tags?: string[];
    };
    if (typeof body.title !== 'string' || !body.title.trim()) {
      reply.code(400);
      return { ok: false, error: 'title required' };
    }
    const tags = ['lex'];
    if (body.kind === 'next-action') tags.push('next-action');
    if (Array.isArray(body.tags)) {
      for (const t of body.tags) {
        if (typeof t === 'string' && t.trim()) tags.push(t.trim());
      }
    }
    const reminder = createReminder({
      title: body.title.trim(),
      ...(body.due_at ? { due_at: body.due_at } : {}),
      ...(body.project_id ? { project_id: body.project_id } : {}),
      tags,
    });
    if (body.brainstorm_id) {
      try {
        appendBrainstormArtifact(body.brainstorm_id, 'reminders', {
          id: reminder.id,
          title: reminder.title,
        });
      } catch {
        /* observability */
      }
    }
    return { ok: true, reminder };
  });

  app.get('/lex/snapshot', async (req, reply) => {
    /* Worker scope (2026-07-08): ?brainstorm_id=<anchor> collapses
     * the envelope to that brainstorm's supervised worker + its own
     * row. Scoped Lex spawns are contractually required to pass it
     * (their text-mode fallback for state questions); the dashboard
     * and daemon-internal consumers keep the global view. */
    const q = (req.query ?? {}) as { brainstorm_id?: string };
    const scopeBrainstormId =
      typeof q.brainstorm_id === 'string' && q.brainstorm_id
        ? q.brainstorm_id
        : null;
    const scopeLex = scopeBrainstormId
      ? store.db.getLexSession(scopeBrainstormId)
      : null;
    const scopeBs = scopeBrainstormId
      ? store.db.getBrainstorm(scopeBrainstormId)
      : null;
    /* Unknown id = hard 404, not a silently empty world; a typoed
     * brainstorm_id otherwise reads as "nothing is running". */
    if (scopeBrainstormId && !scopeLex && !scopeBs) {
      reply.code(404);
      return {
        ok: false,
        error: `brainstorm "${scopeBrainstormId}" not found`,
      };
    }
    const { supervisedAnchorIdFor } = await import(
      '../lex/cross-session-inject.js'
    );
    const scopedSupervisedId = scopeBrainstormId
      ? supervisedAnchorIdFor(store.db, scopeBrainstormId)
      : null;
    const scopedProj = scopedSupervisedId
      ? store.db.getProjectSession(scopedSupervisedId)
      : null;
    const scopedIds = new Set(
      [
        scopedProj?.current_session_id,
        scopedProj?.previous_session_id,
        scopedProj?.current_pty_id,
        scopeLex?.current_pty_id,
        scopeBs?.claude_session_id,
        scopeBs?.pty_id,
      ].filter((x): x is string => Boolean(x)),
    );
    const sessions = scopeBrainstormId
      ? listSessions().filter((s) => s.active && scopedIds.has(s.session_id))
      : listSessions().filter((s) => s.active);
    const brainstorms = scopeBrainstormId
      ? scopeBs && scopeBs.status === 'active'
        ? [scopeBs]
        : []
      : listBrainstorms({ status: 'active', limit: 20 });
    const ptyInfo = scopeBrainstormId
      ? listPtys().filter(
          (p) =>
            scopedIds.has(p.ptyId) ||
            (p.sessionId ? scopedIds.has(p.sessionId) : false),
        )
      : listPtys();
    const env = process.env;
    /* open_projects mirrors the JSON shape of the voice-snapshot text
     * block built in lex/snapshot-context.ts. Sourced from project_session
     * anchors with status='live', which the bridge presence resolver
     * flips on every tick a fresh presence file lands for the anchor's
     * cwd. bridge=ok for the single-window case, bridge=N when more than
     * one VS Code window is reporting presence for the same cwd. */
    const liveAnchors = scopeBrainstormId
      ? scopedProj
        ? [scopedProj]
        : []
      : store.db.listProjectSessions({
          status: 'live',
          limit: 200,
        });
    const openProjects = liveAnchors.map((a) => {
      const decoded = decodeBridgeMarker(a.current_bridge_id);
      return {
        anchor_id: a.id,
        project_slug: a.project_slug,
        cwd: a.cwd,
        cc_session_id: a.current_session_id,
        /* Scoped envelopes include the supervised anchor even when it
         * is dormant (an offline worker must render as offline, not
         * vanish); status makes that honest for every consumer. */
        status: a.status,
        bridge: decoded.count > 1 ? `bridge=${decoded.count}` : 'bridge=ok',
        bridge_connections: decoded.count,
        last_seen_ms: a.last_seen_ms,
      };
    });
    return {
      ok: true,
      now_ms: Date.now(),
      data_root: DATA_ROOT,
      whisper: {
        bin: env.DEVNEURAL_WHISPER_BIN ?? null,
        model: env.DEVNEURAL_WHISPER_MODEL ?? null,
      },
      counts: {
        active_sessions: sessions.length,
        active_brainstorms: brainstorms.length,
        live_ptys: ptyInfo.filter((p) => !p.exited).length,
        open_projects: openProjects.length,
      },
      open_projects: openProjects,
      active_brainstorms: brainstorms.map((b) => {
        /* Phase C: surface the supervised project so Lex's prompt
         * block templates can render the bound target without
         * judgment. Best-effort: stays null when no binding or when
         * the lex_session row hasn't been created yet (legacy
         * brainstorms predating migration 025). */
        const lex = store.db.getLexSession(b.id);
        let supervises:
          | {
              project_anchor_id: string;
              project_slug: string;
              cwd: string;
              cc_session_id: string | null;
              status: 'live' | 'dormant';
            }
          | null = null;
        if (lex?.supervises_project_anchor_id) {
          const proj = store.db.getProjectSession(
            lex.supervises_project_anchor_id,
          );
          if (proj) {
            supervises = {
              project_anchor_id: proj.id,
              project_slug: proj.project_slug,
              cwd: proj.cwd,
              cc_session_id: proj.current_session_id,
              status: proj.status,
            };
          }
        }
        return {
          id: b.id,
          label: b.user_label ?? b.derived_label,
          mode: b.mode,
          started_ms: b.started_ms,
          supervises,
        };
      }),
    };
  });

  // ── Reminders ─────────────────────────────────────────────────────
  app.get('/reminders', async () => ({ ok: true, reminders: listReminders() }));

  app.post('/reminders', async (req, reply) => {
    const body = req.body as {
      title?: string;
      due_at?: string;
      project_id?: string;
      tags?: string[];
    };
    if (!body.title) {
      reply.code(400);
      return { ok: false, error: 'title required' };
    }
    return {
      ok: true,
      reminder: createReminder({
        title: body.title,
        ...(body.due_at ? { due_at: body.due_at } : {}),
        ...(body.project_id ? { project_id: body.project_id } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
      }),
    };
  });

  app.patch('/reminders/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as {
      title?: string;
      due_at?: string;
      project_id?: string;
      tags?: string[];
      complete?: boolean;
    };
    if (body.complete === true) completeReminder(id);
    else if (body.complete === false) uncompleteReminder(id);
    if (Object.keys(body).some((k) => k !== 'complete')) {
      const patch: Record<string, unknown> = {};
      if (body.title) patch.title = body.title;
      if (body.due_at) patch.due_at = body.due_at;
      if (body.project_id) patch.project_id = body.project_id;
      if (body.tags) patch.tags = body.tags;
      if (Object.keys(patch).length > 0) {
        const ok = updateReminder(id, patch as Partial<{ title: string; due_at: string; project_id: string; tags: string[] }>);
        if (!ok) {
          reply.code(404);
          return { ok: false, error: 'not found' };
        }
      }
    }
    return { ok: true };
  });

  app.delete('/reminders/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    deleteReminder(id);
    return { ok: true };
  });

  app.post('/reminders/:id/archive', async (req) => {
    const id = (req.params as { id: string }).id;
    archiveReminder(id);
    return { ok: true };
  });

  // ── Notifications ────────────────────────────────────────────────
  app.get('/notifications', async (req) => {
    const q = req.query as { limit?: string; surface?: string };
    const limit = Number(q.limit ?? '50');
    /* Surface gate. The bell (TopBar dropdown) passes surface=bell
     * to drop notify_class='conversation' rows; the activity rail
     * passes surface=activity (or omits the param) to receive the
     * full stream. */
    const surface =
      q.surface === 'bell' || q.surface === 'activity' ? q.surface : undefined;
    return {
      ok: true,
      notifications: listNotifications({
        limit,
        ...(surface ? { surface } : {}),
      }),
    };
  });

  app.post('/notifications', async (req, reply) => {
    const body = req.body as {
      severity?: 'info' | 'warn' | 'alert';
      source?: string;
      title?: string;
      body?: string;
      link?: string;
      notify_class?: 'conversation' | 'report' | 'followup' | 'signal';
    };
    if (!body.title || !body.severity || !body.source) {
      reply.code(400);
      return { ok: false, error: 'severity, source, title required' };
    }
    /* External callers post here for ad-hoc notifications. Default
     * to 'signal' for HTTP-posted rows because anything coming over
     * the wire is presumed system-class; conversational Lex emits
     * never go through this endpoint. Caller may override with an
     * explicit notify_class. */
    return {
      ok: true,
      notification: emitNotification({
        severity: body.severity,
        source: body.source,
        notify_class: body.notify_class ?? 'signal',
        title: body.title,
        ...(body.body ? { body: body.body } : {}),
        ...(body.link ? { link: body.link } : {}),
      }),
    };
  });

  app.post('/notifications/:id/dismiss', async (req) => {
    const id = (req.params as { id: string }).id;
    /* Optional scope: 'bell' or 'activity'. Omitted = legacy
     * "dismiss everywhere" so older clients keep working. */
    const body = (req.body ?? {}) as { scope?: string };
    const scope =
      body.scope === 'bell' || body.scope === 'activity' ? body.scope : undefined;
    dismissNotification(id, scope);
    return { ok: true };
  });

  // ── Web push (VAPID) ────────────────────────────────────────────
  app.get('/push/vapid-public-key', async () => ({
    ok: true,
    public_key: vapidPublicKey(),
  }));

  app.post('/push/subscribe', async (req, reply) => {
    const body = req.body as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
      user_agent?: string;
    };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      reply.code(400);
      return { ok: false, error: 'endpoint + keys.{p256dh,auth} required' };
    }
    const sub = saveSubscription({
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      ...(body.user_agent ? { user_agent: body.user_agent } : {}),
    });
    return { ok: true, id: sub.id };
  });

  app.delete('/push/subscribe/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    removeSubscription(id);
    return { ok: true };
  });

  app.get('/push/subscriptions', async () => ({
    ok: true,
    subscriptions: listSubscriptions().map((s) => ({
      id: s.id,
      endpoint: s.endpoint,
      created_at: s.created_at,
      user_agent: s.user_agent,
    })),
  }));

  // ── Projects (new) ────────────────────────────────────────────────
  app.post('/projects/new', async (req, reply) => {
    const body = req.body as {
      name?: string;
      stage?: 'alpha' | 'beta' | 'deployed' | 'archived';
      tags?: string[];
      description?: string;
      open_vscode?: boolean;
    };
    if (!body.name) {
      reply.code(400);
      return { ok: false, error: 'name required' };
    }
    const r = await createProject(body as Parameters<typeof createProject>[0]);
    if (!r.ok) {
      reply.code(400);
      return r;
    }
    return r;
  });

  /* Start Claude in an existing registered project.
   *
   * Looks up the project root from the registry, drops a workspace-
   * inject marker, and (best-effort) opens VS Code on that folder so
   * the bridge inside that window picks up the marker and types
   * `claude` into a terminal. The dashboard's Sessions page wires its
   * Start Claude / Start (skip permissions) buttons to this endpoint.
   *
   * Body: { dangerous: boolean }
   *   dangerous=true  -> claude --dangerously-skip-permissions
   *   dangerous=false -> claude
   *
   * Command is NOT user-supplied. The endpoint only chooses between
   * two hard-coded strings. An earlier version accepted body.command
   * which would have given anyone with dashboard auth (or anyone on
   * the Tailscale tailnet who learned the cookie) a clean RCE primitive
   * via terminal sendText into the host's VS Code. Removed. */
  app.post('/projects/:id/start-claude', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      dangerous?: boolean;
      anchor_id?: string;
    };
    const { getProject } = await import('../identity/registry.js');
    const proj = getProject(id);
    if (!proj || !proj.root) {
      reply.code(404);
      return { ok: false, error: `project ${id} not found in registry` };
    }
    /* LEX-AUTONOMY codex 10b (Fix 47): loose-ends gate preflight.
     * When the caller supplies an anchor_id (the supervising Lex
     * brainstorm UUID), enforceLooseEndsGate runs first. Blocked
     * decisions short-circuit with HTTP 409 + the structured report
     * so the dashboard can render the LooseEndsBanner before the
     * worker spawns. Auto-resolving and clear decisions fall
     * through. Missing anchor_id = caller is not Lex-supervised, so
     * we skip the gate entirely and spawn as before. */
    if (typeof body.anchor_id === 'string' && body.anchor_id.trim()) {
      const { preflightLooseEndsForSpawn } = await import(
        '../lex/loose-ends-auto-actions.js'
      );
      const { pickProvider } = await import('../llm/index.js');
      const { createPerSessionDistillationGenerator } = await import(
        '../lex/distillation-generator.js'
      );
      const provider = pickProvider();
      const generatorActive =
        provider && provider.isConfigured() && provider.name !== 'anthropic';
      const perSessionGenerator = generatorActive
        ? createPerSessionDistillationGenerator({ db: store.db, provider })
        : undefined;
      const preflight = await preflightLooseEndsForSpawn(
        store.db,
        body.anchor_id.trim(),
        {
          log: (msg) => log(msg),
          ...(perSessionGenerator ? { perSessionGenerator } : {}),
        },
      );
      if (preflight.blocked && preflight.decision) {
        reply.code(409);
        return {
          ok: false,
          error: 'loose-ends gate blocked spawn',
          loose_ends: preflight.decision.report,
        };
      }
    }
    const command = body.dangerous
      ? 'claude --dangerously-skip-permissions'
      : 'claude';
    const { queueProjectBootstrap } = await import('./projects-new.js');
    const warnings: string[] = [];
    try {
      queueProjectBootstrap(proj.root, command);
    } catch (err) {
      reply.code(500);
      return {
        ok: false,
        error: `failed to queue inject: ${(err as Error).message}`,
      };
    }
    /* Force a new VS Code window with -n. Without this, `code <path>`
     * sent to an already-running VS Code IPCs into the existing
     * instance which often just focuses the most-recently-used window
     * without actually opening the folder, leaving no window with
     * proj.root in workspaceFolders for the bridge to claim the
     * marker. -n unambiguously opens a fresh window with the
     * workspace, and the bridge there activates and runs the command.
     * If the user already has the project open in another window,
     * they'll get a duplicate window — an acceptable trade for
     * "the button always works." shell:true for the .cmd shim. */
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn('code', ['-n', proj.root], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: true,
      });
      child.on('error', (err) => {
        warnings.push(`vs code launch failed: ${err.message}`);
      });
      child.unref();
    } catch (err) {
      warnings.push(`vs code launch failed: ${(err as Error).message}`);
    }
    log(`[dashboard] start-claude queued for project ${proj.name} (${id})`);
    return {
      ok: true,
      project_id: id,
      root: proj.root,
      command,
      warnings: warnings.length ? warnings : undefined,
    };
  });

  /* Lightweight screenshot drop.
   *
   * Receives a single image file (typical use: pasted from clipboard
   * into the SendPromptForm on the dashboard), saves it under
   * DATA_ROOT/uploads/screenshots/<uuid>.<ext>, and returns the
   * absolute Windows path. The dashboard splices that path into the
   * textarea so the bridge sends it to Claude Code as a Read-able file
   * reference. No corpus ingestion, no embedding — this is a side door
   * for "look at this picture" prompts, not a way to seed the wiki. */
  app.post('/uploads/screenshot', async (req, reply) => {
    const isMultipart = req.isMultipart && req.isMultipart();
    if (!isMultipart) {
      reply.code(400);
      return { ok: false, error: 'multipart upload required' };
    }
    let buffer: Buffer | undefined;
    let mimetype: string | undefined;
    let filename: string | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const fp = part as MultipartFile;
          if (!buffer) {
            buffer = await fp.toBuffer();
            mimetype = fp.mimetype;
            filename = fp.filename;
          } else {
            await fp.toBuffer();
          }
        }
      }
    } catch (err) {
      reply.code(400);
      return { ok: false, error: `upload parse failed: ${(err as Error).message}` };
    }
    if (!buffer || buffer.length === 0) {
      reply.code(400);
      return { ok: false, error: 'no image in upload' };
    }
    if (mimetype && !mimetype.startsWith('image/')) {
      reply.code(400);
      return { ok: false, error: `unsupported mime: ${mimetype}` };
    }
    const ext = (() => {
      if (filename) {
        const m = filename.match(/\.([a-zA-Z0-9]{2,5})$/);
        if (m) return m[1]!.toLowerCase();
      }
      if (mimetype === 'image/jpeg') return 'jpg';
      if (mimetype === 'image/gif') return 'gif';
      if (mimetype === 'image/webp') return 'webp';
      return 'png';
    })();
    const { randomUUID } = await import('node:crypto');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.posix.join(DATA_ROOT, 'uploads', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const file = path.posix.join(dir, `${id}.${ext}`);
    fs.writeFileSync(file, buffer);
    // Return a Windows-style absolute path so when the user pastes it
    // into the prompt and the bridge ships it to CC, the Read tool's
    // path resolver doesn't trip over forward slashes on a non-cwd
    // file.
    const winPath = file.replace(/\//g, '\\');
    return { ok: true, path: winPath, bytes: buffer.length };
  });

  // ── Reference upload + corpus management ─────────────────────────
  app.post('/upload', async (req, reply) => {
    const isMultipart = req.isMultipart && req.isMultipart();
    if (!isMultipart) {
      reply.code(400);
      return { ok: false, error: 'multipart upload required' };
    }
    // Single pass: stream the file into a buffer when encountered, capture
    // all field parts. Field order in the multipart is not guaranteed.
    let filename: string | undefined;
    let buffer: Buffer | undefined;
    let projectId = 'global';
    let tags: string[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (filename) {
            // Already have a file; consume and discard extras to drain stream
            await part.toBuffer();
            continue;
          }
          filename = (part as MultipartFile).filename;
          buffer = await (part as MultipartFile).toBuffer();
        } else {
          if (part.fieldname === 'project_id' && typeof part.value === 'string') {
            projectId = part.value;
          }
          if (part.fieldname === 'tags' && typeof part.value === 'string') {
            tags = part.value
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);
          }
        }
      }
    } catch (err) {
      reply.code(400);
      return { ok: false, error: `upload parse failed: ${(err as Error).message}` };
    }
    if (!filename || !buffer) {
      reply.code(400);
      return { ok: false, error: 'no file in upload' };
    }

    const r = await ingestUpload(
      referenceStore,
      { filename, buffer, project_id: projectId, tags },
      log,
    );
    return r;
  });

  app.get('/reference', async (req) => {
    const projectId = (req.query as { project_id?: string }).project_id;
    return {
      ok: true,
      docs: referenceStore.listDocs({
        ...(projectId ? { project_id: projectId } : {}),
      }),
    };
  });

  app.get('/reference/:doc_id', async (req, reply) => {
    const docId = (req.params as { doc_id: string }).doc_id;
    const doc = referenceStore.getDoc(docId);
    if (!doc) {
      reply.code(404);
      return { ok: false, error: 'doc not found' };
    }
    return { ok: true, doc };
  });

  // ── Stats: total lines of code across registered projects ──────
  /* Walks every registered project's root with `git ls-files` and
   * counts lines. Skips lockfiles, vendored bundles, and binary file
   * extensions. Cached in-process for 5 minutes because git ls-files
   * + wc on N projects is several hundred ms; the dashboard ticker
   * polls every 60s and can tolerate a stale value within the cache
   * window. */
  interface LocCacheEntry {
    total: number;
    by_project: { id: string; name: string; lines: number }[];
    computed_at: string;
  }
  let locCache: { value: LocCacheEntry; expires_at: number } | null = null;
  const LOC_CACHE_MS = 5 * 60 * 1000;
  app.get('/stats/loc', async () => {
    if (locCache && Date.now() < locCache.expires_at) {
      return { ok: true, ...locCache.value, cache: 'hit' };
    }
    const { listProjects: lp } = await import('../identity/registry.js');
    const { execSync } = await import('node:child_process');
    const projects = lp();
    const by_project: { id: string; name: string; lines: number }[] = [];
    let total = 0;
    /* Skip files that inflate the count without representing source.
     * Ignored: package-lock, raster images, archives, binaries,
     * vendored ML wasm + onnx bundles. */
    const skip =
      /(?:^|\/)(package-lock\.json|.*\.png|.*\.ico|.*\.svg|.*\.zip|.*\.exe|.*\.dll|.*\.pdb|.*\.bin|.*\.onnx|.*\.wasm)$|public\/vad\//i;
    for (const project of projects) {
      const root = project.root.replace(/\\/g, '/');
      if (!fs.existsSync(root)) continue;
      try {
        /* git ls-files lists tracked files only — the right unit
         * because that's what the developer actually owns. */
        const out = execSync('git ls-files', {
          cwd: root,
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 16 * 1024 * 1024,
        });
        const files = out
          .split(/\r?\n/)
          .filter((f) => f.length > 0 && !skip.test(f));
        let lines = 0;
        for (const rel of files) {
          const p = path.posix.join(root, rel);
          try {
            const buf = fs.readFileSync(p);
            /* Count newlines + 1 for last line if non-empty. Cheap
             * approximation; matches `wc -l` semantics closely. */
            let nl = 0;
            for (let i = 0; i < buf.length; i++) {
              if (buf[i] === 0x0a) nl++;
            }
            lines += nl;
          } catch {
            /* unreadable / deleted between ls-files and read */
          }
        }
        if (lines > 0) {
          by_project.push({ id: project.id, name: project.name, lines });
          total += lines;
        }
      } catch {
        /* not a git repo or git missing; skip silently */
      }
    }
    by_project.sort((a, b) => b.lines - a.lines);
    const value: LocCacheEntry = {
      total,
      by_project,
      computed_at: new Date().toISOString(),
    };
    locCache = { value, expires_at: Date.now() + LOC_CACHE_MS };
    return { ok: true, ...value, cache: 'miss' };
  });

  // ── Stats: omnibus KPI snapshot for the dashboard strip ────────
  /* One round-trip, multiple numbers. Every section is best-effort:
   * any sub-computation that errors returns null instead of throwing
   * so a single missing data source never blacks out the whole strip.
   * Heavy parts (wiki dir scan, git commit walk) are cached for 60s
   * because the strip polls every 30s and can tolerate that latency.
   * Light parts (in-memory store sizes, db queries) are computed
   * fresh on every call. */
  interface KpiCacheEntry {
    wiki: {
      canonical: number;
      pending: number;
      archived: number;
      avg_weight: number | null;
      flagged_for_review: number;
      cross_project: number;
    } | null;
    git: { commits_7d: number } | null;
    artifacts: {
      research_notes: number;
      wiki_drafts: number;
      project_intents: number;
      notes_summaries: number;
      total: number;
    } | null;
    backup: { last_run_at: string | null; days_ago: number | null } | null;
    computed_at: string;
  }
  let kpiHeavyCache: { value: KpiCacheEntry; expires_at: number } | null = null;
  const KPI_HEAVY_CACHE_MS = 60_000;

  function readWikiSnapshot(): KpiCacheEntry['wiki'] {
    try {
      const wp = wikiPagesDir();
      const wpend = wikiPendingDir();
      const warch = wikiArchiveDir();
      const countMd = (dir: string): number => {
        try {
          return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
        } catch {
          return 0;
        }
      };
      const canonical = countMd(wp);
      const pending = countMd(wpend);
      const archived = countMd(warch);
      let totalWeight = 0;
      let weighted = 0;
      let flagged = 0;
      let crossProject = 0;
      const scan = (dir: string) => {
        try {
          for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.md')) continue;
            try {
              const raw = fs.readFileSync(path.posix.join(dir, file), 'utf-8');
              const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
              if (!fmMatch) continue;
              const fm = fmMatch[1] ?? '';
              const wMatch = fm.match(/^weight:\s*([0-9.]+)/m);
              if (wMatch) {
                const w = Number(wMatch[1]);
                if (Number.isFinite(w)) {
                  totalWeight += w;
                  weighted++;
                }
              }
              if (/^flag_for_review:\s*true/m.test(fm)) flagged++;
              const projMatch = fm.match(/^projects:\s*\[([^\]]*)\]/m);
              if (projMatch) {
                const inner = projMatch[1] ?? '';
                const items = inner
                  .split(',')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0);
                if (items.length >= 2) crossProject++;
              }
            } catch {
              /* unreadable page, skip */
            }
          }
        } catch {
          /* dir missing */
        }
      };
      scan(wp);
      scan(wpend);
      return {
        canonical,
        pending,
        archived,
        avg_weight: weighted > 0 ? totalWeight / weighted : null,
        flagged_for_review: flagged,
        cross_project: crossProject,
      };
    } catch {
      return null;
    }
  }

  function readGitCommits7d(): KpiCacheEntry['git'] {
    try {
      const { listProjects: lp } = require('../identity/registry.js') as typeof import('../identity/registry.js');
      const projects = lp();
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      let total = 0;
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      for (const project of projects) {
        const root = project.root.replace(/\\/g, '/');
        if (!fs.existsSync(root)) continue;
        try {
          const out = execSync(`git log --since=${since} --oneline`, {
            cwd: root,
            encoding: 'utf-8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 4 * 1024 * 1024,
          });
          total += out.split(/\r?\n/).filter((l) => l.length > 0).length;
        } catch {
          /* not a git repo or git missing */
        }
      }
      return { commits_7d: total };
    } catch {
      return null;
    }
  }

  function readArtifacts(): KpiCacheEntry['artifacts'] {
    try {
      const root = path.posix.join(
        DATA_ROOT.replace(/\\/g, '/'),
        'lex',
        'artifacts',
      );
      const countDir = (kind: string): number => {
        try {
          return fs
            .readdirSync(path.posix.join(root, kind))
            .filter((f) => f.endsWith('.json')).length;
        } catch {
          return 0;
        }
      };
      const rn = countDir('research-note');
      const wd = countDir('wiki-draft');
      const pi = countDir('project-intent');
      const ns = countDir('notes-summary');
      return {
        research_notes: rn,
        wiki_drafts: wd,
        project_intents: pi,
        notes_summaries: ns,
        total: rn + wd + pi + ns,
      };
    } catch {
      return null;
    }
  }

  function readBackup(): KpiCacheEntry['backup'] {
    try {
      /* Backup task writes a small marker; we look for the most recent
       * snapshot directory under the configured target. The target is
       * recorded by install-backup-task.ps1 in a sibling marker file
       * under DATA_ROOT/backup-target.json. Best-effort. */
      const marker = path.posix.join(
        DATA_ROOT.replace(/\\/g, '/'),
        'backup-target.json',
      );
      let target: string | null = null;
      if (fs.existsSync(marker)) {
        try {
          const j = JSON.parse(fs.readFileSync(marker, 'utf-8')) as {
            BackupRoot?: string;
          };
          target = j.BackupRoot ?? null;
        } catch {
          /* marker malformed */
        }
      }
      if (!target || !fs.existsSync(target)) {
        return { last_run_at: null, days_ago: null };
      }
      const entries = fs
        .readdirSync(target)
        .map((name) => {
          try {
            const stat = fs.statSync(path.posix.join(target as string, name));
            return { name, mtime: stat.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((e): e is { name: string; mtime: number } => e !== null)
        .sort((a, b) => b.mtime - a.mtime);
      if (entries.length === 0) return { last_run_at: null, days_ago: null };
      const newest = entries[0]!;
      const daysAgo = (Date.now() - newest.mtime) / (24 * 60 * 60 * 1000);
      return {
        last_run_at: new Date(newest.mtime).toISOString(),
        days_ago: Math.round(daysAgo * 10) / 10,
      };
    } catch {
      return null;
    }
  }

  function getKpiHeavy(): KpiCacheEntry {
    if (kpiHeavyCache && Date.now() < kpiHeavyCache.expires_at) {
      return kpiHeavyCache.value;
    }
    const value: KpiCacheEntry = {
      wiki: readWikiSnapshot(),
      git: readGitCommits7d(),
      artifacts: readArtifacts(),
      backup: readBackup(),
      computed_at: new Date().toISOString(),
    };
    kpiHeavyCache = { value, expires_at: Date.now() + KPI_HEAVY_CACHE_MS };
    return value;
  }

  app.get('/stats/kpi', async () => {
    const heavy = getKpiHeavy();
    const sessions = listSessions();
    const active = sessions.filter((s) => s.active);
    const byPhase: Record<string, number> = {
      thinking: 0,
      tool: 0,
      permission: 0,
      idle: 0,
      unknown: 0,
    };
    for (const s of active) byPhase[s.phase] = (byPhase[s.phase] ?? 0) + 1;
    /* Brainstorms */
    let brainstorm: {
      total: number;
      active: number;
      by_mode: Record<string, number>;
    } | null = null;
    try {
      const all = store.db.listBrainstorms({ limit: 10_000 });
      const act = all.filter((b) => b.status === 'active');
      const byMode: Record<string, number> = {};
      for (const b of act) byMode[b.mode] = (byMode[b.mode] ?? 0) + 1;
      brainstorm = { total: all.length, active: act.length, by_mode: byMode };
    } catch {
      /* leave null */
    }
    /* Reinforcement signals from the last 7 days */
    let reinforcement: {
      hits_7d: number;
      corrections_7d: number;
      raw_hits_7d: number;
    } | null = null;
    try {
      const file = path.posix.join(
        DATA_ROOT.replace(/\\/g, '/'),
        'reinforcement.log.jsonl',
      );
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        const tailBytes = Math.min(stat.size, 512 * 1024);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(tailBytes);
        try {
          fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
        } finally {
          fs.closeSync(fd);
        }
        const text = buf.toString('utf-8');
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let hits = 0;
        let corrections = 0;
        let rawHits = 0;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed) as {
              kind?: string;
              ts?: string | number;
            };
            const t =
              typeof ev.ts === 'string'
                ? Date.parse(ev.ts)
                : typeof ev.ts === 'number'
                  ? ev.ts
                  : 0;
            if (!t || t < cutoff) continue;
            if (ev.kind === 'hit' || ev.kind === 'promote') hits++;
            else if (ev.kind === 'correction') corrections++;
            else if (ev.kind === 'raw-hit') rawHits++;
          } catch {
            /* skip malformed line */
          }
        }
        reinforcement = {
          hits_7d: hits,
          corrections_7d: corrections,
          raw_hits_7d: rawHits,
        };
      } else {
        reinforcement = { hits_7d: 0, corrections_7d: 0, raw_hits_7d: 0 };
      }
    } catch {
      /* leave null */
    }
    /* LLM token totals + uptime + embedder */
    const provider = providerStatus();
    const embedder = embedderStats();
    return {
      ok: true,
      computed_at: new Date().toISOString(),
      store: {
        raw_chunks: store.rawChunks.size(),
        wiki_vectors: store.wikiPages.size(),
        reference_chunks: referenceStore.chunks.size(),
      },
      sessions: {
        total: sessions.length,
        active: active.length,
        by_phase: byPhase,
      },
      brainstorm,
      wiki: heavy.wiki,
      artifacts: heavy.artifacts,
      reinforcement,
      git: heavy.git,
      backup: heavy.backup,
      llm: provider,
      embedder,
      daemon: {
        uptime_s: Math.round(process.uptime()),
        node_pid: process.pid,
      },
    };
  });

  // ── Phase Two KPI endpoints (CI-6, BF-12, PB-3) ────────────────
  /* /stats/curator-health drives the Curator Health KPI card. Window
   * defaults to 7 days; ?window=N overrides up to 30. Rates are
   * computed client-side from the totals so the card can show
   * sparkline + headline numbers from one fetch. */
  app.get('/stats/curator-health', async (req) => {
    const q = (req.query ?? {}) as { window?: string };
    const windowDays = Math.min(
      Math.max(Number(q.window ?? 7) || 7, 1),
      30,
    );
    const w = store.db.curatorHealthWindow(windowDays);
    /* Build a per-day series of length windowDays so the sparkline
     * has zero-filled gaps where no inject happened. */
    const days: string[] = [];
    const today = new Date();
    for (let i = windowDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const perDayMap = new Map(w.injections_per_day.map((r) => [r.day, r.count]));
    const injections_per_day = days.map((d) => perDayMap.get(d) ?? 0);
    const inject = w.inject_total;
    const rate = (n: number) => (inject > 0 ? n / inject : 0);
    return {
      ok: true,
      window_days: windowDays,
      injections_per_day,
      hit_rate: rate(w.hit_total),
      correction_rate: rate(w.correction_total + w.wrong_total),
      silence_rate:
        inject + w.silence_total > 0
          ? w.silence_total / (inject + w.silence_total)
          : 0,
      click_through_rate: rate(w.click_total),
      canary_status: 'unknown' as const,
      canary_last_run: null as string | null,
      flagged_pages_count: 0,
    };
  });

  /* /stats/brainstorm-kpi drives the BrainstormKpiTiles. Counts come
   * from brainstorm_sessions (not brainstorm_chunks because the
   * intent is sessions-as-records, not chunks-as-records). */
  app.get('/stats/brainstorm-kpi', async () => {
    const counts = (
      store.db as unknown as {
        db: {
          prepare: (s: string) => { get: () => Record<string, number | string | null> };
        };
      }
    ).db
      .prepare(
        `SELECT
           COUNT(*)                                              AS total,
           SUM(CASE WHEN ended_ms IS NOT NULL THEN (ended_ms - started_ms) / 1000.0 ELSE 0 END) / 3600.0
                                                                 AS hours,
           SUM(CASE WHEN project_slug IS NULL THEN 1 ELSE 0 END) AS project_less,
           SUM(CASE WHEN substr(strftime('%Y-%m-%dT%H:%M:%SZ', started_ms / 1000.0, 'unixepoch'), 1, 10)
                       = strftime('%Y-%m-%d', 'now') THEN 1 ELSE 0 END)
                                                                 AS active_today
         FROM brainstorm_sessions
         WHERE COALESCE(kind, 'brainstorm') = 'brainstorm'`,
      )
      .get() as {
      total: number;
      hours: number;
      project_less: number;
      active_today: number;
    };
    const total = Number(counts.total ?? 0);
    return {
      ok: true,
      total_brainstorms: total,
      hours_captured: Number(counts.hours ?? 0),
      artifacts_per_brainstorm_avg: 0,
      wiki_lineage_coverage: 0,
      project_less_ratio:
        total > 0 ? Number(counts.project_less ?? 0) / total : 0,
      active_today: Number(counts.active_today ?? 0),
    };
  });

  /* /stats/outbound drives the OutboundCard. brainstorm_outbound_count
   * is wired to always return 0 (the SQLite trigger guarantees this);
   * the field is in the response shape so the card can render the
   * "0 ever, by design" assertion. */
  app.get('/stats/outbound', async () => {
    const today = store.db.outboundTodayUsage();
    const last7 = (
      store.db as unknown as {
        db: {
          prepare: (s: string) => {
            all: () => Array<{ date: string; calls: number; bytes: number }>;
          };
        };
      }
    ).db
      .prepare(
        `SELECT substr(request_at, 1, 10) AS date,
                COUNT(*) AS calls,
                COALESCE(SUM(payload_bytes), 0) AS bytes
         FROM outbound_log
         WHERE request_at >= datetime('now', '-7 days')
         GROUP BY date
         ORDER BY date`,
      )
      .all();
    const byDest = (
      store.db as unknown as {
        db: {
          prepare: (s: string) => {
            all: () => Array<{ destination: string; n: number }>;
          };
        };
      }
    ).db
      .prepare(
        `SELECT destination, COUNT(*) AS n
         FROM outbound_log
         WHERE substr(request_at, 1, 10) = strftime('%Y-%m-%d', 'now')
         GROUP BY destination`,
      )
      .all();
    const cap = Number(
      process.env.DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS ?? 200,
    );
    return {
      ok: true,
      today: {
        calls_total: today.calls,
        calls_by_destination: Object.fromEntries(
          byDest.map((r) => [r.destination, r.n]),
        ),
        bytes_total: today.bytes,
        cap,
        cap_remaining: Math.max(0, cap - today.calls),
        paused: today.calls >= cap,
      },
      last_7_days: last7,
      brainstorm_outbound_count_alltime: 0,
    };
  });

  // ── Admin: one-time backfill of historical Claude transcripts ───
  /* These endpoints kick off long-running in-process work and return
   * immediately; clients poll /admin/backfill/status for progress. Single
   * -flight per mode; calling start while one is running is a no-op.
   * Host-binding (localhost/Tailscale) is the only trust boundary. */
  app.get('/admin/backfill/status', async () => ({
    ok: true,
    ...getBackfillStatus(),
  }));

  app.post('/admin/backfill/raw', async (req, reply) => {
    const body = (req.body ?? {}) as { reset?: boolean };
    if (body.reset) resetBackfill('raw');
    const before = getBackfillStatus().raw;
    if (before.running) {
      return { ok: true, already_running: true, status: before };
    }
    void runBackfillRaw(store, log).catch((err) =>
      log(`[backfill-raw] uncaught: ${(err as Error).message}`),
    );
    reply.code(202);
    return { ok: true, started: true };
  });

  app.post('/admin/backfill/wiki', async (req, reply) => {
    const body = (req.body ?? {}) as { reset?: boolean };
    if (body.reset) resetBackfill('wiki');
    const before = getBackfillStatus().wiki;
    if (before.running) {
      return { ok: true, already_running: true, status: before };
    }
    void runBackfillWiki(store, log).catch((err) =>
      log(`[backfill-wiki] uncaught: ${(err as Error).message}`),
    );
    reply.code(202);
    return { ok: true, started: true };
  });

  /* One-shot cleanup of existing wiki pages on disk. Re-renders every
   * page through the current schema so historical qwen3 ./.md.md drift
   * gets normalised to ./id.md. Idempotent. Safe to run while a wiki
   * backfill is in flight. */
  app.post('/admin/repair/wiki-cross-refs', async () => {
    const r = repairWikiCrossRefs(log);
    return { ok: true, ...r };
  });

  /* One-click correction from the dashboard. Used when the user spots
   * a curator injection in the live activity rail and decides the
   * page was bad recall. Lowers weight, increments corrections, archives
   * if the page hits the corrections>=3 + weight<floor threshold.
   * Idempotent: safe to call multiple times; each call counts. */
  app.post('/admin/wiki/correct/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { correctWikiPageById } = await import('../reinforcement/index.js');
    const r = await correctWikiPageById(store, id, log);
    if (!r.ok) {
      reply.code(404);
      return r;
    }
    return r;
  });

  /* Manually promote a pending wiki page to canonical. Intended use:
   * seed the curator before any organic reinforcement has fired so the
   * loop has at least one canonical target to inject. Idempotent: if
   * already canonical, returns ok with already_canonical:true. Updates
   * frontmatter, moves the file from pending/ to pages/, and reindexes
   * the vector-store metadata so the curator's status filter matches. */
  app.post('/admin/wiki/promote/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { weight?: number };
    const { loadPage, rewritePageFrontmatter, moveTo, reindexPage } =
      await import('../reinforcement/index.js');
    const { wikiPagesDir } = await import('../paths.js');
    let page = loadPage(id);
    if (!page) {
      reply.code(404);
      return { ok: false, error: `wiki page ${id} not found in pending or pages` };
    }
    const alreadyCanonical = page.frontmatter.status === 'canonical';
    const fm = {
      ...page.frontmatter,
      status: 'canonical' as const,
      weight:
        typeof body.weight === 'number'
          ? body.weight
          : alreadyCanonical
            ? page.frontmatter.weight
            : 0.5,
    };
    // Always rewrite frontmatter so the new weight (or status) reaches
    // disk, even when status was already canonical and only the weight
    // changed.
    rewritePageFrontmatter(page, fm);
    if (!alreadyCanonical) {
      const movedPath = moveTo({ ...page, frontmatter: fm }, wikiPagesDir());
      page = { ...page, filePath: movedPath, frontmatter: fm };
    } else {
      page = { ...page, frontmatter: fm };
    }
    // Always reindex. Even when frontmatter is already canonical the
    // vector-store metadata may still say pending (e.g. an earlier
    // promote ran but the store was killed before flush, so the
    // canonical line was lost on the loader's length-mismatch
    // truncation). Idempotent: same id → in-place update.
    await reindexPage(store, page);
    // Flush so the canonical metadata reaches disk and survives a hard
    // kill. Without this, taskkill /F between promote and the next
    // graceful shutdown silently reverts the store to pending on
    // restart.
    await store.wikiPages.flush();
    log(`[admin] promoted wiki page ${id} to canonical (weight ${fm.weight})`);
    return { ok: true, id, weight: fm.weight, was_already_canonical: alreadyCanonical };
  });

  /* Daemon self-restart. Spawns a detached PowerShell that sleeps ~2s
   * (long enough for our process.exit to release the singleton port and
   * lock files), then runs start-daemon.ps1, which is idempotent and
   * health-probes before respawning. We exit ~250ms after responding so
   * the dashboard sees a clean 200 before the connection drops. The
   * autostart Task Scheduler entry is the safety net if the relauncher
   * itself fails for any reason; it polls every 5min.
   *
   * Script path resolved relative to this compiled module so cwd does
   * not matter. Required because Task Scheduler launches the daemon
   * with cwd at the project root, not 07-daemon/. */
  app.post('/admin/daemon/restart', async (_req, reply) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const startScript = path.resolve(here, '..', '..', 'scripts', 'start-daemon.ps1');
    if (!fs.existsSync(startScript)) {
      reply.code(500);
      return { ok: false, error: `start-daemon.ps1 not found at ${startScript}` };
    }
    /* Direct PowerShell launch: -Command runs an inline script that
     * sleeps then dot-sources start-daemon.ps1. No cmd.exe, no nested
     * quoting, no `timeout` shell builtin. Keeps the spawn argv clean
     * and avoids the "bad argument" error path some shells produce when
     * their builtins see a quoted operand. */
    /* -Force on start-daemon.ps1 bypasses the "already alive" probe so
     * the relauncher cannot self-skip during the old daemon's graceful
     * shutdown window. Without -Force, the probe at t+2s sees the old
     * Fastify still answering /health (chokidar watcher close + app
     * close + store close take 2-6s on Windows) and exits 0 with
     * "already alive; skipping spawn". The sidecar Stop-Process then
     * kills the old daemon at t+6s and nothing is left to bind :3747
     * until the Task Scheduler 5-min autostart tick — average wait
     * ~2.5min, worst ~5min. Task Scheduler itself does NOT pass -Force;
     * its job is to no-op when the daemon is healthy. */
    const inline = `Start-Sleep -Seconds 2; & '${startScript.replace(/'/g, "''")}' -Force`;
    try {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-WindowStyle', 'Hidden',
          '-Command', inline,
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.unref();
    } catch (err) {
      reply.code(500);
      return { ok: false, error: `relauncher spawn failed: ${(err as Error).message}` };
    }
    /* Exit path with EXTERNAL hard-kill watchdog.
     *
     * process.exit(0) alone hangs on Windows when a worker thread
     * (pino transport, @xenova embedder, node-pty) holds a native
     * handle. The C++ exit hook never returns. The process stays
     * alive forever; the dashboard restart loop times out.
     *
     * A naive in-process setTimeout watchdog DOES NOT work — once
     * process.exit is called the event loop is torn down and JS
     * timers never fire. The watchdog must live in another process.
     *
     * So we spawn a detached PowerShell sidecar BEFORE process.exit.
     * The sidecar sleeps 3s then unconditionally taskkill /F's our
     * PID. If we exited cleanly the kill is a no-op (PID is gone or
     * already reused — Stop-Process tolerates either). If we hung,
     * the sidecar drags us down via TerminateProcess.
     *
     * Also: app.close() is awaited so the listen socket is released
     * before exit, and the PID file is unlinked, so the relauncher's
     * health probe at t+2s sees a dead daemon and respawns instead
     * of "already alive". */
    /* Trigger the real graceful shutdown.
     *
     * Root cause of past restart hangs: process.exit(0) on Windows
     * waits for libuv to release every open native handle. chokidar's
     * recursive watch on C:/dev/Projects holds ReadDirectoryChangesW
     * handles that never get cleaned up unless watcher.close() runs
     * first. The daemon's existing `shutdown()` (registered for
     * SIGTERM/SIGINT) awaits watcher.close, app.close, transcripts,
     * gitWatcher, store, then unlinks the PID file, then exits.
     *
     * We surface that via app.decorate('shutdownDaemon', ...) in
     * daemon.ts. If it's missing for any reason (older build, test
     * harness without main()) fall back to process.exit.
     *
     * Belt-and-suspenders: a detached PowerShell sidecar Stop-Process
     * us after 6s. Long enough for shutdown to finish on a healthy
     * system; short enough that a stuck shutdown does not leave the
     * daemon zombie-alive after the relauncher spawns its
     * replacement. */
    try {
      const selfPid = process.pid;
      const killCmd =
        `Start-Sleep -Seconds 6; ` +
        `try { Stop-Process -Id ${selfPid} -Force -ErrorAction SilentlyContinue } catch {}`;
      spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', killCmd],
        { detached: true, stdio: 'ignore', windowsHide: true },
      ).unref();
    } catch {
      /* sidecar is the safety net; if it fails to spawn the
       * graceful path still runs */
    }
    setTimeout(() => {
      log('[admin] daemon restart requested via /admin/daemon/restart; exiting');
      if (hasShutdownHook()) {
        void triggerShutdown('admin-restart');
      } else {
        log('[admin] shutdown hook not registered; falling back to process.exit');
        process.exit(0);
      }
    }, 250);
    return { ok: true, restarting: true };
  });

  app.post('/admin/backfill/:mode/cancel', async (req, reply) => {
    const mode = (req.params as { mode: string }).mode;
    if (mode !== 'raw' && mode !== 'wiki') {
      reply.code(400);
      return { ok: false, error: 'mode must be raw or wiki' };
    }
    requestBackfillCancel(mode);
    return { ok: true };
  });

  /* ── /brainstorms (Wave 2 day 2 step 9 / BF-5 / A1) ───────────────
   * Brainstorm-first dashboard surface. /brainstorms returns the
   * filtered list (project_slug + mode + date filter chips); /brain
   * storms/:id returns the row plus the artifacts manifest plus a
   * cues_url + audio_url when audio was retained. /brainstorms/:id/
   * audio + /brainstorms/:id/cues serve the on-disk bundle written
   * by the session-end pipeline. */
  app.get('/brainstorms', async (req) => {
    const q = (req.query ?? {}) as {
      kind?: string;
      project?: string;
      mode?: string;
      date?: string;
      limit?: string;
      include_empty?: string;
    };
    const kind = q.kind === 'meeting' ? 'meeting' : 'brainstorm';
    const opts: {
      kind: 'brainstorm' | 'meeting';
      project_slug?: string;
      mode?: string;
      date?: string;
      limit?: number;
      includeEmpty?: boolean;
    } = { kind };
    if (q.project) opts.project_slug = q.project;
    if (q.mode) opts.mode = q.mode;
    if (q.date) opts.date = q.date;
    if (q.limit) opts.limit = Math.min(500, Math.max(1, Number(q.limit)));
    /* Default hides zero-substance rows (auto-spawn shells, daemon-
     * restart orphans). Pass ?include_empty=1 to surface them. */
    if (q.include_empty === '1') opts.includeEmpty = true;
    const rows = store.db.listBrainstormsFiltered(opts);
    return {
      ok: true,
      brainstorms: rows.map(decorateBrainstorm),
    };
  });

  app.get('/brainstorms/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.getBrainstorm(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    /* Brainstorm-as-durable-primary-entity (2026-05-22, plan section
     * N). BrainstormDetail surfaces the brainstorm's open
     * expectations so the operator can see what Lex has told the
     * worker to accomplish, the last evaluation's alignment score,
     * and whether drift was detected. Best-effort lookup; legacy
     * daemons without migration 034 return [] silently. */
    let open_expectations: import('../store/index-db.js').WorkerExpectationRow[] = [];
    try {
      open_expectations = store.db.listOpenWorkerExpectations({
        brainstormId: id,
        limit: 50,
      });
    } catch {
      /* observational */
    }
    /* Codex item 6: per-anchor freshness pill. Compose by reading
     * lex_transcript_ref + isRefStale (Fix 42). Best-effort; legacy
     * daemons before migration 041 stay with NULL latest_chunk_ms,
     * so isRefStale returns false uniformly and the pill renders
     * "healthy" - which is the correct fallback. */
    let staleness: {
      fresh: number;
      stale: number;
      total: number;
      oldest_stale_ms: number | null;
    } = { fresh: 0, stale: 0, total: 0, oldest_stale_ms: null };
    try {
      const { isRefStale } = await import('../lex/lex-transcript-ref.js');
      const refs = store.db.listLexTranscriptRefs(id);
      let stale = 0;
      let oldest: number | null = null;
      for (const r of refs) {
        if (!isRefStale(r)) continue;
        stale += 1;
        if (
          r.latest_chunk_ms !== null &&
          (oldest === null || r.latest_chunk_ms < oldest)
        ) {
          oldest = r.latest_chunk_ms;
        }
      }
      staleness = {
        fresh: refs.length - stale,
        stale,
        total: refs.length,
        oldest_stale_ms: oldest,
      };
    } catch {
      /* observational; pill renders zeros */
    }
    return {
      ok: true,
      brainstorm: decorateBrainstorm(row),
      open_expectations,
      staleness,
    };
  });

  /* Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
   *
   * Create a standalone brainstorm: no Lex PTY backing it, no Claude
   * Code session bound. Voice WS connects by brainstorm_id and runs
   * the direct-llm path on every turn. user_label is optional;
   * defaults to null and the dashboard / Stream Deck pickers will
   * fall back to derived_label once Lex has spoken a few turns. */
  app.post('/brainstorms/standalone', async (req, reply) => {
    const body = (req.body ?? {}) as {
      user_label?: string;
      mode?: string;
      cwd?: string;
    };
    const userLabel =
      typeof body.user_label === 'string' && body.user_label.trim()
        ? body.user_label.trim()
        : null;
    const mode =
      body.mode === 'notes' || body.mode === 'push-to-talk'
        ? body.mode
        : 'conversation';
    const cwd =
      typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd : undefined;
    let row;
    try {
      row = createStandaloneBrainstorm({ userLabel, mode, cwd });
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
    return { ok: true, brainstorm: decorateBrainstorm(row) };
  });

  /* Attach a worker CC session UUID to a brainstorm so the worker
   * SessionStart preamble pulls the brainstorm's accumulated context
   * on its next /clear and Lex's cross-session inject targets the
   * right worker without manual ?target_session= plumbing. */
  app.post('/brainstorms/:id/attach-worker', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { cc_session_id?: string };
    const cc = (body.cc_session_id ?? '').trim();
    if (!cc) {
      reply.code(400);
      return { ok: false, error: 'cc_session_id required' };
    }
    const row = attachWorkerSession(id, cc);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'brainstorm not found' };
    }
    return { ok: true, brainstorm: decorateBrainstorm(row) };
  });

  app.post('/brainstorms/:id/detach-worker', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = detachWorkerSession(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'brainstorm not found' };
    }
    return { ok: true, brainstorm: decorateBrainstorm(row) };
  });

  /* Admin redistill (Fix 2026-05-24): re-run the distillation flush
   * (steps 1-7 of the session-end pipeline minus the status flip) on
   * an existing brainstorm row. Used to retro-fill last_summary for
   * sessions that ended before the cc-pty last_summary write landed,
   * per docs/bugs/2026-05-24-cold-start-preload-stale-distillation.md.
   *
   * markEnded=false so an already-ended brainstorm stays ended and a
   * still-live one is not prematurely archived. Best-effort; reports
   * the SessionEndResult so the caller can see drafts_created,
   * summary_written, and skip reasons. */
  app.post('/brainstorms/:id/redistill', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.getBrainstorm(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'brainstorm not found' };
    }
    const { runDistillationFlush } = await import(
      '../lex/session-end-pipeline.js'
    );
    try {
      const result = await runDistillationFlush(
        store,
        {
          brainstormId: id,
          claudeSessionId: row.claude_session_id ?? null,
          mode: row.mode ?? 'conversation',
          reason: 'admin-redistill',
        },
        log,
      );
      const refreshed = store.db.getBrainstorm(id);
      return {
        ok: true,
        result,
        brainstorm: refreshed ? decorateBrainstorm(refreshed) : null,
      };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  /* LEX-AUTONOMY codex 12b: operator-facing PATCH for
   * brainstorm_sessions.project_scope_id. See
   * patchBrainstormProjectScope at the bottom of this module for
   * the full validation + audit contract. The route is a thin
   * wrapper so the pure helper can be unit-tested without a
   * fastify boot. */
  app.patch('/brainstorms/:id/project-scope', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { project_scope_id?: string | null };
    const result = await patchBrainstormProjectScope(store.db, id, body);
    reply.code(result.status);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'patch failed' };
    }
    return {
      ok: true,
      brainstorm_id: result.brainstorm_id,
      project_scope_id: result.project_scope_id ?? null,
      old_scope: result.old_scope ?? null,
    };
  });

  /* Wave 3 fixup (bug: 2026-05-10-brainstorm-picker-and-transcripts).
   * Return the brainstorm_chunks rows for a session so the dashboard can
   * render the text transcript alongside the audio player. limit is
   * capped to 1000 (one chunk per turn; 1000 is well above any real
   * session's turn count). Embedding vectors are not returned; only the
   * text + metadata. */
  app.get('/brainstorms/:id/chunks', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { limit?: string; offset?: string; order?: string };
    const limit = Math.min(1000, Math.max(1, Number(q.limit ?? 200) || 200));
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const order: 'asc' | 'desc' = q.order === 'desc' ? 'desc' : 'asc';
    const row = store.db.getBrainstorm(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    const chunks = store.db.listBrainstormChunks(id, limit, { order, offset });
    return { ok: true, chunks, total: row.turn_count };
  });

  app.get('/brainstorms/:id/cues', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.getBrainstorm(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    const cuesPath = brainstormCuesFile(id);
    if (!fs.existsSync(cuesPath)) {
      reply.code(404);
      return { ok: false, error: 'no cues file for this session' };
    }
    try {
      const raw = fs.readFileSync(cuesPath, 'utf-8');
      reply.header('content-type', 'application/json; charset=utf-8');
      return JSON.parse(raw);
    } catch (err) {
      reply.code(500);
      return { ok: false, error: `cues read failed: ${(err as Error).message}` };
    }
  });

  /* Range-supporting audio endpoint. The browser <audio> element
   * issues `Range: bytes=N-` requests on first play and again on
   * seeks; without a 206 response the seek bar locks up on iOS. We
   * read the file once per request — cheap because OS page cache
   * keeps repeat hits hot — and slice the requested window. */
  app.get('/brainstorms/:id/audio', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.getBrainstorm(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    const wavPath = brainstormAudioFile(id, 'wav');
    if (!fs.existsSync(wavPath)) {
      reply.code(404);
      return { ok: false, error: 'no audio for this session' };
    }
    const stat = fs.statSync(wavPath);
    const total = stat.size;
    const range = req.headers.range;
    reply.header('accept-ranges', 'bytes');
    reply.header('content-type', 'audio/wav');
    reply.header('cache-control', 'no-store');
    if (!range) {
      reply.header('content-length', String(total));
      return reply.send(fs.createReadStream(wavPath));
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      reply.code(416);
      reply.header('content-range', `bytes */${total}`);
      return { ok: false, error: 'invalid range header' };
    }
    const startStr = m[1] ?? '';
    const endStr = m[2] ?? '';
    const start = startStr === '' ? Math.max(0, total - Number(endStr)) : Number(startStr);
    const end = endStr === '' || startStr === '' ? total - 1 : Math.min(Number(endStr), total - 1);
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 ||
      end < start ||
      start >= total
    ) {
      reply.code(416);
      reply.header('content-range', `bytes */${total}`);
      return { ok: false, error: 'unsatisfiable range' };
    }
    reply.code(206);
    reply.header('content-range', `bytes ${start}-${end}/${total}`);
    reply.header('content-length', String(end - start + 1));
    return reply.send(fs.createReadStream(wavPath, { start, end }));
  });

  /* ── /meetings (Wave 2 day 5 step 24a / BF-15 / BF-17 / 5.1) ─────
   * Meeting-kind brainstorm rows surface here; the route family
   * mirrors /brainstorms but adds the consent gate, action items,
   * and the explicit promote-to-wiki path that meetings require
   * (BF-15: no auto-distillation). */
  app.get('/meetings', async (req) => {
    const q = (req.query ?? {}) as {
      project?: string;
      date?: string;
      consent?: string;
      limit?: string;
    };
    const opts: Parameters<typeof store.db.listBrainstormsFiltered>[0] = {
      kind: 'meeting',
    };
    if (q.project) opts.project_slug = q.project;
    if (q.date) opts.date = q.date;
    if (q.limit) opts.limit = Math.min(500, Math.max(1, Number(q.limit)));
    let rows = store.db.listBrainstormsFiltered(opts);
    if (q.consent === 'acked') rows = rows.filter((r) => (r.consent_acked ?? 0) === 1);
    if (q.consent === 'pending') rows = rows.filter((r) => (r.consent_acked ?? 0) === 0);
    return { ok: true, meetings: rows };
  });

  app.get('/meetings/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.getBrainstorm(id);
    if (!row || (row.kind ?? 'brainstorm') !== 'meeting') {
      reply.code(404);
      return { ok: false, error: 'meeting not found' };
    }
    /* Audio purge countdown per BF-17 / spec line 100. Default
     * meeting audio max age is 30 days; the dashboard uses the
     * derived audio_purges_at to render the countdown chip. */
    const maxAgeDays = Number(
      process.env.DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS ?? 30,
    );
    let audio_purges_at: string | null = null;
    if (row.audio_path && (row.keep_audio ?? 0) !== 1 && row.ended_ms) {
      audio_purges_at = new Date(
        row.ended_ms + maxAgeDays * 24 * 60 * 60 * 1000,
      ).toISOString();
    }
    return {
      ok: true,
      meeting: row,
      action_items: store.db.listMeetingActionItems(id),
      audio_purges_at,
    };
  });

  app.post('/meetings/:id/consent-ack', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { acked_by?: string };
    const row = store.db.getBrainstorm(id);
    if (!row || (row.kind ?? 'brainstorm') !== 'meeting') {
      reply.code(404);
      return { ok: false, error: 'meeting not found' };
    }
    store.db.setBrainstormPhaseTwo(id, {
      consent_acked: 1,
      consent_acked_at: new Date().toISOString(),
      consent_acked_by: body.acked_by ?? 'user',
    });
    return { ok: true, meeting: store.db.getBrainstorm(id) };
  });

  app.post('/meetings/:id/keep-audio', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { keep?: boolean };
    const row = store.db.getBrainstorm(id);
    if (!row || (row.kind ?? 'brainstorm') !== 'meeting') {
      reply.code(404);
      return { ok: false, error: 'meeting not found' };
    }
    store.db.setBrainstormPhaseTwo(id, { keep_audio: body.keep === false ? 0 : 1 });
    return { ok: true, meeting: store.db.getBrainstorm(id) };
  });

  app.post('/meetings/:id/action-items', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      text?: string;
      assignee?: string;
      due?: string;
      source_turn_index?: number;
    };
    const row = store.db.getBrainstorm(id);
    if (!row || (row.kind ?? 'brainstorm') !== 'meeting') {
      reply.code(404);
      return { ok: false, error: 'meeting not found' };
    }
    if (!body.text || typeof body.text !== 'string') {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    const aid = `mai-${id}-${Date.now()}`;
    store.db.insertMeetingActionItem({
      id: aid,
      meeting_id: id,
      text: body.text,
      assignee: body.assignee ?? null,
      due: body.due ?? null,
      source_turn_index: typeof body.source_turn_index === 'number' ? body.source_turn_index : null,
    });
    return { ok: true, action_items: store.db.listMeetingActionItems(id) };
  });

  app.patch('/meetings/:id/action-items/:aid', async (req, reply) => {
    const id = (req.params as { id: string; aid: string }).id;
    const aid = (req.params as { id: string; aid: string }).aid;
    const body = (req.body ?? {}) as { status?: 'open' | 'done' | 'dismissed' | 'superseded' };
    if (!body.status || !['open', 'done', 'dismissed', 'superseded'].includes(body.status)) {
      reply.code(400);
      return { ok: false, error: 'status must be open|done|dismissed|superseded' };
    }
    const updated = store.db.updateMeetingActionItemStatus(aid, body.status);
    if (!updated || updated.meeting_id !== id) {
      reply.code(404);
      return { ok: false, error: 'action item not found' };
    }
    return { ok: true, action_item: updated };
  });

  /* Promote a meeting to a wiki page. Meetings never auto-distill
   * (BF-15); the user must explicitly opt in via this endpoint. The
   * actual write borrows the same writeDraftAsPendingWikiPage helper
   * the BF-7 path uses, so the resulting page lands in pending/ and
   * waits for /admin/wiki/promote/:id to canonicalise. */
  app.post('/meetings/:id/promote-to-wiki', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { slug?: string; title?: string };
    const row = store.db.getBrainstorm(id);
    if (!row || (row.kind ?? 'brainstorm') !== 'meeting') {
      reply.code(404);
      return { ok: false, error: 'meeting not found' };
    }
    const slug = body.slug ?? `meeting-${id}`;
    if (!/^[a-z0-9][a-z0-9-]+$/.test(slug)) {
      reply.code(400);
      return { ok: false, error: 'slug must match [a-z0-9][a-z0-9-]+' };
    }
    const today = new Date().toISOString().slice(0, 10);
    const action = store.db.listMeetingActionItems(id);
    const summary = (row.last_summary ?? row.meeting_topic ?? row.user_label ?? id).slice(0, 580);
    const body_markdown =
      `# Meeting summary\n\n${row.last_summary ?? '(no summary captured)'}\n\n` +
      (action.length > 0
        ? `## Action items\n${action.map((a) => `- ${a.text}${a.assignee ? ` (${a.assignee})` : ''}${a.due ? ` due ${a.due}` : ''}`).join('\n')}\n`
        : '');
    try {
      writePage(wikiPendingDir(), {
        frontmatter: {
          id: slug,
          title: body.title ?? `${row.user_label ?? 'Meeting'} → notes`,
          trigger: `from meeting ${id}`,
          insight: row.meeting_topic ?? row.user_label ?? slug,
          summary,
          status: 'pending',
          weight: 0.3,
          hits: 0,
          corrections: 0,
          created: today,
          last_touched: today,
          projects: [],
          human_edited: true,
          human_edited_at: new Date().toISOString(),
          source_meetings: [id],
          derived_from_meeting: true,
        },
        sections: {
          pattern: body_markdown,
          crossRefs: [],
          crossRefsRaw: [],
          evidence: [],
          openQuestions: [],
          log: [`promoted from meeting ${id} on ${today}`],
        },
      });
      return { ok: true, wiki_page_id: slug };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  /* ── /lex/feedback (Wave 2 day 5 step 24 / LX-5 / B5) ────────────
   * Inline thumbs UI writes one row per Lex turn. prompt_version
   * comes from the same versioned-prompt builder so weeks of votes
   * can be aggregated per revision. */
  app.post('/lex/feedback', async (req, reply) => {
    const body = (req.body ?? {}) as {
      turn_id?: string;
      brainstorm_id?: string | null;
      prompt_version?: string;
      vote?: 'up' | 'down';
      reason?: string;
    };
    if (!body.turn_id || !body.prompt_version || (body.vote !== 'up' && body.vote !== 'down')) {
      reply.code(400);
      return { ok: false, error: 'turn_id, prompt_version, vote (up|down) required' };
    }
    const id = `lf-${body.turn_id}-${body.vote}`;
    try {
      store.db.insertLexFeedback({
        id,
        turn_id: body.turn_id,
        brainstorm_id: body.brainstorm_id ?? null,
        prompt_version: body.prompt_version,
        vote: body.vote,
        reason: body.reason ?? null,
      });
    } catch (err) {
      /* Duplicate vote on same turn is a no-op; surface other
       * errors so the caller can retry. */
      if (!/UNIQUE/.test((err as Error).message)) {
        reply.code(500);
        return { ok: false, error: (err as Error).message };
      }
    }
    return { ok: true, id };
  });

  app.get('/lex/feedback', async (req) => {
    const q = (req.query ?? {}) as {
      version?: string;
      brainstorm?: string;
      vote?: string;
      limit?: string;
    };
    const opts: Parameters<typeof store.db.listLexFeedback>[0] = {};
    if (q.version) opts.prompt_version = q.version;
    if (q.brainstorm) opts.brainstorm_id = q.brainstorm;
    if (q.vote === 'up' || q.vote === 'down') opts.vote = q.vote;
    if (q.limit) opts.limit = Math.min(500, Math.max(1, Number(q.limit)));
    return { ok: true, feedback: store.db.listLexFeedback(opts) };
  });

  app.get('/lex/feedback/up-rate/:version', async (req) => {
    const version = (req.params as { version: string }).version;
    return { ok: true, version, ...store.db.lexFeedbackUpRate(version) };
  });

  /* ── /lex/awareness (Wave 2 day 5 step 24b / LX-7 + LX-8) ────────
   * L1 broadcaster + L2 recent_context surface. Producers POST
   * events; consumers (Lex via tool, dashboard for telemetry) GET
   * the recent slice. */
  app.get('/lex/awareness/recent', async (req) => {
    const q = (req.query ?? {}) as { limit?: string; detail?: string };
    const { recentContext } = await import('../lex/awareness.js');
    return {
      ok: true,
      ...recentContext({
        limit: q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 20,
        detail: q.detail === 'true',
      }),
    };
  });

  app.post('/lex/awareness/emit', async (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: string;
      label?: string;
      detail?: Record<string, unknown>;
      brainstorm_id?: string | null;
    };
    const valid = ['audit-finding', 'reminder-due', 'draft-auto-dropped', 'canary-fail', 'session-start', 'session-end', 'capture', 'manual'];
    if (!body.kind || !valid.includes(body.kind) || !body.label) {
      reply.code(400);
      return { ok: false, error: `kind must be one of ${valid.join('|')}; label required` };
    }
    const { emitAwarenessEvent } = await import('../lex/awareness.js');
    const r = emitAwarenessEvent({
      kind: body.kind as 'audit-finding',
      label: body.label,
      ...(body.detail ? { detail: body.detail } : {}),
      brainstorm_id: body.brainstorm_id ?? null,
    });
    return { ok: true, ...r };
  });

  app.post('/lex/awareness/mode', async (req, reply) => {
    const body = (req.body ?? {}) as { mode?: string };
    if (body.mode !== 'conversation' && body.mode !== 'push-to-talk' && body.mode !== 'notes') {
      reply.code(400);
      return { ok: false, error: 'mode must be conversation|push-to-talk|notes' };
    }
    const { setAwarenessMode } = await import('../lex/awareness.js');
    setAwarenessMode(body.mode);
    return { ok: true, mode: body.mode };
  });

  /* ── /lex/retrieval-trace (Wave 3 Lane B step 35 / LX-12b) ────────
   * Lists recent retrieval log rows for dashboard observability.
   * Query params: brainstorm_id (filter to session), kind (grep|chunks|wiki|web), limit. */
  app.get('/lex/retrieval-trace', async (req) => {
    const q = (req.query ?? {}) as {
      brainstorm_id?: string;
      kind?: string;
      limit?: string;
    };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const kind =
      q.kind === 'grep' || q.kind === 'chunks' || q.kind === 'wiki' || q.kind === 'web'
        ? (q.kind as 'grep' | 'chunks' | 'wiki' | 'web')
        : undefined;
    const rows = store.db.listRetrievalLogs({
      brainstorm_id: q.brainstorm_id,
      kind,
      limit,
    });
    return { ok: true, rows, total: rows.length };
  });

  /* ── /lex/prompts (Wave 2 day 5 step 20 / LX-1) ──────────────────
   * Disk archive of every Lex system-prompt revision. The dashboard
   * LexReplayViewer lists versions and reads bodies. */
  app.get('/lex/prompts/versions', async () => {
    const { listPromptVersions } = await import('../lex/prompt-archive.js');
    return { ok: true, versions: listPromptVersions().map((v) => v.version) };
  });

  app.post('/admin/lex-replay', async (req, reply) => {
    const body = (req.body ?? {}) as {
      input_path?: string;
      version_a?: string;
      version_b?: string;
    };
    if (!body.input_path || !body.version_a || !body.version_b) {
      reply.code(400);
      return { ok: false, error: 'input_path, version_a, version_b required' };
    }
    const { runLexReplay } = await import('../lex/replay.js');
    const r = await runLexReplay({
      inputPath: body.input_path,
      versionA: body.version_a,
      versionB: body.version_b,
      log,
    });
    return { ok: true, result: r };
  });

  app.get('/lex/prompts/:version', async (req, reply) => {
    const version = (req.params as { version: string }).version;
    const { readPromptVersion } = await import('../lex/prompt-archive.js');
    const body = readPromptVersion(version);
    if (body === null) {
      reply.code(404);
      return { ok: false, error: 'version not found' };
    }
    reply.header('content-type', 'text/markdown; charset=utf-8');
    return reply.send(body);
  });

  /* ── audit_findings (Wave 2 day 4 steps 15, 16, 17) ─────────────
   * Cross-source surface for lint, the LLM self-audit, the canary,
   * the schema-regression suite, and the user-flag "this looks wrong"
   * button. The dashboard LintFindingsPanel reads from here. */
  app.get('/audit-findings', async (req) => {
    const q = (req.query ?? {}) as {
      status?: string;
      source?: string;
      severity?: string;
      page?: string;
      limit?: string;
    };
    const opts: Parameters<typeof store.db.listAuditFindings>[0] = {};
    if (q.status === 'open' || q.status === 'acknowledged' || q.status === 'resolved' || q.status === 'dismissed') {
      opts.status = q.status;
    } else {
      opts.status = 'open';
    }
    if (q.source === 'lint' || q.source === 'self-audit' || q.source === 'canary' || q.source === 'user-flag' || q.source === 'schema-regression' || q.source === 'janitor') {
      opts.source = q.source;
    }
    if (q.severity === 'low' || q.severity === 'medium' || q.severity === 'high') {
      opts.severity = q.severity;
    }
    if (q.page) opts.page_slug = q.page;
    if (q.limit) opts.limit = Math.min(500, Math.max(1, Number(q.limit)));
    return { ok: true, findings: store.db.listAuditFindings(opts) };
  });

  app.post('/audit-findings/:id/:action', async (req, reply) => {
    const id = (req.params as { id: string; action: string }).id;
    const action = (req.params as { id: string; action: string }).action;
    const status =
      action === 'acknowledge'
        ? 'acknowledged'
        : action === 'resolve'
          ? 'resolved'
          : action === 'dismiss'
            ? 'dismissed'
            : null;
    if (!status) {
      reply.code(400);
      return { ok: false, error: 'action must be acknowledge|resolve|dismiss' };
    }
    const row = store.db.updateAuditFindingStatus(id, status as 'acknowledged' | 'resolved' | 'dismissed');
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'finding not found' };
    }
    return { ok: true, finding: row };
  });

  /* POST /admin/lint/run — manual trigger for the nightly lint pass.
   * Same shape as the scheduled call; useful when the user wants an
   * immediate pass after promoting a batch of drafts. */
  app.post('/admin/lint/run', async () => {
    const { runLint } = await import('../wiki/lint.js');
    const r = await runLint({ db: store.db });
    return { ok: true, result: r };
  });

  /* POST /admin/self-audit/run — Wave 2 day 4 step 16 manual
   * trigger for the LLM self-audit. Picks N random canonical pages,
   * asks "are these accurate, useful, well-scoped?" and writes
   * findings with source='self-audit'. */
  app.post('/admin/self-audit/run', async (req) => {
    const body = (req.body ?? {}) as { sample?: number };
    const { runSelfAudit } = await import('../wiki/self-audit.js');
    const r = await runSelfAudit(store, { sample: body.sample, log });
    return { ok: true, result: r };
  });

  /* POST /admin/janitor/run (Wave 3 Lane B step 37 / LX-14). Manual
   * trigger for the memory janitor. Scans brainstorm_chunks for merge
   * candidates and contradictions; writes findings to audit_findings
   * with source='janitor'. */
  app.post('/admin/janitor/run', async () => {
    const { runMemoryJanitor } = await import('../lex/memory-janitor.js');
    const r = await runMemoryJanitor(store, log);
    return { ok: true, result: r };
  });

  /* ── Cross-session prompt injection (Wave 3 Lane B step 38 / LX-15) ──
   *
   * POST /lex/inject-cross-session
   *   Body: { target_session, token, text, caller_label?, commit? }
   *   token = HMAC-SHA256(auth_secret, `${target_session}:${unix_minute}`)
   *
   * POST /auth/cross-session-token
   *   Body: { target_session }
   *   Requires valid dn_session cookie. Returns a short-lived token.
   *
   * GET /lex/injection-log
   *   Query: target_session?, decision?, limit?
   *   Returns audit records from cross_session_injection_log.
   */
  app.post('/lex/inject-cross-session', async (req, reply) => {
    const body = (req.body ?? {}) as {
      target_session?: string;
      token?: string;
      text?: string;
      caller_label?: string;
      caller_brainstorm_id?: string;
      commit?: boolean;
      /* Fix 15 C2 — explicit signing-subject override. When the
       * caller signed its HMAC against an anchor id (recommended
       * for supervisory paths) instead of the session uuid, it must
       * tell the daemon which anchor so verification picks the
       * right subject. Omitted = auto: the daemon also tries the
       * resolved anchor id when it knows one. */
      signed_anchor_id?: string;
      /* Worker scope (2026-07-08). The Lex anchor the caller speaks
       * for. Scoped Lex spawns are contractually required to send
       * this on every inject; the daemon then only dispatches to
       * that anchor's supervised worker or its own brainstorm. */
      from_anchor_id?: string;
    };
    /* Phase C fallback: when Lex omits target_session and identifies
     * itself with caller_brainstorm_id, resolve the bound project
     * anchor's current_session_id. Explicit target_session always
     * wins. A bound-but-dormant project surfaces as 422 with a
     * structured reason so Lex can queue and tell the user "parked,
     * worker closed" rather than silently drop the inject. */
    let targetSession = body.target_session;
    if (
      (!targetSession || typeof targetSession !== 'string') &&
      typeof body.caller_brainstorm_id === 'string' &&
      body.caller_brainstorm_id
    ) {
      const resolved = resolveSupervisedTargetSession(
        store.db,
        body.caller_brainstorm_id,
      );
      if (resolved.reason === 'bound-live' && resolved.target_session) {
        targetSession = resolved.target_session;
      } else if (resolved.reason === 'bound-project-dormant') {
        reply.code(422);
        return {
          ok: false,
          error: 'bound project worker is closed; queue for next live session',
          reason: resolved.reason,
          project_anchor_id: resolved.project_anchor_id,
        };
      } else if (resolved.reason === 'bound-project-missing') {
        reply.code(422);
        return {
          ok: false,
          error: 'bound project anchor was deleted; rebind the brainstorm',
          reason: resolved.reason,
          project_anchor_id: resolved.project_anchor_id,
        };
      }
      /* 'unbound' / 'no-such-brainstorm' fall through to the
       * target_session-required 400 below so the legacy path
       * (explicit target_session, no binding configured) stays
       * intact. */
    }
    if (!targetSession || typeof targetSession !== 'string') {
      reply.code(400);
      return {
        ok: false,
        error:
          'target_session required (or caller_brainstorm_id pointing at a bound + live project anchor)',
      };
    }
    if (!body.token || typeof body.token !== 'string') {
      reply.code(400);
      return { ok: false, error: 'token required' };
    }
    if (!body.text || typeof body.text !== 'string') {
      reply.code(400);
      return { ok: false, error: 'text required' };
    }
    if (body.text.length > 4096) {
      reply.code(400);
      return { ok: false, error: 'text too long (max 4096 chars)' };
    }
    /* Fix 15 — anchor-resolved dispatch.
     *
     * target_session is treated as a hint, not absolute. If the uuid
     * is still the live current_session_id for its owning anchor (or
     * the caller addressed a session with no known anchor), the
     * dispatch path is unchanged. If the uuid is stale and the
     * anchor is live under a different uuid, redirect and log. If
     * the anchor is dormant, return 422 with a structured reason
     * the caller can park on. */
    const { randomUUID } = await import('node:crypto');
    const { resolveAnchorDispatch } = await import('../lex/cross-session-resolve.js');
    const signedSession = targetSession;
    let dispatchSession = targetSession;
    let resolvedAnchorId: string | undefined;
    const outcome = resolveAnchorDispatch(store.db, targetSession);
    if (outcome.kind === 'dormant') {
      try {
        store.db.insertCrossSessionLog({
          id: randomUUID(),
          target_session: targetSession,
          caller_label: body.caller_label ?? null,
          text_preview: body.text.slice(0, 120),
          text_length: body.text.length,
          decision: 'dispatched_dead_session',
          reject_reason: JSON.stringify({
            anchor_id: outcome.anchor_id,
            reason: 'bound-anchor-dormant',
          }),
          brainstorm_id: null,
          /* Fix 15 C3 — persist the full text so smart-compact's
           * resume hook can replay this inject when the anchor
           * comes back live. Only stamped on this decision branch;
           * other audit rows leave payload_text NULL to keep
           * audit-log storage bounded. */
          payload_text: body.text,
        });
      } catch {
        /* never let audit failures block the response */
      }
      reply.code(422);
      return {
        ok: false,
        error:
          'anchor owning target_session is dormant; queue for next live session',
        reason: 'bound-anchor-dormant',
        anchor_id: outcome.anchor_id,
      };
    }
    if (outcome.kind === 'redirect') {
      try {
        store.db.insertCrossSessionLog({
          id: randomUUID(),
          target_session: targetSession,
          caller_label: body.caller_label ?? null,
          text_preview: body.text.slice(0, 120),
          text_length: body.text.length,
          decision: 'redirected',
          reject_reason: JSON.stringify({
            old_session: outcome.old_session,
            new_session: outcome.dispatch_session,
            anchor_id: outcome.anchor_id,
          }),
          brainstorm_id: null,
        });
      } catch {
        /* never let audit failures block the response */
      }
      dispatchSession = outcome.dispatch_session;
      resolvedAnchorId = outcome.anchor_id;
    } else if (outcome.kind === 'live-direct') {
      resolvedAnchorId = outcome.anchor_id;
    }
    const { crossSessionInject } = await import('../lex/cross-session-inject.js');
    /* Fix 15 C2 — anchor_id-signed HMAC alternate. When the request
     * resolved to a known anchor, accept tokens signed against
     * either the session uuid (legacy) or the anchor id (stable
     * across /clear). Callers should prefer the anchor form for
     * supervisory injects: session uuids flip; anchor ids do not.
     * If the caller explicitly passes signed_anchor_id, honour
     * exactly that subject. */
    const explicitSignedAnchor =
      typeof body.signed_anchor_id === 'string' && body.signed_anchor_id
        ? body.signed_anchor_id
        : undefined;
    /* Worker scope (2026-07-08): a caller that declares which Lex
     * anchor it speaks for (from_anchor_id, or the Phase C
     * caller_brainstorm_id identity) is scope-checked against that
     * anchor's supervised worker. Daemon-internal supervisors that
     * pass neither keep the legacy behavior. */
    const fromLexAnchorId =
      (typeof body.from_anchor_id === 'string' && body.from_anchor_id) ||
      (typeof body.caller_brainstorm_id === 'string' &&
        body.caller_brainstorm_id) ||
      undefined;
    const result = crossSessionInject(
      {
        target_session: dispatchSession,
        token: body.token,
        text: body.text,
        caller_label: body.caller_label,
        commit: body.commit !== false,
        signed_session: signedSession,
        signed_anchor_id: explicitSignedAnchor ?? resolvedAnchorId,
        anchor_id: resolvedAnchorId,
        from_lex_anchor_id: fromLexAnchorId,
      },
      store.db,
    );
    if (resolvedAnchorId) {
      result.anchor_id = resolvedAnchorId;
    }
    if (dispatchSession !== signedSession) {
      result.dispatched_to = dispatchSession;
    }
    if (!result.ok) {
      const code =
        result.decision === 'rejected_auth'
          ? 401
          : result.decision === 'rejected_allowlist' ||
              result.decision === 'rejected_scope'
            ? 403
            : 422;
      reply.code(code);
    }
    return result;
  });

  app.post('/auth/cross-session-token', async (req, reply) => {
    /* Fix 15 C2 — supports two subject modes:
     *
     *   { target_session }   — legacy, signs against the session uuid
     *   { anchor_id }        — preferred for supervisory callers; the
     *                           signature stays valid across /clear-
     *                           driven uuid flips because anchor ids
     *                           are durable
     *
     * Exactly one must be provided; anchor_id wins if both are
     * present. */
    const body = (req.body ?? {}) as {
      target_session?: string;
      anchor_id?: string;
    };
    const anchorSubject =
      typeof body.anchor_id === 'string' && body.anchor_id
        ? body.anchor_id
        : null;
    const sessionSubject =
      typeof body.target_session === 'string' && body.target_session
        ? body.target_session
        : null;
    if (!anchorSubject && !sessionSubject) {
      reply.code(400);
      return { ok: false, error: 'target_session or anchor_id required' };
    }
    const subject = anchorSubject ?? sessionSubject!;
    const { issueToken } = await import('../lex/cross-session-inject.js');
    return {
      ok: true,
      token: issueToken(subject),
      target_session: sessionSubject ?? undefined,
      anchor_id: anchorSubject ?? undefined,
      subject_kind: anchorSubject ? ('anchor' as const) : ('session' as const),
      valid_for_s: 120,
    };
  });

  /* POST /worker/clear-handoff
   *
   * Called by Claude Code's SessionStart hook for project-anchor
   * worker sessions (parallel to /lex/cold-start-preload for Lex
   * brainstorms). Returns a structured handoff doc covering: where
   * the prior session left off (branch / last commit / in-flight
   * files), the active task and its acceptance criteria, the next
   * 2-3 queued backlog items, and any open blockers. The hook prints
   * the block to stdout so CC injects it as additionalContext on the
   * first turn.
   *
   * Empty block + reason='not-a-project-anchor' for cwds that aren't
   * bound to a project_session row. The hook treats empty as no-op.
   *
   * Body: { session_id: string; cwd: string }
   */
  app.post('/worker/clear-handoff', async (req, reply) => {
    const body = (req.body ?? {}) as { session_id?: string; cwd?: string };
    if (!body.cwd || typeof body.cwd !== 'string') {
      reply.code(400);
      return { ok: false, error: 'cwd required' };
    }
    const { buildWorkerHandoff } = await import('../lex/worker-handoff.js');
    const result = buildWorkerHandoff({
      cwd: body.cwd,
      db: store.db,
      workerSessionId: typeof body.session_id === 'string' ? body.session_id : undefined,
    });
    /* Codex item 8 (Fix 45 follow-up): attach source_graph_block when
     * the runtime flag enables it. 'both' (default) returns both the
     * legacy sections + the new block; 'source-graph' returns the new
     * block in the primary slot so the hook prints it; 'legacy' keeps
     * the existing behavior unchanged.
     *
     * Resolve the anchor id from the worker's cwd. Only renders when
     * the cwd belongs to a known project anchor AND a brainstorm row
     * has claimed this worker via attached_worker_session_id; otherwise
     * source_graph_block stays null and the response is byte-identical
     * to the legacy shape. */
    const mode = workerBootSourceGraphMode(store.db);
    let source_graph_block: string | null = null;
    const bodyTyped = body as unknown as {
      mode?: 'smart-clear' | 'first-attach';
      next_action?: string;
    };
    if (
      mode !== 'legacy' &&
      result.ok &&
      result.reason === 'rendered' &&
      typeof body.session_id === 'string' &&
      body.session_id.trim()
    ) {
      try {
        const bs = store.db.getBrainstormByAttachedWorker(body.session_id);
        if (bs) {
          const {
            buildSourceGraphPayload,
            isFirstAttach,
            deriveFirstAttachNextAction,
          } = await import('../lex/source-graph-payload.js');
          const { renderWorkerBoot } = await import(
            '../lex/worker-boot-render.js'
          );
          const now = Date.now();
          /* Codex 9 auto-toggle: detect first-attach from the anchor's
           * own ref + chunk state. Caller can override via explicit
           * body.mode for test harnesses. */
          const detected = isFirstAttach(store.db, bs.id, bs.id);
          const renderMode =
            bodyTyped.mode === 'first-attach' || bodyTyped.mode === 'smart-clear'
              ? bodyTyped.mode
              : detected
                ? 'first-attach'
                : 'smart-clear';
          const payload = buildSourceGraphPayload({
            db: store.db,
            anchorId: bs.id,
            currentCcSessionId: body.session_id,
            refLimit: 3,
            pairsPerRef: 3,
            now: () => now,
            firstAttach: renderMode === 'first-attach',
          });
          let nextAction = bodyTyped.next_action;
          if (renderMode === 'first-attach' && (!nextAction || !nextAction.trim())) {
            nextAction = deriveFirstAttachNextAction(store.db, bs.id, bs.id);
          }
          source_graph_block = renderWorkerBoot(payload, {
            mode: renderMode,
            now,
            ...(nextAction ? { nextAction } : {}),
          });
        }
      } catch {
        /* best-effort; legacy block still ships */
      }
    }
    if (mode === 'source-graph' && source_graph_block) {
      return { ...result, block: source_graph_block, source_graph_block };
    }
    return { ...result, source_graph_block };
  });

  /* POST /lex/cold-start-preload
   *
   * Called by Claude Code's SessionStart hook the moment a fresh Lex
   * brainstorm session boots. Resolves the new brainstorm row by its
   * just-bound CC session id, looks up sibling brainstorms that share
   * the same user_label, and returns a tiny markdown block listing
   * each sibling's last_summary distillation. The hook prints the
   * block to stdout so CC injects it as additionalContext on the
   * first turn, letting Lex reference prior decisions without
   * firing a Read.
   *
   * Side-effect-free apart from one audit row written via
   * insertCrossSessionLog with caller_label='cold-start-preload'.
   * Returns { ok: true, block: '', reason } when there is nothing
   * to preload so the hook can no-op cleanly.
   *
   * Body: { session_id: string; cwd?: string }
   */
  app.post('/lex/cold-start-preload', async (req, reply) => {
    const body = (req.body ?? {}) as { session_id?: string; cwd?: string };
    if (!body.session_id || typeof body.session_id !== 'string') {
      reply.code(400);
      return { ok: false, error: 'session_id required' };
    }
    const sessionId = body.session_id;
    /* Every exit from this route writes an audit row so operators
     * can tell "hook never fired" apart from "hook fired and bailed
     * at brainstorm-resolve". Pre-fix: only the successful render
     * path wrote a row; the no-brainstorm / no-label / no-siblings
     * / disabled paths were silent. Operators saw zero rows and
     * incorrectly assumed the hook was not wired. */
    const { randomUUID } = await import('node:crypto');
    function auditEarlyOut(
      reject_reason: string,
      brainstormId: string | null,
    ): void {
      try {
        store.db.insertCrossSessionLog({
          id: randomUUID(),
          target_session: sessionId,
          caller_label: 'cold-start-preload',
          text_preview: '',
          text_length: 0,
          decision: 'shadow',
          reject_reason,
          brainstorm_id: brainstormId,
        });
      } catch {
        /* observational; never block the preload response */
      }
    }
    /* Three-state runtime mode: off / shadow / live. Off short-
     * circuits before any work. Shadow + live still compute the
     * block so the operator can audit what would have shipped; the
     * difference is whether the block is returned to the caller and
     * whether the audit row is decision='shadow' or 'accepted'. */
    const mode = coldStartPreloadMode(store.db);
    if (mode === 'off') {
      auditEarlyOut('disabled', null);
      return { ok: true, block: '', reason: 'disabled', mode };
    }
    const { getBrainstormByClaudeSessionId } = await import(
      '../lex/brainstorm-store.js'
    );
    const { buildSiblingIndex } = await import('../lex/sibling-index.js');
    const bs = getBrainstormByClaudeSessionId(sessionId);
    if (!bs) {
      auditEarlyOut('no-brainstorm-bound', null);
      return {
        ok: true,
        block: '',
        reason: 'no-brainstorm-bound',
        mode,
      };
    }
    const label = bs.user_label ?? bs.derived_label ?? null;
    if (!label) {
      auditEarlyOut('no-label', bs.id);
      return {
        ok: true,
        block: '',
        reason: 'no-label',
        brainstorm_id: bs.id,
        mode,
      };
    }
    /* Force-distill the top-N siblings synchronously before
     * buildSiblingIndex reads them. Closes the race where the
     * steady-state cron has not yet caught up to a just-ended
     * sibling; preloadColdStartSiblings invokes the LLM generator
     * for any missing last_summary row + returns the metadata the
     * three visibility layers consume. Generator wiring is null
     * when no LLM provider is configured (or the env points at
     * anthropic, which BF-4 blocks for brainstorm content) - in
     * that case the preloader skips the force pass and the
     * sibling-index falls back to whatever last_summary rows the
     * cron has already produced. */
    let preloadSummary:
      | Awaited<
          ReturnType<
            typeof import('../lex/lex-cold-start-preamble.js').preloadColdStartSiblings
          >
        >
      | null = null;
    let preamble = '';
    try {
      const { preloadColdStartSiblings, formatColdStartPreamble, buildPreloadEventLogRow, recordPreloadEvent } =
        await import('../lex/lex-cold-start-preamble.js');
      const { pickProvider } = await import('../llm/index.js');
      const { createLlmDistillationGenerator, createPerSessionDistillationGenerator } = await import(
        '../lex/distillation-generator.js'
      );
      const provider = pickProvider();
      const generatorActive =
        provider && provider.isConfigured() && provider.name !== 'anthropic';
      const generator = generatorActive
        ? createLlmDistillationGenerator({ db: store.db, provider })
        : null;
      /* Codex item 5: per-session generator wired alongside the
       * anchor-flat one so stale-ref catchup can run inside the
       * preload window. Same provider-gate (provider configured +
       * not anthropic per BF-4) so the catchup either runs or the
       * [stale] tag survives unchanged. */
      const perSessionGenerator = generatorActive
        ? createPerSessionDistillationGenerator({ db: store.db, provider })
        : null;
      preloadSummary = await preloadColdStartSiblings({
        db: store.db,
        generator,
        label,
        excludeId: bs.id,
        forceForTopN: 2,
        anchorId: bs.id,
        currentCcSessionId: sessionId,
        perSessionGenerator,
      });
      preamble = formatColdStartPreamble(preloadSummary);
      /* DRIVE-QUEUE 3: stage-aware greeting. When this brainstorm anchor
       * supervises a project, append the project's current lifecycle
       * stage + what the gate needs next so Lex states it on its first
       * reply. Additive + observational: a missing anchor / project / any
       * throw leaves the preamble exactly as the distillation built it. */
      try {
        /* cwd is the documented unique join key between a brainstorm
         * anchor and its project_session row. */
        const ps = bs.cwd ? store.db.getProjectSessionByCwd(bs.cwd) : null;
        if (ps) {
          const { lifecycleGreetingLine } = await import(
            '../lex/project-lifecycle.js'
          );
          preamble = `${preamble}\n${lifecycleGreetingLine(ps)}`;
        }
      } catch {
        /* observational; never block the cold-start path */
      }
      recordPreloadEvent(
        buildPreloadEventLogRow({
          brainstormId: bs.id,
          ccSessionId: sessionId,
          summary: preloadSummary,
          preamble,
        }),
      );
    } catch (err) {
      /* Force-distill failure cannot block the cold-start path.
       * Fall through to the existing buildSiblingIndex behaviour
       * and surface the failure reason in the preamble so the
       * brainstorm header pill can render red. */
      preamble = `Cold start: preload failed (${(err as Error).message}).`;
    }
    let block = buildSiblingIndex({
      db: store.db,
      label,
      anchorId: bs.id,
      currentCcSessionId: sessionId,
      excludeId: bs.id,
      limit: 5,
      distillationWords: 20,
      /* Scope isolation (2026-06-19): the cold-start preload is anchored
       * (anchorId = bs.id always set here), so fail closed. If this
       * anchor has no prior refs we surface nothing rather than dropping
       * to the label-match fallback, which could pull a same-named
       * brainstorm from a different project. An LPCC Lex session must
       * never inherit DevNeural context. */
      strictScope: true,
      /* Codex item 12a (Fix 49): mirror the scope-wins-over-label
       * predicate that preloadSiblingDistillations already uses.
       * When the active brainstorm carries a non-null scope, the
       * label-match block groups by scope; falls back to label
       * when scope is null (legacy compat). */
      projectScopeId: bs.project_scope_id ?? null,
    });
    /* Cold-start investigator (2026-06-19): if the spawn path pre-warmed
     * a scope-isolated primed-context block for this anchor, prepend it
     * to the sibling-index block. One-shot read (takeInvestigatorBlock
     * deletes on read) so a stale block is never served twice; a 10-min
     * freshness window covers the spawn->SessionStart latency. Fail-safe:
     * a cache miss leaves `block` exactly as buildSiblingIndex produced
     * it, so this cannot regress the existing cold-start path. When the
     * sibling index was empty but the investigator assembled real
     * context (project docs + live tail), this is also what lets the
     * route serve a primed block instead of early-outing 'no-siblings'. */
    try {
      const { takeInvestigatorBlock } = await import(
        '../lex/lex-investigator.js'
      );
      let primed = takeInvestigatorBlock(bs.id, 10 * 60 * 1000, Date.now());
      if (!primed || !primed.trim()) {
        /* Sliver 3: in-memory cache miss (typically a daemon restart
         * lost the pre-warm). Fall back to the newest persisted cold-
         * start report on disk - the durable seed. Additive: before
         * this, a miss served nothing for the investigator block. */
        try {
          const { readLatestColdStartReport } = await import(
            '../lex/cold-start-report.js'
          );
          const report = readLatestColdStartReport(store.db, bs.id);
          if (report && report.block.trim()) primed = report.block;
        } catch {
          /* disk fallback is additive; never block cold start */
        }
      }
      if (primed && primed.trim()) {
        block = block ? `${primed}\n\n${block}` : primed;
      }
    } catch {
      /* investigator serve is additive; never block cold start */
    }
    if (!block) {
      auditEarlyOut('no-siblings', bs.id);
      return {
        ok: true,
        block: '',
        reason: 'no-siblings',
        brainstorm_id: bs.id,
        label,
        mode,
      };
    }
    /* Audit row: decision tracks the mode so reviewers can filter
     * /lex/injection-log for 'shadow' to see what the feature WOULD
     * have done versus 'accepted' for real fires. caller_label
     * remains 'cold-start-preload' in both states.
     *
     * Codex item 5: when stale_refs_count > 0, pack
     * {stale_refs_count, synced_refs_count, partial_sync} into the
     * reject_reason field as JSON so the dashboard audit panel can
     * grep it and the operator can correlate a "stale_refs=N" pill
     * back to the audit row. Empty when no staleness was detected so
     * the happy-path row stays compact. */
    try {
      let syncMeta: string | undefined;
      if (
        preloadSummary &&
        (preloadSummary.stale_refs_count > 0 ||
          preloadSummary.synced_refs_count > 0 ||
          preloadSummary.partial_sync)
      ) {
        syncMeta = JSON.stringify({
          stale_refs_count: preloadSummary.stale_refs_count,
          synced_refs_count: preloadSummary.synced_refs_count,
          partial_sync: preloadSummary.partial_sync,
        });
      }
      store.db.insertCrossSessionLog({
        id: randomUUID(),
        target_session: sessionId,
        caller_label: 'cold-start-preload',
        text_preview: block.slice(0, 240),
        text_length: block.length,
        decision: mode === 'live' ? 'accepted' : 'shadow',
        brainstorm_id: bs.id,
        ...(syncMeta ? { reject_reason: syncMeta } : {}),
      });
    } catch {
      /* audit row is observational; never block the preload response */
    }
    const siblingCount = (block.match(/^- /gm) ?? []).length;
    /* preamble + header_status surface the three visibility layers:
     *   - preamble: one-liner the SessionStart hook prepends to the
     *     injected block so Lex prints it verbatim on her first
     *     reply ("Loaded 4 sibling sessions, last distilled ...").
     *   - header_status: tone + text the brainstorm UI renders as a
     *     small pill in the session header row (green when healthy,
     *     red on preload failure).
     *   - preload_summary: the raw counts so the dashboard panel +
     *     anyone who wants to drive their own UI off these fields
     *     can read them without re-deriving from the preamble. */
    const { formatHeaderStatus } = await import(
      '../lex/lex-cold-start-preamble.js'
    );
    const headerStatus = preloadSummary
      ? formatHeaderStatus(preloadSummary)
      : { tone: 'err' as const, text: 'context: preload failed' };
    if (mode === 'shadow') {
      return {
        ok: true,
        block: '',
        reason: 'shadow',
        preview_len: block.length,
        sibling_count: siblingCount,
        brainstorm_id: bs.id,
        label,
        mode,
        preamble,
        header_status: headerStatus,
        preload_summary: preloadSummary,
      };
    }
    return {
      ok: true,
      block: preamble ? `${preamble}\n\n${block}` : block,
      reason: 'live',
      sibling_count: siblingCount,
      brainstorm_id: bs.id,
      label,
      mode,
      preamble,
      header_status: headerStatus,
      preload_summary: preloadSummary,
    };
  });

  /* GET + POST /lex/cold-start-preload/toggle
   *
   * Dashboard /system surface for the runtime kill-switch backing
   * /lex/cold-start-preload. Reads + writes runtime_config so the
   * flip takes effect immediately without a daemon restart.
   *
   * GET response shape:
   *   { ok, enabled, runtime_value, env_value, env_default_off }
   *
   * POST body: { enabled: boolean, updated_by?: string }
   *   Persists 'on' / 'off' into runtime_config; returns the same
   *   shape as GET so the dashboard can reconcile optimistically. */
  app.get('/lex/cold-start-preload/toggle', async () => {
    const runtimeValue = store.db.getRuntimeConfig(
      COLD_START_PRELOAD_CONFIG_KEY,
    );
    const envValue =
      process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED ?? null;
    return {
      ok: true,
      mode: coldStartPreloadMode(store.db),
      runtime_value: runtimeValue,
      env_value: envValue,
      default_mode: 'shadow',
    };
  });

  app.post('/lex/cold-start-preload/toggle', async (req, reply) => {
    const body = (req.body ?? {}) as {
      mode?: string;
      updated_by?: string;
    };
    const next = parseColdStartPreloadValue(body.mode);
    if (!next) {
      reply.code(400);
      return {
        ok: false,
        error: "mode must be 'off' | 'shadow' | 'live'",
      };
    }
    store.db.setRuntimeConfig(
      COLD_START_PRELOAD_CONFIG_KEY,
      next,
      body.updated_by,
    );
    return {
      ok: true,
      mode: coldStartPreloadMode(store.db),
      runtime_value: store.db.getRuntimeConfig(COLD_START_PRELOAD_CONFIG_KEY),
      env_value:
        process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED ?? null,
      default_mode: 'shadow',
    };
  });

  /* GET /lex/cold-start-preload/events
   *
   * Multi-session preload event log. Returns one card per brainstorm
   * (latest cc_session_id, most-recent N rows under that brainstorm)
   * so the LexColdStartPreloadPanel can show what context primed
   * each concurrently running session without mashing the feeds
   * together. recordPreloadEvent appends to the in-memory log; the
   * route exposes it for the dashboard. */
  app.get('/lex/cold-start-preload/events', async (req) => {
    const { groupPreloadEventsBySession, listPreloadEvents } = await import(
      '../lex/lex-cold-start-preamble.js'
    );
    const q = (req.query ?? {}) as {
      brainstorm_id?: string;
      limit?: string;
    };
    if (q.brainstorm_id) {
      const limit = q.limit ? Number(q.limit) : 50;
      return {
        ok: true,
        rows: listPreloadEvents({
          brainstormId: q.brainstorm_id,
          limit,
        }),
      };
    }
    const perSessionLimit = q.limit ? Number(q.limit) : 20;
    return {
      ok: true,
      groups: groupPreloadEventsBySession({ perSessionLimit }),
    };
  });

  /* Codex item 6 (Fix 43): distillation error log surface.
   *
   * Returns recent rows from distillation_error_log so the dashboard
   * (codex 7 will wire the panel) + the stale-watcher can correlate
   * "ref_summary still NULL" with the structured error class. Pure
   * read; observational. Returns rows: [] when migration 042 has not
   * applied yet. */
  /* LEX-AUTONOMY codex 11c (Fix 48 partial closure step 3): grooming
   * watch observable surface.
   *
   * GET /lex/grooming/recent?limit=20 returns the most recent grooming
   * events from the notifications log filtered by
   * source='grooming-watch'. Sorted ts DESC by listNotifications. Limit
   * defaults to 20, capped at 200. Push integration already flows
   * through emitNotification (codex 11a): alert rows already pass
   * push='force' from grooming-watch's emit hook, so the dashboard
   * does not need to re-derive push policy here. */
  app.get('/lex/grooming/recent', async (req) => {
    const q = (req.query ?? {}) as { limit?: string };
    const limit = q.limit
      ? Math.min(200, Math.max(1, Number(q.limit) || 20))
      : 20;
    const rows = recentGroomingNotifications(limit);
    return { ok: true, rows };
  });

  app.get('/lex/distillation-errors', async (req) => {
    const q = (req.query ?? {}) as {
      brainstorm_id?: string;
      limit?: string;
    };
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 20;
    const rows = store.db.listRecentDistillationErrors(limit, {
      brainstormId: q.brainstorm_id ?? null,
    });
    return { ok: true, rows };
  });

  /* Codex item 7 (Fix 44): pin / unpin a lex_transcript_ref row.
   *
   * POST /lex/refs/:cc_session_id/pin   body: { pinned: boolean }
   *
   * The adaptive walk-back scorer treats pinned=1 as a pre-pass
   * bonus that forces inclusion ahead of recency + freshness ranking.
   * Audit row lands in cross_session_injection_log with
   * caller_label='ref-pin' so the dashboard injection panel can
   * show pin / unpin history without a new table. */
  app.post('/lex/refs/:cc_session_id/pin', async (req, reply) => {
    const cc = (req.params as { cc_session_id: string }).cc_session_id;
    if (!cc || typeof cc !== 'string') {
      reply.code(400);
      return { ok: false, error: 'cc_session_id required' };
    }
    const body = (req.body ?? {}) as { pinned?: boolean };
    if (typeof body.pinned !== 'boolean') {
      reply.code(400);
      return { ok: false, error: 'pinned (boolean) required' };
    }
    const changed = store.db.setLexTranscriptRefPinned(cc, body.pinned);
    if (!changed) {
      reply.code(404);
      return { ok: false, error: 'ref not found for cc_session_id' };
    }
    try {
      const { randomUUID } = await import('node:crypto');
      store.db.insertCrossSessionLog({
        id: randomUUID(),
        target_session: cc,
        caller_label: 'ref-pin',
        text_preview: body.pinned ? 'pin' : 'unpin',
        text_length: body.pinned ? 3 : 5,
        decision: 'accepted',
      });
    } catch {
      /* audit row is observational; never block the response */
    }
    return { ok: true, cc_session_id: cc, pinned: body.pinned };
  });

  /* Lex standalone idle activity (Phase 5 of LSS).
   *
   * Surface for the "Standalone brainstorm idle activity" dashboard
   * panel. Walks every brainstorm row whose lifecycle_state is
   * 'idle' or 'attached', returns silence + pending grooming pass +
   * last grooming kind/time so the panel can render one card per
   * row. Pure read; no side effects. */
  app.get('/lex/idle-activity', async () => {
    const { listIdleActivity } = await import('../lex/idle-watcher.js');
    return {
      ok: true,
      rows: listIdleActivity(store.db),
      generated_at: new Date().toISOString(),
    };
  });

  /* Auto-advance supervisor toggle (autonomous supervisor phase 4).
   *
   * Three-state runtime kill-switch backing the auto-advance loop.
   * Reads + writes runtime_config so the flip takes effect on the
   * next tick without a daemon restart. Mirrors the shape of
   * /lex/smart-compact/toggle so the dashboard panel can be a
   * near-clone of SmartCompactPanel.
   *
   * GET response: { ok, mode, runtime_value, env_value, default_mode } */
  app.get('/lex/auto-advance/toggle', async () => {
    const { AUTO_ADVANCE_CONFIG_KEY, getAutoAdvanceMode } = await import(
      '../lex/auto-advance-supervisor.js'
    );
    const runtimeValue = store.db.getRuntimeConfig(AUTO_ADVANCE_CONFIG_KEY);
    const envValue = process.env.DEVNEURAL_AUTO_ADVANCE_MODE ?? null;
    return {
      ok: true,
      mode: getAutoAdvanceMode(store.db),
      runtime_value: runtimeValue,
      env_value: envValue,
      default_mode: 'off',
    };
  });

  app.post('/lex/auto-advance/toggle', async (req, reply) => {
    const { AUTO_ADVANCE_CONFIG_KEY, getAutoAdvanceMode, parseAutoAdvanceMode } =
      await import('../lex/auto-advance-supervisor.js');
    const body = (req.body ?? {}) as {
      mode?: string;
      updated_by?: string;
    };
    const next = parseAutoAdvanceMode(body.mode);
    if (!next) {
      reply.code(400);
      return {
        ok: false,
        error: "mode must be 'off' | 'shadow' | 'live'",
      };
    }
    store.db.setRuntimeConfig(
      AUTO_ADVANCE_CONFIG_KEY,
      next,
      body.updated_by,
    );
    log(
      `[auto-advance] mode -> ${next} by=${body.updated_by ?? 'unknown'}`,
    );
    return {
      ok: true,
      mode: getAutoAdvanceMode(store.db),
      runtime_value: store.db.getRuntimeConfig(AUTO_ADVANCE_CONFIG_KEY),
      env_value: process.env.DEVNEURAL_AUTO_ADVANCE_MODE ?? null,
      default_mode: 'off',
    };
  });

  /* Recent auto-advance log rows for post-mortem review. Mirrors
   * /lex/smart-compact/recent so the dashboard panel can paginate
   * a tidy table of every decision the loop has made. */
  app.get('/lex/auto-advance/recent', async (req) => {
    const q = (req.query ?? {}) as {
      anchor_id?: string;
      mode?: string;
      decision?: string;
      limit?: string;
    };
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 50;
    return {
      ok: true,
      rows: store.db.listAutoAdvanceLog({
        anchor_id: q.anchor_id,
        mode: q.mode as 'off' | 'shadow' | 'live' | undefined,
        decision: q.decision as
          | 'shadow'
          | 'would-inject'
          | 'accepted'
          | 'skip'
          | 'error'
          | undefined,
        limit,
      }),
    };
  });

  /* Lex backlog REST surface (autonomous supervisor phase 2).
   *
   * Migration 026 created lex_backlog_items; backlog-store.ts owns
   * the typed CRUD. Three endpoints expose the canonical queue
   * over HTTP so the dashboard panel + future supervisor logic
   * both go through the atomic claim primitive instead of the
   * legacy c:/tmp file-CAS.
   *
   *   GET   /lex/backlog                list (optional ?status=)
   *   POST  /lex/backlog                add a new item
   *   PATCH /lex/backlog/:id            claim | release | done
   */
  app.get('/lex/backlog', async (req) => {
    const { listBacklog } = await import('../lex/backlog-store.js');
    const q = (req.query ?? {}) as { status?: string; limit?: string };
    const status = q.status as
      | 'queued'
      | 'in-flight'
      | 'done'
      | 'parked'
      | undefined;
    const limit = q.limit ? Number(q.limit) : undefined;
    const items = listBacklog({ status, limit });
    return { ok: true, items };
  });

  app.post('/lex/backlog', async (req, reply) => {
    const { addBacklogItem } = await import('../lex/backlog-store.js');
    const body = (req.body ?? {}) as {
      id?: string;
      title?: string;
      priority?: string;
      notes?: string;
      status?: 'queued' | 'parked';
    };
    if (!body.title || typeof body.title !== 'string') {
      reply.code(400);
      return { ok: false, error: 'title required' };
    }
    if (
      body.status !== undefined &&
      body.status !== 'queued' &&
      body.status !== 'parked'
    ) {
      reply.code(400);
      return {
        ok: false,
        error: 'status must be queued or parked on add',
      };
    }
    try {
      const row = addBacklogItem({
        id: body.id,
        title: body.title,
        priority: body.priority,
        notes: body.notes ?? null,
        status: body.status ?? 'queued',
      });
      return { ok: true, item: row };
    } catch (err) {
      reply.code(409);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      action?: 'claim' | 'release' | 'done';
      claimed_by?: string;
      claimed_turn_uuid?: string | null;
      anchor_id?: string | null;
      target_status?: 'queued' | 'parked';
      commit_shas?: string[];
      notes?: string | null;
    };
  }>('/lex/backlog/:id', async (req, reply) => {
    const {
      claimBacklogItem,
      releaseBacklogItem,
      markBacklogDone,
    } = await import('../lex/backlog-store.js');
    const id = req.params.id;
    const body = req.body ?? {};
    if (!id) {
      reply.code(400);
      return { ok: false, error: 'id required' };
    }
    switch (body.action) {
      case 'claim': {
        if (!body.claimed_by) {
          reply.code(400);
          return { ok: false, error: 'claimed_by required for claim' };
        }
        const r = claimBacklogItem({
          id,
          claimed_by: body.claimed_by,
          claimed_turn_uuid: body.claimed_turn_uuid ?? null,
          anchor_id: body.anchor_id ?? null,
        });
        if (!r.ok) reply.code(409);
        return r;
      }
      case 'release': {
        if (!body.claimed_by) {
          reply.code(400);
          return { ok: false, error: 'claimed_by required for release' };
        }
        const r = releaseBacklogItem({
          id,
          claimed_by: body.claimed_by,
          target_status: body.target_status ?? 'queued',
        });
        if (!r.ok) reply.code(409);
        return r;
      }
      case 'done': {
        const r = markBacklogDone({
          id,
          claimed_by: body.claimed_by ?? null,
          commit_shas: body.commit_shas ?? null,
          notes: body.notes ?? null,
        });
        if (!r.ok) reply.code(409);
        return r;
      }
      default:
        reply.code(400);
        return {
          ok: false,
          error: 'action must be claim | release | done',
        };
    }
  });

  app.get('/lex/injection-log', async (req) => {
    const q = (req.query ?? {}) as {
      target_session?: string;
      decision?: string;
      caller_label?: string;
      limit?: string;
    };
    const opts: Parameters<typeof store.db.listCrossSessionLogs>[0] = {};
    if (q.target_session) opts.target_session = q.target_session;
    if (q.decision) {
      opts.decision = q.decision as
        | 'accepted'
        | 'rejected_auth'
        | 'rejected_allowlist'
        | 'rejected_pty'
        | 'shadow';
    }
    if (q.caller_label) opts.caller_label = q.caller_label;
    if (q.limit) opts.limit = Number(q.limit);
    return { ok: true, logs: store.db.listCrossSessionLogs(opts) };
  });

  /* POST /curator/wrong (Wave 2 day 4 step 17 / CI-5 / A9). The
   * dashboard "this looks wrong" button posts here. Does the same
   * weight drop + archive-on-3 work as /admin/wiki/correct/:id, plus
   * opens a self-audit user-flag finding so the LLM self-audit pass
   * sees the page next time. */
  app.post('/curator/wrong', async (req, reply) => {
    const body = (req.body ?? {}) as { page_id?: string; curator_log_id?: string; note?: string };
    if (!body.page_id) {
      reply.code(400);
      return { ok: false, error: 'page_id required' };
    }
    const { correctWikiPageById } = await import('../reinforcement/index.js');
    const r = await correctWikiPageById(store, body.page_id, log);
    if (!r.ok) {
      reply.code(404);
      return r;
    }
    try {
      store.db.insertAuditFinding({
        id: `userflag-${body.page_id}-${Date.now()}`,
        source: 'user-flag',
        severity: 'medium',
        page_slug: body.page_id,
        finding: 'user flagged injection as wrong',
        detail: body.note ?? (body.curator_log_id ? `curator_log_id=${body.curator_log_id}` : null),
      });
    } catch (err) {
      log(`[curator/wrong] audit_finding insert failed: ${(err as Error).message}`);
    }
    return r;
  });

  /* ── runtime_config (Wave 2 day 4 step 19 / A15) ─────────────────
   * Pause-mode toggle lives in runtime_config.pause_mode; the
   * decayInactivePages gate consults this first, then env, then
   * default. The dashboard /system route reads / writes here. */
  app.get('/runtime-config', async () => ({
    ok: true,
    config: store.db.listRuntimeConfig(),
  }));

  app.post('/runtime-config/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const body = (req.body ?? {}) as { value?: string; updated_by?: string };
    if (typeof body.value !== 'string') {
      reply.code(400);
      return { ok: false, error: 'value (string) required' };
    }
    /* Validate pause_mode values explicitly so a typo does not
     * silently disable the gate (any unknown string falls through
     * to "default"). */
    if (key === 'pause_mode' && !['on', 'off', 'auto'].includes(body.value)) {
      reply.code(400);
      return { ok: false, error: 'pause_mode must be on|off|auto' };
    }
    store.db.setRuntimeConfig(key, body.value, body.updated_by);
    return { ok: true, key, value: body.value };
  });

  /* ── /brainstorms/backfill-review (Wave 2 day 3 step 13 / BF-13) ─
   * Surfaces borderline-band candidates produced by
   * `npm run backfill-brainstorms`. The user one-clicks link / reject;
   * link writes source_brainstorms onto the page, reject just flips
   * the row to status='rejected'. */
  app.get('/brainstorms/backfill-review', async (req) => {
    const q = (req.query ?? {}) as { status?: string; band?: string; limit?: string };
    const validStatus = ['pending', 'linked', 'rejected', 'skipped'].includes(q.status ?? '')
      ? (q.status as 'pending' | 'linked' | 'rejected' | 'skipped')
      : 'pending';
    const validBand = ['high', 'borderline', 'low'].includes(q.band ?? '')
      ? (q.band as 'high' | 'borderline' | 'low')
      : undefined;
    const opts: { status?: 'pending' | 'linked' | 'rejected' | 'skipped'; band?: 'high' | 'borderline' | 'low'; limit?: number } = { status: validStatus };
    if (validBand) opts.band = validBand;
    if (q.limit) opts.limit = Math.min(500, Math.max(1, Number(q.limit)));
    return { ok: true, candidates: store.db.listBackfillReview(opts) };
  });

  app.post('/brainstorms/backfill-review/:id/link', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.listBackfillReview({}).find((r) => r.id === id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'review row not found' };
    }
    if (row.status !== 'pending') {
      reply.code(409);
      return { ok: false, conflict: 'already_resolved', row };
    }
    const { loadPage, rewritePageFrontmatter } = await import('../reinforcement/index.js');
    const page = loadPage(row.candidate_page_slug);
    if (!page) {
      reply.code(404);
      return {
        ok: false,
        error: `wiki page ${row.candidate_page_slug} no longer exists`,
      };
    }
    const existing = page.frontmatter.source_brainstorms ?? [];
    if (!existing.includes(row.brainstorm_id)) {
      rewritePageFrontmatter(page, {
        ...page.frontmatter,
        source_brainstorms: [...existing, row.brainstorm_id],
      });
    }
    const merged = store.db.updateBackfillReview(id, { status: 'linked', resolved_by: 'user' });
    return { ok: true, row: merged };
  });

  app.post('/brainstorms/backfill-review/:id/reject', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.listBackfillReview({}).find((r) => r.id === id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'review row not found' };
    }
    if (row.status !== 'pending') {
      reply.code(409);
      return { ok: false, conflict: 'already_resolved', row };
    }
    const merged = store.db.updateBackfillReview(id, { status: 'rejected', resolved_by: 'user' });
    return { ok: true, row: merged };
  });

  /* Trigger the backfill from the dashboard. Long-running; returns
   * 202 + the result payload after the job finishes. Single-flight at
   * the daemon level via the same in-process lock the GPU queue would
   * use; here we accept simple sequential runs because the script is
   * a one-shot. */
  app.post('/admin/backfill/brainstorms', async (req, reply) => {
    void req;
    try {
      const { runBackfillBrainstorms } = await import('../wiki/backfill-brainstorms.js');
      const result = await runBackfillBrainstorms(store, log);
      reply.code(202);
      return { ok: true, result };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  /* ── /drafts (Wave 2 day 2 step 10 / BF-7 review / A2) ────────────
   * List + detail + edit + promote + discard for wiki_drafts rows
   * produced by the session-end auto-distillation pipeline. The
   * promote handler enforces the four conflict cases per the spec:
   * slug_collision, frozen_target, superseded, target_drift. */
  app.get('/drafts', async (req) => {
    const q = (req.query ?? {}) as { status?: string; limit?: string };
    const status = isDraftStatus(q.status) ? q.status : 'pending';
    const limit = q.limit ? Math.min(500, Math.max(1, Number(q.limit))) : 100;
    const rows = store.db.listWikiDrafts({ status, limit });
    return { ok: true, drafts: rows };
  });

  app.get('/drafts/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = store.db.getWikiDraft(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    return { ok: true, draft: row };
  });

  app.patch('/drafts/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      page_slug?: string;
      page_title?: string;
      body_markdown?: string;
    };
    const existing = store.db.getWikiDraft(id);
    if (!existing) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    if (existing.status !== 'pending') {
      reply.code(409);
      return {
        ok: false,
        conflict: 'already_resolved',
        error: `draft status ${existing.status} no longer editable`,
        draft: existing,
      };
    }
    if (body.page_slug && !/^[a-z0-9][a-z0-9-]+$/.test(body.page_slug)) {
      reply.code(400);
      return {
        ok: false,
        error: `page_slug must match [a-z0-9][a-z0-9-]+: got ${body.page_slug}`,
      };
    }
    const merged = store.db.updateWikiDraft(id, {
      ...(body.page_slug ? { page_slug: body.page_slug } : {}),
      ...(body.page_title ? { page_title: body.page_title } : {}),
      ...(body.body_markdown !== undefined
        ? { body_markdown: body.body_markdown }
        : {}),
    });
    return { ok: true, draft: merged };
  });

  app.post('/drafts/:id/discard', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = store.db.getWikiDraft(id);
    if (!existing) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    if (existing.status !== 'pending') {
      reply.code(409);
      return {
        ok: false,
        conflict: 'already_resolved',
        draft: existing,
      };
    }
    const merged = store.db.updateWikiDraft(id, {
      status: 'discarded',
      resolved_by: 'user',
    });
    return { ok: true, draft: merged };
  });

  app.post('/drafts/:id/promote', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      resolution?: 'rename' | 'merge' | 'overwrite';
      new_slug?: string;
      force?: boolean;
      expected_resolved_at?: string | null;
    };
    const draft = store.db.getWikiDraft(id);
    if (!draft) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    if (draft.status !== 'pending') {
      reply.code(409);
      return {
        ok: false,
        conflict: 'already_resolved',
        error: `draft status ${draft.status}`,
        draft,
      };
    }
    /* Conflict 1: target-drift. The dashboard sends the resolved_at
     * snapshot it observed when it loaded the draft; if that no
     * longer matches the row, another tab edited the draft and the
     * user is acting on stale content. resolved_at is null on every
     * pending draft, so any non-null mismatch from the client also
     * trips this case (defensive: protects against partial updates
     * that landed without status flipping). */
    if (
      body.expected_resolved_at !== undefined &&
      body.expected_resolved_at !== draft.resolved_at
    ) {
      reply.code(409);
      return {
        ok: false,
        conflict: 'target_drift',
        error: 'draft was edited by another caller; refresh and retry',
        draft,
      };
    }
    const slug = body.new_slug ?? draft.page_slug;
    if (!/^[a-z0-9][a-z0-9-]+$/.test(slug)) {
      reply.code(400);
      return {
        ok: false,
        error: `slug must match [a-z0-9][a-z0-9-]+: got ${slug}`,
      };
    }
    /* Conflict 2: superseded race. Some other draft for the same
     * page_slug already promoted while this one was sitting in
     * pending. Mark this draft superseded so the user sees the new
     * status in the list and stop here. */
    const sibling = store.db
      .wikiDraftsBySlug(slug, ['promoted', 'auto-promoted'])
      .find((d) => d.id !== id);
    if (sibling) {
      const merged = store.db.updateWikiDraft(id, {
        status: 'superseded',
        resolved_by: 'system:promote-race',
      });
      reply.code(409);
      return {
        ok: false,
        conflict: 'superseded',
        error: `another draft for slug ${slug} already promoted`,
        draft: merged,
        promoted_id: sibling.id,
      };
    }
    /* Conflict 3 + 4: frozen target + slug collision. Look for an
     * existing wiki page on disk under the slug. The promoted draft
     * writes a NEW pending wiki page; canonicalisation is a separate
     * step via /admin/wiki/promote/:id. */
    const { loadPage } = await import('../reinforcement/index.js');
    const existingPage = loadPage(slug);
    if (existingPage) {
      if (existingPage.frontmatter.frozen === true && body.force !== true) {
        reply.code(409);
        return {
          ok: false,
          conflict: 'frozen_target',
          error: `target page ${slug} is frozen; pass force:true to override`,
          draft,
          existing_page_id: existingPage.frontmatter.id,
        };
      }
      if (!body.resolution) {
        reply.code(409);
        return {
          ok: false,
          conflict: 'slug_collision',
          error: `wiki page ${slug} already exists; supply resolution:rename|merge|overwrite`,
          draft,
          existing_page_id: existingPage.frontmatter.id,
          existing_status: existingPage.frontmatter.status,
        };
      }
      if (body.resolution === 'rename') {
        if (!body.new_slug || body.new_slug === draft.page_slug) {
          reply.code(400);
          return {
            ok: false,
            conflict: 'slug_collision',
            error: 'rename resolution requires a new_slug different from current',
            draft,
          };
        }
        /* fall through to write at body.new_slug */
      }
      /* merge / overwrite both write a new pending page under the
       * existing slug; merge concats existing body, overwrite
       * replaces. The actual file write happens below. */
    }
    const targetSlug = slug;
    const writeRes = writeDraftAsPendingWikiPage({
      draft,
      targetSlug,
      resolution: existingPage ? body.resolution ?? 'overwrite' : 'overwrite',
      existingPage,
    });
    if (!writeRes.ok) {
      reply.code(500);
      return { ok: false, error: writeRes.error };
    }
    const merged = store.db.updateWikiDraft(id, {
      status: 'promoted',
      resolved_by: 'user',
      ...(body.new_slug ? { page_slug: body.new_slug } : {}),
    });
    log(
      `[drafts] promoted draft ${id} -> wiki page ${targetSlug} (resolution=${body.resolution ?? 'new'})`,
    );
    return {
      ok: true,
      draft: merged,
      wiki_page_id: targetSlug,
      wiki_page_path: writeRes.path,
    };
  });

  // Use the notification event bus to suppress unused-import lint
  void notificationEvents;
}

/* Phase C resolver: brainstorm-anchor -> bound project anchor ->
 * current CC session id. Structured result so the inject route can
 * tell apart "unbound, fall through to explicit target_session" from
 * "bound but the project's worker is closed, surface as 422 so Lex
 * can queue + tell the user". Exported so tests can drive it
 * directly. */
export type ResolveSupervisedReason =
  | 'unbound'
  | 'bound-project-missing'
  | 'bound-project-dormant'
  | 'bound-live'
  | 'no-such-brainstorm';

export interface ResolveSupervisedResult {
  ok: true;
  target_session: string | null;
  reason: ResolveSupervisedReason;
  project_anchor_id: string | null;
}

export function resolveSupervisedTargetSession(
  db: import('../store/index-db.js').IndexDb,
  brainstormAnchorId: string,
): ResolveSupervisedResult {
  const lex = db.getLexSession(brainstormAnchorId);
  if (!lex) {
    return {
      ok: true,
      target_session: null,
      reason: 'no-such-brainstorm',
      project_anchor_id: null,
    };
  }
  const projectId = lex.supervises_project_anchor_id ?? null;
  if (!projectId) {
    return {
      ok: true,
      target_session: null,
      reason: 'unbound',
      project_anchor_id: null,
    };
  }
  const project = db.getProjectSession(projectId);
  if (!project) {
    return {
      ok: true,
      target_session: null,
      reason: 'bound-project-missing',
      project_anchor_id: projectId,
    };
  }
  if (!project.current_session_id) {
    return {
      ok: true,
      target_session: null,
      reason: 'bound-project-dormant',
      project_anchor_id: projectId,
    };
  }
  return {
    ok: true,
    target_session: project.current_session_id,
    reason: 'bound-live',
    project_anchor_id: projectId,
  };
}

/* Runtime mode selector for the cold-start preload feature.
 *
 * Mirrors the smart-compact precedent in three states:
 *   - 'off'    : skip everything; no audit row.
 *   - 'shadow' : compute the block and write an audit row with
 *                decision='shadow', but return block:'' so the
 *                SessionStart hook injects nothing. Lets the
 *                operator observe what the feature would do before
 *                flipping it live.
 *   - 'live'   : compute the block, audit with decision='accepted',
 *                return block to the caller for stdout injection.
 *
 * Source order:
 *   1. runtime_config.lex_cold_start_preload_enabled   (dashboard toggle)
 *   2. DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED env var
 *   3. default = 'shadow'
 *
 * Back-compat: legacy truthy spellings 'on' / 'true' / '1' (from
 * commit b997f2a) map to 'live'. Legacy falsey spellings 'off' /
 * 'false' / '0' map to 'off'. Anything unrecognised falls through
 * to the next source so a typo never silently re-enables live. */
export const COLD_START_PRELOAD_CONFIG_KEY = 'lex_cold_start_preload_enabled';
export type ColdStartPreloadMode = 'off' | 'shadow' | 'live';

export function parseColdStartPreloadValue(
  raw: string | null | undefined,
): ColdStartPreloadMode | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'shadow') return 'shadow';
  if (v === 'live' || v === 'on' || v === 'true' || v === '1') return 'live';
  return null;
}

export function coldStartPreloadMode(
  db: import('../store/index-db.js').IndexDb,
): ColdStartPreloadMode {
  const fromRuntime = parseColdStartPreloadValue(
    db.getRuntimeConfig(COLD_START_PRELOAD_CONFIG_KEY),
  );
  if (fromRuntime) return fromRuntime;
  const fromEnv = parseColdStartPreloadValue(
    process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED,
  );
  if (fromEnv) return fromEnv;
  return 'shadow';
}

/* Codex item 8 (Fix 45 follow-up): worker boot source-graph flag.
 * Gates the /worker/clear-handoff response shape so the new
 * source-graph render can ship additive ('both' default) and roll
 * forward to 'source-graph' once consumers migrate. */
export const WORKER_BOOT_SOURCE_GRAPH_CONFIG_KEY =
  'worker_boot_source_graph';
export type WorkerBootSourceGraphMode = 'legacy' | 'source-graph' | 'both';

export function parseWorkerBootSourceGraphValue(
  raw: string | null | undefined,
): WorkerBootSourceGraphMode | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'legacy') return 'legacy';
  if (v === 'source-graph' || v === 'source_graph') return 'source-graph';
  if (v === 'both') return 'both';
  return null;
}

export function workerBootSourceGraphMode(
  db: import('../store/index-db.js').IndexDb,
): WorkerBootSourceGraphMode {
  const fromRuntime = parseWorkerBootSourceGraphValue(
    db.getRuntimeConfig(WORKER_BOOT_SOURCE_GRAPH_CONFIG_KEY),
  );
  if (fromRuntime) return fromRuntime;
  return 'both';
}

/* Decorate a brainstorm row with the audio + cues URLs the dashboard
 * needs without forcing every consumer to know the data-root layout.
 * audio_url is null when no audio bundle was finalised (text-only
 * session, or meeting without consent_acked). */
function decorateBrainstorm(row: import('../store/index-db.js').BrainstormSessionRow): {
  brainstorm: import('../store/index-db.js').BrainstormSessionRow;
  audio_url: string | null;
  cues_url: string | null;
} {
  const hasAudio = Boolean(row.audio_path) && fs.existsSync(brainstormAudioFile(row.id, 'wav'));
  return {
    brainstorm: row,
    audio_url: hasAudio ? `/brainstorms/${encodeURIComponent(row.id)}/audio` : null,
    cues_url: hasAudio && fs.existsSync(brainstormCuesFile(row.id))
      ? `/brainstorms/${encodeURIComponent(row.id)}/cues`
      : null,
  };
}

function isDraftStatus(
  s: string | undefined,
): s is 'pending' | 'promoted' | 'discarded' | 'auto-promoted' | 'auto-dropped' | 'superseded' {
  return (
    s === 'pending' ||
    s === 'promoted' ||
    s === 'discarded' ||
    s === 'auto-promoted' ||
    s === 'auto-dropped' ||
    s === 'superseded'
  );
}

/* Write a wiki_drafts row to disk as a pending wiki page. Used by
 * /drafts/:id/promote. The new page lands in the pending dir; an
 * explicit /admin/wiki/promote/:id call canonicalises it later. The
 * draft body becomes the page's pattern section (free-form markdown);
 * trigger / insight / summary fall back to the draft title when the
 * upstream distillation prompt did not split them out. */
function writeDraftAsPendingWikiPage(args: {
  draft: import('../store/index-db.js').WikiDraftRow;
  targetSlug: string;
  resolution: 'rename' | 'merge' | 'overwrite';
  existingPage:
    | { frontmatter: import('../wiki/schema.js').PageFrontmatter; raw: string }
    | null;
}): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const titleHasArrow = args.draft.page_title.includes('→');
    const safeTitle = titleHasArrow
      ? args.draft.page_title
      : `${args.draft.page_title} → captured`;
    let body = args.draft.body_markdown;
    if (args.existingPage && args.resolution === 'merge') {
      const existingParsed = parsePage(args.existingPage.raw);
      body = `${existingParsed.sections.pattern}\n\n---\n\n${args.draft.body_markdown}`;
    }
    const summary = (args.draft.body_markdown ?? '').slice(0, 580);
    writePage(wikiPendingDir(), {
      frontmatter: {
        id: args.targetSlug,
        title: safeTitle,
        trigger: `from brainstorm ${args.draft.brainstorm_id}`,
        insight: args.draft.page_title,
        summary,
        status: 'pending',
        weight: 0.3,
        hits: 0,
        corrections: 0,
        created: today,
        last_touched: today,
        projects: [],
        human_edited: true,
        human_edited_at: new Date().toISOString(),
        source_brainstorms: [args.draft.brainstorm_id],
        derived_from_brainstorm: true,
      },
      sections: {
        pattern: body,
        crossRefs: [],
        crossRefsRaw: [],
        evidence: [],
        openQuestions: [],
        log: [`promoted from draft ${args.draft.id} on ${today}`],
      },
    });
    const filePath = path.posix.join(wikiPendingDir(), `${args.targetSlug}.md`);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* LEX-AUTONOMY codex 11c (Fix 48 partial closure step 3): observable
 * tail of grooming-watch events.
 *
 * Reads through listNotifications and filters source='grooming-watch'.
 * Over-fetches 500 rows from the underlying notifications log to keep
 * the post-filter slice deterministic when the dashboard has a flood
 * of unrelated rows (lex-attention, curator, etc.) sitting on top.
 *
 * Push delivery for severity='alert' rows already happens at write
 * time via emitNotification -> maybePushNotification (codex 11a
 * wire). This helper is read-only; no audit row, no side effect. */
export function recentGroomingNotifications(limit = 20): Notification[] {
  const overFetch = Math.max(limit, 500);
  const rows = listNotifications({ limit: overFetch });
  const filtered = rows.filter((n) => n.source === 'grooming-watch');
  return filtered.slice(0, Math.max(1, limit));
}

/* LEX-AUTONOMY codex item 12b (Fix 49 partial closure step 3).
 *
 * Operator-facing setter for brainstorm_sessions.project_scope_id.
 * The scope column already auto-inherits from the bound lex_session
 * at insert time (codex 12c, b189956) and drives the sibling-index
 * label-match block (codex 12a, ecab2d8); this helper closes the
 * loop by letting the dashboard / a corrective script repoint or
 * clear the scope after the fact without touching the DB by hand.
 *
 * Validation:
 *   - id must be a v4-shaped UUID; 400 otherwise.
 *   - body.project_scope_id is REQUIRED; pass null to clear, a
 *     non-empty string to set. Omitting the field is a 400 so the
 *     caller cannot accidentally no-op via a typo.
 *   - 404 if the brainstorm row does not exist.
 *
 * Audit: every accepted patch lands a cross_session_injection_log
 * row with caller_label='brainstorm-scope-patch'. target_session is
 * the brainstorm id (the table accepts any uuid-shaped value; this
 * is the routine convention for non-target operator actions). The
 * reject_reason column carries a JSON blob {old_scope, new_scope}
 * so the audit log shows the full transition. No-op patches (new
 * value equal to old) still log so the trail is dense.
 *
 * Returns a status code alongside the body so the route handler can
 * forward it without re-deriving from the error string. */
const BRAINSTORM_SCOPE_PATCH_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PatchBrainstormProjectScopeResult {
  status: number;
  ok: boolean;
  error?: string;
  brainstorm_id?: string;
  project_scope_id?: string | null;
  old_scope?: string | null;
}

export async function patchBrainstormProjectScope(
  db: import('../store/index-db.js').IndexDb,
  id: string,
  body: { project_scope_id?: string | null } | null | undefined,
): Promise<PatchBrainstormProjectScopeResult> {
  if (!id || !BRAINSTORM_SCOPE_PATCH_UUID_RE.test(id)) {
    return { status: 400, ok: false, error: 'id must be uuid' };
  }
  if (
    !body ||
    !Object.prototype.hasOwnProperty.call(body, 'project_scope_id')
  ) {
    return {
      status: 400,
      ok: false,
      error: 'project_scope_id field required (pass null to clear)',
    };
  }
  const existing = db.getBrainstorm(id);
  if (!existing) {
    return { status: 404, ok: false, error: 'brainstorm not found' };
  }
  const raw = body.project_scope_id;
  let newScope: string | null;
  if (raw === null) {
    newScope = null;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    newScope = trimmed.length === 0 ? null : trimmed;
  } else {
    return {
      status: 400,
      ok: false,
      error: 'project_scope_id must be a string or null',
    };
  }
  const oldScope = existing.project_scope_id ?? null;
  const updated = db.updateBrainstorm(id, { project_scope_id: newScope });
  try {
    const { randomUUID } = await import('node:crypto');
    db.insertCrossSessionLog({
      id: randomUUID(),
      target_session: id,
      caller_label: 'brainstorm-scope-patch',
      text_preview: '',
      text_length: 0,
      decision: 'accepted',
      reject_reason: JSON.stringify({
        old_scope: oldScope,
        new_scope: newScope,
      }),
      brainstorm_id: id,
    });
  } catch {
    /* audit row failures must not block the patch response */
  }
  return {
    status: 200,
    ok: true,
    brainstorm_id: id,
    project_scope_id: updated?.project_scope_id ?? newScope,
    old_scope: oldScope,
  };
}
