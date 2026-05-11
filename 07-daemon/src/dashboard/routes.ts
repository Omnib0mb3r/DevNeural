/**
 * Dashboard routes registration.
 *
 * One function that wires every Phase 3 endpoint onto the existing
 * Fastify instance owned by the daemon. Auth middleware applied to
 * every route except the small public set in auth.ts.
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
import { authMiddleware, registerAuthRoutes, isPinSet } from './auth.js';
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
} from './pty-host.js';
import {
  buildLexSystemPrompt,
  buildLexSystemPromptVersioned,
} from '../lex/system-prompt.js';
import {
  listBrainstorms,
  getBrainstorm,
  setLabel as setBrainstormLabel,
  setMode as setBrainstormMode,
  endBrainstorm,
  appendArtifact as appendBrainstormArtifact,
  setStore as setBrainstormStore,
  reapAllActive as reapAllActiveBrainstorms,
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
import { attachLexVoiceWs } from '../voice/lex-voice-ws.js';
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

  /* Background poll that binds a daemon-owned PTY to its claude
   * session_id once the .jsonl file appears. Single global timer; no
   * cost when no PTYs are unbound. */
  startSessionDiscoveryProbe();

  /* Hand the brainstorm-store the live Store reference so its helper
   * functions (used by pty-host on spawn, used by /lex/sessions
   * routes, eventually used by voice WS) can talk to SQLite without
   * threading the store through every layer. */
  setBrainstormStore(store);

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

  // Auth middleware on every request before route handlers
  app.addHook('preHandler', (req, reply, done) => {
    authMiddleware(req, reply, done);
  });

  registerAuthRoutes(app);

  // ── Dashboard surface ─────────────────────────────────────────────
  app.get('/dashboard/health', async () => {
    const metrics = await getSystemMetrics();
    const services = await checkAll();
    return {
      ok: true,
      pin_set: isPinSet(),
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
    const body = req.body as { text?: string };
    if (!body.text || typeof body.text !== 'string') {
      reply.code(400);
      return { ok: false, error: 'text required' };
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
    const body = req.body as { text?: string };
    if (!body.text || typeof body.text !== 'string') {
      reply.code(400);
      return { ok: false, error: 'text required' };
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
    const n = emitNotification({
      severity: pulse.severity,
      source: 'lex',
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

  /* Brainstorm session endpoints (Slice A). First-class records so
   * each Lex spawn gets a label, lifecycle, mode, and artifact list
   * the dashboard + retrieval can use as a key into the transcript
   * RAG. See codex review for context. */
  app.get('/lex/sessions', async (req) => {
    const q = (req.query ?? {}) as { status?: string; limit?: string };
    const status =
      q.status === 'active' || q.status === 'ended' ? q.status : undefined;
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 50;
    return { ok: true, sessions: listBrainstorms({ status, limit }) };
  });

  app.get('/lex/sessions/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getBrainstorm(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    return { ok: true, session: row };
  });

  app.patch('/lex/sessions/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      user_label?: string | null;
      derived_label?: string | null;
      mode?: string;
      status?: 'ended';
      summary?: string;
    };
    let row;
    if (
      body.user_label !== undefined ||
      body.derived_label !== undefined
    ) {
      row = setBrainstormLabel(id, {
        user_label: body.user_label,
        derived_label: body.derived_label,
      });
    }
    if (body.mode) row = setBrainstormMode(id, body.mode) ?? row;
    if (body.status === 'ended') {
      row = endBrainstorm(id, body.summary) ?? row;
    }
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    return { ok: true, session: row };
  });

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
       * conversation is restored verbatim. Skipped if missing OR if
       * the brainstorm row never bound a claude_session_id (PTY died
       * before its jsonl appeared). The dashboard's "resume" button
       * passes row.claude_session_id when present. */
      resume_session_id?: string;
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
      });
      log(
        `[lex] spawn ptyId=${r.ptyId} pid=${r.pid} cwd=${cwd}${
          resumeId ? ` resume=${resumeId}` : ''
        }`,
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
    return {
      ok: true,
      scope: body.scope ?? 'all',
      results: page.results,
      groups: page.groups ?? [],
      total: page.total,
      limit: page.limit,
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
    };
    if (!body.q || !body.q.trim()) {
      reply.code(400);
      return { ok: false, error: 'q required' };
    }
    const { chunkSearch } = await import('../lex/chunk-retrieval.js');
    const result = await chunkSearch(store, body.q.trim(), {
      limit: typeof body.limit === 'number' ? body.limit : 3,
      brainstorm_id: body.brainstorm_id,
    });
    return { ok: true, ...result };
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
    const body = (req.body ?? {}) as { text?: string; commit?: boolean };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      reply.code(400);
      return { ok: false, error: 'text required' };
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

  app.get('/lex/snapshot', async () => {
    const sessions = listSessions().filter((s) => s.active);
    const brainstorms = listBrainstorms({ status: 'active', limit: 20 });
    const ptyInfo = listPtys();
    const env = process.env;
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
      },
      active_brainstorms: brainstorms.map((b) => ({
        id: b.id,
        label: b.user_label ?? b.derived_label,
        mode: b.mode,
        started_ms: b.started_ms,
      })),
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
    const limit = Number((req.query as { limit?: string }).limit ?? '50');
    return { ok: true, notifications: listNotifications({ limit }) };
  });

  app.post('/notifications', async (req, reply) => {
    const body = req.body as {
      severity?: 'info' | 'warn' | 'alert';
      source?: string;
      title?: string;
      body?: string;
      link?: string;
    };
    if (!body.title || !body.severity || !body.source) {
      reply.code(400);
      return { ok: false, error: 'severity, source, title required' };
    }
    return {
      ok: true,
      notification: emitNotification({
        severity: body.severity,
        source: body.source,
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
    const body = (req.body ?? {}) as { dangerous?: boolean };
    const { getProject } = await import('../identity/registry.js');
    const proj = getProject(id);
    if (!proj || !proj.root) {
      reply.code(404);
      return { ok: false, error: `project ${id} not found in registry` };
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
  /* These endpoints are gated behind authMiddleware (registered above on
   * preHandler). They kick off long-running in-process work and return
   * immediately; clients poll /admin/backfill/status for progress. Single
   * -flight per mode; calling start while one is running is a no-op. */
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
    const inline = `Start-Sleep -Seconds 2; & '${startScript.replace(/'/g, "''")}'`;
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
    setTimeout(() => {
      log('[admin] daemon restart requested via /admin/daemon/restart; exiting');
      process.exit(0);
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
    return { ok: true, brainstorm: decorateBrainstorm(row) };
  });

  /* Wave 3 fixup (bug: 2026-05-10-brainstorm-picker-and-transcripts).
   * Return the brainstorm_chunks rows for a session so the dashboard can
   * render the text transcript alongside the audio player. limit is
   * capped to 1000 (one chunk per turn; 1000 is well above any real
   * session's turn count). Embedding vectors are not returned; only the
   * text + metadata. */
  app.get('/brainstorms/:id/chunks', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { limit?: string };
    const limit = Math.min(1000, Math.max(1, Number(q.limit ?? 200) || 200));
    const row = store.db.getBrainstorm(id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'not found' };
    }
    const chunks = store.db.listBrainstormChunks(id, limit);
    return { ok: true, chunks };
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
      commit?: boolean;
    };
    if (!body.target_session || typeof body.target_session !== 'string') {
      reply.code(400);
      return { ok: false, error: 'target_session required' };
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
    const { crossSessionInject } = await import('../lex/cross-session-inject.js');
    const result = crossSessionInject(
      {
        target_session: body.target_session,
        token: body.token,
        text: body.text,
        caller_label: body.caller_label,
        commit: body.commit !== false,
      },
      store.db,
    );
    if (!result.ok) {
      const code =
        result.decision === 'rejected_auth'
          ? 401
          : result.decision === 'rejected_allowlist'
            ? 403
            : 422;
      reply.code(code);
    }
    return result;
  });

  app.post('/auth/cross-session-token', async (req, reply) => {
    const body = (req.body ?? {}) as { target_session?: string };
    if (!body.target_session || typeof body.target_session !== 'string') {
      reply.code(400);
      return { ok: false, error: 'target_session required' };
    }
    const { issueToken } = await import('../lex/cross-session-inject.js');
    return {
      ok: true,
      token: issueToken(body.target_session),
      target_session: body.target_session,
      valid_for_s: 120,
    };
  });

  app.get('/lex/injection-log', async (req) => {
    const q = (req.query ?? {}) as {
      target_session?: string;
      decision?: string;
      limit?: string;
    };
    const opts: Parameters<typeof store.db.listCrossSessionLogs>[0] = {};
    if (q.target_session) opts.target_session = q.target_session;
    if (q.decision) {
      opts.decision = q.decision as 'accepted' | 'rejected_auth' | 'rejected_allowlist' | 'rejected_pty';
    }
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
