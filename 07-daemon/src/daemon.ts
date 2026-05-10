#!/usr/bin/env node
/**
 * DevNeural daemon entrypoint.
 *
 * P1 scope: capture only. Owns the transcript watcher, fs watcher, and
 * git watcher; receives SIGUSR1 throttle pings from hooks (no-op for
 * now, will trigger ingest in P3); exposes /health on Fastify.
 *
 * Exits cleanly on SIGTERM/SIGINT, releases PID file.
 */
import * as fs from 'node:fs';
import Fastify from 'fastify';
import { ensureDataRoot, daemonLogFile, daemonPidFile } from './paths.js';
import { writePid, readPid, removeStalePid, isAlive } from './lifecycle/pid.js';
import { SignalCoalescer } from './lifecycle/signals.js';
import { startTranscriptWatcher } from './capture/transcript-watcher.js';
import { startFsWatcher } from './capture/fs-watcher.js';
import { startGitWatcher } from './capture/git-watcher.js';
import { Store } from './store/index.js';
import { runMigrations } from './db/migrate.js';
import { initGpuQueue } from './gpu/queue.js';
import { VramMonitor } from './gpu/vram-monitor.js';
import { createHeartbeatPoster } from './heartbeat/poster.js';
import { cullRawChunks } from './reinforcement/raw-chunks-cull.js';
import { purgeMeetingAudio } from './voice/meeting-audio-purge.js';
import { embedOne, warmUp, getEmbedDim, getModelId, setEmbedderLogger, embedderStats } from './embedder/index.js';
import { ensureWiki } from './wiki/scaffolding.js';
import { runSeed, hasSeeded } from './corpus/seed.js';
import { runIngest } from './wiki/ingest.js';
import { pickProvider, providerStatus } from './llm/index.js';
import { curate, updateSummary, updateGlossary, updateCurrentTask } from './curation/index.js';
import { decayInactivePages } from './reinforcement/index.js';
import { runLint } from './wiki/lint.js';
import { initLintQueue, lintQueueStatus } from './wiki/lint-queue.js';
import { runAutoIngest, startAutoIngestInterval } from './wiki/auto-ingest.js';
import { startWikiPushInterval } from './wiki/push.js';
import { runBackfillWiki, getBackfillStatus } from './wiki/backfill.js';
import { generateWhatsNew } from './wiki/whats-new.js';
import { registerDashboardRoutes } from './dashboard/routes.js';
import { listReminders } from './dashboard/reminders.js';
import { emitAwarenessEvent } from './lex/awareness.js';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.DEVNEURAL_PORT ?? 3747);

function logger(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(daemonLogFile(), line, 'utf-8');
  } catch {
    /* fall back to stderr */
  }
  process.stderr.write(line);
}

async function main(): Promise<void> {
  ensureDataRoot();

  const existing = readPid();
  if (existing !== null && existing !== process.pid && isAlive(existing)) {
    logger(`already running as pid ${existing}; exiting.`);
    process.exit(0);
  }

  removeStalePid();
  writePid(process.pid);
  logger(`daemon starting; pid=${process.pid}`);

  setEmbedderLogger(logger);
  logger('opening store...');
  const store = await Store.open(logger);
  logger(
    `store open: raw_chunks=${store.rawChunks.size()} wiki_pages=${store.wikiPages.size()} embedder=${getModelId()} dim=${getEmbedDim()}`,
  );

  // Phase Two migration runner. Applies any new files in
  // scripts/migrations not yet recorded in the _migrations table.
  // Runs after the legacy Store.open() which sets up the original
  // tables, and before HTTP bind so all routes see the post-migration
  // schema. Idempotent on every boot.
  try {
    const migDir = path.posix.join(
      path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/'),
      '..',
      'scripts',
      'migrations',
    );
    const migResult = await runMigrations({ migrationsDir: migDir });
    if (migResult.applied.length > 0) {
      logger(
        `migrations: applied ${migResult.applied.length} (${migResult.applied.join(', ')}); total=${migResult.totalAppliedAfter}`,
      );
    } else {
      logger(`migrations: no new (total=${migResult.totalAppliedAfter})`);
    }
  } catch (err) {
    logger(`migrations FAILED: ${(err as Error).message}`);
    throw err;
  }

  /* GPU job queue + VRAM monitor (Wave 2 day 1 steps 3 + 4).
   * Lanes 0 and 1 always run (curator + voice). Lanes 2 and 3
   * defer when free VRAM dips below the floor. The VRAM monitor
   * fails open on hosts without nvidia-smi so the queue keeps
   * dispatching. */
  const vram = new VramMonitor({ log: logger });
  vram.start();
  initGpuQueue({
    vramOk: () => vram.vramOk(),
    vramBackoffMs: Number(process.env.DEVNEURAL_VRAM_BACKOFF_MS ?? 10_000),
    log: logger,
  });
  logger('gpu queue + vram monitor up');

  /* External heartbeat poster (Wave 2 day 1 step 5).
   * No-op when DEVNEURAL_HEARTBEAT_URL is unset; the poster logs
   * the disabled state and skips the timer. With the URL set, a
   * row lands in heartbeat_log every 60s (default) regardless of
   * watcher reachability so a forensic trail survives. */
  const heartbeat = createHeartbeatPoster({ log: logger });
  heartbeat.start(store.db);
  void heartbeat;

  /* Raw chunks cull (Wave 2 day 1 step 7 / OP-4).
   * Runs once at boot (after a small delay so the daemon does not
   * block its own listen call) and then daily. brainstorm_chunks
   * is a different table and is never touched. */
  const cullIntervalMs = Number(
    process.env.DEVNEURAL_RAW_CHUNK_CULL_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
  );
  const cullTimer = setTimeout(() => {
    void cullRawChunks(store, { log: logger }).catch((err) =>
      logger(`[cull] failed: ${(err as Error).message}`),
    );
    const repeat = setInterval(() => {
      void cullRawChunks(store, { log: logger }).catch((err) =>
        logger(`[cull] failed: ${(err as Error).message}`),
      );
    }, cullIntervalMs);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, 60_000);
  if (typeof cullTimer.unref === 'function') cullTimer.unref();

  /* Wave 2 carry-over #3: meeting audio purge cron. Daily sweep next
   * to the raw-chunks cull (BF-17: meeting audio expires after
   * DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS, default 30d). Skips rows
   * pinned via keep_audio=1; deletes the WAV + .cues.json sidecar and
   * clears audio_path so /meetings/:id stops reporting a path that no
   * longer exists. */
  const meetingAudioPurgeIntervalMs = Number(
    process.env.DEVNEURAL_MEETING_AUDIO_PURGE_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
  );
  const meetingAudioPurgeTimer = setTimeout(() => {
    try {
      const r = purgeMeetingAudio(store, { log: logger });
      logger(
        `[meeting-audio-purge] scanned=${r.scanned} purged=${r.purged} kept=${r.skipped_keep_audio} not-due=${r.skipped_not_due} errors=${r.errors}`,
      );
    } catch (err) {
      logger(`[meeting-audio-purge] failed: ${(err as Error).message}`);
    }
    const repeat = setInterval(() => {
      try {
        const r = purgeMeetingAudio(store, { log: logger });
        logger(
          `[meeting-audio-purge] scanned=${r.scanned} purged=${r.purged} kept=${r.skipped_keep_audio} not-due=${r.skipped_not_due} errors=${r.errors}`,
        );
      } catch (err) {
        logger(`[meeting-audio-purge] failed: ${(err as Error).message}`);
      }
    }, meetingAudioPurgeIntervalMs);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, 90_000);
  if (typeof meetingAudioPurgeTimer.unref === 'function')
    meetingAudioPurgeTimer.unref();

  /* Self-audit periodic (Wave 2 day 4 step 16 / Karpathy steal 3 / A8).
   * Runs at +15min after boot then every DEVNEURAL_SELF_AUDIT_INTERVAL_MS
   * (default 7d). Skipped when DEVNEURAL_LLM_PROVIDER=none or when the
   * provider is not configured (the module returns skipped_reason). */
  const selfAuditIntervalMs = Number(
    process.env.DEVNEURAL_SELF_AUDIT_INTERVAL_MS ?? 7 * 24 * 60 * 60 * 1000,
  );
  const selfAuditTimer = setTimeout(() => {
    void (async () => {
      const { runSelfAudit } = await import('./wiki/self-audit.js');
      await runSelfAudit(store, { log: logger }).catch((err) =>
        logger(`[self-audit] failed: ${(err as Error).message}`),
      );
    })();
    const repeat = setInterval(() => {
      void (async () => {
        const { runSelfAudit } = await import('./wiki/self-audit.js');
        await runSelfAudit(store, { log: logger }).catch((err) =>
          logger(`[self-audit] failed: ${(err as Error).message}`),
        );
      })();
    }, selfAuditIntervalMs);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, 15 * 60 * 1000);
  if (typeof selfAuditTimer.unref === 'function') selfAuditTimer.unref();

  /* Lint nightly (Wave 2 day 4 step 15 / Karpathy steal 2 / A7).
   * Runs the full lint pass with apply=false + the IndexDb handle so
   * findings flow into audit_findings. The existing debounced lint-
   * queue still fires on every wiki mutation; this nightly pass is
   * the safety net that scans pages no mutation touched. The 5-min
   * stagger after boot keeps the daemon's listen + first-ingest
   * latency clean. */
  const lintIntervalMs = Number(
    process.env.DEVNEURAL_LINT_NIGHTLY_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
  );
  const lintTimer = setTimeout(() => {
    void runLint({ db: store.db }).catch((err) =>
      logger(`[lint nightly] failed: ${(err as Error).message}`),
    );
    const repeat = setInterval(() => {
      void runLint({ db: store.db }).catch((err) =>
        logger(`[lint nightly] failed: ${(err as Error).message}`),
      );
    }, lintIntervalMs);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, 5 * 60 * 1000);
  if (typeof lintTimer.unref === 'function') lintTimer.unref();

  /* Wave 2 carry-over #2: awareness reminder-due producer. Sweeps the
   * append-only reminders log every 5 min, emits one awareness event
   * per reminder the first time it goes due, and never re-emits the
   * same id after that (per-process dedupe). Completed / archived /
   * deleted reminders drop out of listReminders naturally so no
   * teardown is required. Interval cheap; failure is best-effort. */
  const reminderSweepIntervalMs = Number(
    process.env.DEVNEURAL_REMINDER_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000,
  );
  const remindedIds = new Set<string>();
  function sweepReminders(): void {
    try {
      const now = Date.now();
      for (const r of listReminders()) {
        if (!r.due_at) continue;
        if (r.completed_at) continue;
        if (remindedIds.has(r.id)) continue;
        const dueMs = Date.parse(r.due_at);
        if (!Number.isFinite(dueMs) || dueMs > now) continue;
        remindedIds.add(r.id);
        emitAwarenessEvent({
          kind: 'reminder-due',
          label: r.title.slice(0, 80),
          detail: {
            id: r.id,
            due_at: r.due_at,
            ...(r.project_id ? { project_id: r.project_id } : {}),
          },
        });
      }
    } catch (err) {
      logger(`[reminder sweep] failed: ${(err as Error).message}`);
    }
  }
  const reminderTimer = setTimeout(() => {
    sweepReminders();
    const repeat = setInterval(sweepReminders, reminderSweepIntervalMs);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, 30_000);
  if (typeof reminderTimer.unref === 'function') reminderTimer.unref();

  const scaffold = ensureWiki();
  logger(
    `wiki scaffold: created=${scaffold.created.length} updated=${scaffold.updated.length} present=${scaffold.alreadyPresent.length}`,
  );

  const llmStatus = providerStatus();
  if (llmStatus) {
    logger(
      `LLM provider=${llmStatus.name} configured=${llmStatus.configured} models: ingest=${llmStatus.models.ingest} lint=${llmStatus.models.lint}`,
    );
    if (!llmStatus.configured) {
      logger(`LLM hint: ${llmStatus.hint}`);
    }
  } else {
    logger(
      'LLM disabled (DEVNEURAL_LLM_PROVIDER=none). Capture continues; ingest/lint/reconcile skipped.',
    );
  }

  // Pre-warm the chosen provider so the first ingest is not blocked.
  const provider = pickProvider();
  if (provider && provider.isConfigured()) {
    void provider.warmUp?.().catch(() => undefined);
  }

  // Trigger initial corpus ingest in background if never run.
  if (!hasSeeded() && provider && provider.isConfigured()) {
    logger('initial corpus ingest scheduled (background)');
    void runSeed(store, { log: logger }).catch((err) => {
      logger(`corpus seed failed: ${(err as Error).message}`);
    });
  }

  // Pre-warm the embedder so the first transcript chunk is not blocked by model load.
  warmUp()
    .then(() => logger('embedder warmed'))
    .catch((err) => logger(`embedder warm failed: ${(err as Error).message}`));

  // Always-on lint: every ingest that touches a page schedules a debounced
  // lint cycle. Replaces the weekly mental model so promotions and decay
  // land within minutes of the session that produced them.
  initLintQueue(store, logger);

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Number(process.env.DEVNEURAL_UPLOAD_MAX_BYTES ?? 100 * 1024 * 1024),
      files: 1,
    },
  });
  await app.register(fastifyWebsocket);

  /* SPA-vs-API collision guard.
   *
   * Several daemon API routes share paths with dashboard SPA routes: the
   * dashboard renders /sessions, /projects, /reminders, while the API
   * also exposes GET /sessions, GET /projects, GET /reminders that
   * return JSON. Without this hook a browser hard-load (or PWA shortcut,
   * or refresh) on any of those URLs hits the API handler first and
   * returns JSON, which the page can't render.
   *
   * Routes without an API collision (/system, /orb, /wiki, etc) have a
   * different problem: @fastify/static does not auto-resolve
   * "/system" -> "system.html" without an `extensions: ['html']` option,
   * so they would 404 and fall through to the SPA fallback that serves
   * index.html (Home content) for every unknown path.
   *
   * One hook fixes both: when a browser asks for HTML on a path that has
   * a matching <route>.html in 08-dashboard/out, send that file and
   * short-circuit before any other handler runs. Non-HTML clients (curl,
   * fetch, the dashboard's own JSON calls) keep hitting the API.
   *
   * Identifying browser nav: GET method, Accept includes text/html, URL
   * has no file extension, and the corresponding .html exists. */
  const dashboardOutEarly = (() => {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      return path.resolve(here, '..', '..', '08-dashboard', 'out');
    } catch {
      return null;
    }
  })();
  if (dashboardOutEarly && fs.existsSync(dashboardOutEarly)) {
    app.addHook('onRequest', (req, reply, done) => {
      if (req.method !== 'GET') return done();
      const accept = (req.headers.accept ?? '').toLowerCase();
      if (!accept.includes('text/html')) return done();
      const rawUrl = req.url ?? '/';
      const pathOnly = (rawUrl.split('?')[0] ?? '/').replace(/\/+$/, '') || '/';
      // Skip Next chunks, service worker, manifest, icon files, anything
      // with an extension. The browser will request HTML for / and for
      // SPA routes; everything else we let through to fastify-static.
      if (pathOnly === '/' || pathOnly.includes('.')) return done();
      if (pathOnly.startsWith('/_next/')) return done();
      if (pathOnly.startsWith('/auth/')) return done();
      const target = path.resolve(dashboardOutEarly, '.' + pathOnly + '.html');
      // Defence-in-depth: ensure the resolved path stays under out/.
      if (!target.startsWith(dashboardOutEarly)) return done();
      if (!fs.existsSync(target)) return done();
      try {
        const html = fs.readFileSync(target, 'utf-8');
        reply.type('text/html').send(html);
      } catch {
        return done();
      }
    });
  }

  /* Per-request observability. Logs slow requests (>500ms) and any 5xx
   * with method/path/status/duration so we can correlate dashboard
   * misbehavior to specific endpoints in the /system log tail. Hot
   * polling endpoints (system-metrics, sessions, health) are excluded
   * from the slow-request threshold to avoid log spam. */
  const SILENT_PATHS = new Set([
    '/health',
    '/dashboard/health',
    '/dashboard/system-metrics',
    '/dashboard/diagnostics',
    '/dashboard/log-tail',
    '/services',
    '/sessions',
    '/notifications',
    '/reminders',
  ]);
  const reqStart = new WeakMap<object, number>();
  app.addHook('onRequest', (req, _reply, done) => {
    reqStart.set(req as unknown as object, Date.now());
    done();
  });
  app.addHook('onResponse', (req, reply, done) => {
    const t0 = reqStart.get(req as unknown as object);
    const ms = t0 ? Date.now() - t0 : 0;
    const status = reply.statusCode;
    const url = (req.url ?? '').split('?')[0] ?? '';
    const isSilent = SILENT_PATHS.has(url) || url.startsWith('/_next/') || url.startsWith('/auth/');
    if (status >= 500 || (!isSilent && ms > 500)) {
      logger(`[http] ${req.method} ${url} -> ${status} in ${ms}ms`);
    }
    done();
  });

  await registerDashboardRoutes(app, store, logger);
  app.get('/health', async () => ({
    ok: true,
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    phase: 'P3.2-reference-corpus',
    raw_chunks: store.rawChunks.size(),
    wiki_pages: store.wikiPages.size(),
    llm: providerStatus(),
    lint_queue: lintQueueStatus(),
    embedder: embedderStats(),
  }));

  app.get('/projects', async () => {
    const { listProjects } = await import('./identity/registry.js');
    return { projects: listProjects() };
  });

  app.post('/search', async (req) => {
    const body = (req.body ?? {}) as {
      q?: string;
      project_id?: string;
      kind?: string;
      top_k?: number;
      collection?: 'raw_chunks' | 'wiki_pages';
    };
    if (!body.q || typeof body.q !== 'string') {
      return { ok: false, error: 'q required' };
    }
    const topK = Math.min(Math.max(body.top_k ?? 10, 1), 50);
    const collection = body.collection ?? 'raw_chunks';
    const vec = await embedOne(body.q.slice(0, 4000));
    const target =
      collection === 'wiki_pages' ? store.wikiPages : store.rawChunks;
    const filterFn = (m: unknown): boolean => {
      const meta = m as Record<string, unknown>;
      if (body.project_id && meta.project_id !== body.project_id) return false;
      if (body.kind && meta.kind !== body.kind) return false;
      return true;
    };
    // VectorStore.search filter signature is generic on the stored metadata type;
    // we cast through unknown so a single predicate works for either collection.
    const results = (
      target as unknown as {
        search: (
          q: Float32Array,
          o: { topK: number; filter: (m: unknown) => boolean },
        ) => Array<{ id: string; score: number; metadata: unknown }>;
      }
    ).search(vec, { topK, filter: filterFn });
    return { ok: true, collection, count: results.length, results };
  });

  // /sync was the legacy monday.com sync endpoint used by devneural-projects.
  // Monday integration is dead. Returning 410 Gone so any caller still hitting
  // it gets a clear deprecation signal instead of silently succeeding.
  app.post('/sync', async (_req, reply) => {
    reply.code(410);
    return {
      ok: false,
      error: 'gone',
      note: 'monday integration deprecated; project status board coming in Phase 3 dashboard',
    };
  });

  app.post('/reseed', async () => {
    const r = await runSeed(store, { log: logger });
    return { ok: true, ...r };
  });

  app.post('/curate', async (req) => {
    const body = req.body as {
      prompt?: string;
      session_id?: string;
      project_id?: string;
    };
    if (!body.prompt || typeof body.prompt !== 'string') {
      return { ok: false, error: 'prompt required' };
    }
    const out = await curate(
      store,
      {
        prompt: body.prompt,
        sessionId: body.session_id ?? 'unknown',
        projectId: body.project_id ?? 'global',
      },
      logger,
    );
    return { ok: true, ...out };
  });

  app.post('/summarize', async (req) => {
    const body = req.body as {
      session_id?: string;
      project_id?: string;
      project_name?: string;
      chunks?: { role: string; text: string; timestamp_ms: number }[];
    };
    if (!body.session_id || !body.chunks) {
      return { ok: false, error: 'session_id and chunks required' };
    }
    const r = await updateSummary(
      {
        sessionId: body.session_id,
        projectId: body.project_id ?? 'global',
        projectName: body.project_name ?? 'global',
        newTurns: body.chunks.length,
        recentChunks: body.chunks,
      },
      logger,
    );
    return { ok: true, ...r };
  });

  app.post('/glossary', async (req) => {
    const body = req.body as {
      project_id?: string;
      project_name?: string;
      recent_text?: string;
    };
    if (!body.project_id || !body.recent_text) {
      return { ok: false, error: 'project_id and recent_text required' };
    }
    const r = await updateGlossary(
      {
        projectId: body.project_id,
        projectName: body.project_name ?? body.project_id,
        recentText: body.recent_text,
      },
      logger,
    );
    return { ok: true, ...r };
  });

  app.post('/decay', async () => {
    const r = await decayInactivePages(store, logger);
    return { ok: true, ...r };
  });

  app.post('/lint', async (req) => {
    const body = (req.body ?? {}) as { apply?: boolean };
    const r = await runLint({ apply: body.apply });
    return { ok: true, ...r };
  });

  app.post('/whats-new', async (req) => {
    const body = (req.body ?? {}) as { days?: number };
    const r = generateWhatsNew(body.days ?? 7);
    return { ok: true, ...r };
  });

  // /graph is now registered by registerDashboardRoutes (see dashboard/graph.ts).

  /* /flush is the backup script's hand-shake so a snapshot is internally
   * consistent. It flushes the in-memory vector buffer to disk and asks
   * SQLite to checkpoint its WAL. Best-effort; backup.ps1 tolerates a
   * missing or failing daemon. */
  app.post('/flush', async () => {
    await store.flush();
    try {
      const sqlite = (
        store as unknown as {
          rawChunks: { db?: { exec?: (sql: string) => unknown } };
        }
      ).rawChunks?.db;
      if (sqlite?.exec) {
        sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      }
    } catch {
      /* best-effort; the file copy will still be readable even if WAL is
       * not truncated since SQLite's WAL format is forward-compatible */
    }
    return { ok: true, flushed_at: new Date().toISOString() };
  });

  app.get('/page/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const fsLib = await import('node:fs');
    const pathLib = await import('node:path');
    const { wikiPagesDir, wikiPendingDir, wikiArchiveDir } = await import('./paths.js');
    const { parsePage } = await import('./wiki/schema.js');
    for (const dir of [wikiPagesDir(), wikiPendingDir(), wikiArchiveDir()]) {
      const file = pathLib.posix.join(dir, `${id}.md`);
      if (fsLib.existsSync(file)) {
        const raw = fsLib.readFileSync(file, 'utf-8');
        try {
          const parsed = parsePage(raw);
          return { ok: true, raw, frontmatter: parsed.frontmatter };
        } catch {
          return { ok: false, error: 'parse failed', raw };
        }
      }
    }
    return { ok: false, error: 'page not found' };
  });

  app.get('/glossary/:projectId', async (req) => {
    const projectId = (req.params as { projectId: string }).projectId;
    const { readGlossary } = await import('./curation/index.js');
    return { ok: true, project_id: projectId, entries: readGlossary(projectId) };
  });

  app.get('/session/:sessionId/summary', async (req) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const { readSummary } = await import('./curation/index.js');
    return { ok: true, session_id: sessionId, summary: readSummary(sessionId) };
  });

  app.get('/session/:sessionId/task', async (req) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const { readCurrentTask } = await import('./curation/index.js');
    return { ok: true, session_id: sessionId, task: readCurrentTask(sessionId) };
  });

  app.post('/task', async (req) => {
    const body = req.body as {
      session_id?: string;
      chunks?: { role: string; text: string }[];
    };
    if (!body.session_id || !body.chunks) {
      return { ok: false, error: 'session_id and chunks required' };
    }
    const r = await updateCurrentTask(
      { sessionId: body.session_id, recentChunks: body.chunks },
      logger,
    );
    return { ok: true, ...r };
  });

  app.post('/ingest', async (req) => {
    const body = req.body as {
      source?: string;
      project_id?: string;
      project_name?: string;
      content?: string;
    };
    if (!body.content || typeof body.content !== 'string') {
      return { ok: false, error: 'content required' };
    }
    const r = await runIngest(
      store,
      {
        source: body.source ?? 'manual',
        projectId: body.project_id ?? 'global',
        projectName: body.project_name ?? 'global',
        newContent: body.content,
        evidenceHints: [],
      },
      logger,
    );
    return { ok: true, ...r };
  });

  // Serve the dashboard static export when present. The export lives at
  // 08-dashboard/out/ produced by `npm run build` in that workspace. Path
  // resolution uses fileURLToPath so it works on Windows whether started
  // from dist/ or src/ via tsx. Layout: <repo>/07-daemon/dist/daemon.js
  // and <repo>/08-dashboard/out, so we go up two levels from this file's
  // directory then over to 08-dashboard/out.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dashboardOut = path.resolve(here, '..', '..', '08-dashboard', 'out');
    if (fs.existsSync(dashboardOut)) {
      await app.register(fastifyStatic, {
        root: dashboardOut,
        prefix: '/',
        index: ['index.html'],
        /* Disable fastify-static's auto cache-control header so the
         * setHeaders callback below is the single source of truth.
         * Without this, fastify-static emits `public, max-age=0` and
         * silently ignores our overrides. */
        cacheControl: false,
        /* Cache strategy:
         *   - HTML (entry points) MUST NOT be cached. Each dashboard
         *     rebuild rotates the next/static chunk hashes, and the
         *     fresh index.html references the new hashes. iOS Safari
         *     and home-screen PWAs would otherwise serve a stale
         *     cached index.html that points at chunks no longer on
         *     disk → white screen until manual cache clear.
         *   - /_next/static/** content has hash-based filenames so it
         *     is safe to cache aggressively (immutable forever).
         *   - Everything else (manifest.json, sw.js, icons, fonts)
         *     gets a short cache window so updates propagate within
         *     a few minutes without forcing a full revalidation per
         *     request. */
        setHeaders: (res, p) => {
          /* Normalize Windows backslashes so the path checks below
           * match regardless of host OS. fastify-static hands the
           * absolute path to the file being served. */
          const norm = p.replace(/\\/g, '/');
          if (norm.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            return;
          }
          if (norm.includes('/_next/static/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return;
          }
          if (norm.endsWith('/sw.js') || norm.endsWith('/manifest.json')) {
            res.setHeader('Cache-Control', 'no-cache');
            return;
          }
          res.setHeader('Cache-Control', 'public, max-age=300');
        },
      });
      // SPA fallback. The onRequest hook above already serves <route>.html
      // for HTML browser navigations, so this only catches a small
      // residual set: GET requests that escaped the hook (no Accept
      // header, or non-HTML Accept) and don't match any other route.
      // Prefer a matching <route>.html if one exists on disk; only fall
      // back to index.html for genuinely unknown paths.
      app.setNotFoundHandler((req, reply) => {
        if (req.method !== 'GET') {
          reply.code(404).send({ ok: false, error: 'not found' });
          return;
        }
        const url = (req.url ?? '/').split('?')[0] ?? '/';
        if (url.includes('.')) {
          reply.code(404).send({ ok: false, error: 'not found' });
          return;
        }
        const cleaned = url.replace(/\/+$/, '') || '/';
        if (cleaned !== '/') {
          const candidate = path.resolve(dashboardOut, '.' + cleaned + '.html');
          if (
            candidate.startsWith(dashboardOut) &&
            fs.existsSync(candidate)
          ) {
            try {
              reply.type('text/html').send(fs.readFileSync(candidate, 'utf-8'));
              return;
            } catch {
              /* fall through to index.html */
            }
          }
        }
        reply.type('text/html').sendFile('index.html');
      });
      logger(`dashboard static serve enabled from ${dashboardOut}`);
    } else {
      logger(`dashboard static export not found at ${dashboardOut}; API only`);
    }
  } catch (err) {
    logger(`dashboard static serve setup failed: ${(err as Error).message}`);
  }

  try {
    // Bind 0.0.0.0 so Tailscale can route to the dashboard from your
    // other devices on the tailnet. Localhost-only callers (hooks)
    // continue to hit 127.0.0.1 transparently. Override with
    // DEVNEURAL_BIND if you want to lock back down to 127.0.0.1.
    const host = process.env.DEVNEURAL_BIND ?? '0.0.0.0';
    await app.listen({ port: PORT, host });
    logger(`listening on http://${host}:${PORT}`);
  } catch (err) {
    logger(`http listen failed: ${(err as Error).message}`);
  }

  const coalescer = new SignalCoalescer(
    async () => {
      await store.flush();
      try {
        const result = await runAutoIngest(store, logger);
        if (result.ingests_triggered > 0) {
          logger(
            `[auto-ingest] signal pass: scanned=${result.projects_scanned} triggered=${result.ingests_triggered} created=${result.pages_created} updated=${result.pages_updated}`,
          );
        }
      } catch (err) {
        logger(`[auto-ingest] signal pass failed: ${(err as Error).message}`);
      }
    },
    logger,
  );

  /* Auto-resume an in-flight wiki backfill across daemon restarts.
   * If the cursor file shows incomplete work, kick a new run in the
   * background. Cursor logic skips files marked done so we never
   * re-process completed sessions. Disabled with DEVNEURAL_AUTO_RESUME_WIKI=0. */
  if ((process.env.DEVNEURAL_AUTO_RESUME_WIKI ?? '1') !== '0') {
    setTimeout(() => {
      try {
        const status = getBackfillStatus().wiki;
        if (status.running) return; // current process already has it
        // Heuristic: if there is any cursor history (started_at), and not
        // every file is done, kick off a resume. The runner will skip
        // completed files immediately so this is cheap when fully done.
        const everRan = status.started_at !== null;
        const hasMore = status.files_done + status.files_skipped < status.files_total;
        if (everRan && hasMore) {
          logger('[backfill-wiki] auto-resuming after daemon start');
          void runBackfillWiki(store, logger).catch((err) =>
            logger(`[backfill-wiki] auto-resume failed: ${(err as Error).message}`),
          );
        }
      } catch (err) {
        logger(`[backfill-wiki] auto-resume check failed: ${(err as Error).message}`);
      }
    }, 5000);
  }

  const transcripts = startTranscriptWatcher({ log: logger, store });
  const fsWatcher = startFsWatcher({ log: logger });
  const gitWatcher = startGitWatcher({ log: logger });

  /* Periodic auto-ingest tick. Catches activity that didn't produce a
   * hook signal (background work, idle sessions that left chunks in the
   * transcript). Default 5 min; tunable via env. The brain stays current
   * even when hook delivery is interrupted. */
  startAutoIngestInterval(
    store,
    logger,
    Number(process.env.DEVNEURAL_AUTO_INGEST_INTERVAL_MS ?? 5 * 60 * 1000),
  );

  /* Off-site wiki push. Wiki lives at DATA_ROOT/wiki and is committed
   * locally on every lint/ingest cycle. Without an off-site mirror a
   * disk failure loses every page. The OneDrive backup catches the
   * data root daily but a real git remote gives us versioned history
   * survival even between backups. Default 5 min; skipped when no
   * remote is configured (so a dev clone without origin doesn't spam
   * errors). */
  startWikiPushInterval(
    logger,
    Number(process.env.DEVNEURAL_WIKI_PUSH_INTERVAL_MS ?? 5 * 60 * 1000),
  );

  /* Periodic reinforcement decay. decayInactivePages multiplies every
   * page weight by 0.995 and archives anything that drops below 0.15.
   * Without a scheduler, weights for pages that are never injected
   * stay at their last-touched value indefinitely and lint never
   * reaches the archive threshold. The /decay HTTP route exists for
   * manual runs, but the audit on 2026-05-09 confirmed decay had
   * never run automatically — closes that gap.
   * Default cadence: daily (24h). Tunable via env so sites with very
   * fast page churn can run every few hours, and a dev box can
   * disable via 0. The decay is cheap (file rewrite per page); the
   * 24h default mirrors the daily backup window cadence. */
  const decayMs = Number(
    process.env.DEVNEURAL_DECAY_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
  );
  if (decayMs > 0) {
    setInterval(() => {
      void decayInactivePages(store, logger).catch((err) =>
        logger(`[decay] periodic run failed: ${(err as Error).message}`),
      );
    }, decayMs);
    logger(`[decay] interval started, every ${Math.round(decayMs / 1000)}s`);
  } else {
    logger(`[decay] interval disabled (DEVNEURAL_DECAY_INTERVAL_MS=0)`);
  }

  process.on('SIGUSR1', () => {
    coalescer.trigger('SIGUSR1');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger(`received ${signal}; shutting down`);
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    try {
      await transcripts.stop();
    } catch {
      /* ignore */
    }
    try {
      await fsWatcher.stop();
    } catch {
      /* ignore */
    }
    try {
      gitWatcher.stop();
    } catch {
      /* ignore */
    }
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    try {
      const pid = readPid();
      if (pid === process.pid) {
        fs.unlinkSync(daemonPidFile());
      }
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger(`uncaught: ${err?.stack ?? err?.message ?? err}`);
  });
  process.on('unhandledRejection', (err) => {
    logger(`unhandled rejection: ${(err as Error)?.message ?? err}`);
  });
}

main().catch((err) => {
  logger(`fatal: ${(err as Error)?.stack ?? (err as Error)?.message ?? err}`);
  process.exit(1);
});
