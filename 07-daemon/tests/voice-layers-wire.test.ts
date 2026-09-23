/**
 * Voice layers Phase B wiring (voice-layers-wire.ts): the dispatch
 * confirm gate and plan approval as the routes see them, with every
 * side effect faked. No Fastify, no PTY, no database.
 */
import { describe, expect, it } from 'vitest';
import {
  createVoiceLayersWire,
  resolveProjectByName,
  type VoiceLayersWireDeps,
} from '../src/dashboard/voice-layers-wire.js';
import type { TopLayerEvent } from '../src/voice/voice-top-layer.js';
import { HandoverApprovalRegistry } from '../src/lex/handover-approval.js';

const PLAN_TAIL =
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu1', name: 'ExitPlanMode', input: { plan: '# Plan\n1. do x' } },
      ],
    },
  }) + '\n';

function rig(over: Partial<VoiceLayersWireDeps> & { gateOn?: boolean } = {}) {
  let now = 1_000;
  const calls = {
    notify: [] as Array<[string, TopLayerEvent]>,
    bell: [] as string[],
    reinject: [] as Array<Record<string, unknown>>,
    inject: [] as Array<[string, string, boolean]>,
    raw: [] as Array<[string, string]>,
    cleared: [] as string[],
    delayed: [] as Array<() => void>,
    log: [] as string[],
  };
  const deps: VoiceLayersWireDeps = {
    cfg: { getRuntimeConfig: (k) => (k === 'dispatch_confirm_gate' && over.gateOn !== false ? 'on' : null) },
    now: () => now,
    log: (m) => calls.log.push(m),
    notify: async (a, e) => {
      calls.notify.push([a, e]);
      return true;
    },
    bell: (i) => {
      calls.bell.push(i.title);
    },
    reinject: async (b) => {
      calls.reinject.push(b);
      return { status: 200, ok: true, decision: 'accepted' };
    },
    freshToken: (subject) => `tok:${subject}`,
    resolveSupervisedTarget: (b) => `worker-of-${b}`,
    lexPtyFor: (a) => `lexpty-${a}`,
    ptyInject: (p, t, c) => {
      calls.inject.push([p, t, c]);
      return { ok: true };
    },
    ptyWriteRaw: (p, b) => {
      calls.raw.push([p, b]);
      return true;
    },
    anchorForCcSession: (cc) => (cc === 'cc-l2' ? { id: 'anchor-a', current_pty_id: 'lexpty-anchor-a' } : null),
    ptyIdForCcSession: () => null,
    transcriptPathFor: () => 'C:/fake/l2.jsonl',
    readTail: () => PLAN_TAIL,
    clearPendingPrompt: (cc) => {
      calls.cleared.push(cc);
    },
    delay: (fn) => {
      calls.delayed.push(fn);
    },
    ...over,
  };
  const wire = createVoiceLayersWire(deps);
  return { wire, calls, tick: (ms: number) => (now += ms) };
}

const LEX_BODY = {
  target_session: 'cc-worker',
  token: 'stale',
  text: 'run the vitest suite and report back',
  caller_label: 'lex-voice',
  from_anchor_id: 'anchor-a',
};

describe('dispatch confirm gate (route hook)', () => {
  it('is off unless dispatch_confirm_gate=on', async () => {
    const { wire } = rig({ gateOn: false });
    expect(await wire.maybePark({ ...LEX_BODY })).toBeNull();
  });

  it('parks a Lex dispatch, tells Layer 1, and answers 202 held_for_confirm', async () => {
    const { wire, calls } = rig();
    const r = await wire.maybePark({ ...LEX_BODY });
    expect(r?.status).toBe(202);
    expect(r?.payload.decision).toBe('held_for_confirm');
    expect(calls.notify).toHaveLength(1);
    expect(calls.notify[0]![1].kind).toBe('dispatch-pending');
    expect(calls.notify[0]![1].text).toContain('run the vitest suite');
    expect(calls.bell).toEqual([]);
    expect(wire.handlers().pendingDispatch!('anchor-a')?.summary).toBe(
      'run the vitest suite and report back',
    );
  });

  it('bells when no voice client is bound', async () => {
    const { wire, calls } = rig({ notify: async () => false });
    await wire.maybePark({ ...LEX_BODY });
    expect(calls.bell).toEqual(['Lex wants to prompt the worker']);
  });

  it('context-management callers and anchor-less requests pass through', async () => {
    const { wire } = rig();
    expect(await wire.maybePark({ ...LEX_BODY, caller_label: 'smart-compact:window-open' })).toBeNull();
    expect(await wire.maybePark({ ...LEX_BODY, caller_label: 'smart-clear' })).toBeNull();
    const { from_anchor_id: _f, ...noAnchor } = LEX_BODY;
    expect(await wire.maybePark({ ...noAnchor })).toBeNull();
  });

  it('confirm re-enters the route with a fresh token and passes the gate exactly once', async () => {
    const { wire, calls } = rig();
    await wire.maybePark({ ...LEX_BODY });
    const status = await wire.handlers().confirmDispatch!('anchor-a', null);
    expect(status).toMatch(/Sent to the worker/);
    expect(calls.reinject).toHaveLength(1);
    const body = calls.reinject[0]!;
    expect(body.token).toBe('tok:cc-worker');
    expect(typeof body.confirmed_dispatch_id).toBe('string');
    /* The re-entered request is let through once, then the gate parks again. */
    expect(await wire.maybePark(body)).toBeNull();
    expect((await wire.maybePark(body))?.status).toBe(202);
    expect(wire.handlers().pendingDispatch!('anchor-a')?.id).not.toBe(body.confirmed_dispatch_id);
  });

  it('confirm on the caller_brainstorm_id path resolves the worker and signs for it', async () => {
    const { wire, calls } = rig();
    const { target_session: _t, ...noTarget } = LEX_BODY;
    await wire.maybePark({ ...noTarget, caller_brainstorm_id: 'anchor-a' });
    await wire.handlers().confirmDispatch!('anchor-a', null);
    expect(calls.reinject[0]!.target_session).toBe('worker-of-anchor-a');
    expect(calls.reinject[0]!.token).toBe('tok:worker-of-anchor-a');
  });

  it('reject tells the brain to revise on its own pty', async () => {
    const { wire, calls } = rig();
    await wire.maybePark({ ...LEX_BODY });
    const status = await wire.handlers().rejectDispatch!('anchor-a', 'not tonight');
    expect(status).toMatch(/revise/i);
    expect(calls.inject).toHaveLength(1);
    expect(calls.inject[0]![0]).toBe('lexpty-anchor-a');
    expect(calls.inject[0]![1]).toMatch(/^\[dispatch-rejected \w+\] The operator said no: not tonight/);
    expect(wire.handlers().pendingDispatch!('anchor-a')).toBeNull();
    expect(await wire.handlers().confirmDispatch!('anchor-a', null)).toMatch(/Nothing is waiting/);
  });

  it('an unanswered dispatch expires with a note to the brain', async () => {
    const { wire, calls, tick } = rig();
    await wire.maybePark({ ...LEX_BODY });
    expect(wire.expireNow()).toEqual([]);
    tick(10 * 60_000 + 1);
    expect(wire.expireNow()).toHaveLength(1);
    expect(calls.inject.at(-1)![1]).toMatch(/No answer from the operator within ten minutes/);
    expect(wire.handlers().pendingDispatch!('anchor-a')).toBeNull();
  });
});

describe('plan approval (pending-prompt hook)', () => {
  it('detects the ExitPlanMode prompt on an L2 session, reads the plan, tells Layer 1', async () => {
    const { wire, calls } = rig();
    await wire.onPendingPrompt('cc-l2', 'permission_prompt', 'Claude needs your permission to use ExitPlanMode');
    expect(wire.handlers().pendingPlan!('anchor-a')).toBe('# Plan\n1. do x');
    expect(calls.notify[0]![1]).toMatchObject({ kind: 'plan-ready', text: '# Plan\n1. do x' });
  });

  it('ignores other prompts and sessions that are not a brainstorm', async () => {
    const { wire, calls } = rig();
    await wire.onPendingPrompt('cc-l2', 'idle_prompt', 'still working?');
    await wire.onPendingPrompt('cc-worker', 'permission_prompt', 'use ExitPlanMode');
    expect(calls.notify).toEqual([]);
    expect(wire.handlers().pendingPlan!('anchor-a')).toBeNull();
  });

  it('approve presses Enter on the L2 pty and clears the pending prompt', async () => {
    const { wire, calls } = rig();
    await wire.onPendingPrompt('cc-l2', 'permission_prompt', 'use ExitPlanMode');
    const status = await wire.handlers().approvePlan!('anchor-a', null);
    expect(status).toMatch(/Approved/);
    expect(calls.inject).toEqual([['lexpty-anchor-a', '\r', false]]);
    expect(calls.cleared).toEqual(['cc-l2']);
    expect(wire.handlers().pendingPlan!('anchor-a')).toBeNull();
    expect(await wire.handlers().approvePlan!('anchor-a', null)).toMatch(/No plan is waiting/);
  });

  it('reject presses Escape then types the reason as the next prompt', async () => {
    const { wire, calls } = rig();
    await wire.onPendingPrompt('cc-l2', 'permission_prompt', 'use ExitPlanMode');
    const status = await wire.handlers().rejectPlan!('anchor-a', 'too risky');
    expect(status).toMatch(/another pass/);
    expect(calls.raw).toEqual([['lexpty-anchor-a', '\x1b']]);
    expect(calls.inject).toEqual([]);
    calls.delayed.forEach((fn) => fn());
    expect(calls.inject).toHaveLength(1);
    expect(calls.inject[0]![1]).toMatch(/^\[plan-rejected\] The operator said no: too risky/);
    expect(calls.cleared).toEqual(['cc-l2']);
  });
});

/* Phase C (2026-09-22): the worker wrote its half, Lex reviewed it, the
 * operator says yes or no by voice. Same shape as plan approval. */
describe('handover approval by voice (Phase C)', () => {
  function handoverRig(over: Partial<VoiceLayersWireDeps> & { voice?: boolean } = {}) {
    const handovers = new HandoverApprovalRegistry(() => 1_000);
    const clears: Array<{ brainstormId: string; projectAnchorId: string; handoverId: string }> = [];
    const base = rig({
      handovers,
      clearAndPasteByHandover: async (i) => {
        clears.push(i);
        return { ok: true };
      },
      ...(over.voice === false
        ? {
            notify: async () => false,
          }
        : {}),
      ...over,
    });
    const pending = handovers.register({
      handoverId: 'HANDOVER-2026-09-22T20-00-00Z.md',
      file: 'HANDOVER-2026-09-22T20-00-00Z.md',
      brainstormId: 'anchor-a',
      projectAnchorId: 'proj-x',
      reseed: 'RESEED TEXT',
      gist: 'worker at end of step 3; Lex added steps 4 and 5',
    });
    return { ...base, handovers, clears, pending };
  }

  it('announces a reviewed handover to Layer 1 and exposes the gist as pending', async () => {
    const { wire, calls, pending } = handoverRig();
    expect(await wire.announceHandover(pending)).toBe(true);
    expect(calls.notify[0]![1]).toMatchObject({
      kind: 'handover-ready',
      id: pending.handoverId,
      text: 'worker at end of step 3; Lex added steps 4 and 5',
    });
    expect(calls.bell).toEqual([]);
    expect(wire.handlers().pendingHandover!('anchor-a')).toBe(
      'worker at end of step 3; Lex added steps 4 and 5',
    );
  });

  it('bells and reports no voice when nobody is listening', async () => {
    const { wire, calls, pending } = handoverRig({ voice: false });
    expect(await wire.announceHandover(pending)).toBe(false);
    expect(calls.bell).toEqual(['A handover is waiting for your go']);
  });

  it('approve runs clear-and-paste by handover id exactly once and clears the pending', async () => {
    const { wire, clears, handovers } = handoverRig();
    const status = await wire.handlers().approveHandover!('anchor-a', null);
    expect(status).toMatch(/Approved/);
    expect(clears).toEqual([
      {
        brainstormId: 'anchor-a',
        projectAnchorId: 'proj-x',
        handoverId: 'HANDOVER-2026-09-22T20-00-00Z.md',
      },
    ]);
    expect(wire.handlers().pendingHandover!('anchor-a')).toBeNull();
    /* Approved entries are what the worker's clear-handoff hook serves. */
    expect(handovers.consumeApproved('proj-x')?.reseed).toBe('RESEED TEXT');
    expect(await wire.handlers().approveHandover!('anchor-a', null)).toMatch(/No handover is waiting/);
    expect(clears).toHaveLength(1);
  });

  it('reject sends the reason back to the brain and clears the pending', async () => {
    const { wire, calls, handovers } = handoverRig();
    const status = await wire.handlers().rejectHandover!('anchor-a', 'missing the migration');
    expect(status).toMatch(/another pass/);
    expect(calls.inject).toHaveLength(1);
    expect(calls.inject[0]![0]).toBe('lexpty-anchor-a');
    expect(calls.inject[0]![1]).toMatch(
      /^\[handover-rejected HANDOVER-2026-09-22T20-00-00Z\.md\] The operator said no: missing the migration/,
    );
    expect(wire.handlers().pendingHandover!('anchor-a')).toBeNull();
    expect(handovers.consumeApproved('proj-x')).toBeNull();
  });
});

describe('worker and project effects by voice (BUG-038)', () => {
  const BRAINSTORMS = [
    { brainstormId: 'anchor-a', slug: 'dropship-01', title: null, live: true },
    { brainstormId: 'anchor-b', slug: 'New-Letter-and-TikToks', title: 'newsletter', live: false },
    { brainstormId: 'anchor-c', slug: 'DevNeural', title: 'DevNeural Testing', live: true },
  ];

  function workerRig(
    over: Partial<VoiceLayersWireDeps> & { live?: boolean; interrupt?: string } = {},
  ) {
    const w = {
      open: [] as string[],
      end: [] as string[],
      interrupt: [] as string[],
      opened: [] as string[],
    };
    const r = rig({
      supervisedProjectFor: (b) =>
        b === 'anchor-a' ? { id: 'proj-1', slug: 'dropship-01', live: over.live ?? false } : null,
      openWorker: async (id) => {
        w.open.push(id);
        return { ok: true, mode: 'spawning' };
      },
      endWorker: (id) => {
        w.end.push(id);
        return true;
      },
      interruptWorker: (id) => {
        w.interrupt.push(id);
        return { ok: over.interrupt !== 'pty_not_found', result: over.interrupt ?? 'accepted' };
      },
      listProjectBrainstorms: () => BRAINSTORMS,
      openBrainstorm: async (id) => {
        w.opened.push(id);
        return { ok: true };
      },
      ...over,
    });
    return { ...r, w };
  }

  it('start_worker starts the supervised project, and says so when there is none', async () => {
    const { wire, w } = workerRig();
    expect(await wire.handlers().startWorker!('anchor-a', null)).toMatch(
      /Starting the worker on dropship-01/,
    );
    expect(w.open).toEqual(['proj-1']);
    expect(await wire.handlers().startWorker!('anchor-z', null)).toMatch(/no project/i);
    expect(w.open).toEqual(['proj-1']);
  });

  it('start_worker on a running worker starts nothing', async () => {
    const { wire, w } = workerRig({ live: true });
    expect(await wire.handlers().startWorker!('anchor-a', null)).toMatch(/already running/);
    expect(w.open).toEqual([]);
  });

  it('stop_worker releases a running worker and refuses a stopped one', async () => {
    const stopped = workerRig();
    expect(await stopped.wire.handlers().stopWorker!('anchor-a', null)).toMatch(/not running/);
    expect(stopped.w.end).toEqual([]);
    const running = workerRig({ live: true });
    expect(await running.wire.handlers().stopWorker!('anchor-a', null)).toMatch(
      /Released the worker on dropship-01/,
    );
    expect(running.w.end).toEqual(['proj-1']);
  });

  it('panic_worker interrupts the worker and reports an unreachable one', async () => {
    const ok = workerRig({ live: true });
    expect(await ok.wire.handlers().panicWorker!('anchor-a', null)).toMatch(
      /Interrupted the worker on dropship-01/,
    );
    expect(ok.w.interrupt).toEqual(['proj-1']);
    const gone = workerRig({ live: true, interrupt: 'pty_not_found' });
    expect(await gone.wire.handlers().panicWorker!('anchor-a', null)).toMatch(/not reachable/);
  });

  it('switch_project opens the brainstorm of the named project and hands back its id', async () => {
    const { wire, w } = workerRig();
    const r = await wire.handlers().switchProject!('anchor-a', 'news letter');
    expect(r.brainstormId).toBe('anchor-b');
    expect(r.label).toBe('New-Letter-and-TikToks');
    expect(r.status).toMatch(/Switched to New-Letter-and-TikToks/);
    expect(w.opened).toEqual(['anchor-b']);
  });

  it('switch_project with no name, an unknown name, or the current project switches nothing', async () => {
    const { wire, w } = workerRig();
    expect((await wire.handlers().switchProject!('anchor-a', null)).brainstormId).toBeNull();
    const unknown = await wire.handlers().switchProject!('anchor-a', 'banana stand');
    expect(unknown.brainstormId).toBeNull();
    expect(unknown.status).toMatch(/dropship-01/);
    expect(unknown.status).toMatch(/DevNeural/);
    const same = await wire.handlers().switchProject!('anchor-a', 'dropship');
    expect(same.brainstormId).toBeNull();
    expect(same.status).toMatch(/already on dropship-01/);
    expect(w.opened).toEqual([]);
  });

  it('resolveProjectByName matches loosely and prefers a live brainstorm', () => {
    expect(resolveProjectByName(BRAINSTORMS, 'DEVNEURAL')?.brainstormId).toBe('anchor-c');
    expect(resolveProjectByName(BRAINSTORMS, 'drop ship')?.brainstormId).toBe('anchor-a');
    expect(resolveProjectByName(BRAINSTORMS, 'tik toks')?.brainstormId).toBe('anchor-b');
    expect(resolveProjectByName(BRAINSTORMS, 'the newsletter project')?.brainstormId).toBe(
      'anchor-b',
    );
    expect(resolveProjectByName(BRAINSTORMS, 'banana')).toBeNull();
    const twins = [
      { brainstormId: 'old', slug: 'DevNeural', title: null, live: false },
      { brainstormId: 'new', slug: 'DevNeural', title: null, live: true },
    ];
    expect(resolveProjectByName(twins, 'devneural')?.brainstormId).toBe('new');
  });
});
