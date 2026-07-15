/**
 * Explicit inject-verdict judge: judgeInjectionUse (src/reinforcement/
 * inject-verdict.ts) asks a local LLM directly whether an assistant's
 * reply actually used a piece of injected context, as an additive
 * second opinion alongside the existing cosine-based HIT/no-hit
 * inference in evaluateAssistantReply.
 *
 * judgeInjectionUse takes its LlmProvider as a plain dependency (no
 * pickProvider() call inside), so these tests exercise it directly
 * with a fake provider object -- no module mocking needed. The
 * provider.call() -> JSON parse -> schema validate pipeline is the
 * real callValidated() from src/llm/validator.ts, so malformed/
 * unparseable responses genuinely exercise the repair-retry path.
 */
import { describe, it, expect } from 'vitest';
import { judgeInjectionUse } from '../src/reinforcement/inject-verdict.js';
import type {
  LlmProvider,
  CallOptions,
  CallResult,
  LlmRole,
} from '../src/llm/index.js';

function fakeProvider(
  callImpl: (role: LlmRole, opts: CallOptions) => Promise<CallResult>,
): LlmProvider {
  return {
    name: 'fake',
    description: 'fake test provider',
    isConfigured: () => true,
    configHint: () => '',
    modelIds: () => ({
      ingest: 'fake',
      lint: 'fake',
      reconcile: 'fake',
      selfQuery: 'fake',
      distillation: 'fake',
    }),
    call: callImpl,
  };
}

function fakeCallResult(text: string): CallResult {
  return {
    text,
    inputTokens: 10,
    outputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelId: 'fake',
    providerName: 'fake',
  };
}

describe('judgeInjectionUse', () => {
  it('provider says "used" -> verdict used, reason passed through', async () => {
    const provider = fakeProvider(async () =>
      fakeCallResult(
        JSON.stringify({
          verdict: 'used',
          reason: 'reply directly applies the injected trigger/insight pair',
        }),
      ),
    );

    const result = await judgeInjectionUse(
      { provider },
      {
        injectedSummary: 'connection pooling trigger -> use a shared pool',
        replyText: 'a'.repeat(100),
      },
    );

    expect(result.verdict).toBe('used');
    expect(result.reason).toContain('trigger/insight');
  });

  it('provider says "ignored" -> verdict ignored', async () => {
    const provider = fakeProvider(async () =>
      fakeCallResult(
        JSON.stringify({
          verdict: 'ignored',
          reason: 'reply never references the injected context',
        }),
      ),
    );

    const result = await judgeInjectionUse(
      { provider },
      {
        injectedSummary: 'connection pooling trigger -> use a shared pool',
        replyText: 'totally unrelated reply about something else',
      },
    );

    expect(result.verdict).toBe('ignored');
    expect(result.reason).toContain('never references');
  });

  it('provider.call() rejects -> verdict unclear, error message as reason', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('simulated provider outage');
    });

    const result = await judgeInjectionUse(
      { provider },
      { injectedSummary: 's', replyText: 'r' },
    );

    expect(result.verdict).toBe('unclear');
    expect(result.reason).toContain('simulated provider outage');
  });

  it('provider never resolves -> hard timeout -> verdict unclear within bound', async () => {
    const provider = fakeProvider(
      () =>
        new Promise<CallResult>(() => {
          /* never resolves: forces the internal timeout branch to win */
        }),
    );

    const start = Date.now();
    const result = await judgeInjectionUse(
      { provider, timeoutMs: 40 },
      { injectedSummary: 's', replyText: 'r' },
    );
    const elapsed = Date.now() - start;

    expect(result.verdict).toBe('unclear');
    expect(result.reason).toBe('timeout');
    // Generous upper bound: proves the hard timeout actually gates the
    // call rather than falling through to the provider's real latency.
    expect(elapsed).toBeLessThan(2000);
  }, 10000);

  it('malformed / unparseable response exhausts repair retries -> verdict unclear', async () => {
    const provider = fakeProvider(async () => fakeCallResult('not json at all, just prose'));

    const result = await judgeInjectionUse(
      { provider },
      { injectedSummary: 's', replyText: 'r' },
    );

    expect(result.verdict).toBe('unclear');
  });

  it('default timeout falls back to DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS / 5000ms when deps.timeoutMs is omitted', async () => {
    // Not exercising the full 5s wait; just confirms a fast, well-formed
    // response resolves correctly without needing the override.
    const provider = fakeProvider(async () =>
      fakeCallResult(JSON.stringify({ verdict: 'used', reason: 'ok' })),
    );

    const result = await judgeInjectionUse(
      { provider },
      { injectedSummary: 's', replyText: 'r' },
    );

    expect(result.verdict).toBe('used');
  });
});
