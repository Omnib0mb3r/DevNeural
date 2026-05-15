/**
 * Worker mid-turn stall watcher.
 *
 * Bug context: workers intermittently stop emitting jsonl records
 * partway through a turn (mid tool_use, or after a user prompt with
 * no assistant response). The session is technically still "live"
 * from the daemon's perspective because the PTY hasn't exited, so
 * /lex/anchors keeps reporting status='live', no notification fires,
 * and the user only notices when they next look at the dashboard.
 *
 * This watcher closes that visibility gap. Every tick (default 60s)
 * it walks live project_session anchors, derives the most recent
 * jsonl record's role + timestamp, and classifies the anchor as
 * stalled when:
 *
 *   tool-stall: last record is an assistant tool_use turn and the
 *               record is older than DEVNEURAL_STALL_TOOL_MS
 *               (default 300_000 = 5 min). Worker called a tool
 *               and the model is still grinding -- or wedged.
 *   no-response: last record is a user message and is older than
 *                DEVNEURAL_STALL_USER_MS (default 180_000 = 3 min).
 *                User pushed something in and the worker never
 *                replied.
 *
 * On a rising edge (transition into stalled state), the tick:
 *   - logs a structured line via the injected logger,
 *   - calls fireForStall so the existing notification + push surface
 *     lights up the dashboard bell and the iPhone PWA,
 *   - records the fire time in a per-anchor map so a subsequent
 *     stall against the same anchor only re-fires after
 *     DEVNEURAL_STALL_COOLDOWN_MS (default 600_000 = 10 min).
 *
 * Pure module: side effects (db.listProjectSessions,
 * listProjectTranscriptRefs, fs.statSync, fireForStall, logger) all
 * flow through the deps object so tests can pin every branch with
 * stubs.
 */
import * as fs from 'node:fs';
import type { IndexDb } from '../store/index-db.js';
import { fireForStall } from './lex-attention.js';

export type StallKind = 'tool-stall' | 'no-response';

export interface AnchorTailSummary {
  /** Last record's role / type. Subset of values
   * derivePhaseFromTail returns plus 'user' for the no-response
   * classifier. Null when the jsonl has no usable records yet. */
  lastRole: 'user' | 'assistant' | 'tool' | null;
  /** ms timestamp of the last record's `timestamp` field, or the
   * file mtime when the record's timestamp is unparseable. */
  lastRecordMs: number | null;
  /** True when the last assistant record contained a tool_use
   * block. tool_use turns are normal mid-turn states, but a
   * tool_use that hasn't completed in N minutes is the stall. */
  lastAssistantWasTool: boolean;
}

export interface StallWatchDeps {
  db: IndexDb;
  /** Resolve the open jsonl path for an anchor. Production wires
   * this to jsonlForAnchor from smart-compact-routes; tests stub. */
  jsonlForAnchor: (db: IndexDb, anchorId: string) => string | null;
  /** Read + classify the jsonl tail. Production wires this to
   * readTail; tests stub with a fixed shape. */
  readTail: (jsonlPath: string) => AnchorTailSummary | null;
  /** fireForStall wrapper. Defaults to the real fireForStall so the
   * notification + push surface is hit; tests pass a fake. */
  fire?: typeof fireForStall;
  log?: (msg: string) => void;
  now?: () => number;
  toolStallMs?: number;
  userStallMs?: number;
  cooldownMs?: number;
  /** Mutable per-anchor cooldown tracker. Pass the same object on
   * every tick so the watcher remembers when it last fired. */
  state: Map<string, number>;
}

export interface StallTickResult {
  evaluated: number;
  stalls: { anchor_id: string; kind: StallKind; ageMs: number }[];
  fired: string[];
  cooldown: string[];
}

export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readTail(jsonlPath: string): AnchorTailSummary | null {
  if (!jsonlPath) return null;
  if (!fs.existsSync(jsonlPath)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(jsonlPath);
  } catch {
    return null;
  }
  if (stat.size === 0) return null;
  const tailLen = Math.min(stat.size, 16 * 1024);
  const start = stat.size - tailLen;
  let text: string;
  const fd = fs.openSync(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(tailLen);
    fs.readSync(fd, buf, 0, tailLen, start);
    text = buf.toString('utf-8');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        role?: string;
        timestamp?: string;
        message?: { role?: string; content?: unknown };
      };
      const role = rec.type ?? rec.role ?? rec.message?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      const lastRecordMs = Number.isFinite(ts) ? ts : stat.mtimeMs;
      const isToolUse =
        role === 'assistant' && /"type"\s*:\s*"tool_use"/.test(line);
      return {
        lastRole: role,
        lastRecordMs,
        lastAssistantWasTool: isToolUse,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function classifyStall(
  summary: AnchorTailSummary,
  now: number,
  toolStallMs: number,
  userStallMs: number,
): { kind: StallKind; ageMs: number } | null {
  if (!summary.lastRecordMs) return null;
  const ageMs = Math.max(0, now - summary.lastRecordMs);
  if (
    summary.lastRole === 'assistant' &&
    summary.lastAssistantWasTool &&
    ageMs >= toolStallMs
  ) {
    return { kind: 'tool-stall', ageMs };
  }
  if (summary.lastRole === 'user' && ageMs >= userStallMs) {
    return { kind: 'no-response', ageMs };
  }
  return null;
}

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

export async function runWorkerStallTick(
  deps: StallWatchDeps,
): Promise<StallTickResult> {
  const log = deps.log ?? (() => undefined);
  const fire = deps.fire ?? fireForStall;
  const now = (deps.now ?? Date.now)();
  const toolStallMs = deps.toolStallMs ?? envMs('DEVNEURAL_STALL_TOOL_MS', 300_000);
  const userStallMs = deps.userStallMs ?? envMs('DEVNEURAL_STALL_USER_MS', 180_000);
  const cooldownMs = deps.cooldownMs ?? envMs('DEVNEURAL_STALL_COOLDOWN_MS', 600_000);
  const result: StallTickResult = {
    evaluated: 0,
    stalls: [],
    fired: [],
    cooldown: [],
  };
  const live = deps.db.listProjectSessions({ status: 'live', limit: 1000 });
  for (const anchor of live) {
    result.evaluated += 1;
    const jsonlPath = deps.jsonlForAnchor(deps.db, anchor.id);
    if (!jsonlPath) continue;
    const summary = deps.readTail(jsonlPath);
    if (!summary) continue;
    const stall = classifyStall(summary, now, toolStallMs, userStallMs);
    if (!stall) continue;
    result.stalls.push({ anchor_id: anchor.id, kind: stall.kind, ageMs: stall.ageMs });
    const lastFired = deps.state.get(anchor.id) ?? 0;
    if (now - lastFired < cooldownMs) {
      result.cooldown.push(anchor.id);
      continue;
    }
    const reason =
      stall.kind === 'tool-stall'
        ? `tool_use turn open for ${fmtAge(stall.ageMs)} without progress`
        : `user prompt waiting ${fmtAge(stall.ageMs)} for assistant reply`;
    log(
      `[stall-watch] anchor=${anchor.id.slice(0, 8)} kind=${stall.kind} age=${fmtAge(stall.ageMs)} jsonl=${jsonlPath}`,
    );
    try {
      fire({
        brainstorm_id: null,
        anchor_id: anchor.id,
        reason,
      });
    } catch (err) {
      log(`[stall-watch] fireForStall threw for ${anchor.id}: ${(err as Error).message}`);
    }
    deps.state.set(anchor.id, now);
    result.fired.push(anchor.id);
  }
  return result;
}
