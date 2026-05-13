/**
 * LLM provider factory.
 *
 * Picks a provider by env: DEVNEURAL_LLM_PROVIDER=ollama|anthropic|none.
 * Default is ollama (local-first, no API cost).
 *
 * "none" disables LLM operations entirely. Capture and retrieval keep
 * working; ingest, lint, reconcile, self-query are skipped.
 */
import type { LlmProvider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { AnthropicProvider } from './anthropic.js';

export type ProviderName = 'ollama' | 'anthropic' | 'none';

let cachedProvider: LlmProvider | null = null;

export function pickProvider(): LlmProvider | null {
  if (cachedProvider) return cachedProvider;
  const choice = (
    process.env.DEVNEURAL_LLM_PROVIDER ?? 'ollama'
  ).toLowerCase() as ProviderName;
  if (choice === 'none') return null;
  if (choice === 'anthropic') {
    cachedProvider = new AnthropicProvider();
    return cachedProvider;
  }
  cachedProvider = new OllamaProvider();
  return cachedProvider;
}

export function providerStatus(): {
  name: string;
  configured: boolean;
  hint: string;
  models: {
    ingest: string;
    lint: string;
    reconcile: string;
    selfQuery: string;
    distillation: string;
  };
} | null {
  const p = pickProvider();
  if (!p) return null;
  return {
    name: p.name,
    configured: p.isConfigured(),
    hint: p.configHint(),
    models: p.modelIds(),
  };
}

export { LlmNotConfiguredError } from './types.js';
export type {
  CallOptions,
  CallResult,
  LlmProvider,
  LlmRole,
  ModelIds,
  SystemBlock,
} from './types.js';
export {
  callValidated,
  validatePass1,
  validatePass2,
  type Pass1Schema,
  type Pass2Schema,
} from './validator.js';
