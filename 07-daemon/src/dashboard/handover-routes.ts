/**
 * Phase C routes (SMART-COMPACT.md section 5, 2026-09-22).
 *
 *   POST /lex/smart-clear/handover-request { brainstorm_id, anchor_id }
 *       Injects the T5 wrap prompt into the supervised worker (caller
 *       label smart-clear, exempt from the dispatch gate) asking it to
 *       write its half of the handover and reply "ready".
 *   POST /lex/smart-clear/review { brainstorm_id, anchor_id, worker_draft, lex, kind?, force? }
 *       Lex posts the worker's half plus its own review; the daemon vets
 *       the frame, persists HANDOVER-<iso>.md under the brainstorm with
 *       both halves visible, registers it for the spoken approval, and
 *       returns the reseed text.
 *   GET  /lex/anchors/:id/handovers            newest first
 *   GET  /lex/anchors/:id/handovers/:file      one file
 *   GET  /lex/auto-clear/mode                  the one switch
 *   POST /lex/auto-clear/mode { mode }         writes all three keys
 *
 * Every read and write is keyed on the ids in the request; the handover
 * directory is the brainstorm's own, so no anchor can see another's.
 */
import type { FastifyInstance } from 'fastify';
import type { IndexDb } from '../store/index-db.js';
import {
  parseHandoverFrame,
  reseedFromFrame,
  vetHandoverFrame,
  HANDOVER_KINDS,
  type HandoverFrame,
  type HandoverKind,
  type HandoverVerdict,
} from '../lex/handover-frame.js';
import {
  listHandovers,
  readHandover,
  writeFrameHandover,
  type HandoverFsDeps,
} from '../lex/handover-writer.js';
import { HandoverApprovalRegistry, type PendingHandover } from '../lex/handover-approval.js';
import {
  parseSmartClearMode,
  SMART_CLEAR_MODE_KEY,
  type SmartClearMode,
} from '../lex/smart-clear.js';
import { SMART_COMPACT_CONFIG_KEY, smartCompactMode } from './smart-compact-routes.js';

export const AUTO_CLEAR_MODE_KEY = 'auto_clear_mode';

/* The wrap prompt the worker gets. Plain text, the four T5 headings, the
 * "not a transcript dump" rule, and the word that closes it. */
export const HANDOVER_REQUEST_PROMPT = `Stop at a safe point and write your handover. Commit first if the tree is dirty; never stop mid-edit. Then answer with exactly these four headings and prose under each, no transcript, no tool output:

### Verified state
(git HEAD and branch, tree clean or dirty, files in flight)

### What I was doing
(the task and where you are in it, for example "end of step 3 of 5")

### Decisions in force
(constraints that carry forward; "none" if none)

### Stopping point
(what you did to stop safely)

End with the single word: ready`;

export interface HandoverRouteDeps {
  registry: HandoverApprovalRegistry;
  /** Inject text into the supervised worker session (the same path as
   * every smart-clear drive; the gate exempts it). */
  requestWorkerHandover: (input: {
    targetSession: string;
    brainstormId: string;
    projectAnchorId: string;
    text: string;
  }) => Promise<{ ok: boolean; status: number; decision: string | null }>;
  /** A review landed: the voice layer reads it out (Task 8 wires this). */
  onReviewed?: (p: PendingHandover) => Promise<void>;
  fs?: HandoverFsDeps;
  now?: () => number;
}

/** The one switch. Explicit auto_clear_mode wins; otherwise the pair. */
export function autoClearMode(db: IndexDb): SmartClearMode {
  const explicit = parseSmartClearMode(db.getRuntimeConfig(AUTO_CLEAR_MODE_KEY));
  if (explicit) return explicit;
  const clear = parseSmartClearMode(db.getRuntimeConfig(SMART_CLEAR_MODE_KEY)) ?? 'off';
  const compact = smartCompactMode(db);
  if (clear === 'live' && compact === 'live') return 'live';
  if (clear === 'off' && compact === 'off') return 'off';
  return 'shadow';
}

export function setAutoClearMode(db: IndexDb, mode: SmartClearMode, updatedBy?: string): void {
  db.setRuntimeConfig(AUTO_CLEAR_MODE_KEY, mode, updatedBy);
  db.setRuntimeConfig(SMART_CLEAR_MODE_KEY, mode, updatedBy);
  db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, mode, updatedBy);
}

function gistOf(f: HandoverFrame): string {
  const doing = f.worker.whatIWasDoing.replace(/\s+/g, ' ').trim().slice(0, 160);
  const stop = f.worker.stoppingPoint.replace(/\s+/g, ' ').trim().slice(0, 100);
  const parts = [`The worker is at: ${doing}.`, `Stopping point: ${stop}.`];
  if (f.lex) {
    const n = f.lex.corrections.length;
    parts.push(
      n === 0 ? 'Nothing to correct.' : `${n} correction${n === 1 ? '' : 's'}: ${f.lex.corrections[0]!.slice(0, 100)}.`,
    );
    parts.push(`Next: ${f.lex.nextSteps.replace(/\s+/g, ' ').trim().slice(0, 140)}.`);
  }
  return parts.join(' ').slice(0, 480);
}

export function registerHandoverRoutes(
  app: FastifyInstance,
  db: IndexDb,
  log: (msg: string) => void,
  deps: HandoverRouteDeps,
): void {
  const now = deps.now ?? (() => Date.now());
  const fsDeps = deps.fs ?? {};

  app.post('/lex/smart-clear/handover-request', async (req, reply) => {
    const body = (req.body ?? {}) as { brainstorm_id?: string; anchor_id?: string };
    if (!body.brainstorm_id || !body.anchor_id) {
      reply.code(400);
      return { ok: false, error: 'brainstorm_id and anchor_id required' };
    }
    const project = db.getProjectSession(body.anchor_id);
    if (!project) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    if (!project.current_session_id) {
      reply.code(409);
      return { ok: false, error: 'worker has no live session' };
    }
    const r = await deps.requestWorkerHandover({
      targetSession: project.current_session_id,
      brainstormId: body.brainstorm_id,
      projectAnchorId: body.anchor_id,
      text: HANDOVER_REQUEST_PROMPT,
    });
    log(
      `[handover] request anchor=${body.anchor_id.slice(0, 8)} brainstorm=${body.brainstorm_id.slice(0, 8)} status=${r.status} ok=${r.ok}`,
    );
    return { ok: r.ok, status: r.status, decision: r.decision, target_session: project.current_session_id };
  });

  app.post('/lex/smart-clear/review', async (req, reply) => {
    const body = (req.body ?? {}) as {
      brainstorm_id?: string;
      anchor_id?: string;
      kind?: string;
      force?: boolean;
      worker_draft?: {
        session_id?: string | null;
        verified_state?: string;
        what_i_was_doing?: string;
        decisions_in_force?: string;
        stopping_point?: string;
      };
      lex?: {
        session_id?: string | null;
        corrections?: string[];
        next_steps?: string;
        plan_reference?: string;
        verdict?: string;
      };
    };
    if (!body.brainstorm_id || !body.anchor_id || !body.worker_draft || !body.lex) {
      reply.code(400);
      return { ok: false, error: 'brainstorm_id, anchor_id, worker_draft and lex required' };
    }
    const project = db.getProjectSession(body.anchor_id);
    if (!project) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    const kind = (HANDOVER_KINDS as ReadonlyArray<string>).includes(body.kind ?? '')
      ? (body.kind as HandoverKind)
      : 'auto-clear';
    const verdictRaw = (body.lex.verdict ?? 'approved').toLowerCase();
    const verdict: HandoverVerdict =
      verdictRaw === 'revised' || verdictRaw === 'rejected' ? verdictRaw : 'approved';
    const at = new Date(now()).toISOString();
    const frame: HandoverFrame = {
      anchorId: body.brainstorm_id,
      kind,
      createdAt: at,
      worker: {
        author: {
          role: 'worker',
          sessionId: body.worker_draft.session_id ?? project.current_session_id ?? null,
          at,
        },
        verifiedState: body.worker_draft.verified_state ?? '',
        whatIWasDoing: body.worker_draft.what_i_was_doing ?? '',
        decisionsInForce: body.worker_draft.decisions_in_force ?? '',
        stoppingPoint: body.worker_draft.stopping_point ?? '',
      },
      lex: {
        author: { role: 'lex', sessionId: body.lex.session_id ?? null, at },
        corrections: Array.isArray(body.lex.corrections)
          ? body.lex.corrections.map((c) => String(c)).filter((c) => c.trim().length > 0)
          : [],
        nextSteps: body.lex.next_steps ?? '',
        planReference: body.lex.plan_reference ?? '',
        verdict,
      },
      unvetted: false,
    };
    const vet = vetHandoverFrame(frame);
    if (!vet.ok && body.force !== true) {
      reply.code(422);
      return { ok: false, error: 'handover failed the structural vet', vet };
    }
    const written = writeFrameHandover(frame, fsDeps);
    const reseed = reseedFromFrame(frame);
    const gist = gistOf(frame);
    const pending = deps.registry.register({
      handoverId: written.file,
      file: written.file,
      brainstormId: body.brainstorm_id,
      projectAnchorId: body.anchor_id,
      reseed,
      gist,
    });
    log(
      `[handover] reviewed brainstorm=${body.brainstorm_id.slice(0, 8)} anchor=${body.anchor_id.slice(0, 8)} verdict=${verdict} vet_ok=${vet.ok} file=${written.file}`,
    );
    try {
      await deps.onReviewed?.(pending);
    } catch (err) {
      log(`[handover] onReviewed threw (ignored): ${(err as Error).message}`);
    }
    return {
      ok: true,
      handover_id: written.file,
      file: written.filePath,
      vet,
      reseed,
      gist,
      verdict,
    };
  });

  app.get('/lex/anchors/:id/handovers', async (req) => {
    const id = (req.params as { id: string }).id;
    return { ok: true, anchor_id: id, handovers: listHandovers(id, fsDeps) };
  });

  app.get('/lex/anchors/:id/handovers/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const content = readHandover(id, file, fsDeps);
    if (content === null) {
      reply.code(404);
      return { ok: false, error: 'handover not found' };
    }
    const frame = parseHandoverFrame(content);
    return { ok: true, anchor_id: id, file, content, frame };
  });

  app.get('/lex/auto-clear/mode', async () => {
    return { ok: true, mode: autoClearMode(db) };
  });

  app.post('/lex/auto-clear/mode', async (req, reply) => {
    const body = (req.body ?? {}) as { mode?: string; updated_by?: string };
    const mode = parseSmartClearMode(body.mode);
    if (!mode) {
      reply.code(400);
      return { ok: false, error: "mode must be 'off' | 'shadow' | 'live'" };
    }
    setAutoClearMode(db, mode, body.updated_by);
    log(`[auto-clear] mode -> ${mode} by=${body.updated_by ?? 'unknown'}`);
    return { ok: true, mode };
  });
}
