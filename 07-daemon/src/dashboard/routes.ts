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
import { DATA_ROOT } from '../paths.js';
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
import {
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  listSubscriptions,
} from './push.js';

export async function registerDashboardRoutes(
  app: FastifyInstance,
  store: Store,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const referenceStore = await ReferenceStore.open(log);
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
    const liveSlugs = new Set(
      sessions
        .filter((s) => s.active)
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
      },
      referenceStore,
    );
    return {
      ok: true,
      results: page.results,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
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
    /* Also open VS Code if it isn't already on this workspace. We
     * can't reliably detect that from the daemon, so we always fire
     * `code <path>` and let VS Code be a no-op when the window is
     * already focused on the workspace. shell:true for the same
     * Windows .cmd-shim reason as createProject. */
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn('code', [proj.root], {
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

  app.post('/admin/backfill/:mode/cancel', async (req, reply) => {
    const mode = (req.params as { mode: string }).mode;
    if (mode !== 'raw' && mode !== 'wiki') {
      reply.code(400);
      return { ok: false, error: 'mode must be raw or wiki' };
    }
    requestBackfillCancel(mode);
    return { ok: true };
  });

  // Use the notification event bus to suppress unused-import lint
  void notificationEvents;
}
