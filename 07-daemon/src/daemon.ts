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
import { setShutdownHook } from './lifecycle/shutdown-hook.js';
import { createRotatingAppender } from './lifecycle/log-rotation.js';
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
import { whisperStatus } from './voice/whisper.js';
import { piperStatus } from './voice/piper.js';
import { getVoiceWsStats, setVoiceWsLogger } from './voice/lex-voice-ws.js';
import { setPtyHostLogger } from './dashboard/pty-host.js';
import { setJudgeSessionLogger } from './lex/judge-session.js';
import {
  useVoiceHaiku,
  voiceApiKey,
  enableVoiceHaikuIfKeyPresent,
} from './voice/voice-haiku.js';
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
import {
  firePushForReminder,
  loadPushedReminderIds,
} from './dashboard/reminder-push.js';
import { runDistillationBackfill, BACKFILL_DEFAULT_LIMIT } from './lex/sibling-distillation-backfill.js';
import { createLlmDistillationGenerator } from './lex/distillation-generator.js';
import { jsonlForAnchor } from './dashboard/smart-compact-routes.js';
import {
  runWorkerStallTick,
  readTail as readStallTail,
} from './dashboard/worker-stall-watch.js';
import { startBridgePresenceLoop } from './dashboard/bridge-presence.js';
import {
  seedProjectAnchors,
  startProjectsRootWatcher,
  getProjectsRoot,
} from './dashboard/seed-project-anchors.js';
import { startDistillationBackfillScheduler } from './lex/distillation-scheduler.js';
import { startWorkerEventListener } from './dashboard/worker-event-listener.js';
import { startExpectationSupervisor } from './lex/expectation-supervisor.js';
import {
  startDashboardSupervisor,
  type DashboardSupervisorHandle,
} from './dashboard/dashboard-supervisor.js';
import { emitAwarenessEvent } from './lex/awareness.js';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.DEVNEURAL_PORT ?? 3747);

/* F1 (observability hardening): daemon.log grew unrotated to 130MB /
 * 1.13M lines with no cap. createRotatingAppender wraps the raw
 * appendFileSync sink with a periodic size check (every 1000 writes
 * or 60s) that renames daemon.log -> daemon.log.1 once the file
 * crosses DEVNEURAL_LOG_MAX_BYTES (default 32MB), keeping exactly one
 * rotated generation. See src/lifecycle/log-rotation.ts. */
const DAEMON_LOG_MAX_BYTES = Number(
  process.env.DEVNEURAL_LOG_MAX_BYTES ?? 32 * 1024 * 1024,
);
const appendDaemonLog = createRotatingAppender({
  filePath: daemonLogFile(),
  maxBytes: DAEMON_LOG_MAX_BYTES,
});

function logger(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendDaemonLog(line);
    return;
  } catch {
    /* fall through to stderr; daemon.log is unreachable */
  }
  /* Stderr is only the fallback. If we also wrote it on every line,
   * daemons spawned via lifecycle/spawn.ts (which pipes child stderr
   * directly into daemon.log) would log each line twice: once via
   * appendFileSync, once via the inherited stderr fd. */
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
  setVoiceWsLogger(logger);
  setPtyHostLogger(logger);
  setJudgeSessionLogger(logger);
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

  /* Project anchor seeding (PROJECT-ANCHORS.md `## Seeding`, line 57).
   * Enumerate top-level subdirs of the Projects root and upsert one
   * project_session row per dir. Idempotent. fs.watch on the root
   * keeps the seed pass in sync with new dirs created at runtime.
   *
   * Must run BEFORE the bridge-presence loop so an unknown-cwd
   * presence file on first reconcile sees a row to flip live, and
   * the inline auto-create fallback in reconcileBridgePresence has
   * a coherent helper to call.
   *
   * Tunable via env:
   *   DEVNEURAL_PROJECTS_ROOT (default C:/dev/Projects)            */
  try {
    const seedResult = seedProjectAnchors(store.db, { log: logger });
    logger(
      `project anchors seeded (root=${seedResult.root} scanned=${seedResult.scanned} inserted=${seedResult.inserted})`,
    );
  } catch (err) {
    logger(`project anchor seed FAILED: ${(err as Error).message}`);
  }
  const projectsWatcherStop = startProjectsRootWatcher(store.db, {
    root: getProjectsRoot(),
    log: logger,
  });

  /* Bridge presence resolver (PROJECT-ANCHORS.md step 2 of 6).
   * Polls <bridgeDir>/.bridge-presence/ on a short interval, flips
   * project_session anchors live or dormant based on whether their
   * cwd has a fresh presence file. Tunable via env:
   *   DEVNEURAL_BRIDGE_PRESENCE_INTERVAL_MS (default 1000)
   *   DEVNEURAL_BRIDGE_TIMEOUT_MS         (default 30000) */
  const bridgePresenceInterval = Number(
    process.env.DEVNEURAL_BRIDGE_PRESENCE_INTERVAL_MS ?? 1_000,
  );
  const bridgePresenceFreshMs = Number(
    process.env.DEVNEURAL_BRIDGE_TIMEOUT_MS ?? 30_000,
  );
  startBridgePresenceLoop(store.db, {
    intervalMs: bridgePresenceInterval,
    freshMs: bridgePresenceFreshMs,
    log: logger,
    onError: (err) =>
      logger(`[bridge-presence] reconcile failed: ${err.message}`),
  });
  logger(
    `bridge presence loop up (interval=${bridgePresenceInterval}ms fresh=${bridgePresenceFreshMs}ms)`,
  );

  /* Bind the local-only distillation generator to the
   * sibling-distillation backfill module. Generator is gated on
   * ollama isConfigured() + name !== 'anthropic' (BF-4); when either
   * gate fails the scheduler logs once and no-ops. Tunable via env:
   *   DEVNEURAL_DISTILL_SCHEDULER_INTERVAL_MS  (default 600000 / 10m)
   *   DEVNEURAL_DISTILL_SCHEDULER_FIRST_FIRE_MS (default 30000 / 30s)
   *   DEVNEURAL_DISTILL_BOOT_RECOVERY_LIMIT    (default 20; 0 disables)
   *   DEVNEURAL_DISTILL_BOOT_RECOVERY_DELAY_MS (default 5000)
   *
   * Boot recovery sweep runs a single high-cap tick shortly after
   * boot to catch up ended-but-undistilled sessions left behind when
   * the prior daemon died mid-tick (fast restart). Without it,
   * stale-ref counts on cold-start preload can sit at 20+ for over
   * an hour because the steady-state tick only handles 5 rows per
   * 10-minute interval. */
  const distillScheduler = startDistillationBackfillScheduler({
    db: store.db,
    log: logger,
    intervalMs: Number(
      process.env.DEVNEURAL_DISTILL_SCHEDULER_INTERVAL_MS ?? 10 * 60_000,
    ),
    firstFireDelayMs: Number(
      process.env.DEVNEURAL_DISTILL_SCHEDULER_FIRST_FIRE_MS ?? 30_000,
    ),
    bootRecoveryLimit: Number(
      process.env.DEVNEURAL_DISTILL_BOOT_RECOVERY_LIMIT ?? 20,
    ),
    bootRecoveryDelayMs: Number(
      process.env.DEVNEURAL_DISTILL_BOOT_RECOVERY_DELAY_MS ?? 5_000,
    ),
  });

  /* Crash recovery (sliver 4): a crash kills the daemon mid-session and
   * the normal end-of-session distill/handoff never runs. On boot, sweep
   * for anchors whose activity landed past the last clean checkpoint
   * (newest cold-start report ms / last_summary_ms) and run the missed
   * non-terminal flush so distillations + docs catch up. Bounded +
   * fire-and-forget so it never blocks boot; staggered after the distill
   * boot-recovery sweep. DEVNEURAL_CRASH_RECOVERY_LIMIT=0 disables. */
  {
    const crashLimit = Number(
      process.env.DEVNEURAL_CRASH_RECOVERY_LIMIT ?? 10,
    );
    const crashDelay = Number(
      process.env.DEVNEURAL_CRASH_RECOVERY_DELAY_MS ?? 8_000,
    );
    if (crashLimit > 0) {
      const crashTimer = setTimeout(() => {
        void (async () => {
          try {
            const { recoverCrashedAnchors } = await import(
              './lex/crash-recovery.js'
            );
            await recoverCrashedAnchors({
              store,
              log: logger,
              limit: crashLimit,
            });
          } catch (err) {
            logger(`crash-recovery sweep failed: ${(err as Error).message}`);
          }
        })();
      }, crashDelay);
      if (typeof crashTimer.unref === 'function') crashTimer.unref();
    }
  }

  /* Event-driven Lex supervision (EVENT-DRIVEN-SUPERVISION.md).
   * Subscribes to every Claude Code transcript jsonl, runs the
   * detector pipeline, routes WorkerEvents to Lex's active
   * brainstorm via the cross-session inject path. Only fires for
   * anchors with supervision_mode='event'; polling stays the
   * failsafe for the rest. */
  const workerEventListener = startWorkerEventListener({
    db: store.db,
    log: (msg) => logger(msg),
  });
  void workerEventListener;

  /* Brainstorm-as-durable-primary-entity (2026-05-22, plan section L).
   * Active polling-with-expectations supervisor. Ticks every 90s
   * (DEVNEURAL_EXPECTATION_TICK_MS override), walks open
   * lex_worker_expectation rows, asks the LLM whether the worker's
   * recent jsonl tail aligns with the expected outcome, and on
   * drift fires lex-attention so the operator sees a push and Lex
   * sees the correction text on its next voice turn. */
  const expectationSupervisor = startExpectationSupervisor({ log: logger });
  void expectationSupervisor;

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
  /* In-memory dedupe set, seeded from the persisted push ledger so a
   * daemon restart mid-sweep does not re-fire a reminder that already
   * dispatched a web push. The awareness event uses its own
   * idle_duplicate guard so we keep emitting it (cheap, no external
   * side effect); the push ledger guards the network-side action. */
  const remindedIds = new Set<string>();
  const pushedIds = loadPushedReminderIds();
  function sweepReminders(): void {
    try {
      const now = Date.now();
      for (const r of listReminders()) {
        if (!r.due_at) continue;
        if (r.completed_at) continue;
        const dueMs = Date.parse(r.due_at);
        if (!Number.isFinite(dueMs) || dueMs > now) continue;
        if (!remindedIds.has(r.id)) {
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
        /* Web push dispatch. Dedupe handled inside firePushForReminder
         * against the shared pushedIds Set + the persisted ledger so
         * a daemon restart cannot re-buzz the user's phone. */
        firePushForReminder(r, { pushedIds });
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

  /* Sibling distillation backfill scheduler. Wires the LLM-backed
   * generator (createLlmDistillationGenerator) into runDistillationBackfill
   * so older brainstorm_sessions with a null last_summary get a one-line
   * distillation in the background. Cap is N=5 per run by default so a
   * cold start cannot melt ollama. Default cadence 6h; configurable via
   * DEVNEURAL_DISTILL_BACKFILL_INTERVAL_MS. Skipped entirely when the
   * provider is unconfigured or BF-4-blocked (anthropic); the generator
   * returns null and the job logs the skip without touching rows. */
  const distillBackfillIntervalMs = Number(
    process.env.DEVNEURAL_DISTILL_BACKFILL_INTERVAL_MS ??
      6 * 60 * 60 * 1000,
  );
  const distillBackfillLimit = Number(
    process.env.DEVNEURAL_DISTILL_BACKFILL_LIMIT ?? BACKFILL_DEFAULT_LIMIT,
  );
  async function tickDistillBackfill(): Promise<void> {
    try {
      const generator = createLlmDistillationGenerator({
        db: store.db,
        log: (m) => logger(m),
      });
      const r = await runDistillationBackfill({
        db: store.db,
        generator,
        limit: distillBackfillLimit,
      });
      logger(
        `[distill-backfill] processed=${r.processed.length} skipped=${r.skipped.length} errors=${r.errors.length} hit_cap=${r.hit_cap}`,
      );
    } catch (err) {
      logger(`[distill-backfill] tick failed: ${(err as Error).message}`);
    }
  }
  const distillBackfillTimer = setTimeout(() => {
    void tickDistillBackfill();
    const repeat = setInterval(
      () => void tickDistillBackfill(),
      distillBackfillIntervalMs,
    );
    if (typeof repeat.unref === 'function') repeat.unref();
  }, 60_000);
  if (typeof distillBackfillTimer.unref === 'function') {
    distillBackfillTimer.unref();
  }

  /* Brainstorm jsonl ingestor. Tails every active brainstorm
   * session's CC jsonl and lands each user / assistant turn into
   * brainstorm_chunks. Single source of truth so typed-textarea
   * inputs land alongside voice STT in the same transcript stream
   * with proper turn ordering + speaker tagging. Idempotent via
   * deterministic chunk id (= cc turn uuid) + INSERT OR REPLACE on
   * the brainstorm_chunks primary key, so concurrent writes from
   * the voice WS path are no-ops rather than duplicates. */
  try {
    const { startBrainstormJsonlIngestor } = await import(
      './lex/brainstorm-jsonl-ingestor.js'
    );
    startBrainstormJsonlIngestor({
      deps: {
        db: store.db,
        log: logger,
      },
    });
    logger('brainstorm-jsonl-ingestor: started');
  } catch (err) {
    logger(
      `brainstorm-jsonl-ingestor bootstrap failed: ${(err as Error).message}`,
    );
  }

  /* Codex item 6 (Fix 43): distillation staleness watcher. Walks
   * active brainstorm anchors every 5 min, emits notify_class='signal'
   * when any anchor's oldest stale ref crosses the threshold T
   * (default 10 min via DEVNEURAL_STALE_REMINDER_MS). Per-anchor 30
   * min debounce so the bell never sees the same anchor twice inside
   * the window. Bell-only this round; push='suppress' bypasses the
   * web-push pipeline so the phone stays quiet. */
  try {
    const { startStaleWatch } = await import('./lex/stale-watcher.js');
    startStaleWatch({
      deps: {
        db: store.db,
        log: logger,
        /* Sliver 2c: detection -> action. When the watch finds an
         * anchor past the staleness threshold, kick the distillation
         * scheduler's bounded tick so the bell is no longer the only
         * response. The scheduler's re-entrancy guard prevents this
         * from stacking on the periodic tick, and it runs through the
         * scheduler's own engine (ollama by default; headless Opus only
         * under DEVNEURAL_DISTILL_HEADLESS), so the flag is respected. */
        onStale: (anchorIds) => {
          logger(
            `[stale-watch] ${anchorIds.length} stale anchor(s) past threshold; kicking distill`,
          );
          distillScheduler.kick();
        },
      },
    });
    logger('stale-watcher: started');
  } catch (err) {
    logger(`stale-watcher bootstrap failed: ${(err as Error).message}`);
  }

  /* Cancelled-tool recovery (Fix 33). Tails the same active brainstorm
   * jsonls as the brainstorm-jsonl-ingestor; when a tool_result line
   * carries a CC reject envelope, arms the session. After 5 s without
   * an assistant follow-up the service fires a single recovery inject
   * via cross-session-inject. Two strikes inside 30 s escalates to
   * recovery_exhausted (audit row + WS frame to the active voice
   * client). Removes the "Lex stuck until user types again" failure
   * mode regardless of what caused the cancellation. */
  let cancelledToolRecoveryHandle:
    | { stop(): void; tickNow(): void }
    | null = null;
  try {
    const { startCancelledToolRecovery } = await import(
      './lex/cancelled-tool-recovery.js'
    );
    const { broadcastRecoveryExhausted } = await import(
      './voice/lex-voice-ws.js'
    );
    cancelledToolRecoveryHandle = startCancelledToolRecovery({
      deps: {
        db: store.db,
        notifyExhausted: (ccId, reason): void => {
          try {
            broadcastRecoveryExhausted(ccId, reason);
          } catch {
            /* broadcaster best-effort; audit row already landed */
          }
        },
        log: logger,
      },
    });
    logger('cancelled-tool-recovery: started');
  } catch (err) {
    logger(
      `cancelled-tool-recovery bootstrap failed: ${(err as Error).message}`,
    );
  }

  /* LEX-AUTONOMY codex item 11 (Fix 48). Grooming watch: 30-min tick
   * walking every live brainstorm anchor and surfacing six gap
   * classes (distill_failure_persistent, parked_question_persistent,
   * distill_error_repeat, loose_ends_block_persistent, grooming_gap,
   * idle_no_distill). Severity drives push policy through
   * emitNotification (alert -> 'force', else 'auto', info stays
   * bell-only). Per-(anchor, class) 30-min debounce keeps the
   * notifications surface quiet. looseEndsBlockedAt map is left
   * undefined this round; the loose-ends gate cache wire is a
   * codex 10 follow-up. */
  let groomingHandle: { stop(): void; tickNow(): unknown } | null = null;
  try {
    const { installGroomingScheduler } = await import(
      './lex/grooming-watch.js'
    );
    const { emitNotification } = await import('./dashboard/notifications.js');
    groomingHandle = installGroomingScheduler({
      db: store.db,
      log: logger,
      emit: (input) =>
        emitNotification({
          severity: input.severity,
          source: input.source,
          title: input.title,
          body: input.body,
          link: input.link,
          push: input.push,
          notify_class: input.notify_class,
        }),
    });
    logger('grooming-watch: started');
  } catch (err) {
    logger(`grooming-watch bootstrap failed: ${(err as Error).message}`);
  }

  /* Phase 5 wire-up of docs/spec/LEX-STANDALONE-SUPERVISION.md.
   * Boots the idle-watcher with the production grooming deps so
   * standalone brainstorms get light/mid/cold/day-cap passes on
   * the spec-defined cadence (5/20/60 min, 6h).
   *
   * Generator: createLlmDistillationGenerator against the active
   * provider (ollama by default). Honors BF-4 = no anthropic for
   * brainstorm content.
   *
   * writeHandover: real disk writer at <DATA_ROOT>/brainstorms/<id>/.
   *
   * runFinalDistillation: the day-cap pass flips lifecycle_state=
   * ended via grooming.ts step 3, then delegates here. We re-enter
   * runSessionEndPipeline so day-cap, voice "end session", PTY exit,
   * and admin redistill all share the same code path per spec
   * section D. markEnded=true is the default behavior of
   * runSessionEndPipeline; grooming's status flip is idempotent
   * because the canonical pipeline only updates ended_ms when it
   * was previously null.
   *
   * Cadence configurable via DEVNEURAL_IDLE_WATCHER_INTERVAL_MS;
   * default 60s per startIdleWatcher.DEFAULT_IDLE_WATCHER_INTERVAL_
   * MS. Set to 0 to disable (e.g. on dev boxes where the LLM is
   * cold). */
  try {
    const idleIntervalRaw = Number(
      process.env.DEVNEURAL_IDLE_WATCHER_INTERVAL_MS ?? NaN,
    );
    if (idleIntervalRaw === 0) {
      logger('idle-watcher: disabled via DEVNEURAL_IDLE_WATCHER_INTERVAL_MS=0');
    } else {
      const { startIdleWatcher } = await import('./lex/idle-watcher.js');
      const { createLlmDistillationGenerator } = await import(
        './lex/distillation-generator.js'
      );
      const { writeHandover } = await import('./lex/handover-writer.js');
      const { runSessionEndPipeline } = await import(
        './lex/session-end-pipeline.js'
      );
      const generator = createLlmDistillationGenerator({
        db: store.db,
        log: logger,
      });
      startIdleWatcher({
        db: store.db,
        generator,
        writeHandover,
        runFinalDistillation: async (brainstormId: string) => {
          const row = store.db.getBrainstorm(brainstormId);
          if (!row) return;
          await runSessionEndPipeline(
            store,
            {
              brainstormId,
              claudeSessionId: row.claude_session_id ?? null,
              mode: row.mode ?? 'conversation',
              reason: 'idle-watcher-day-cap',
            },
            logger,
          );
        },
        log: logger,
        intervalMs: Number.isFinite(idleIntervalRaw)
          ? idleIntervalRaw
          : undefined,
      });
      logger(
        `idle-watcher: started intervalMs=${Number.isFinite(idleIntervalRaw) ? idleIntervalRaw : 'default(60000)'}`,
      );
    }
  } catch (err) {
    logger(`idle-watcher bootstrap failed: ${(err as Error).message}`);
  }

  /* Fix 41 Stage 3: smart-compact scheduler removed. Lex drives the
   * loop entirely via the policy-out endpoints (GET /state +
   * POST /clear-and-paste + POST /wrap-paste). The legacy 60s
   * daemon-side walker, the DEVNEURAL_SMART_COMPACT_TICK_MS env, the
   * shared schedulerInjector, and the production ctxProvider that
   * fed evaluateSmartCompact are all dead code now. The same
   * deriveContextFromTail-based ctxProvider used to live here; it
   * still lives in dashboard/routes.ts, bound directly into
   * registerSmartCompactRoutes for GET /lex/smart-compact/state. */

  /* Worker mid-turn stall watch. Walks live anchors every
   * DEVNEURAL_STALL_TICK_MS (default 60s) and fires the existing
   * fireForStall notification when a tool_use turn has been open
   * past DEVNEURAL_STALL_TOOL_MS or a user message has gone
   * unanswered past DEVNEURAL_STALL_USER_MS. Cooldown per anchor
   * is DEVNEURAL_STALL_COOLDOWN_MS so a wedged worker doesn't
   * spam pushes. State lives in this closure's Map; daemon
   * restart resets the cooldowns, which is fine -- a new daemon
   * boot is a real signal that ought to re-fire if the stall is
   * still present. */
  const stallTickMs = Number(
    process.env.DEVNEURAL_STALL_TICK_MS ?? 60_000,
  );
  const stallState = new Map<string, number>();
  async function tickStallWatch(): Promise<void> {
    try {
      const r = await runWorkerStallTick({
        db: store.db,
        jsonlForAnchor,
        readTail: readStallTail,
        log: (m) => logger(m),
        state: stallState,
      });
      if (r.fired.length || r.stalls.length) {
        logger(
          `[stall-watch] evaluated=${r.evaluated} stalled=${r.stalls.length} fired=${r.fired.length} cooldown=${r.cooldown.length}`,
        );
      }
    } catch (err) {
      logger(`[stall-watch] tick failed: ${(err as Error).message}`);
    }
  }
  const stallTimer = setTimeout(() => {
    void tickStallWatch();
    const repeat = setInterval(() => void tickStallWatch(), stallTickMs);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, 120_000);
  if (typeof stallTimer.unref === 'function') {
    stallTimer.unref();
  }

  /* Memory janitor (Wave 3 Lane B step 37 / LX-14). Runs weekly at
   * +20min after boot; staggered so it does not compete with the
   * self-audit and lint timers. Weekly cadence is controlled by
   * DEVNEURAL_JANITOR_INTERVAL_MS (default 7 days). */
  const janitorIntervalMs = Number(
    process.env.DEVNEURAL_JANITOR_INTERVAL_MS ?? 7 * 24 * 60 * 60 * 1000,
  );
  const janitorTimer = setTimeout(() => {
    void (async () => {
      const { runMemoryJanitor } = await import('./lex/memory-janitor.js');
      await runMemoryJanitor(store, logger).catch((err) =>
        logger(`[janitor] failed: ${(err as Error).message}`),
      );
    })();
    const repeat = setInterval(() => {
      void (async () => {
        const { runMemoryJanitor } = await import('./lex/memory-janitor.js');
        await runMemoryJanitor(store, logger).catch((err) =>
          logger(`[janitor] failed: ${(err as Error).message}`),
        );
      })();
    }, janitorIntervalMs);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, 20 * 60 * 1000);
  if (typeof janitorTimer.unref === 'function') janitorTimer.unref();

  /* Personality guard (Wave 3 Lane B step 42 / LX-17). Watches
   * lex-prompts/ for unexpected writes to protected files and applies
   * best-effort icacls deny-write on Windows. Both are fire-and-forget;
   * errors are logged but never block the daemon. */
  let stopPersonalityGuard: (() => void) | null = null;
  try {
    const { startPersonalityGuardWatcher, applyIcacls } = await import('./lex/personality-guard.js');
    stopPersonalityGuard = startPersonalityGuardWatcher(logger);
    applyIcacls(logger);
  } catch (err) {
    logger(`[personality-guard] init failed: ${(err as Error).message}`);
  }
  void stopPersonalityGuard;

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

  /* forceCloseConnections: the /dashboard/events SSE stream pings every
   * 15s, so Fastify's default ('idle') never reclaims it and app.close()
   * blocks until the client's TCP dies. Live proof: both 2026-07-15
   * admin restarts hung 2-4 minutes inside app.close() with a phone tab
   * holding the stream (14:53:40Z request -> 14:57:32Z boot; 23:57:08Z
   * -> 00:01:16Z). `true` destroys active connections at close so
   * shutdown is bounded regardless of connected dashboards. */
  const app = Fastify({ logger: false, forceCloseConnections: true });
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
        /* HTML must NOT be cached. fastify-static's setHeaders only
         * fires for files served BY fastify-static; this hook
         * short-circuits before that runs, so HTML sent here would
         * otherwise inherit the browser's default caching heuristic.
         * iOS Safari + desktop Chrome happily cache an un-headered
         * 200 response, then keep serving the stale shell after a
         * deploy that rotated every chunk hash. Force no-store
         * inline so the early-hook path stays consistent with the
         * fastify-static HTML path. */
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
        reply.header('Pragma', 'no-cache');
        reply.header('Expires', '0');
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

  /* Cross-origin isolation: COOP + COEP unlock SharedArrayBuffer in the
   * dashboard tab, which onnxruntime-web's threaded WASM build needs to
   * grow past the single-thread heap budget. Without these the VAD silero
   * load cascades into `RangeError: Out of memory` on remount. CORP on
   * every response keeps same-origin sub-resources (vad-web wasm/model,
   * Next chunks, service worker, manifest) loadable under COEP
   * require-corp. The dashboard makes no cross-origin requests; if any
   * are added later they must ship CORP same-origin or cross-origin or
   * they will be blocked. */
  app.addHook('onSend', (_req, reply, payload, done) => {
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    done(null, payload);
  });

  await registerDashboardRoutes(app, store, logger);
  app.get('/health', async () => {
    /* Audio block surfaces whether the daemon's STT/TTS workers are
     * usable and whether any browser voice WS is currently bound. The
     * top-level `ok` flag flips to false when a session is bound but
     * the audio workers are dead, so an external probe (or the
     * dashboard reconnect path) can detect a daemon-restart broke voice
     * scenario without having to scrape four separate endpoints. */
    const wsStats = getVoiceWsStats();
    const wh = whisperStatus();
    const pi = piperStatus();
    const workerAlive = wh.ready && pi.configured;
    const sessionBound = wsStats.bound_count > 0;
    const ok = !(sessionBound && !workerAlive);
    return {
      ok,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      phase: 'P3.2-reference-corpus',
      raw_chunks: store.rawChunks.size(),
      wiki_pages: store.wikiPages.size(),
      llm: providerStatus(),
      lint_queue: lintQueueStatus(),
      embedder: embedderStats(),
      audio: {
        worker_alive: workerAlive,
        whisper_ready: wh.ready,
        piper_configured: pi.configured,
        session_bound: sessionBound,
        bound_count: wsStats.bound_count,
        last_tts_ack_ms: wsStats.last_tts_ack_ms,
      },
    };
  });

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
        // Only fall back to SPA HTML for actual browser navigations.
        // If a JSON caller hits an unknown path (e.g. an API endpoint
        // that didn't register because the daemon dist is stale, or a
        // typo), serving index.html with 200 silently masks the bug
        // and the caller parses HTML as JSON. Return a real 404 JSON
        // so the failure is visible.
        const accept = (req.headers.accept ?? '').toLowerCase();
        if (!accept.includes('text/html')) {
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
              /* Mirror the early HTML hook: this fallback also sends
               * HTML via readFileSync, bypassing fastify-static's
               * setHeaders callback. Without no-store the SPA shell
               * gets cached and a deploy that rotated every chunk
               * hash keeps serving the stale wrapper. */
              reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
              reply.header('Pragma', 'no-cache');
              reply.header('Expires', '0');
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
    /* Voice-haiku readiness (2026-07-09). Self-enable the smart voice
     * lane when a key is present so it no longer depends on
     * start-daemon.ps1's env block reaching this process, then log the
     * resolved state - a flat-voice complaint becomes a one-line log
     * check. The key resolves from ANTHROPIC_API_KEY or the BRIDGER
     * fallback. */
    enableVoiceHaikuIfKeyPresent();
    logger(
      `[voice-haiku] enabled=${useVoiceHaiku()} api_key=${voiceApiKey() ? 'present' : 'absent'} flag=${process.env.DEVNEURAL_VOICE_HAIKU ?? 'unset'}`,
    );
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

  /* Dashboard `next dev` supervisor. Manages a single child process
   * running next dev so dashboard edits rebuild without the operator
   * having to remember a separate terminal. Toggle:
   * runtime_config.dashboard_supervisor_enabled (default on;
   * CI=true forces off). The supervisor itself is responsible for
   * the toggle check + the "next bin missing" early-out; this site
   * just calls start and wires stop() into shutdown(). */
  let dashboardSupervisor: DashboardSupervisorHandle | null = null;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dashboardDir = path.resolve(here, '..', '..', '08-dashboard');
    dashboardSupervisor = startDashboardSupervisor({
      db: store.db,
      dashboardDir,
      log: logger,
    });
  } catch (err) {
    logger(`dashboard-supervisor bootstrap failed: ${(err as Error).message}`);
  }

  /* Prompt-archive backfill (step 20 / LX-1). On a fresh checkout the
   * <data>/lex-prompts directory is empty and the A/B replay harness
   * (step 21) has no baseline to compare against. Walk the canonical
   * modes once at boot so every mode has at least one archived body
   * before the first Lex session spawns. On an already-primed install
   * every call is a hash-dedup no-op. Observational: any failure is
   * logged and swallowed because prompt assembly handles its own
   * archive writes during real session spawns. */
  try {
    const { backfillPromptVersions } = await import('./lex/prompt-archive.js');
    const { buildLexSystemPromptStable } = await import('./lex/system-prompt.js');
    const r = backfillPromptVersions((mode) => buildLexSystemPromptStable(mode));
    logger(
      `prompt-archive backfill: written=${r.written} skipped=${r.skipped}${
        r.errors.length ? ' errors=' + r.errors.join('; ') : ''
      }`,
    );
  } catch (err) {
    logger(`prompt-archive backfill failed: ${(err as Error).message}`);
  }

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
  /* Every step is time-boxed and its duration logged. Before 2026-07-15
   * the steps were unbounded awaits; app.close() alone blocked 2-4
   * minutes on live SSE connections and the whole restart stalled with
   * zero evidence of where. A step that overruns its budget is logged
   * and abandoned - restart latency beats a perfect teardown, and the
   * stores flush atomically (.tmp + fsync + rename) so a later hard
   * kill cannot corrupt them. */
  const shutdownStep = async (
    name: string,
    budgetMs: number,
    fn: () => unknown,
  ): Promise<void> => {
    const t0 = Date.now();
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          const t = setTimeout(
            () => reject(new Error('step timeout')),
            budgetMs,
          );
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      logger(`[shutdown] ${name} done in ${Date.now() - t0}ms`);
    } catch (err) {
      const why =
        (err as Error).message === 'step timeout'
          ? `TIMED OUT (budget ${budgetMs}ms)`
          : `failed: ${(err as Error).message}`;
      logger(`[shutdown] ${name} ${why} after ${Date.now() - t0}ms; continuing`);
    }
  };
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger(`received ${signal}; shutting down`);
    /* In-process dead man's switch. Fires only if the bounded steps
     * below somehow wedge the event loop's timers don't - budgets sum
     * to ~37s, so 45s means something is deeply wrong. Runs while the
     * event loop is still alive (this is NOT the post-process.exit
     * timer trap documented in routes.ts - exit hasn't been called
     * yet). unref'd so it never keeps a healthy shutdown alive. */
    const deadMan = setTimeout(() => {
      logger('[shutdown] dead-man watchdog fired at 45s; forcing exit');
      process.exit(0);
    }, 45_000);
    if (typeof deadMan.unref === 'function') deadMan.unref();
    await shutdownStep('app.close', 5_000, () => app.close());
    await shutdownStep('transcripts.stop', 8_000, () => transcripts.stop());
    await shutdownStep('fs-watcher.stop', 8_000, () => fsWatcher.stop());
    await shutdownStep('git-watcher.stop', 2_000, () => gitWatcher.stop());
    await shutdownStep('dashboard-supervisor.stop', 6_000, () =>
      dashboardSupervisor ? dashboardSupervisor.stop() : undefined,
    );
    await shutdownStep('cancelled-tool-recovery.stop', 2_000, () =>
      cancelledToolRecoveryHandle ? cancelledToolRecoveryHandle.stop() : undefined,
    );
    await shutdownStep('grooming.stop', 2_000, () =>
      groomingHandle ? groomingHandle.stop() : undefined,
    );
    await shutdownStep('projects-watcher.stop', 2_000, () => projectsWatcherStop());
    await shutdownStep('store.close', 10_000, () => store.close());
    try {
      const pid = readPid();
      if (pid === process.pid) {
        fs.unlinkSync(daemonPidFile());
      }
    } catch {
      /* ignore */
    }
    logger('[shutdown] complete; exiting');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /* Expose the graceful shutdown to route handlers (e.g.
   * /admin/daemon/restart). Without this, an admin restart can only
   * call process.exit(0), which hangs on Windows when chokidar's
   * recursive watch holds open ReadDirectoryChangesW handles on
   * C:/dev/Projects. Routing through `shutdown` properly awaits
   * watcher.close(), app.close(), store.close() before exit. */
  setShutdownHook(shutdown);
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
