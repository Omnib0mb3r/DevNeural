/**
 * Project anchor REST endpoints (PROJECT-ANCHORS.md step 3 of 6).
 *
 * - GET    /projects               list anchors
 * - GET    /projects/:id           anchor detail + transcript refs
 * - POST   /projects/:id/open      spawn-or-bind (openInFlight memoised)
 * - POST   /projects/:id/end       flip dormant + clear current_* fields
 * - PATCH  /projects/:id           rename (title only)
 * - DELETE /projects/:id           cascade delete
 *
 * Spawn path reuses the existing workspace-inject marker pipeline that
 * `/projects/:id/start-claude` already wires up: queue a marker with
 * the claude command, then launch `code -n <cwd>` so a bridge-bearing
 * VS Code window definitely exists to claim the marker. The bridge
 * presence reconcile loop flips the anchor's status to live as soon
 * as the new window's bridge writes its first presence file.
 *
 * The endpoint polls the anchor row for status='live' up to a small
 * timeout so the response carries the bound bridge id. If the window
 * takes longer than the timeout (slow VS Code start), the endpoint
 * still returns ok=true with mode='spawning' so the dashboard knows
 * the workspace-inject was queued; subsequent /projects/:id polls
 * will see status='live' as soon as the bridge reports presence.
 */
import type { FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { IndexDb, ProjectSessionRow } from '../store/index-db.js';
import { decodeBridgeMarker } from './bridge-presence.js';
import { queueProjectBootstrap } from './projects-new.js';
import { listProjectAnchorTiles } from './projects-anchor-tiles.js';

const DEFAULT_OPEN_WAIT_MS = 5_000;
const DEFAULT_OPEN_POLL_MS = 200;

export interface ProjectAnchorView {
  id: string;
  project_slug: string;
  cwd: string;
  title: string | null;
  status: 'live' | 'dormant';
  current_session_id: string | null;
  current_bridge_id: string | null;
  bridge_connection_count: number;
  current_pty_id: string | null;
  created_ms: number;
  last_seen_ms: number;
  exists_on_disk: boolean;
  supervision_mode: 'polling' | 'event' | 'off';
}

export function toAnchorView(
  row: ProjectSessionRow,
  defaultSupervisionMode: 'polling' | 'event' | 'off' = 'polling',
): ProjectAnchorView {
  const decoded = decodeBridgeMarker(row.current_bridge_id);
  let exists = false;
  try {
    exists = fs.existsSync(row.cwd);
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    project_slug: row.project_slug,
    cwd: row.cwd,
    title: row.title,
    status: row.status,
    current_session_id: row.current_session_id,
    current_bridge_id: decoded.primaryBridgeId,
    bridge_connection_count: decoded.count,
    current_pty_id: row.current_pty_id,
    created_ms: row.created_ms,
    last_seen_ms: row.last_seen_ms,
    exists_on_disk: exists,
    supervision_mode: (row.supervision_mode ?? defaultSupervisionMode) as
      | 'polling'
      | 'event'
      | 'off',
  };
}

export interface ListOptions {
  status?: 'live' | 'dormant';
  limit?: number;
}

export function listProjectAnchors(
  db: IndexDb,
  opts: ListOptions = {},
): ProjectAnchorView[] {
  const defaultMode = db.getDefaultSupervisionMode();
  return db.listProjectSessions(opts).map((row) => toAnchorView(row, defaultMode));
}

export function getProjectAnchorDetail(
  db: IndexDb,
  id: string,
): { anchor: ProjectAnchorView; transcripts: ReturnType<IndexDb['listProjectTranscriptRefs']> } | null {
  const row = db.getProjectSession(id);
  if (!row) return null;
  return {
    anchor: toAnchorView(row, db.getDefaultSupervisionMode()),
    transcripts: db.listProjectTranscriptRefs(id),
  };
}

export interface OpenOptions {
  dangerous?: boolean;
  /** Override for tests: skip the `code -n` window launch (the
   * spawn-or-bind contract still queues the workspace-inject marker
   * either way). */
  launchVsCode?: boolean;
  /** How long to wait for the bridge presence loop to flip the anchor
   * live after queueing the workspace-inject marker. */
  waitMs?: number;
  pollMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Injectable bootstrap queue. Defaults to the production
   * queueProjectBootstrap. Tests pass a stub so DATA_ROOT, which is
   * captured at paths.ts load time and cannot be re-aliased via env
   * after the daemon imports it, doesn't leak production marker
   * writes into the test temp dir. */
  bootstrapQueue?: (cwd: string, command: string) => void;
}

export interface OpenResult {
  ok: true;
  mode: 'bind' | 'spawn' | 'spawning';
  anchor: ProjectAnchorView;
  command?: string;
  warnings?: string[];
}

export interface OpenError {
  ok: false;
  error: string;
}

async function pollAnchorLive(
  db: IndexDb,
  id: string,
  waitMs: number,
  pollMs: number,
  now: () => number,
): Promise<ProjectSessionRow> {
  const deadline = now() + waitMs;
  while (now() < deadline) {
    const row = db.getProjectSession(id);
    if (row && row.status === 'live') return row;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  /* Last read so the caller sees the latest known state even on
   * timeout. */
  return db.getProjectSession(id) as ProjectSessionRow;
}

/* Shared concurrency guard: collapses concurrent /open calls per
 * anchor into one spawn. Mirrors the lex_session openInFlight Map. */
export type OpenInFlightMap = Map<string, Promise<OpenResult | OpenError>>;

export function createOpenInFlightMap(): OpenInFlightMap {
  return new Map();
}

export async function openProjectAnchor(
  db: IndexDb,
  id: string,
  opts: OpenOptions,
  inflight: OpenInFlightMap,
): Promise<OpenResult | OpenError> {
  const row = db.getProjectSession(id);
  if (!row) {
    return { ok: false, error: 'anchor not found' };
  }
  if (row.status === 'live' && row.current_bridge_id) {
    return {
      ok: true,
      mode: 'bind',
      anchor: toAnchorView(row, db.getDefaultSupervisionMode()),
    };
  }
  const existing = inflight.get(id);
  if (existing) return existing;

  const now = opts.now ?? Date.now;
  const promise = (async (): Promise<OpenResult | OpenError> => {
    const command = opts.dangerous
      ? 'claude --dangerously-skip-permissions'
      : 'claude';
    const warnings: string[] = [];
    const bootstrap = opts.bootstrapQueue ?? queueProjectBootstrap;
    try {
      bootstrap(row.cwd, command);
    } catch (err) {
      return {
        ok: false,
        error: `failed to queue workspace inject: ${(err as Error).message}`,
      };
    }

    /* Launch VS Code with -n so a fresh window opens at the cwd. The
     * bridge in that window picks up the workspace-inject marker on
     * its next tick and runs `claude`. Failure is non-fatal: the
     * marker is queued either way; the user just has to open the
     * folder manually. */
    if (opts.launchVsCode !== false) {
      try {
        const child = spawn('code', ['-n', row.cwd], {
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
    }

    const waitMs = opts.waitMs ?? DEFAULT_OPEN_WAIT_MS;
    const pollMs = opts.pollMs ?? DEFAULT_OPEN_POLL_MS;
    const final = await pollAnchorLive(db, id, waitMs, pollMs, now);
    const mode: OpenResult['mode'] = final.status === 'live' ? 'spawn' : 'spawning';
    return {
      ok: true,
      mode,
      anchor: toAnchorView(final, db.getDefaultSupervisionMode()),
      command,
      warnings: warnings.length ? warnings : undefined,
    };
  })();
  inflight.set(id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(id);
  }
}

export interface EndOptions {
  now?: () => number;
}

export function endProjectAnchor(
  db: IndexDb,
  id: string,
  opts: EndOptions = {},
): ProjectAnchorView | null {
  const row = db.getProjectSession(id);
  if (!row) return null;
  const nowMs = (opts.now ?? Date.now)();
  const updated = db.updateProjectSession(id, {
    status: 'dormant',
    current_bridge_id: null,
    current_session_id: null,
    current_pty_id: null,
    last_seen_ms: nowMs,
  });
  return updated ? toAnchorView(updated, db.getDefaultSupervisionMode()) : null;
}

export interface PatchOptions {
  title?: string | null;
  supervision_mode?: 'polling' | 'event' | 'off';
}

export function patchProjectAnchor(
  db: IndexDb,
  id: string,
  patch: PatchOptions,
): ProjectAnchorView | null {
  const row = db.getProjectSession(id);
  if (!row) return null;
  const defaultMode = db.getDefaultSupervisionMode();
  const updates: Partial<typeof row> = {};
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.supervision_mode !== undefined) {
    if (
      patch.supervision_mode !== 'polling' &&
      patch.supervision_mode !== 'event' &&
      patch.supervision_mode !== 'off'
    ) {
      return toAnchorView(row, defaultMode);
    }
    updates.supervision_mode = patch.supervision_mode;
  }
  if (Object.keys(updates).length === 0) return toAnchorView(row, defaultMode);
  const updated = db.updateProjectSession(id, updates);
  return updated ? toAnchorView(updated, defaultMode) : null;
}

export function deleteProjectAnchor(db: IndexDb, id: string): boolean {
  const row = db.getProjectSession(id);
  if (!row) return false;
  db.deleteProjectSession(id);
  return true;
}

export function registerProjectAnchorRoutes(
  app: FastifyInstance,
  db: IndexDb,
  log: (msg: string) => void = () => undefined,
): void {
  const inflight = createOpenInFlightMap();

  /* Stream Deck feed. One tile per live anchor, deduped so multiple
   * VS Code windows on the same cwd render as a single tile with a
   * bridge_connection_count badge. Mirrors /lex/anchor-tiles. */
  app.get('/projects/anchor-tiles', async () => {
    return { ok: true, tiles: listProjectAnchorTiles(db) };
  });

  /* GET /projects (bare list) collides with the legacy registry-backed
   * route in daemon.ts; fastify rejects duplicate route registrations and
   * the daemon crashes on boot. The legacy shape is the one the dashboard
   * already consumes via daemon-client.projects(); the anchor list here
   * had no source-level callers as of 2026-05-13. Keep the per-anchor
   * routes (/:id, /:id/open, etc.) which the dashboard does need. */
  // app.get('/projects', async (req) => { ...listProjectAnchors... });

  app.get('/projects/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const detail = getProjectAnchorDetail(db, id);
    if (!detail) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    return { ok: true, anchor: detail.anchor, transcripts: detail.transcripts };
  });

  app.post('/projects/:id/open', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { dangerous?: boolean };
    const result = await openProjectAnchor(
      db,
      id,
      { dangerous: body.dangerous },
      inflight,
    );
    if (!result.ok) {
      reply.code(result.error === 'anchor not found' ? 404 : 500);
      return result;
    }
    log(`[projects] open anchor=${id} mode=${result.mode}`);
    return result;
  });

  app.post('/projects/:id/end', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const view = endProjectAnchor(db, id);
    if (!view) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    log(`[projects] end anchor=${id}`);
    return { ok: true, anchor: view };
  });

  app.patch('/projects/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      title?: string | null;
      supervision_mode?: 'polling' | 'event' | 'off';
    };
    const view = patchProjectAnchor(db, id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.supervision_mode !== undefined
        ? { supervision_mode: body.supervision_mode }
        : {}),
    });
    if (!view) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    return { ok: true, anchor: view };
  });

  app.delete('/projects/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = deleteProjectAnchor(db, id);
    if (!ok) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    log(`[projects] delete anchor=${id}`);
    return { ok: true };
  });
}
