/**
 * Bridge presence resolver (PROJECT-ANCHORS.md step 2 of 6).
 *
 * The VS Code bridge extension writes one presence file per window
 * under <bridgeDir>/.bridge-presence/<workspace-key>.json on its tick
 * loop. Each file carries:
 *   {
 *     workspace: "C:/dev/Projects/DevNeural",
 *     cwd:       "C:/dev/Projects/DevNeural",
 *     bridge_id: "<window-stable-uuid>",
 *     cc_session_ids: ["<cc-uuid>", ...],   // optional
 *     updated_at: "2026-05-11T23:00:00.000Z"
 *   }
 *
 * Daemon side runs reconcileBridgePresence on a timer (default 1s).
 * For every presence file whose mtime is within BRIDGE_TIMEOUT_MS
 * (default 30s), it resolves the matching project_session anchor by
 * cwd and flips it live, recording the most recently bound CC session
 * UUID in current_session_id and the connection count in
 * current_bridge_id (encoded as "primary-bridge-id|count" so a single
 * column still serves Stream Deck dedupe without a join). Anchors that
 * were live but have no fresh presence file flip back to dormant and
 * get their current_* fields cleared. last_seen_ms updates on every
 * transition.
 *
 * The presence file format is forward-compatible: extra fields are
 * ignored, missing optional fields default safely. cwd is normalised
 * the same way migration 019 does (forward slashes, no trailing
 * slash) so equality comparisons work across the daemon, bridge, and
 * Stream Deck identity files.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndexDb, ProjectSessionRow } from '../store/index-db.js';
import { DATA_ROOT } from '../paths.js';
import { ensureAnchorForCwd } from './seed-project-anchors.js';

export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
export const BRIDGE_PRESENCE_SUBDIR = '.bridge-presence';

export interface BridgePresenceFile {
  workspace?: string;
  cwd?: string;
  bridge_id?: string;
  cc_session_ids?: string[];
  cc_session_id?: string;
  updated_at?: string;
  /* Bug 3d (2026-05-22): per-UUID deliverability flag emitted by
   * bridges >= 2026-05-22. Absent on older bridges; consumers must
   * treat absence as "unknown" (migration grace) rather than false. */
  has_terminal_for_uuid?: Record<string, boolean>;
}

export interface BridgePresenceRecord {
  bridgeId: string;
  cwd: string;
  ccSessionIds: string[];
  fileMtimeMs: number;
  updatedAtMs: number;
  /* Bug 3d (2026-05-22): null on old bridges (no field shipped),
   * empty record on new bridges that explicitly reported no
   * deliverability. The distinction matters: null => migration grace
   * applies, {} => bridge said "I have NO terminal for any UUID I'm
   * claiming." */
  hasTerminalForUuid: Record<string, boolean> | null;
}

export interface ReconcileResult {
  liveCwds: string[];
  liveAnchorIds: string[];
  dormantAnchorIds: string[];
  /** Total fresh presence records read this pass, before grouping by
   * cwd (i.e. one per bridge window, not one per anchor). Surfaced so
   * the heartbeat log in startBridgePresenceLoop can report activity
   * without a second directory read. */
  presenceRecordCount: number;
}

export interface ReconcileOptions {
  /** Override bridge presence directory (defaults to DATA_ROOT/session-bridge/.bridge-presence). */
  presenceDir?: string;
  /** Freshness window (ms). Files older than this count as gone. */
  freshMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Resolve a CC session id to its on-disk jsonl path. Defaults to
   * scanning ~/.claude/projects/<slug>/<cc>.jsonl. Tests can override
   * to avoid touching the user's transcript dir. */
  resolveJsonlPath?: (ccSessionId: string) => string;
  /** VB-2 (2026-07-18): backfill current_session_id for a fresh live
   * worker whose bridge presence file has not yet listed a cc session
   * id. Given the anchor cwd + clock + freshness window, resolve the
   * most-recent ACTIVE cc session (newest jsonl written within freshMs)
   * under the project's ~/.claude/projects dir, or null when none is
   * active. Injected for tests; the filesystem default scans the claude
   * projects dir. */
  resolveLiveSessionForCwd?: (
    cwd: string,
    nowMs: number,
    freshMs: number,
  ) => string | null;
}

/* VB-2 default resolver: map an anchor cwd to its ~/.claude/projects
 * dir and return the newest jsonl written within `freshMs` (an active
 * session), or null. Claude Code names each project dir by replacing
 * every non-alphanumeric char in the cwd with '-', preserving the
 * drive-letter case however the cwd was cased when CC started - the
 * same c:/ vs C:/ divergence normalizeCwd papers over - so the slug is
 * matched case-INSENSITIVELY. The freshness window is the "a session
 * is active" gate: a stale jsonl from a prior worker cannot bind. */
export function defaultResolveLiveSessionForCwd(
  cwd: string,
  nowMs: number,
  freshMs: number,
): string | null {
  const root = defaultClaudeProjectsDir();
  if (!fs.existsSync(root)) return null;
  const wantSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  let slugs: string[];
  try {
    slugs = fs.readdirSync(root);
  } catch {
    return null;
  }
  const dirName = slugs.find((s) => s.toLowerCase() === wantSlug);
  if (!dirName) return null;
  const dir = path.posix.join(root, dirName);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: { id: string; mtimeMs: number } | null = null;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.posix.join(dir, f));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (nowMs - stat.mtimeMs > freshMs) continue; /* not an active session */
    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { id: f.replace(/\.jsonl$/, ''), mtimeMs: stat.mtimeMs };
    }
  }
  return best?.id ?? null;
}

function normalizeCwd(cwd: string): string {
  /* Canonicalise the Windows drive letter to uppercase. VS Code reports
   * folder fsPaths with a lowercase drive ("c:/dev/Projects/LPCC") while
   * the anchor seed + project registry store uppercase ("C:/dev/..."),
   * so a bridge presence cwd never matched its anchor and the project
   * stayed dormant despite a live, correctly-written presence file.
   * Windows paths are case-insensitive; canonicalising here keeps the
   * presence-side and DB-side equality comparison in lockstep. */
  return cwd
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
}

/* R3 fix (2026-07-14): production carried TWO project_session rows
 * for the same directory differing only by drive-letter case
 * ('c:/dev/Projects/DevNeural' vs 'C:/dev/Projects/DevNeural') -- a
 * normalizeCwd bypass that predates consistent normalization in this
 * file. getProjectSessionByCwd does an exact `cwd = ?` match, so a
 * stale mixed-case row on disk is invisible to a normalized lookup;
 * pre-fix that miss fell through to ensureAnchorForCwd and minted a
 * SECOND anchor for the same directory, and the duplicate never
 * healed itself on later reconciles. Scan for a case-insensitive
 * match before conceding "not found" so an old mixed-case row gets
 * reused instead of duplicated. Reuses the normalizeCwd already
 * defined in this file; does not introduce a second implementation. */
function findAnchorByCwd(
  db: IndexDb,
  cwd: string,
): ProjectSessionRow | null {
  const normalized = normalizeCwd(cwd);
  const exact = db.getProjectSessionByCwd(normalized);
  if (exact) return exact;
  const all = db.listProjectSessions({ limit: 100_000 });
  return all.find((row) => normalizeCwd(row.cwd) === normalized) ?? null;
}

function defaultClaudeProjectsDir(): string {
  return path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  );
}

function defaultResolveJsonlPath(ccSessionId: string): string {
  const root = defaultClaudeProjectsDir();
  if (fs.existsSync(root)) {
    let slugs: string[] = [];
    try {
      slugs = fs.readdirSync(root);
    } catch {
      slugs = [];
    }
    for (const slug of slugs) {
      const candidate = path.posix.join(root, slug, `${ccSessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  /* Fall back to a deterministic path under the projects root so the
   * tile renderer's tail-phase resolver can quietly return 'unknown'
   * for sessions whose jsonl hasn't been written yet. */
  return path.posix.join(root, 'unknown', `${ccSessionId}.jsonl`);
}

export function defaultPresenceDir(): string {
  return path.posix.join(
    DATA_ROOT.replace(/\\/g, '/'),
    'session-bridge',
    BRIDGE_PRESENCE_SUBDIR,
  );
}

export function readPresenceDir(
  dir: string,
  now: number,
  freshMs: number,
): BridgePresenceRecord[] {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BridgePresenceRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const full = path.posix.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs > freshMs) continue;
    let parsed: BridgePresenceFile;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf-8')) as BridgePresenceFile;
    } catch {
      continue;
    }
    const cwd = parsed.cwd ?? parsed.workspace;
    const bridgeId = parsed.bridge_id;
    if (!cwd || !bridgeId) continue;
    const ccSessionIds: string[] = [];
    if (Array.isArray(parsed.cc_session_ids)) {
      for (const id of parsed.cc_session_ids) {
        if (typeof id === 'string' && id) ccSessionIds.push(id);
      }
    }
    if (typeof parsed.cc_session_id === 'string' && parsed.cc_session_id) {
      ccSessionIds.push(parsed.cc_session_id);
    }
    const updatedAtMs = parsed.updated_at
      ? Date.parse(parsed.updated_at)
      : stat.mtimeMs;
    let hasTerminalForUuid: Record<string, boolean> | null = null;
    if (parsed.has_terminal_for_uuid && typeof parsed.has_terminal_for_uuid === 'object') {
      hasTerminalForUuid = {};
      for (const [k, v] of Object.entries(parsed.has_terminal_for_uuid)) {
        if (typeof k === 'string' && typeof v === 'boolean') {
          hasTerminalForUuid[k] = v;
        }
      }
    }
    out.push({
      bridgeId,
      cwd: normalizeCwd(cwd),
      ccSessionIds,
      fileMtimeMs: stat.mtimeMs,
      updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : stat.mtimeMs,
      hasTerminalForUuid,
    });
  }
  return out;
}

export function groupByCwd(
  records: BridgePresenceRecord[],
): Map<string, BridgePresenceRecord[]> {
  const out = new Map<string, BridgePresenceRecord[]>();
  for (const r of records) {
    const list = out.get(r.cwd);
    if (list) list.push(r);
    else out.set(r.cwd, [r]);
  }
  return out;
}

/* Encoded current_bridge_id format: "<primary-bridge-id>|<count>".
 * Older readers that only know about the UUID still split on '|' and
 * take the first segment. Count = number of distinct bridges
 * currently reporting presence for this anchor's cwd. */
function encodeBridgeMarker(
  records: BridgePresenceRecord[],
): { marker: string; primary: BridgePresenceRecord } {
  const sorted = [...records].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs,
  );
  const primary = sorted[0]!;
  const count = records.length;
  const marker = count > 1 ? `${primary.bridgeId}|${count}` : primary.bridgeId;
  return { marker, primary };
}

export function reconcileBridgePresence(
  db: IndexDb,
  opts: ReconcileOptions = {},
): ReconcileResult {
  const dir = opts.presenceDir ?? defaultPresenceDir();
  const fresh = opts.freshMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  const now = (opts.now ?? Date.now)();
  const resolveJsonlPath = opts.resolveJsonlPath ?? defaultResolveJsonlPath;
  const resolveLiveSessionForCwd =
    opts.resolveLiveSessionForCwd ?? defaultResolveLiveSessionForCwd;
  const records = readPresenceDir(dir, now, fresh);
  const byCwd = groupByCwd(records);

  const liveCwds: string[] = [];
  const liveAnchorIds: string[] = [];
  const dormantAnchorIds: string[] = [];

  /* Pass 1: flip matching anchors to live, fill current_*. Track the
   * set of anchor ids we touched so pass 2 can flip anything else
   * back to dormant. */
  const touched = new Set<string>();
  for (const [cwd, recs] of byCwd) {
    let anchor = findAnchorByCwd(db, cwd);
    if (!anchor) {
      /* PROJECT-ANCHORS.md `## Seeding`: bridge reports a cwd no
       * boot seed pass has covered (new top-level dir created after
       * boot, or a workspace outside DEVNEURAL_PROJECTS_ROOT).
       * Auto-create the anchor inline so this same pass can flip it
       * live; otherwise the bridge would be silently dropped until
       * the next boot. This replaces the prior `continue` drop. */
      const created = ensureAnchorForCwd(db, cwd, { now });
      if (!created) {
        /* Race: another tick created the row between our lookup and
         * our insert attempt. Re-read; if still missing the helper
         * itself failed (read-only DB, FK constraint) and there is
         * nothing more we can do here. */
        anchor = findAnchorByCwd(db, cwd);
        if (!anchor) continue;
      } else {
        anchor = created;
      }
    }
    const { marker, primary } = encodeBridgeMarker(recs);
    /* current_session_id: prefer the most recently updated record's
     * first cc session id. If none reports one, leave the existing
     * value alone so we don't blank out a known UUID just because
     * the bridge hasn't shipped that field yet. */
    const priorSession = anchor.current_session_id;
    let currentSession = priorSession;
    const claimed = primary.ccSessionIds;
    if (claimed.length === 1) {
      /* Unambiguous single claim: trust the bridge's one cc id. Fast
       * path - no disk scan (see the WIRE branch below for why the
       * multi-claim case cannot). */
      currentSession = claimed[0]!;
    } else if (claimed.length > 1) {
      /* WIRE (2026-07-19): the bridge window listed MULTIPLE cc sessions
       * for this cwd - across a worker /clear or restart it still lists
       * the RETIRED sibling next to the live one, in file order, which
       * is NOT recency. A blind ccSessionIds[0] can therefore pin a
       * STALE uuid as the anchor's ONE live-worker binding
       * (current_session_id), and every surface that reads it then
       * points at a dead transcript: inject/supervision resolution, GET
       * /sessions liveness, the Workers panel's supervised/nested state,
       * and the terminal mirror's ring key. Rank the authoritative
       * newest-active-jsonl signal (the SAME source the dashboard
       * already trusts - resolveLiveSessionForCwd) ABOVE the bridge's
       * array order, scoped to the claimed set so an unrelated session
       * active in the same folder (a bare `claude` run outside the
       * dashboard) can never hijack the binding. */
      const authoritative = resolveLiveSessionForCwd(cwd, now, fresh);
      currentSession =
        authoritative && claimed.includes(authoritative)
          ? authoritative
          : claimed[0]!;
    } else if (!priorSession) {
      /* VB-2 (2026-07-18): the bridge reports presence for this cwd but
       * has not listed a cc session id yet, and the anchor has none.
       * Without a backfill the anchor flips 'live' with a null
       * current_session_id, so anchor-tiles omits the tile, inject
       * auto-target returns 422 bound-project-dormant, and the
       * supervisor label renders an empty worker= for the whole window.
       * Resolve the fresh worker's active cc session from disk so
       * supervision binds promptly. Only fires when the anchor has no
       * session at all (never overrides a known binding); a later
       * bridge cc report takes precedence above. */
      const resolved = resolveLiveSessionForCwd(cwd, now, fresh);
      if (resolved) currentSession = resolved;
    }
    /* Fix 15 — preserve the prior uuid so /lex/inject-cross-session
     * can map a stale uuid back to this anchor and redirect to the
     * live session. Only update when the uuid actually changed; a
     * no-op rebind shouldn't clobber a still-useful history pointer. */
    const previousSessionPatch =
      priorSession && currentSession && priorSession !== currentSession
        ? { previous_session_id: priorSession }
        : {};
    db.updateProjectSession(anchor.id, {
      status: 'live',
      current_bridge_id: marker,
      current_session_id: currentSession,
      last_seen_ms: now,
      ...previousSessionPatch,
    });
    /* Transcript-ref bookkeeping. Anchor just bound a CC session UUID,
     * either fresh from dormant or because the bridge reported a new
     * session id. Close any prior open ref for this anchor whose
     * cc_session_id differs, then insert (idempotent on UNIQUE
     * cc_session_id) so the open_projects snapshot has something to
     * read. */
    if (currentSession) {
      if (priorSession && priorSession !== currentSession) {
        db.closeProjectTranscriptRef(priorSession, now);
      }
      const existing = db.getProjectTranscriptRefByCc(currentSession);
      if (!existing) {
        db.insertProjectTranscriptRef({
          id: randomUUID(),
          anchor_id: anchor.id,
          cc_session_id: currentSession,
          jsonl_path: resolveJsonlPath(currentSession),
          opened_ms: now,
          closed_ms: null,
        });
      }
    }
    liveCwds.push(cwd);
    liveAnchorIds.push(anchor.id);
    touched.add(anchor.id);
  }

  /* Pass 2: every anchor that's currently live but didn't get touched
   * has lost its bridge connection. Flip dormant, clear current_*, and
   * close any open transcript_ref so the JSONL doesn't show as
   * perpetually open in the dashboard. */
  const live = db.listProjectSessions({ status: 'live', limit: 1000 });
  for (const row of live) {
    if (touched.has(row.id)) continue;
    if (row.current_session_id) {
      db.closeProjectTranscriptRef(row.current_session_id, now);
    }
    /* Fix 15 — anchor going dormant. Stash the prior uuid so a late
     * inject targeting it gets the bound-anchor-dormant reject rather
     * than a silent rejected_pty (no PTY found). */
    db.updateProjectSession(row.id, {
      status: 'dormant',
      current_bridge_id: null,
      current_session_id: null,
      current_pty_id: null,
      previous_session_id: row.current_session_id ?? row.previous_session_id ?? null,
      last_seen_ms: now,
    });
    dormantAnchorIds.push(row.id);
  }

  return { liveCwds, liveAnchorIds, dormantAnchorIds, presenceRecordCount: records.length };
}

export interface BridgePresenceLoop {
  stop: () => void;
}

/** F3: default cadence for the "still alive" heartbeat line on the
 * 1s reconcile loop. The loop previously logged errors only, so a
 * quiet daemon.log was ambiguous between "healthy, nothing to do"
 * and "the timer died". One INFO line an hour resolves that without
 * adding noise to a log that already gets 3600 silent ticks/hour. */
export const DEFAULT_BRIDGE_PRESENCE_HEARTBEAT_MS = 60 * 60_000;

export function startBridgePresenceLoop(
  db: IndexDb,
  opts: ReconcileOptions & {
    intervalMs?: number;
    onError?: (err: Error) => void;
    log?: (msg: string) => void;
    /** Heartbeat cadence (ms). Defaults to 1 hour. */
    heartbeatMs?: number;
  } = {},
): BridgePresenceLoop {
  const interval = opts.intervalMs ?? 1_000;
  const log = opts.log ?? ((): void => undefined);
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_BRIDGE_PRESENCE_HEARTBEAT_MS;
  const clock = opts.now ?? Date.now;
  let lastHeartbeatMs = clock();
  const timer = setInterval(() => {
    try {
      const result = reconcileBridgePresence(db, opts);
      const nowMs = clock();
      if (nowMs - lastHeartbeatMs >= heartbeatMs) {
        lastHeartbeatMs = nowMs;
        log(
          `[bridge-presence] tick ok live=${result.liveAnchorIds.length} presences=${result.presenceRecordCount}`,
        );
      }
    } catch (err) {
      opts.onError?.(err as Error);
    }
  }, interval);
  /* Don't block process exit on this timer. */
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}

/* Bug 3d/3e (2026-05-22). Resolve whether the bridge fleet has a
 * deliverable terminal for `ccSessionId` right now. Used by
 * crossSessionInject to gate the bridge fallback so a marker is
 * never written into a queue file with no terminal-owning bridge to
 * consume it.
 *
 * Verdict semantics:
 *   - 'deliverable'           — at least one fresh presence record
 *                               flags has_terminal_for_uuid[uuid]=true
 *   - 'legacy-grace'          — at least one fresh record CLAIMS the
 *                               uuid (cc_session_ids), but none ship
 *                               the deliverability field. Migration
 *                               window: assume deliverable so older
 *                               bridges keep working. Logged at
 *                               caller so the soak can spot stuck
 *                               legacy fleets.
 *   - 'no_terminal'           — uuid is claimed by at least one
 *                               record, but every flagged record
 *                               reports has_terminal_for_uuid=false.
 *                               This is the actual sinkhole the bug
 *                               describes; caller should refuse to
 *                               queue.
 *   - 'not_claimed'           — no presence record claims the uuid.
 *                               No bridge is even pretending to own
 *                               this worker; structured failure. */
export type DeliverabilityVerdict =
  | 'deliverable'
  | 'legacy-grace'
  | 'no_terminal'
  | 'not_claimed';

export interface DeliverabilityResult {
  verdict: DeliverabilityVerdict;
  /* The bridge record selected as the route target when
   * verdict='deliverable' or 'legacy-grace'. Most-recently-updated
   * record wins ties. Null for the negative verdicts. */
  selected: BridgePresenceRecord | null;
  /* Every fresh record that claimed the uuid, in updatedAt-desc
   * order. Useful for logging which bridges saw which UUID. */
  claimingRecords: BridgePresenceRecord[];
}

export function resolveDeliverableBridgeForSession(
  ccSessionId: string,
  opts: ReconcileOptions = {},
): DeliverabilityResult {
  const dir = opts.presenceDir ?? defaultPresenceDir();
  const fresh = opts.freshMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  const now = (opts.now ?? Date.now)();
  const records = readPresenceDir(dir, now, fresh);
  const claiming = records
    .filter((r) => r.ccSessionIds.includes(ccSessionId))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (claiming.length === 0) {
    return { verdict: 'not_claimed', selected: null, claimingRecords: [] };
  }
  /* Prefer the most-recent record whose flag explicitly says true. */
  const flaggedTrue = claiming.find(
    (r) => r.hasTerminalForUuid?.[ccSessionId] === true,
  );
  if (flaggedTrue) {
    return { verdict: 'deliverable', selected: flaggedTrue, claimingRecords: claiming };
  }
  /* If any claiming record ships the field, the fleet has opted in
   * to the new contract; an all-false fleet means no terminal owns
   * the uuid. Refuse delivery. */
  const anyHasField = claiming.some((r) => r.hasTerminalForUuid !== null);
  if (anyHasField) {
    return { verdict: 'no_terminal', selected: null, claimingRecords: claiming };
  }
  /* Migration grace: every claiming record is an old bridge with no
   * deliverability field. Treat the most-recent record as deliverable
   * so the legacy fleet keeps working through the transition window. */
  return { verdict: 'legacy-grace', selected: claiming[0]!, claimingRecords: claiming };
}

/* Convenience: returns the encoded marker decoded into its parts so
 * tile renderers and the live_state builder don't have to repeat the
 * pipe-split. */
export function decodeBridgeMarker(
  marker: string | null,
): { primaryBridgeId: string | null; count: number } {
  if (!marker) return { primaryBridgeId: null, count: 0 };
  const idx = marker.indexOf('|');
  if (idx < 0) return { primaryBridgeId: marker, count: 1 };
  const id = marker.slice(0, idx);
  const count = Number(marker.slice(idx + 1));
  return {
    primaryBridgeId: id || null,
    count: Number.isFinite(count) && count > 0 ? count : 1,
  };
}

export type { ProjectSessionRow };
