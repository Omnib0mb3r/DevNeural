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
import { askJudge } from './judge-session.js';
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

/* Operator's expectation-supersede policy (2026-07-15). Verbatim
 * intent: "if it's a contradictory instruction, supersede; or else a
 * new command should be heard and the replies combined if they
 * respond at the right time, just like a human would do."
 *
 * Before a new dispatch is recorded, classify it against every OPEN
 * expectation already sitting on the same worker anchor:
 *   - 'contradicts' -> close the prior row as 'superseded'. The
 *     worker was told to do X; a contradictory Y makes X's row stale
 *     supervision noise (it would otherwise sit open until the 90s
 *     tick eventually judges it "drifted" against activity that was
 *     never wrong, just superseded).
 *   - 'independent' -> leave the prior row open. runExpectationTick
 *     already evaluates every open row for an anchor independently
 *     against the same jsonl tail each tick (see that function): a
 *     single worker reply that satisfies two open, unrelated asks
 *     shows up as two independently-'aligned' verdicts in the same
 *     tick and both close together. That is the "replies combined...
 *     just like a human would do" half of the policy; it needed no
 *     change to the tick loop, only verification (see
 *     expectation-supervisor.test.ts).
 *
 * BF-4: routed through callVoiceChat, same local-only ollama plumbing
 * runExpectationTick's evaluator uses -- the new instruction text is
 * brainstorm content same as the jsonl tail is.
 *
 * FAIL-OPEN by design: a timeout, provider error, or missing provider
 * classifies as 'independent' (never blind-close a real expectation
 * because ollama hiccuped). Cheap pre-filter: an anchor with no open
 * rows never reaches the LLM at all. */
const DEFAULT_POLICY_TIMEOUT_MS = Number(
  process.env.DEVNEURAL_EXPECTATION_POLICY_TIMEOUT_MS ?? 3000,
);

/* Judge-session ask timeout for both classifySupersede and
 * evaluateExpectation below (2026-07-15, persistent Max-plan judge
 * session). Deliberately much more generous than DEFAULT_POLICY_
 * TIMEOUT_MS: askJudge's target is the operator's kept-open Claude Max
 * session, which has zero marginal cost per call, so there is no
 * reason to race it as tightly as the metered/local ollama fallback.
 * Both call sites here are fire-and-forget from the judge session's
 * perspective -- a slow judge reply just means the ollama fallback
 * below fires instead, never a blocked caller. */
const JUDGE_ASK_TIMEOUT_MS = Number(
  process.env.DEVNEURAL_EXPECTATION_JUDGE_TIMEOUT_MS ?? 15_000,
);

const EXPECTATION_POLICY_SYSTEM_PROMPT = `You are a dispatch-policy judge for a coding supervisor. The supervisor is about to record a NEW instruction it just sent to a worker. One OPEN instruction sent earlier to the SAME worker is still outstanding (not yet resolved). Decide whether the NEW instruction contradicts the OPEN one.

Return STRICT JSON only, no prose:
{ "verdict": "contradicts" | "independent" }

Hard rules:
- "contradicts" means the new instruction reverses, cancels, or replaces the open one for the same piece of work, so pursuing both literally would be wasteful or impossible (e.g. "stop refactoring X" after "refactor X", or "use approach B" after "use approach A" for the same goal).
- "independent" means the new instruction is a separate ask that can be pursued alongside the open one, even if unrelated, and even if a single worker reply could end up satisfying both at once.
- When genuinely uncertain, answer "independent": closing a live expectation on a wrong guess loses supervision coverage, while keeping two open only costs a second evaluation on the next tick.`;

export type SupersedeVerdict = 'contradicts' | 'independent';

/* Two-label judge call, one open row at a time. Mirrors
 * judgeInjectionUse's AbortController + Promise.race hard-timeout
 * shape (src/reinforcement/inject-verdict.ts) rather than inventing a
 * fourth timeout dance in this codebase. Never throws: any error,
 * timeout, or malformed reply resolves to 'independent' per the
 * fail-open contract above. */
async function classifySupersede(
  callChat: typeof callVoiceChat,
  openInstruction: string,
  newInstruction: string,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<SupersedeVerdict> {
  const questionPrompt = `Open instruction: ${openInstruction}\nNew instruction: ${newInstruction}\n\nDoes the new instruction contradict the open one?`;

  /* Prefer the persistent Max-plan judge session (2026-07-15 operator
   * directive: keep child sessions open, don't pay per call). askJudge
   * resolves null when DEVNEURAL_JUDGE_SESSION=0, the session is
   * unavailable/suspect, or the reply doesn't parse to a recognised
   * verdict -- this is a pure prefer-then-fallback onto the unchanged
   * ollama race below, so the fail-open contract documented on this
   * function still holds either way. */
  try {
    const judged = await askJudge({
      kind: 'supersede',
      prompt: questionPrompt,
      timeoutMs: JUDGE_ASK_TIMEOUT_MS,
    });
    const verdict = (judged as { verdict?: unknown } | null)?.verdict;
    if (verdict === 'contradicts' || verdict === 'independent') {
      return verdict;
    }
  } catch (err) {
    log(
      `[expectation-policy] judge session ask threw, falling back to ollama: ${(err as Error).message}`,
    );
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SupersedeVerdict>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('independent');
    }, timeoutMs);
  });

  const call = (async (): Promise<SupersedeVerdict> => {
    try {
      const reply = await callChat(
        [
          { role: 'system', content: EXPECTATION_POLICY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: questionPrompt,
          },
        ],
        { maxTokens: 60, temperature: 0.1, signal: controller.signal },
      );
      const match = reply.text.match(/\{[\s\S]*\}/);
      if (!match) return 'independent';
      const parsed = JSON.parse(match[0]) as { verdict?: unknown };
      return parsed.verdict === 'contradicts' ? 'contradicts' : 'independent';
    } catch (err) {
      log(
        `[expectation-policy] classify failed, fail-open independent: ${(err as Error).message}`,
      );
      return 'independent';
    }
  })();

  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RecordExpectationPolicyDeps {
  /** Injectable seam so tests can fake the classification call
   * without hitting real ollama. Defaults to callVoiceChat. */
  callVoiceChat?: typeof callVoiceChat;
  /** Daemon logger; defaults to a no-op like ExpectationTickDeps.log. */
  log?: (msg: string) => void;
  /** Overrides DEVNEURAL_EXPECTATION_POLICY_TIMEOUT_MS. Mainly for
   * tests so they don't have to wait out the real default. */
  timeoutMs?: number;
}

/**
 * Dispatcher-facing entry point: classify `input` against every open
 * expectation already on `input.anchorId`, supersede the ones that
 * contradict it, then record the new expectation exactly as
 * recordExpectation would. Both dispatcher call sites
 * (cross-session-inject.ts, dashboard/routes.ts) should call this
 * instead of recordExpectation directly.
 */
export async function recordExpectationWithPolicy(
  deps: RecordExpectationPolicyDeps,
  input: RecordExpectationInput,
): Promise<string> {
  const log = deps.log ?? ((): void => undefined);
  const callChat = deps.callVoiceChat ?? callVoiceChat;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS;

  const db = getStore().db;
  /* listOpenWorkerExpectations has no anchor-scoped query today (only
   * brainstormId / global); a global pull + in-memory filter keeps
   * this anchor-scoped without widening index-db.ts's surface for a
   * filter this narrow. Cheap pre-filter per the operator's policy:
   * an anchor with zero open rows never reaches the loop below, so
   * the LLM is never called. */
  const openForAnchor = db
    .listOpenWorkerExpectations({ limit: 500 })
    .filter((row) => row.anchor_id === input.anchorId);

  for (const row of openForAnchor) {
    const verdict = await classifySupersede(
      callChat,
      row.expected_outcome,
      input.expectedOutcome,
      timeoutMs,
      log,
    );
    if (verdict === 'contradicts') {
      db.closeWorkerExpectation(row.id, 'superseded');
      log(
        `[expectation-policy] superseded id=${row.id} open="${row.expected_outcome}" new="${input.expectedOutcome}"`,
      );
    }
    /* 'independent': leave the prior row open. See the module-level
     * comment above this section for why that alone reproduces the
     * "combined replies" half of the policy. */
  }

  return recordExpectation(input);
}

/* Dispatcher-facing derivation (goal-audit fix wave, 2026-07-15).
 * recordExpectation's only writer was, until this wave, nothing at
 * all -- see the 2026-07-15 goal audit. The dispatcher call sites
 * (cross-session-inject.ts, dashboard/routes.ts operator routes)
 * need a cheap, deterministic way to turn "the text Lex just sent a
 * worker" into the short label EVAL_SYSTEM_PROMPT expects as
 * "Expected outcome: X". No LLM call here -- this runs inline on
 * every accepted dispatch, so it has to be free. Takes the first
 * non-blank line (steer/inject text is usually a single instruction;
 * multi-paragraph prompts still get a usable label from their lede),
 * collapses internal whitespace, and caps length so a long paste
 * doesn't bloat the lex_worker_expectation row or, later, the eval
 * prompt built from it. */
const EXPECTED_OUTCOME_MAX_CHARS = 240;

export function deriveExpectedOutcome(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '(empty instruction)';
  if (collapsed.length <= EXPECTED_OUTCOME_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, EXPECTED_OUTCOME_MAX_CHARS - 3)}...`;
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

/* Coerce a parsed reply (from either the judge session or the ollama
 * fallback) into an EvaluationResult using the same loose acceptance
 * this function has always used for the ollama path: any object-ish
 * value is accepted, missing/malformed fields fall back to safe
 * defaults rather than rejecting the whole reply. Pulled out so the
 * judge-session path (any object askJudge hands back) and the ollama
 * path (a parsed {...} block from the reply text) share one coercion
 * instead of two copies drifting apart. */
function coerceEvaluationResult(parsedUnknown: unknown): EvaluationResult {
  const parsed = (parsedUnknown ?? {}) as Partial<EvaluationResult>;
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

async function evaluateExpectation(
  row: WorkerExpectationRow,
  log: (msg: string) => void,
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

  /* Prefer the persistent Max-plan judge session (2026-07-15 operator
   * directive), same prefer-then-fallback pattern as classifySupersede
   * above. Any object-shaped reply is accepted -- coerceEvaluationResult
   * already tolerates missing/malformed fields exactly as loosely as
   * the ollama path below always has, so this is an additional source,
   * not a stricter gate. */
  try {
    const judged = await askJudge({
      kind: 'alignment',
      prompt: user,
      timeoutMs: JUDGE_ASK_TIMEOUT_MS,
    });
    if (judged && typeof judged === 'object') {
      return coerceEvaluationResult(judged);
    }
  } catch (err) {
    log(
      `[expectation] judge session ask threw for id=${row.id}, falling back to ollama: ${(err as Error).message}`,
    );
  }

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
    log(
      `[expectation] LLM call failed for id=${row.id}: ${(err as Error).message}`,
    );
    return null;
  }
  /* Extract first {...} block to tolerate small LLM preamble noise. */
  const match = reply.text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  return coerceEvaluationResult(parsed);
}

export interface ExpectationTickDeps {
  /** Daemon logger, threaded in the same shape every other scheduler
   * in this codebase uses (see grooming-watch.ts's installGrooming
   * Scheduler, commit b656ead). Defaults to a no-op so callers that
   * don't care about liveness (and existing tests) don't have to
   * pass one. Goal-audit fix wave (2026-07-15) F-shaped finding:
   * this tick's only observability was raw console.log, invisible to
   * daemon.log's rotation and untestable via a spy. */
  log?: (msg: string) => void;
}

export async function runExpectationTick(
  deps: ExpectationTickDeps = {},
): Promise<{
  evaluated: number;
  drift_fired: number;
}> {
  const log = deps.log ?? ((): void => undefined);
  const db = getStore().db;
  const open = db.listOpenWorkerExpectations({ limit: 20 });
  let evaluated = 0;
  let driftFired = 0;
  for (const row of open) {
    const result = await evaluateExpectation(row, log);
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
  log(
    `[expectation-supervisor] tick open=${open.length} evaluated=${evaluated} drift_fired=${driftFired}`,
  );
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
  /** Daemon logger. See ExpectationTickDeps.log; defaults to a
   * no-op. daemon.ts wires this with its own `logger` in one line,
   * mirroring grooming-watch's installGroomingScheduler({ log:
   * logger }) call site added in commit b656ead. */
  log?: (msg: string) => void;
} = {}): ExpectationSupervisorHandle {
  const log = opts.log ?? ((): void => undefined);
  const intervalMs = Math.max(
    10_000,
    opts.intervalMs ??
      Number(process.env.DEVNEURAL_EXPECTATION_TICK_MS ?? 90_000),
  );
  const timer = setInterval(() => {
    void runExpectationTick({ log }).catch((err) =>
      log(
        `[expectation-supervisor] tick threw: ${(err as Error).message}`,
      ),
    );
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  log(`[expectation-supervisor] up interval=${intervalMs}ms enabled=true`);
  return {
    stop: () => clearInterval(timer),
  };
}
