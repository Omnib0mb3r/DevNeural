/**
 * Lex self-clear routes (AUTO-CLEAR T4, Phase C, 2026-09-22).
 *
 *   GET  /lex/self-clear/state?brainstorm_id=   ctx %, setpoint, due,
 *                                               worker clear in flight
 *   GET  /lex/context-pack?brainstorm_id=       the rich pack on demand
 *   POST /lex/self-clear                        her handover in, the three
 *                                               checks, the file, /clear
 *   POST /lex/clear-handoff                     the fresh session's boot
 *                                               block (hook-runner)
 *
 * Everything model-shaped goes through deps.askText (the judge session on
 * the operator's subscription). No Anthropic API anywhere.
 */
import type { FastifyInstance } from 'fastify';
import type { IndexDb } from '../store/index-db.js';
import {
  renderHandoverFrame,
  richReseedFromFrame,
  vetHandoverFrame,
  type HandoverFrame,
  type HandoverVerdict,
} from '../lex/handover-frame.js';
import { writeFrameHandover, type HandoverFsDeps } from '../lex/handover-writer.js';
import { confirmResumeOnTask } from '../lex/smart-clear.js';
import {
  JUDGE_SYSTEM,
  SELF_CLEAR_DEFAULT_PCT,
  SelfClearGate,
  buildJudgePrompt,
  factCheckSelfClear,
  parseJudgeVerdict,
  type SelfClearFacts,
} from '../lex/lex-self-clear.js';

export interface LexSelfClearDeps {
  gate: SelfClearGate;
  /** The shared Layer 2 cwd; clear-handoff answers empty elsewhere. */
  brainstormCwd: string;
  askText: (i: { system?: string; prompt: string; timeoutMs?: number }) => Promise<string | null>;
  facts: (brainstormId: string, projectAnchorId: string | null) => SelfClearFacts;
  contextPack: (brainstormId: string) => string;
  ctxPct: (brainstormId: string) => number | null;
  setpoint: () => number;
  lexPtyFor: (brainstormId: string) => string | null;
  ptyInject: (ptyId: string, text: string, commit: boolean) => { ok: boolean; error?: string };
  notifyVoice?: (brainstormId: string, text: string) => Promise<boolean>;
  bell?: (i: { title: string; body: string; dedup_key: string; anchor_id?: string }) => void;
  /** The brainstorm's newest transcript path (for the resume confirm). */
  newestTranscript?: (brainstormId: string) => string | null;
  readFile?: (p: string) => string | null;
  delay?: (fn: () => void, ms: number) => void;
  fs?: HandoverFsDeps;
  now?: () => number;
  /** Current session id of the brainstorm (for the frame's author line). */
  currentSessionId?: (brainstormId: string) => string | null;
}

const RESUME_CONFIRM_MS = 90_000;
const JUDGE_TIMEOUT_MS = 60_000;
/* After /clear the fresh session sits at an empty prompt; the SessionStart
 * hook has fetched the handoff by then and CC attaches it to the next
 * user turn. The kick is that turn. */
export const KICK_DELAY_MS = 6_000;

function normCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

interface SelfClearBody {
  brainstorm_id?: string;
  draft?: {
    verified_state?: string;
    what_i_was_doing?: string;
    decisions_in_force?: string;
    stopping_point?: string;
  };
  next_steps?: string;
  plan_reference?: string;
  corrections?: unknown;
  force?: boolean;
}

export function registerLexSelfClearRoutes(
  app: FastifyInstance,
  db: IndexDb,
  log: (msg: string) => void,
  deps: LexSelfClearDeps,
): void {
  const now = deps.now ?? (() => Date.now());
  const delay = deps.delay ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
  const fsDeps = deps.fs ?? {};

  function anchorFor(brainstormId: string): string | null {
    const row = db.getLexSession(brainstormId);
    return row?.supervises_project_anchor_id ?? null;
  }

  app.get('/lex/self-clear/state', async (req, reply) => {
    const q = (req.query ?? {}) as { brainstorm_id?: string };
    if (!q.brainstorm_id) {
      reply.code(400);
      return { ok: false, error: 'brainstorm_id required' };
    }
    const row = db.getLexSession(q.brainstorm_id);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'brainstorm not found' };
    }
    const pct = deps.ctxPct(q.brainstorm_id);
    const setpoint = deps.setpoint();
    const anchorId = row.supervises_project_anchor_id ?? null;
    return {
      ok: true,
      brainstorm_id: q.brainstorm_id,
      ctx_pct: pct,
      setpoint,
      due: pct !== null && pct >= setpoint,
      worker_clear_in_flight: anchorId ? deps.gate.workerClearInFlight(anchorId) : false,
      lex_clear_pending: deps.gate.lexClearPending(q.brainstorm_id),
    };
  });

  app.get('/lex/context-pack', async (req, reply) => {
    const q = (req.query ?? {}) as { brainstorm_id?: string };
    if (!q.brainstorm_id) {
      reply.code(400);
      return { ok: false, error: 'brainstorm_id required' };
    }
    if (!db.getLexSession(q.brainstorm_id)) {
      reply.code(404);
      return { ok: false, error: 'brainstorm not found' };
    }
    return { ok: true, brainstorm_id: q.brainstorm_id, pack: deps.contextPack(q.brainstorm_id) };
  });

  app.post('/lex/self-clear', async (req, reply) => {
    const body = (req.body ?? {}) as SelfClearBody;
    if (!body.brainstorm_id || !body.draft || typeof body.draft !== 'object') {
      reply.code(400);
      return { ok: false, error: 'brainstorm_id and draft required' };
    }
    const brainstormId = body.brainstorm_id;
    const row = db.getLexSession(brainstormId);
    if (!row) {
      reply.code(404);
      return { ok: false, error: 'brainstorm not found' };
    }
    const anchorId = row.supervises_project_anchor_id ?? null;
    /* Stagger rule: never while the worker is mid-clear. */
    if (anchorId && deps.gate.workerClearInFlight(anchorId)) {
      reply.code(409);
      return { ok: false, error: 'worker clear in flight; wait for its confirm, then post again' };
    }
    if (deps.gate.lexClearPending(brainstormId)) {
      reply.code(409);
      return { ok: false, error: 'your previous clear has not booted yet' };
    }
    const at = new Date(now()).toISOString();
    const sessionId = deps.currentSessionId?.(brainstormId) ?? null;
    const corrections = Array.isArray(body.corrections)
      ? body.corrections.map((c) => String(c)).filter((c) => c.trim().length > 0)
      : [];
    const frame: HandoverFrame = {
      anchorId: brainstormId,
      kind: 'lex-self-clear',
      createdAt: at,
      worker: {
        author: { role: 'lex', sessionId, at },
        verifiedState: String(body.draft.verified_state ?? ''),
        whatIWasDoing: String(body.draft.what_i_was_doing ?? ''),
        decisionsInForce: String(body.draft.decisions_in_force ?? ''),
        stoppingPoint: String(body.draft.stopping_point ?? ''),
      },
      lex: {
        author: { role: 'judge', sessionId: null, at },
        corrections: [...corrections],
        nextSteps: String(body.next_steps ?? ''),
        planReference: String(body.plan_reference ?? ''),
        verdict: 'approved',
      },
      unvetted: false,
    };
    /* 1. structural vet */
    const vet = vetHandoverFrame(frame);
    /* 2. fact check against live state */
    const facts = deps.facts(brainstormId, anchorId);
    const fact = factCheckSelfClear(frame, facts);
    /* 3. the outside approver */
    let judge = parseJudgeVerdict(null);
    let judgeRaw: string | null = null;
    try {
      judgeRaw = await deps.askText({
        system: JUDGE_SYSTEM,
        prompt: buildJudgePrompt(frame, facts, fact.issues),
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      judge = parseJudgeVerdict(judgeRaw);
    } catch (err) {
      log(`[self-clear] judge threw (treated as unavailable): ${(err as Error).message}`);
    }
    const issues = [...vet.issues, ...fact.issues];
    if (judge && !judge.ok) issues.push(`judge: ${judge.note}`);
    const judgeNote = judge
      ? judge.ok
        ? `judge: OK${judge.note ? ` (${judge.note})` : ''}`
        : `judge: NO, ${judge.note}`
      : 'judge: unavailable (structural vet and fact check only)';
    const passed = vet.ok && fact.ok && (judge === null || judge.ok);
    const verdict: HandoverVerdict = passed ? 'approved' : body.force === true ? 'revised' : 'rejected';
    frame.lex = {
      ...frame.lex!,
      corrections: [...corrections, ...vet.issues, ...fact.issues, judgeNote],
      verdict,
    };
    /* The file is written either way so the operator can see what was
     * refused and why. */
    const written = writeFrameHandover(frame, fsDeps);
    log(
      `[self-clear] brainstorm=${brainstormId.slice(0, 8)} vet_ok=${vet.ok} fact_ok=${fact.ok} judge=${judge ? (judge.ok ? 'ok' : 'no') : 'n/a'} verdict=${verdict} file=${written.file}`,
    );
    if (!passed && body.force !== true) {
      reply.code(422);
      return {
        ok: false,
        error: 'handover did not pass; fix the issues and post again',
        handover_id: written.file,
        issues,
        judge: judgeRaw,
      };
    }
    /* Approved (or forced): the reseed is her handover plus the rich
     * context pack. Served once to the fresh session by clear-handoff. */
    const reseed = `${richReseedFromFrame(frame)}\n\n${deps.contextPack(brainstormId)}`.trim();
    deps.gate.setPendingReseed({ brainstormId, handoverId: written.file, reseed });
    const ctx = deps.ctxPct(brainstormId);
    if (deps.notifyVoice) {
      try {
        await deps.notifyVoice(
          brainstormId,
          `The brain is clearing its own context${ctx !== null ? ` at ${Math.round(ctx)}%` : ''}; its handover passed the checks. It will be back with everything it needs in a moment.`,
        );
      } catch {
        /* voice is optional */
      }
    }
    const ptyId = deps.lexPtyFor(brainstormId);
    let cleared = false;
    if (ptyId) {
      const r = deps.ptyInject(ptyId, '/clear', true);
      cleared = r.ok;
      if (!r.ok) log(`[self-clear] /clear inject failed on ${ptyId}: ${r.error ?? 'unknown'}`);
    }
    if (cleared && ptyId) {
      const before = deps.newestTranscript?.(brainstormId) ?? null;
      const kickLine = reseed.split('\n')[0] ?? 'Resume from your handover.';
      /* The first turn of the fresh session. When the hook already took
       * the handoff, a short kick is enough (CC attaches the block to
       * this turn). When nobody fetched it, the kick carries the whole
       * reseed itself, so the handover never depends on the hook. */
      delay(() => {
        const p = deps.gate.peekPending(brainstormId);
        const served = Boolean(p && p.servedAtMs !== null);
        if (!served) deps.gate.takePendingReseed();
        const text = served
          ? `${kickLine} It is in your session context above. Say in one line where things stand, then carry on with the next steps.`
          : `${kickLine}\n\n${reseed}\n\nSay in one line where things stand, then carry on with the next steps.`;
        const inj = deps.ptyInject(ptyId, text, true);
        log(`[self-clear] kick brainstorm=${brainstormId.slice(0, 8)} hook_served=${served} ok=${inj.ok}`);
        scheduleResumeConfirm(brainstormId, reseed, before, 0);
      }, KICK_DELAY_MS);
    }
    return {
      ok: true,
      handover_id: written.file,
      file: written.filePath,
      verdict,
      issues,
      judge: judgeRaw,
      cleared,
      reseed_chars: reseed.length,
      ...(cleared ? {} : { note: 'no PTY for this brainstorm; type /clear yourself, the handoff is waiting' }),
    };
  });

  /* The fresh Lex session's boot block. Every brainstorm shares one cwd,
   * so the newest pending reseed is the one; the stagger rule keeps at
   * most one pending. Empty for any other cwd or when nothing waits. */
  app.post('/lex/clear-handoff', async (req, reply) => {
    const body = (req.body ?? {}) as { session_id?: string; cwd?: string };
    if (!body.cwd || typeof body.cwd !== 'string') {
      reply.code(400);
      return { ok: false, error: 'cwd required' };
    }
    if (normCwd(body.cwd) !== normCwd(deps.brainstormCwd)) {
      return { ok: true, block: '', reason: 'not-brainstorm-cwd' };
    }
    const p = deps.gate.takePendingReseed();
    if (!p) return { ok: true, block: '', reason: 'none-pending' };
    log(
      `[self-clear] clear-handoff served ${p.handoverId} for brainstorm=${p.brainstormId.slice(0, 8)} session=${(body.session_id ?? '').slice(0, 8)} chars=${p.reseed.length}`,
    );
    return { ok: true, block: p.reseed, reason: 'lex-self-clear', handover_id: p.handoverId, brainstorm_id: p.brainstormId };
  });

  /* After the clear: her fresh self must pick up the next steps. The
   * new transcript is found by comparing with the pre-clear one; when it
   * has not appeared yet we look once more, then bell and re-paste. */
  function scheduleResumeConfirm(
    brainstormId: string,
    reseed: string,
    before: string | null,
    attempt: number,
  ): void {
    delay(() => {
      const current = deps.newestTranscript?.(brainstormId) ?? null;
      if (!current || current === before) {
        if (attempt < 1) {
          scheduleResumeConfirm(brainstormId, reseed, before, attempt + 1);
          return;
        }
        log(`[self-clear] resume confirm: no new transcript for brainstorm=${brainstormId.slice(0, 8)}`);
        deps.bell?.({
          title: 'Lex did not come back after her clear',
          body: 'No fresh session transcript appeared. Check the brainstorm PTY.',
          dedup_key: `self-clear-resume:${brainstormId}`,
          anchor_id: brainstormId,
        });
        return;
      }
      const r = confirmResumeOnTask({
        newJsonl: current,
        reseed,
        ...(deps.readFile ? { readFile: deps.readFile } : {}),
      });
      log(
        `[self-clear] resume confirm brainstorm=${brainstormId.slice(0, 8)} on_task=${r.onTask} reason=${r.reason} echo=${r.sawReseedEcho} assistant=${r.sawAssistant}`,
      );
      if (r.onTask) return;
      /* She replied but the echo is not visible: the hook carried the
       * block as session context, which the transcript does not show as
       * a user turn. Resumed. */
      if (r.sawAssistant) return;
      const ptyId = deps.lexPtyFor(brainstormId);
      if (ptyId && attempt < 1) {
        const inj = deps.ptyInject(ptyId, `You just cleared your context. Your handover:\n\n${reseed}`, true);
        log(`[self-clear] re-pasted the handover after a missed resume: ok=${inj.ok}`);
        scheduleResumeConfirm(brainstormId, reseed, before, attempt + 1);
        return;
      }
      deps.bell?.({
        title: 'Lex may not have resumed after her clear',
        body: r.reason,
        dedup_key: `self-clear-resume:${brainstormId}`,
        anchor_id: brainstormId,
      });
    }, RESUME_CONFIRM_MS);
  }
}

export { SELF_CLEAR_DEFAULT_PCT, renderHandoverFrame };
