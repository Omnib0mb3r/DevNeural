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
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '');
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
    const anchor = db.getProjectSessionByCwd(cwd);
    if (!anchor) continue;
    const { marker, primary } = encodeBridgeMarker(recs);
    /* current_session_id: prefer the most recently updated record's
     * first cc session id. If none reports one, leave the existing
     * value alone so we don't blank out a known UUID just because
     * the bridge hasn't shipped that field yet. */
    const priorSession = anchor.current_session_id;
    let currentSession = priorSession;
    if (primary.ccSessionIds.length > 0) {
      currentSession = primary.ccSessionIds[0]!;
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

  return { liveCwds, liveAnchorIds, dormantAnchorIds };
}

export interface BridgePresenceLoop {
  stop: () => void;
}

export function startBridgePresenceLoop(
  db: IndexDb,
  opts: ReconcileOptions & {
    intervalMs?: number;
    onError?: (err: Error) => void;
  } = {},
): BridgePresenceLoop {
  const interval = opts.intervalMs ?? 1_000;
  const timer = setInterval(() => {
    try {
      reconcileBridgePresence(db, opts);
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
