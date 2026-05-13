/**
 * Anthropic provider.
 *
 * Cloud-hosted Claude (Haiku for ingest/self-query, Sonnet for
 * lint/reconcile). Uses prompt caching: schema + preamble blocks are
 * marked cache_control: ephemeral. Selected via DEVNEURAL_LLM_PROVIDER
 * = anthropic; default provider is ollama.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  CallOptions,
  CallResult,
  LlmProvider,
  LlmRole,
  ModelIds,
} from './types.js';
import { LlmNotConfiguredError } from './types.js';

const MODEL_INGEST =
  process.env.DEVNEURAL_MODEL_INGEST ?? 'claude-haiku-4-5';
const MODEL_LINT = process.env.DEVNEURAL_MODEL_LINT ?? 'claude-sonnet-4-6';
const MODEL_RECONCILE =
  process.env.DEVNEURAL_MODEL_RECONCILE ?? 'claude-sonnet-4-6';
const MODEL_SELF_QUERY =
  process.env.DEVNEURAL_MODEL_SELF_QUERY ?? 'claude-haiku-4-5';
/* Defined for type completeness; the BF-4 guard in
 * distillation-generator short-circuits before this role ever reaches
 * the Anthropic provider, so this model never receives brainstorm
 * content. */
const MODEL_DISTILLATION =
  process.env.DEVNEURAL_MODEL_DISTILLATION ?? 'claude-haiku-4-5';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LlmNotConfiguredError(
      'anthropic',
      'Set ANTHROPIC_API_KEY to enable.',
    );
  }
  client = new Anthropic({
    apiKey,
    defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });
  return client;
}

function modelForRole(role: LlmRole): string {
  switch (role) {
    case 'ingest':
      return MODEL_INGEST;
    case 'lint':
      return MODEL_LINT;
    case 'reconcile':
      return MODEL_RECONCILE;
    case 'self_query':
      return MODEL_SELF_QUERY;
    case 'distillation':
      return MODEL_DISTILLATION;
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly description = `Anthropic API. Models: ${MODEL_INGEST} (ingest), ${MODEL_LINT} (lint).`;

  isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  configHint(): string {
    return 'Set ANTHROPIC_API_KEY to enable.';
  }

  modelIds(): ModelIds {
    return {
      ingest: MODEL_INGEST,
      lint: MODEL_LINT,
      reconcile: MODEL_RECONCILE,
      selfQuery: MODEL_SELF_QUERY,
      distillation: MODEL_DISTILLATION,
    };
  }

  async warmUp(): Promise<void> {
    /* nothing to warm; client is lazy */
  }

  async call(role: LlmRole, opts: CallOptions): Promise<CallResult> {
    if (!this.isConfigured()) {
      throw new LlmNotConfiguredError(this.name, this.configHint());
    }
    const c = getClient();
    const model = modelForRole(role);
    const response = await c.messages.create({
      model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0,
      system: opts.systemBlocks.map((b) => ({
        type: 'text' as const,
        text: b.text,
        ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      })),
      messages: [{ role: 'user' as const, content: opts.user }],
    });
    const text =
      response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim() ?? '';
    const usage = response.usage as unknown as {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    return {
      text,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      modelId: model,
      providerName: this.name,
    };
  }
}
