/**
 * Voice layers, Phase B wiring (LAYER-1-CONTROL.md v2, 2026-09-21):
 * Layer 1 controls Layer 2's two decisions that used to need a human in
 * the TUI.
 *
 *   1. Dispatch confirm gate. Lex (L2) is prompt-told to confirm with
 *      the operator before it prompts the worker (L3). This makes it
 *      mechanical: with runtime_config `dispatch_confirm_gate=on`, a
 *      POST /lex/inject-cross-session that carries from_anchor_id is
 *      PARKED (202 held_for_confirm), Layer 1 tells the operator what
 *      the brain wants to send, and the operator's spoken yes / no comes
 *      back as CONTROL: confirm_dispatch / reject_dispatch. Confirm
 *      re-enters the same route (fresh token, same body) so every
 *      transport rule, audit row and delivery check runs unchanged.
 *      Context-management callers (smart-clear, smart-compact, the
 *      supervisors) are exempt (AUTO-CLEAR T10.2).
 *   2. Plan approval. A headless L2 in --permission-mode plan stalls on
 *      the ExitPlanMode prompt. The Notification hook already posts the
 *      prompt to /sessions/:id/pending-prompt; when it is the plan
 *      prompt, the plan text is read from the L2 jsonl, handed to Layer
 *      1 (plan-ready), and the operator's yes / no becomes
 *      CONTROL: approve_plan (Enter on the L2 PTY) / reject_plan (Escape
 *      + the reason as the next prompt).
 *
 * Every side effect is behind a dep so the module pins without
 * Fastify, a PTY or a database. registerVoiceLayersWire wires the
 * production deps and installs the Layer 1 control handlers.
 */
import * as fs from 'node:fs';
import {
  DispatchGate,
  isContextManagementCaller,
  type PendingDispatch,
} from '../lex/dispatch-gate.js';
import {
  PlanApprovalRegistry,
  approvePlan,
  extractPendingPlan,
  isPlanApprovalPrompt,
  rejectPlan,
} from '../lex/plan-approval.js';
import { dispatchConfirmGateOn, type RuntimeConfigReader } from '../lex/layer-model.js';
import { HandoverApprovalRegistry, type PendingHandover } from '../lex/handover-approval.js';
import type { TopLayerEvent } from '../voice/voice-top-layer.js';
import type { TopLayerControlHandlers } from '../voice/lex-voice-ws.js';

export interface VoiceLayersWireDeps {
  cfg: RuntimeConfigReader;
  now: () => number;
  log: (msg: string) => void;
  /** Hand an event to the anchor's Layer 1; false = no voice client. */
  notify: (anchorId: string, event: TopLayerEvent) => Promise<boolean>;
  /** Bell fallback when no voice client is bound to the anchor. */
  bell: (input: { title: string; body: string; dedup_key: string; anchor_id?: string }) => void;
  /** Re-enter POST /lex/inject-cross-session with a body (Fastify inject). */
  reinject: (
    body: Record<string, unknown>,
  ) => Promise<{ status: number; ok: boolean; decision: string | null }>;
  /** Mint a fresh HMAC token for a subject (session uuid or anchor id). */
  freshToken: (subject: string) => string;
  /** The worker session a brainstorm supervises (caller_brainstorm_id path). */
  resolveSupervisedTarget: (brainstormId: string) => string | null;
  /** The L2 PTY for a brainstorm anchor. */
  lexPtyFor: (anchorId: string) => string | null;
  ptyInject: (ptyId: string, text: string, commit: boolean) => { ok: boolean };
  ptyWriteRaw: (ptyId: string, bytes: string) => boolean;
  /** Plan approval lookups. */
  anchorForCcSession: (ccSessionId: string) => { id: string; current_pty_id: string | null } | null;
  ptyIdForCcSession: (ccSessionId: string) => string | null;
  transcriptPathFor: (anchorId: string, ccSessionId: string) => string | null;
  readTail: (path: string, bytes: number) => string;
  clearPendingPrompt: (ccSessionId: string) => void;
  delay: (fn: () => void, ms: number) => void;
  /** Expiry sweep scheduling (unref'd interval in production). */
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
  /** Gate TTL override (tests). */
  dispatchTtlMs?: number;
  /* Phase C (2026-09-22): handover approval by voice. The registry is
   * shared with the handover routes; the clear runs through the same
   * clear-and-paste route Lex would call, by handover id. */
  handovers?: HandoverApprovalRegistry;
  clearAndPasteByHandover?: (input: {
    brainstormId: string;
    projectAnchorId: string;
    handoverId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}

export interface VoiceLayersWire {
  /** A reviewed handover landed: read it out through Layer 1 (bell
   * fallback when no voice client is bound). Resolves true when a voice
   * client took it. */
  announceHandover(p: PendingHandover): Promise<boolean>;
  /** Route hook for POST /lex/inject-cross-session: a parked response
   * when the gate holds the dispatch, null when the route proceeds. */
  maybePark(
    body: Record<string, unknown>,
  ): Promise<{ status: number; payload: Record<string, unknown> } | null>;
  /** Route hook for POST /sessions/:id/pending-prompt. */
  onPendingPrompt(sessionId: string, kind: string, message: string): Promise<void>;
  handlers(): TopLayerControlHandlers;
  /** Run the expiry sweep now; returns the rejected dispatches. */
  expireNow(): PendingDispatch[];
  stop(): void;
}

export const DISPATCH_TTL_MS = 10 * 60_000;
const EXPIRY_SWEEP_MS = 60_000;
const PLAN_TAIL_BYTES = 256 * 1024;
const PLAN_TEXT_CAP = 1_500;

/** Last `bytes` of a file as utf-8 ('' when unreadable). */
export function readFileTail(path: string, bytes: number): string {
  try {
    const size = fs.statSync(path).size;
    if (size === 0) return '';
    const len = Math.min(size, bytes);
    const fd = fs.openSync(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function createVoiceLayersWire(deps: VoiceLayersWireDeps): VoiceLayersWire {
  const gate = new DispatchGate({ now: deps.now, ttlMs: deps.dispatchTtlMs ?? DISPATCH_TTL_MS });
  const plans = new PlanApprovalRegistry();
  /* Ids released by a spoken confirm: the re-entered request carries
   * confirmed_dispatch_id and passes the gate exactly once. */
  const releasedIds = new Set<string>();

  function rejectToBrain(anchorId: string, line: string): void {
    const ptyId = deps.lexPtyFor(anchorId);
    if (!ptyId) {
      deps.log(`[dispatch-gate] anchor ${anchorId.slice(0, 8)} has no live L2 pty; rejection note dropped`);
      return;
    }
    const r = deps.ptyInject(ptyId, line, true);
    if (!r.ok) deps.log(`[dispatch-gate] rejection inject failed on ${ptyId}`);
  }

  async function maybePark(
    body: Record<string, unknown>,
  ): Promise<{ status: number; payload: Record<string, unknown> } | null> {
    const confirmedId = body.confirmed_dispatch_id;
    if (typeof confirmedId === 'string' && releasedIds.delete(confirmedId)) return null;
    if (!dispatchConfirmGateOn(deps.cfg)) return null;
    const from = body.from_anchor_id;
    if (typeof from !== 'string' || !from) return null;
    const label = typeof body.caller_label === 'string' ? body.caller_label : null;
    if (isContextManagementCaller(label)) return null;
    const parked = gate.park(from, body);
    deps.log(
      `[dispatch-gate] parked ${parked.id} from anchor ${from.slice(0, 8)} caller=${label ?? 'none'}: ${JSON.stringify(parked.summary.slice(0, 80))}`,
    );
    const delivered = await deps.notify(from, {
      kind: 'dispatch-pending',
      id: parked.id,
      text: `the brain wants to send the worker: ${parked.summary}`,
    });
    if (!delivered) {
      deps.bell({
        title: 'Lex wants to prompt the worker',
        body: parked.summary,
        dedup_key: `dispatch:${parked.id}`,
        anchor_id: from,
      });
    }
    return {
      status: 202,
      payload: {
        ok: false,
        decision: 'held_for_confirm',
        pending_id: parked.id,
        message:
          'The operator is being asked by voice. Do not re-send; you will get a [dispatch-rejected] note to revise, or the worker will start.',
      },
    };
  }

  async function confirmDispatch(anchorId: string): Promise<string | null> {
    const p = gate.pendingFor(anchorId);
    if (!p) return 'Nothing is waiting to go to the worker.';
    gate.release(p.id);
    releasedIds.add(p.id);
    const body: Record<string, unknown> = { ...p.body, confirmed_dispatch_id: p.id };
    /* The original token was minute-scoped; mint a fresh one for the
     * same subject the route will verify against. */
    let subject: string | null = null;
    if (typeof body.target_session === 'string' && body.target_session) {
      subject = body.target_session;
    } else if (typeof body.caller_brainstorm_id === 'string' && body.caller_brainstorm_id) {
      subject = deps.resolveSupervisedTarget(body.caller_brainstorm_id);
      if (subject) body.target_session = subject;
    }
    if (typeof body.signed_anchor_id === 'string' && body.signed_anchor_id) {
      subject = body.signed_anchor_id;
    }
    if (!subject) {
      releasedIds.delete(p.id);
      deps.log(`[dispatch-gate] release ${p.id}: no signing subject; dropped`);
      return 'That dispatch has no worker to go to any more.';
    }
    body.token = deps.freshToken(subject);
    const r = await deps.reinject(body);
    deps.log(`[dispatch-gate] released ${p.id}: status=${r.status} decision=${r.decision ?? 'none'}`);
    return r.ok
      ? `Sent to the worker (${r.decision ?? 'accepted'}).`
      : `The worker did not take it (${r.decision ?? r.status}).`;
  }

  async function rejectDispatch(anchorId: string, reason: string | null): Promise<string | null> {
    const p = gate.pendingFor(anchorId);
    if (!p) return 'Nothing is waiting to go to the worker.';
    gate.reject(p.id, reason ?? '');
    rejectToBrain(
      anchorId,
      `[dispatch-rejected ${p.id}] The operator said no${reason ? `: ${reason}` : ''}. Revise the plan and confirm again before dispatching.`,
    );
    deps.log(`[dispatch-gate] rejected ${p.id}: ${reason ?? '(no reason)'}`);
    return 'Told the brain to revise.';
  }

  async function onPendingPrompt(sessionId: string, kind: string, message: string): Promise<void> {
    if (!isPlanApprovalPrompt(kind, message)) return;
    const anchor = deps.anchorForCcSession(sessionId);
    if (!anchor) return;
    const ptyId = deps.ptyIdForCcSession(sessionId) ?? anchor.current_pty_id;
    const path = deps.transcriptPathFor(anchor.id, sessionId);
    let plan: string | null = null;
    try {
      plan = path ? extractPendingPlan(deps.readTail(path, PLAN_TAIL_BYTES)) : null;
    } catch {
      plan = null;
    }
    plans.set({
      anchorId: anchor.id,
      ccSessionId: sessionId,
      ptyId,
      plan: plan ?? '(plan text unavailable; ask the brain to summarise it)',
      atMs: deps.now(),
    });
    deps.log(
      `[plan-approval] pending on anchor ${anchor.id.slice(0, 8)} (${plan ? plan.length : 0} chars, pty=${ptyId ?? 'none'})`,
    );
    const delivered = await deps.notify(anchor.id, {
      kind: 'plan-ready',
      text: plan
        ? plan.slice(0, PLAN_TEXT_CAP)
        : 'the brain has a plan ready but its text is unavailable',
    });
    if (!delivered) {
      deps.bell({
        title: 'Lex has a plan waiting for approval',
        body: (plan ?? '').replace(/\s+/g, ' ').slice(0, 200),
        dedup_key: `plan:${anchor.id}`,
        anchor_id: anchor.id,
      });
    }
  }

  async function approve(anchorId: string): Promise<string | null> {
    const p = plans.get(anchorId);
    if (!p) return 'No plan is waiting.';
    if (!p.ptyId) return 'The brain is not reachable to approve it.';
    const ok = approvePlan(deps.ptyInject, p.ptyId);
    plans.clear(anchorId);
    deps.clearPendingPrompt(p.ccSessionId);
    deps.log(`[plan-approval] ${ok ? 'approved' : 'approve FAILED'} on anchor ${anchorId.slice(0, 8)}`);
    return ok ? 'Approved. The brain is going ahead.' : 'Could not reach the brain to approve it.';
  }

  async function reject(anchorId: string, reason: string | null): Promise<string | null> {
    const p = plans.get(anchorId);
    if (!p) return 'No plan is waiting.';
    if (!p.ptyId) return 'The brain is not reachable.';
    rejectPlan(
      (ptyId, bytes) => {
        deps.ptyWriteRaw(ptyId, bytes);
      },
      deps.ptyInject,
      p.ptyId,
      reason ?? '',
      deps.delay,
    );
    plans.clear(anchorId);
    deps.clearPendingPrompt(p.ccSessionId);
    deps.log(`[plan-approval] rejected on anchor ${anchorId.slice(0, 8)}: ${reason ?? '(no reason)'}`);
    return 'Sent it back for another pass.';
  }

  function expireNow(): PendingDispatch[] {
    const expired = gate.expire(deps.now());
    for (const e of expired) {
      deps.log(`[dispatch-gate] ${e.id} expired unanswered`);
      rejectToBrain(
        e.anchorId,
        `[dispatch-rejected ${e.id}] No answer from the operator within ten minutes. Hold that work; ask again when he is back.`,
      );
    }
    return expired;
  }

  /* Phase C: handover approval by voice, the same shape as plan
   * approval. The worker wrote its half, Lex reviewed it, the operator
   * says yes or no. */
  const handovers = deps.handovers ?? new HandoverApprovalRegistry(deps.now);

  async function announceHandover(p: PendingHandover): Promise<boolean> {
    const delivered = await deps.notify(p.brainstormId, {
      kind: 'handover-ready',
      id: p.handoverId,
      text: p.gist,
    });
    deps.log(
      `[handover] announced ${p.handoverId} on brainstorm ${p.brainstormId.slice(0, 8)} voice=${delivered}`,
    );
    if (!delivered) {
      deps.bell({
        title: 'A handover is waiting for your go',
        body: p.gist.slice(0, 200),
        dedup_key: `handover:${p.handoverId}`,
        anchor_id: p.brainstormId,
      });
    }
    return delivered;
  }

  async function approveHandover(anchorId: string): Promise<string | null> {
    const p = handovers.approve(anchorId);
    if (!p) return 'No handover is waiting.';
    deps.log(`[handover] approved ${p.handoverId} on brainstorm ${anchorId.slice(0, 8)}`);
    if (!deps.clearAndPasteByHandover) return 'Approved. The worker will pick it up on its next start.';
    const r = await deps.clearAndPasteByHandover({
      brainstormId: p.brainstormId,
      projectAnchorId: p.projectAnchorId,
      handoverId: p.handoverId,
    });
    deps.log(`[handover] clear-and-paste ${p.handoverId}: ok=${r.ok}${r.error ? ` error=${r.error}` : ''}`);
    return r.ok
      ? 'Approved. The worker is clearing and picking up from the handover.'
      : `Approved, but the clear did not go through (${r.error ?? 'unknown'}).`;
  }

  async function rejectHandover(anchorId: string, reason: string | null): Promise<string | null> {
    const p = handovers.reject(anchorId);
    if (!p) return 'No handover is waiting.';
    rejectToBrain(
      anchorId,
      `[handover-rejected ${p.handoverId}] The operator said no${reason ? `: ${reason}` : ''}. Revise the review (corrections, next steps) and post it again.`,
    );
    deps.log(`[handover] rejected ${p.handoverId} on brainstorm ${anchorId.slice(0, 8)}: ${reason ?? '(no reason)'}`);
    return 'Sent it back for another pass.';
  }

  const handlers: TopLayerControlHandlers = {
    pendingDispatch: (anchorId) => {
      const p = gate.pendingFor(anchorId);
      return p ? { id: p.id, summary: p.summary } : null;
    },
    pendingPlan: (anchorId) => plans.get(anchorId)?.plan ?? null,
    confirmDispatch,
    rejectDispatch,
    approvePlan: approve,
    rejectPlan: reject,
    pendingHandover: (anchorId) => handovers.pendingForBrainstorm(anchorId)?.gist ?? null,
    approveHandover,
    rejectHandover,
  };

  let sweep: unknown = null;
  if (deps.schedule) sweep = deps.schedule(() => expireNow(), EXPIRY_SWEEP_MS);

  return {
    announceHandover,
    maybePark,
    onPendingPrompt,
    handlers: () => handlers,
    expireNow,
    stop: () => {
      if (sweep !== null && deps.clearSchedule) deps.clearSchedule(sweep);
      sweep = null;
    },
  };
}
