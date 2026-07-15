/**
 * Explicit LLM verdict on injection use.
 *
 * evaluateAssistantReply's cosine check (see index.ts) is a coarse
 * proxy: "does the reply's embedding look similar to the injected
 * summary's embedding." It stays authoritative for promote/decay
 * because it is cheap, fast, and already tuned. This module adds an
 * EXPLICIT second opinion: ask a local LLM directly "did this reply
 * actually use the injected insight" and hand the answer back as an
 * additive signal for the curator health card, never as a replacement
 * for the cosine path.
 *
 * Behind DEVNEURAL_INJECT_VERDICT (default off; see index.ts's
 * scheduleInjectVerdict for the gate). When on, the caller fires this
 * AFTER the cosine evaluation has already run and never awaits it in
 * the request path -- judgeInjectionUse itself races a hard timeout
 * (DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS, default 5000ms) so a slow or
 * hung local model can never stall the transcript watcher. Any error,
 * timeout, or malformed response resolves to 'unclear'; this function
 * never throws.
 *
 * Reuses the same provider plumbing curator.ts's vetCandidate uses
 * (pickProvider / callValidated, AbortController + Promise.race
 * timeout) rather than duplicating that dance a third time.
 */
import { callValidated, type LlmProvider } from '../llm/index.js';
import type { Validator } from '../llm/validator.js';
import { askJudge } from '../lex/judge-session.js';

const DEFAULT_TIMEOUT_MS = Number(
  process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS ?? 5000,
);

export interface JudgeDeps {
  provider: LlmProvider;
  log?: (msg: string) => void;
  /** Overrides DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS. Mainly for tests. */
  timeoutMs?: number;
}

export interface JudgeInput {
  injectedSummary: string;
  replyText: string;
}

export type InjectVerdict = 'used' | 'ignored' | 'unclear';

export interface JudgeResult {
  verdict: InjectVerdict;
  reason: string;
}

/* The judge itself is a strict binary ('used' | 'ignored'); 'unclear'
 * is reserved for this module's own error/timeout/malformed-response
 * fallback, never something the model is asked to produce directly.
 * Mirrors vetCandidate's inject/veto binary in curator.ts. */
interface VerdictShape {
  verdict: 'used' | 'ignored';
  reason: string;
}

const validateVerdict: Validator<VerdictShape> = (raw) => {
  if (!raw || typeof raw !== 'object')
    return { ok: false, errors: ['response not object'] };
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== 'used' && verdict !== 'ignored') {
    return { ok: false, errors: ['verdict must be "used" or "ignored"'] };
  }
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { ok: true, value: { verdict, reason }, errors: [] };
};

/**
 * Ask the local LLM whether the assistant's reply shows evidence of
 * having used the injected context. Never throws: any provider error,
 * malformed response, or timeout resolves to { verdict: 'unclear' }.
 */
export async function judgeInjectionUse(
  deps: JudgeDeps,
  input: JudgeInput,
): Promise<JudgeResult> {
  const log = deps.log ?? (() => undefined);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const system = `You are judging whether a developer assistant's reply actually used a piece of context that was injected ahead of the user's prompt.

Given a short summary of the injected context and the assistant's reply that followed, decide whether the reply's content shows it relied on that specific context.

Output strictly this JSON shape:
{ "verdict": "used" | "ignored", "reason": "one short sentence" }

Hard rules:
- "used" means the reply paraphrases, applies, or directly builds on the injected context.
- "ignored" means the reply shows no evidence of drawing on the injected context, even if the reply is otherwise reasonable.
- When genuinely uncertain, prefer "ignored" -- false credit corrupts the reinforcement signal more than a missed credit.
- reason is exactly one short sentence.`;

  const user = `Injected context summary:
${input.injectedSummary.slice(0, 1200)}

Assistant's reply:
${input.replyText.slice(0, 4000)}

Answer used or ignored.`;

  /* Prefer the persistent Max-plan judge session (2026-07-15 operator
   * directive: keep child sessions open, don't pay per call). Reuses
   * the SAME validateVerdict validator the provider path below uses,
   * so a judge-session reply and a provider reply are held to
   * identical shape rules -- validateVerdict already rejects a null
   * (askJudge unavailable/timeout) or malformed reply, so this is a
   * pure prefer-then-fallback onto the unchanged provider path; the
   * 'unclear' semantics this function documents are unaffected. */
  try {
    const judged = await askJudge({
      kind: 'inject_verdict',
      prompt: user,
      timeoutMs,
    });
    const validated = validateVerdict(judged);
    if (validated.ok && validated.value) {
      return {
        verdict: validated.value.verdict,
        reason: validated.value.reason || 'unspecified',
      };
    }
  } catch (err) {
    log(
      `[inject-verdict] judge session ask threw, falling back to provider: ${(err as Error).message}`,
    );
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JudgeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ verdict: 'unclear', reason: 'timeout' });
    }, timeoutMs);
  });

  const call = (async (): Promise<JudgeResult> => {
    try {
      const result = await callValidated(
        deps.provider,
        {
          role: 'self_query',
          systemBlocks: [{ text: system, cache: true }],
          user,
          maxTokens: 120,
          signal: controller.signal,
        },
        validateVerdict,
        log,
      );
      if (!result.value) {
        return {
          verdict: 'unclear',
          reason: result.errors.join('; ') || 'no value',
        };
      }
      return {
        verdict: result.value.verdict,
        reason: result.value.reason || 'unspecified',
      };
    } catch (err) {
      return { verdict: 'unclear', reason: (err as Error).message };
    }
  })();

  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
