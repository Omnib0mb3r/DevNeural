/**
 * judgeInjectionUse (src/reinforcement/inject-verdict.ts) provider
 * swap: prefer the persistent Max-plan judge session (askJudge) before
 * falling back to the existing provider path (callValidated against
 * whatever LlmProvider the caller injects). Mocks judge-session.js
 * wholesale so no real `claude` process, PTY, or fs read is ever
 * touched -- these tests only prove the ROUTING contract (judge
 * session preferred, existing fallback + 'unclear' semantics
 * unchanged), not judge-session.ts's own internals (covered by
 * tests/judge-session.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lex/judge-session.js', () => ({
  askJudge: vi.fn(),
}));

import { askJudge } from '../src/lex/judge-session.js';
import { judgeInjectionUse } from '../src/reinforcement/inject-verdict.js';
import type { LlmProvider, CallResult } from '../src/llm/types.js';

function fakeCallResult(text: string): CallResult {
  return {
    text,
    inputTokens: 5,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelId: 'fake',
    providerName: 'fake',
  };
}

function fakeProvider(callImpl: LlmProvider['call']): LlmProvider {
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

let priorTimeout: string | undefined;

beforeEach(() => {
  vi.mocked(askJudge).mockReset();
  priorTimeout = process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS;
});

afterEach(() => {
  if (priorTimeout === undefined) delete process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS;
  else process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS = priorTimeout;
});

describe('judgeInjectionUse: prefers the judge session', () => {
  it('a valid judge-session verdict short-circuits: the provider is never called', async () => {
    vi.mocked(askJudge).mockResolvedValue({ verdict: 'used', reason: 'applies the note' });
    const callFn = vi.fn(async () => {
      throw new Error('provider must not be called when the judge session answers');
    });

    const result = await judgeInjectionUse(
      { provider: fakeProvider(callFn) },
      { injectedSummary: 'the injected summary', replyText: 'the assistant reply' },
    );

    expect(result).toEqual({ verdict: 'used', reason: 'applies the note' });
    expect(callFn).not.toHaveBeenCalled();
    expect(askJudge).toHaveBeenCalledTimes(1);
    const call = vi.mocked(askJudge).mock.calls[0]![0];
    expect(call.kind).toBe('inject_verdict');
    expect(call.prompt).toContain('the injected summary');
    expect(call.prompt).toContain('the assistant reply');
  });

  it('an "ignored" judge-session verdict is returned as-is, provider never called', async () => {
    vi.mocked(askJudge).mockResolvedValue({ verdict: 'ignored', reason: 'never touches it' });
    const callFn = vi.fn(async () => {
      throw new Error('must not be called');
    });

    const result = await judgeInjectionUse(
      { provider: fakeProvider(callFn) },
      { injectedSummary: 's', replyText: 'r' },
    );

    expect(result).toEqual({ verdict: 'ignored', reason: 'never touches it' });
    expect(callFn).not.toHaveBeenCalled();
  });
});

describe('judgeInjectionUse: falls back to the provider path', () => {
  it('askJudge resolving null falls back to the provider and returns its verdict', async () => {
    vi.mocked(askJudge).mockResolvedValue(null);
    const callFn = vi.fn(async () => fakeCallResult(JSON.stringify({ verdict: 'used', reason: 'from provider' })));

    const result = await judgeInjectionUse(
      { provider: fakeProvider(callFn) },
      { injectedSummary: 's', replyText: 'r' },
    );

    expect(result).toEqual({ verdict: 'used', reason: 'from provider' });
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  it('a malformed judge-session shape (fails validateVerdict) falls back to the provider', async () => {
    vi.mocked(askJudge).mockResolvedValue({ not_a_verdict: true });
    const callFn = vi.fn(async () => fakeCallResult(JSON.stringify({ verdict: 'ignored', reason: 'from provider' })));

    const result = await judgeInjectionUse(
      { provider: fakeProvider(callFn) },
      { injectedSummary: 's', replyText: 'r' },
    );

    expect(result).toEqual({ verdict: 'ignored', reason: 'from provider' });
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  it('askJudge itself throwing is caught and still falls back to the provider', async () => {
    vi.mocked(askJudge).mockRejectedValue(new Error('judge session unavailable'));
    const callFn = vi.fn(async () => fakeCallResult(JSON.stringify({ verdict: 'used', reason: 'from provider' })));

    const result = await judgeInjectionUse(
      { provider: fakeProvider(callFn) },
      { injectedSummary: 's', replyText: 'r' },
    );

    expect(result).toEqual({ verdict: 'used', reason: 'from provider' });
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  it('both the judge session and the provider fail: resolves "unclear" (existing contract unchanged)', async () => {
    vi.mocked(askJudge).mockResolvedValue(null);
    const callFn = vi.fn(async () => {
      throw new Error('provider down');
    });

    const result = await judgeInjectionUse(
      { provider: fakeProvider(callFn) },
      { injectedSummary: 's', replyText: 'r' },
    );

    expect(result.verdict).toBe('unclear');
  });
});
