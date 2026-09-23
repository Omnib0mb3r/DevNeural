/**
 * A handover from the trail (AUTO-CLEAR T6, operator 2026-09-22): every
 * session end writes one next to distillation, and the boot crash sweep
 * writes one for a session that died without a clean end. Nobody
 * authored these halves, so they are marked unvetted and the author is
 * the daemon reading the jsonl tail; the worker's own words (its latest
 * directive and reply) fill the slots, the repo probe fills verified
 * state and the stopping point.
 *
 * Pure over injected deps: no disk, no db, no git in tests.
 */
import * as os from 'node:os';
import type { HandoverFrame } from './handover-frame.js';
import { writeFrameHandover, type HandoverFsDeps } from './handover-writer.js';
import {
  defaultRepoProbe,
  draftStoppingPoint,
  extractWorkerActivity,
  type RepoProbe,
} from './smart-clear.js';
import { transcriptPathFor } from './spawn-lex-session.js';
import { readFileTail } from '../dashboard/voice-layers-wire.js';

export interface TrailSource {
  /** Which session's tail fills the worker half. */
  role: 'worker' | 'lex';
  sessionId: string | null;
  cwd: string | null;
}

export interface TrailHandoverDeps {
  /** The brainstorm's supervised project anchor, resolved by the caller. */
  worker: TrailSource | null;
  /** The brainstorm's own session, when no worker is bound. */
  lex: TrailSource | null;
  readTail?: (path: string, bytes: number) => string;
  probe?: RepoProbe;
  transcriptPath?: (cwd: string, sessionId: string) => string;
  now?: () => number;
}

const TAIL_BYTES = 4 * 1024 * 1024;

export function buildTrailHandover(
  brainstormId: string,
  kind: 'session-end' | 'crash-recovery',
  deps: TrailHandoverDeps,
): HandoverFrame | null {
  const readTail = deps.readTail ?? readFileTail;
  const probe = deps.probe ?? defaultRepoProbe;
  const pathFor =
    deps.transcriptPath ??
    ((cwd: string, sessionId: string) =>
      transcriptPathFor({ cwd, ccSessionId: sessionId, homeDir: os.homedir() }));
  const now = deps.now ?? (() => Date.now());
  const src = deps.worker?.sessionId ? deps.worker : deps.lex?.sessionId ? deps.lex : null;
  if (!src || !src.sessionId) return null;
  const at = new Date(now()).toISOString();
  let tail = '';
  if (src.cwd) {
    try {
      tail = readTail(pathFor(src.cwd, src.sessionId), TAIL_BYTES);
    } catch {
      tail = '';
    }
  }
  const activity = extractWorkerActivity(tail);
  const signals = src.cwd ? probe(src.cwd) : { headSha: null, branch: null, dirty: false, lastCommitSubject: null };
  const verified = [
    signals.branch ? `branch ${signals.branch}` : null,
    signals.headSha ? `HEAD ${signals.headSha}` : null,
    signals.dirty ? 'working tree DIRTY (uncommitted work at the time)' : 'working tree clean',
    signals.lastCommitSubject ? `last commit "${signals.lastCommitSubject}"` : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(', ');
  const doingParts = [
    activity.directive ? `Latest directive: ${activity.directive}` : null,
    activity.reply ? `Latest reply: ${activity.reply}` : null,
    activity.nextItems.length ? `Queued: ${activity.nextItems.join('; ')}` : null,
  ].filter((s): s is string => Boolean(s));
  const ended = kind === 'crash-recovery' ? 'The session died without a clean end.' : 'The session ended.';
  return {
    anchorId: brainstormId,
    kind,
    createdAt: at,
    worker: {
      author: { role: 'daemon-trail', sessionId: src.sessionId, at },
      verifiedState: verified || 'unknown (no repo at the recorded cwd)',
      whatIWasDoing: doingParts.length
        ? `${src.role === 'lex' ? 'Lex' : 'The worker'}: ${doingParts.join(' ')}`
        : `${src.role === 'lex' ? 'Lex' : 'The worker'}: nothing readable in the transcript tail.`,
      decisionsInForce: activity.constraints.join('; '),
      stoppingPoint: `${ended} ${draftStoppingPoint(signals)}`,
    },
    lex: null,
    unvetted: true,
  };
}

/** Build and persist; never throws. Returns the file name or null. */
export function writeTrailHandover(
  brainstormId: string,
  kind: 'session-end' | 'crash-recovery',
  deps: TrailHandoverDeps,
  fsDeps: HandoverFsDeps = {},
  log: (msg: string) => void = () => undefined,
): string | null {
  try {
    const frame = buildTrailHandover(brainstormId, kind, deps);
    if (!frame) {
      log(`[handover] ${kind}: nothing to write for ${brainstormId.slice(0, 8)} (no session)`);
      return null;
    }
    const r = writeFrameHandover(frame, fsDeps);
    log(`[handover] ${kind}: wrote ${r.file} for ${brainstormId.slice(0, 8)} (unvetted, from the trail)`);
    return r.file;
  } catch (err) {
    log(`[handover] ${kind}: write failed for ${brainstormId.slice(0, 8)}: ${(err as Error).message}`);
    return null;
  }
}
