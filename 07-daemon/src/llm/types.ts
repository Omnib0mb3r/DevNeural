/**
 * Provider-neutral LLM interface.
 *
 * Swap targets behind a single shape: Anthropic Cloud (Haiku/Sonnet),
 * a local ollama instance (Qwen / Llama), or any future provider.
 *
 * The wiki operations (ingest, lint, reconcile, self-query) call
 * through a provider role rather than a hard-coded model id, so the
 * provider's modelIds() controls which actual model handles each role.
 */
export type LlmRole =
  | 'ingest'
  | 'lint'
  | 'reconcile'
  | 'self_query'
  | 'distillation';

export interface SystemBlock {
  text: string;
  /**
   * If true, the provider may apply prompt caching to this block.
   * Anthropic uses this to set cache_control: ephemeral. Ollama treats
   * it as a hint that the block is stable across calls and benefits
   * from KV-cache reuse.
   */
  cache?: boolean;
}

export interface CallOptions {
  systemBlocks: SystemBlock[];
  user: string;
  maxTokens: number;
  temperature?: number;
  /** Optional abort signal. If aborted, in-flight HTTP request to the
   * provider is cancelled and the call rejects with an AbortError. */
  signal?: AbortSignal;
}

export interface CallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelId: string;
  providerName: string;
}

export interface ModelIds {
  ingest: string;
  lint: string;
  reconcile: string;
  selfQuery: string;
  distillation: string;
}

export class LlmNotConfiguredError extends Error {
  constructor(providerName: string, hint: string) {
    super(`LLM provider "${providerName}" is not configured. ${hint}`);
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly description: string;
  isConfigured(): boolean;
  configHint(): string;
  call(role: LlmRole, opts: CallOptions): Promise<CallResult>;
  modelIds(): ModelIds;
  warmUp?(): Promise<void>;
}
