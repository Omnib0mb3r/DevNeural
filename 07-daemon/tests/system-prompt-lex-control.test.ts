/**
 * Lex in control (operator, 2026-09-22): the Layer 2 contract tells Lex to
 * look at the current state before answering, lets her start a worker
 * for a deeper look, reads the worker's turn summaries to Michael, and
 * drives the Phase C handover flow (request, review, spoken approval,
 * clear-and-paste by handover id). The old plan route stays documented
 * for a worker that cannot write its own half.
 */
import { describe, expect, it } from 'vitest';
import { buildLexSystemPromptVersioned } from '../src/lex/system-prompt.js';

const SCOPE = {
  brainstormId: 'bs-mha-anchor',
  projectAnchorId: 'proj-mha',
  projectSlug: 'Material-Handling-Academy',
  workerSessionId: 'cc-mha-1234',
};

describe('Lex in control (L2 contract, 2026-09-22)', () => {
  it('checks current state first, may start a worker, and reads turn summaries', () => {
    for (const r of [
      buildLexSystemPromptVersioned({ archive: false, scope: SCOPE }),
      buildLexSystemPromptVersioned({ archive: false }),
    ]) {
      const flat = r.prompt.replace(/\s+/g, ' ');
      expect(flat).toContain('Current state first');
      expect(flat).toContain('never repeat a fact you cannot see right now');
      expect(flat).toContain('/projects/:id/start-claude');
      expect(flat).toContain('event=turn_summary');
      expect(flat).toContain('in your words, first person');
    }
  });

  it('drives the Phase C handover flow in the supervision loop', () => {
    const r = buildLexSystemPromptVersioned({ archive: false, scope: SCOPE });
    const flat = r.prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('POST /lex/smart-clear/handover-request { brainstorm_id: "bs-mha-anchor", anchor_id: "proj-mha" }');
    expect(flat).toContain('POST /lex/smart-clear/review');
    expect(flat).toContain('held_for_approval');
    expect(flat).toContain('no_voice');
    expect(flat).toContain('[handover-rejected');
    expect(flat).toContain('brainstorm_id: "bs-mha-anchor", handover_id, reason: "ctx-fill-clear"');
    expect(flat).toContain('turn_summary) as your cue');
    /* The pre-Phase-C plan route is still documented for a dead worker. */
    expect(flat).toContain('POST /lex/smart-clear/plan { anchor_id }');
    expect(flat).toContain('vet.ok');
  });

  it('owns her own context: self-clear through the daemon, never a bare /clear', () => {
    for (const r of [
      buildLexSystemPromptVersioned({ archive: false, scope: SCOPE }),
      buildLexSystemPromptVersioned({ archive: false }),
    ]) {
      const flat = r.prompt.replace(/\s+/g, ' ');
      expect(flat).toContain('Your own context (hard rule, AUTO-CLEAR T4)');
      expect(flat).toContain('[self-clear-due]');
      expect(flat).toContain('POST /lex/self-clear { brainstorm_id, draft: { verified_state, what_i_was_doing, decisions_in_force, stopping_point }, next_steps, plan_reference }');
      expect(flat).toContain('Never type /clear otherwise');
      expect(flat).toContain('GET /lex/context-pack?brainstorm_id=');
      expect(r.prompt).toContain('GET  /lex/self-clear/state?brainstorm_id=');
    }
  });

  it('documents the handover routes in the runtime route list for every prompt', () => {
    for (const r of [
      buildLexSystemPromptVersioned({ archive: false, scope: SCOPE }),
      buildLexSystemPromptVersioned({ archive: false }),
    ]) {
      expect(r.prompt).toContain('POST /lex/smart-clear/handover-request { brainstorm_id, anchor_id }');
      expect(r.prompt).toContain('GET  /lex/anchors/:id/handovers');
      expect(r.prompt).toContain('GET  /lex/anchors/:id/handovers/:file');
      expect(r.prompt).toContain('GET  /lex/auto-clear/mode, POST /lex/auto-clear/mode { mode }');
      expect(r.prompt).toContain('POST /projects/:id/start-claude { anchor_id }');
    }
  });
});
