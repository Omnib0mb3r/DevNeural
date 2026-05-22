/**
 * Active polling-with-expectations supervisor.
 *
 * Brainstorm-as-durable-primary-entity (2026-05-22, plan section L).
 * Today's worker-stall-watch is reactive: it detects "tool stalled >5
 * min" or "no user response >3 min" and pages. It does NOT know what
 * the worker was supposed to be doing.
 *
 * This module adds an EXPECTATION layer. Whenever Lex dispatches a
 * task to its attached worker CC, the dispatcher calls
 * `recordExpectation` to stash {expected_outcome, expected_files,
 * expected_duration_ms} keyed on the brainstorm + anchor. The 90s
 * tick walks open expectations, reads each worker's recent jsonl
 * turns, and asks the LLM "given expected_outcome X, does the
 * worker's recent activity match? Return {aligned, drift_summary,
 * suggested_correction}". On drift the supervisor fires
 * lex-attention so the operator sees a push notification AND
 * persists the LLM's correction text so Lex can read it on the next
 * voice turn and inject a course-correction.
 *
 * LLM provider: routed through callVoiceChat (ollama, local-only,
 * BF-4 anthropic hard-blocked) since the worker jsonl tail is
 * brainstorm content per the same data classification.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { getStore } from './brainstorm-store.js';
import { resolveCcProjectDir } from './cc-project-slug.js';
import { fireForStall } from '../dashboard/lex-attention.js';
import {
  getSharedWorkerEventGate,
  type WorkerEvent,
} from '../dashboard/worker-event-router.js';
import { callVoiceChat } from '../llm/voice-chat.js';
import type { WorkerExpectationRow } from '../store/index-db.js';

/* Public API: Lex's dispatcher calls this when it tells the worker
 * to do something. anchorId is the worker's project_session anchor
 * id (NOT the cc_session_id, which can rebind on /clear); the
 * resolveCcJsonlPath helper translates anchor + current bound cc
 * session into the on-disk jsonl path. */
export interface RecordExpectationInput {
  brainstormId: string;
  anchorId: string;
  expectedOutcome: string;
  expectedFiles?: string[];
  expectedDurationMs?: number;
}

export function recordExpectation(input: RecordExpectationInput): string {
  const id = randomUUID();
  getStore().db.insertWorkerExpectation({
    id,
    brainstorm_id: input.brainstormId,
    anchor_id: input.anchorId,
    expected_outcome: input.expectedOutcome,
    expected_files: input.expectedFiles,
    expected_duration_ms: input.expectedDurationMs ?? null,
  });
  return id;
}

interface EvaluationResult {
  aligned: boolean;
  drift_summary: string;
  suggested_correction: string;
  alignment_score: number;
}

/* Tail the worker's jsonl from the bound CC session under the
 * project anchor. The anchor row carries current_session_id +
 * cwd; we resolve the jsonl path via the shared cc-project-slug
 * resolver. Returns at most `maxBytes` of trailing bytes so a long
 * session does not blow the LLM context window. */
function readWorkerJsonlTail(
  anchorId: string,
  maxBytes = 16 * 1024,
): string | null {
  const db = getStore().db;
  const anchor = db.getProjectSession(anchorId);
  if (!anchor || !anchor.current_session_id) return null;
  const projDir = resolveCcProjectDir(anchor.cwd);
  if (!projDir) return null;
  const file = `${projDir}/${anchor.current_session_id}.jsonl`;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const start = Math.max(0, stat.size - maxBytes);
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

const EVAL_SYSTEM_PROMPT = `You are an alignment judge for a coding assistant. The supervisor will give you (1) an expected outcome (what the worker was told to accomplish) and (2) the tail of the worker's transcript jsonl (recent tool calls and assistant turns). Decide whether the worker's recent activity is aligned with the expected outcome.

Return STRICT JSON only, no prose:
{
  "aligned": boolean,
  "alignment_score": 0.0-1.0,
  "drift_summary": "one short sentence; empty when aligned",
  "suggested_correction": "one short sentence the brainstorm can inject if drifted; empty when aligned"
}`;

async function evaluateExpectation(
  row: WorkerExpectationRow,
): Promise<EvaluationResult | null> {
  const tail = readWorkerJsonlTail(row.anchor_id);
  if (!tail || tail.trim().length < 80) {
    /* Not enough activity yet to judge. Skip this tick rather than
     * misclassify silence as drift. */
    return null;
  }
  const user = [
    `Expected outcome: ${row.expected_outcome}`,
    row.expected_files && row.expected_files !== '[]'
      ? `Expected files (heuristic): ${row.expected_files}`
      : '',
    '',
    'Worker jsonl tail:',
    tail.slice(-12_000),
  ]
    .filter((s) => s !== '')
    .join('\n');
  let reply;
  try {
    reply = await callVoiceChat(
      [
        { role: 'system', content: EVAL_SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      { maxTokens: 300, temperature: 0.1 },
    );
  } catch (err) {
    console.log(
      `[expectation] LLM call failed for id=${row.id}: ${(err as Error).message}`,
    );
    return null;
  }
  /* Extract first {...} block to tolerate small LLM preamble noise. */
  const match = reply.text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Partial<EvaluationResult>;
  try {
    parsed = JSON.parse(match[0]) as Partial<EvaluationResult>;
  } catch {
    return null;
  }
  return {
    aligned: Boolean(parsed.aligned),
    drift_summary: (parsed.drift_summary ?? '').trim(),
    suggested_correction: (parsed.suggested_correction ?? '').trim(),
    alignment_score:
      typeof parsed.alignment_score === 'number' &&
      Number.isFinite(parsed.alignment_score)
        ? Math.max(0, Math.min(1, parsed.alignment_score))
        : 0,
  };
}

export async function runExpectationTick(): Promise<{
  evaluated: number;
  drift_fired: number;
}> {
  const db = getStore().db;
  const open = db.listOpenWorkerExpectations({ limit: 20 });
  let evaluated = 0;
  let driftFired = 0;
  for (const row of open) {
    const result = await evaluateExpectation(row);
    if (!result) continue;
    evaluated += 1;
    db.updateWorkerExpectationEvaluation(row.id, {
      alignment_score: result.alignment_score,
      drift_summary: result.drift_summary || null,
      suggested_correction: result.suggested_correction || null,
    });
    if (result.aligned) {
      /* Below a high bar we don't close; aligned at low confidence
       * stays open for the next tick. Close on a clear aligned
       * verdict so the table doesn't accumulate. */
      if (result.alignment_score >= 0.85) {
        db.closeWorkerExpectation(row.id, 'completed');
      }
    } else {
      /* Plan section L reconcile (2026-05-22): drift events route
       * through the shared WorkerEventGate so they share the
       * per-anchor 12/hour cap with permission_denied / test_failure
       * / commit / idle. Without this, a misbehaving evaluator on a
       * tight tick could spam corrections past the rate limit and
       * blow up the worker's context. */
      const event: WorkerEvent = {
        type: 'expectation_drift',
        anchor_id: row.anchor_id,
        worker_session_id: row.anchor_id,
        timestamp: new Date().toISOString(),
        snippet: (result.drift_summary || '').slice(0, 2_000),
      };
      const verdict = getSharedWorkerEventGate().evaluate(event, Date.now());
      if (verdict.decision === 'accept') {
        try {
          fireForStall({
            brainstorm_id: row.brainstorm_id,
            anchor_id: row.anchor_id,
            reason: `worker drift: ${result.drift_summary.slice(0, 160)}`,
          });
        } catch {
          /* notification path is best-effort */
        }
        driftFired += 1;
      }
    }
  }
  return { evaluated, drift_fired: driftFired };
}

export interface ExpectationSupervisorHandle {
  stop: () => void;
}

/* Wire into daemon.ts schedulers table. Default 90s tick per plan
 * section L; tunable via env for tests. The first fire delays one
 * tick so daemon boot doesn't race ollama warm-up. */
export function startExpectationSupervisor(opts: {
  intervalMs?: number;
} = {}): ExpectationSupervisorHandle {
  const intervalMs = Math.max(
    10_000,
    opts.intervalMs ??
      Number(process.env.DEVNEURAL_EXPECTATION_TICK_MS ?? 90_000),
  );
  const timer = setInterval(() => {
    void runExpectationTick().catch((err) =>
      console.log(
        `[expectation-supervisor] tick threw: ${(err as Error).message}`,
      ),
    );
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
