/**
 * Ollama provider.
 *
 * Local LLM served by ollama on http://localhost:11434. Uses the native
 * /api/chat endpoint. Honors `format: "json"` for ingest-style structured
 * output. Maps prompt-cache hints to ollama's KV-cache reuse: ollama
 * automatically reuses KV when the system prompt prefix is identical
 * across calls, so we order systemBlocks deterministically.
 *
 * Default model: `qwen3:8b` if available, falling back to
 * `qwen2.5:7b-instruct`. Per-role overrides via env.
 */
import type {
  CallOptions,
  CallResult,
  LlmProvider,
  LlmRole,
  ModelIds,
} from './types.js';
import { LlmNotConfiguredError } from './types.js';

const HOST = (
  process.env.DEVNEURAL_OLLAMA_HOST ?? 'http://localhost:11434'
).replace(/\/$/, '');

const DEFAULT_MODEL =
  process.env.DEVNEURAL_OLLAMA_MODEL ?? 'qwen3:8b';

const MODEL_INGEST =
  process.env.DEVNEURAL_OLLAMA_MODEL_INGEST ?? DEFAULT_MODEL;
const MODEL_LINT = process.env.DEVNEURAL_OLLAMA_MODEL_LINT ?? DEFAULT_MODEL;
const MODEL_RECONCILE =
  process.env.DEVNEURAL_OLLAMA_MODEL_RECONCILE ?? DEFAULT_MODEL;
const MODEL_SELF_QUERY =
  process.env.DEVNEURAL_OLLAMA_MODEL_SELF_QUERY ?? DEFAULT_MODEL;
const MODEL_DISTILLATION =
  process.env.DEVNEURAL_OLLAMA_MODEL_DISTILLATION ?? DEFAULT_MODEL;

interface OllamaChatRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  stream: false;
  format?: 'json';
  keep_alive?: string;
  options?: {
    num_predict?: number;
    temperature?: number;
    num_ctx?: number;
  };
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

interface OllamaTagsResponse {
  models?: { name: string }[];
}

let availableModelsCache: { models: Set<string>; checkedAt: number } | null = null;
const MODEL_CACHE_TTL_MS = 60_000;

async function listAvailableModels(): Promise<Set<string> | null> {
  const now = Date.now();
  if (
    availableModelsCache &&
    now - availableModelsCache.checkedAt < MODEL_CACHE_TTL_MS
  ) {
    return availableModelsCache.models;
  }
  try {
    const res = await fetch(`${HOST}/api/tags`, { method: 'GET' });
    if (!res.ok) return null;
    const body = (await res.json()) as OllamaTagsResponse;
    const set = new Set<string>(
      (body.models ?? []).map((m) => m.name).filter((n) => Boolean(n)),
    );
    availableModelsCache = { models: set, checkedAt: now };
    return set;
  } catch {
    return null;
  }
}

function modelMatches(needle: string, available: Set<string>): boolean {
  if (available.has(needle)) return true;
  // Allow `qwen3:8b` to match `qwen3:8b-instruct-q4_K_M` etc.
  for (const tag of available) {
    if (tag.startsWith(needle)) return true;
    if (tag.split(':')[0] === needle.split(':')[0] && needle.includes(':')) {
      // looser match: same family
      return true;
    }
  }
  return false;
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly description = `Local ollama at ${HOST}. Default model: ${DEFAULT_MODEL}.`;

  isConfigured(): boolean {
    // Configured if the host is set; reachability is checked at call time.
    return Boolean(HOST);
  }

  configHint(): string {
    return `Install ollama (https://ollama.com), pull the model with \`ollama pull ${DEFAULT_MODEL}\`, ensure ollama is running on ${HOST}.`;
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
    // Pre-pull KV by issuing a tiny request. Falls through silently if
    // ollama isn't running.
    try {
      const available = await listAvailableModels();
      if (!available) return;
      const model = MODEL_INGEST;
      if (!modelMatches(model, available)) {
        throw new Error(
          `ollama: model ${model} not present. Run \`ollama pull ${model}\` and try again.`,
        );
      }
      await this.call('ingest', {
        systemBlocks: [{ text: 'You are a helper.', cache: true }],
        user: 'reply with the single word: ready',
        maxTokens: 16,
        temperature: 0,
      });
    } catch {
      /* warm-up failures are tolerated; real call surfaces them */
    }
  }

  async call(role: LlmRole, opts: CallOptions): Promise<CallResult> {
    const ids = this.modelIds();
    const roleKey: keyof ModelIds =
      role === 'self_query'
        ? 'selfQuery'
        : (role as 'ingest' | 'lint' | 'reconcile' | 'distillation');
    const model = ids[roleKey];

    // Validate model presence on first attempt; log clear error if missing.
    const available = await listAvailableModels();
    if (available && !modelMatches(model, available)) {
      throw new LlmNotConfiguredError(
        this.name,
        `model "${model}" not pulled. Run: ollama pull ${model}`,
      );
    }

    const messages: OllamaChatRequest['messages'] = [];
    for (const block of opts.systemBlocks) {
      messages.push({ role: 'system', content: block.text });
    }
    messages.push({ role: 'user', content: opts.user });

    const useJsonFormat = role === 'ingest' || role === 'lint';

    const body: OllamaChatRequest = {
      model,
      messages,
      stream: false,
      keep_alive: '10m',
      ...(useJsonFormat ? { format: 'json' } : {}),
      options: {
        num_predict: opts.maxTokens,
        temperature: opts.temperature ?? 0,
        num_ctx: 16384,
      },
    };

    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ollama call failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
      );
    }

    const json = (await res.json()) as OllamaChatResponse;
    const text = (json.message?.content ?? '').trim();

    return {
      text,
      inputTokens: json.prompt_eval_count ?? 0,
      outputTokens: json.eval_count ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelId: model,
      providerName: this.name,
    };
  }
}
