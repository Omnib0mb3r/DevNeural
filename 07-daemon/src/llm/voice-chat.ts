/**
 * Voice-mode multi-turn chat against the local ollama backend.
 *
 * Brainstorm-as-durable-primary-entity (2026-05-22, Path B) needs an
 * LLM call that:
 *   - accepts a real assistant/user history (the LlmProvider.call
 *     interface only takes a single user blob, designed for the
 *     wiki one-shot pipelines).
 *   - never touches anthropic. BF-4 hard-blocks anthropic for
 *     brainstorm content; voice = brainstorm. If the daemon's
 *     DEVNEURAL_LLM_PROVIDER is anthropic, this helper throws
 *     instead of silently falling through.
 *   - keeps the model selection in lock-step with the existing
 *     OllamaProvider modelIds so a model swap stays a one-line env
 *     change.
 *
 * Streaming is NOT exercised yet; piper synthesises the full reply
 * after ollama returns. Sentence-level streaming is a separate
 * follow-up that would carve `chat()` into an async iterator.
 */
import { pickProvider } from './index.js';
import type { LlmRole } from './types.js';

const HOST = (
  process.env.DEVNEURAL_OLLAMA_HOST ?? 'http://localhost:11434'
).replace(/\/$/, '');

/* Reuses the distillation model role: both are local-only (BF-4),
 * pull from the same qwen3:8b default, and respect the same per-role
 * env override. A separate 'conversation' role can land later if the
 * voice path ever needs to diverge from distillation; for now they
 * share a single config knob to keep the operator surface narrow. */
const VOICE_ROLE: LlmRole = 'distillation';

export interface VoiceChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface VoiceChatOptions {
  /** Hard cap on tokens piper will synthesise. Default 800 keeps
   * single-turn TTS under ~90s on the en_GB-alan-medium voice. */
  maxTokens?: number;
  /** Sampling temperature. Default 0.4 leans deterministic so
   * voice replies stay focused. */
  temperature?: number;
  /** Optional abort signal so the caller can cancel an in-flight
   * call when the user barges in. */
  signal?: AbortSignal;
}

export interface VoiceChatResult {
  text: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

interface OllamaChatBody {
  model: string;
  messages: VoiceChatMessage[];
  stream: false;
  keep_alive: string;
  options?: {
    num_predict?: number;
    temperature?: number;
    num_ctx?: number;
  };
}

interface OllamaChatResp {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/* Resolve the model id by reaching into OllamaProvider's modelIds.
 * Honoring the provider abstraction means a future model swap
 * (qwen3 -> next-gen) only edits the provider, not this caller. */
function resolveModelId(): string {
  const p = pickProvider();
  if (!p) {
    throw new Error(
      'voice-chat: no LLM provider configured. Set DEVNEURAL_LLM_PROVIDER=ollama.',
    );
  }
  if (p.name === 'anthropic') {
    /* BF-4: brainstorm content (voice = brainstorm) must never leave
     * the host. Refuse instead of silently sending the prompt out. */
    throw new Error(
      'voice-chat: anthropic provider is hard-blocked for brainstorm content (BF-4). Set DEVNEURAL_LLM_PROVIDER=ollama.',
    );
  }
  const ids = p.modelIds();
  /* Use distillation slot. See VOICE_ROLE comment above. */
  return ids.distillation;
}

export async function callVoiceChat(
  messages: VoiceChatMessage[],
  opts: VoiceChatOptions = {},
): Promise<VoiceChatResult> {
  if (messages.length === 0) {
    throw new Error('voice-chat: at least one message required');
  }
  const model = resolveModelId();
  const body: OllamaChatBody = {
    model,
    messages,
    stream: false,
    keep_alive: '10m',
    options: {
      num_predict: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.4,
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
      `voice-chat ollama call failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
    );
  }
  const parsed = (await res.json()) as OllamaChatResp;
  const reply = (parsed.message?.content ?? '').trim();
  return {
    text: reply,
    modelId: model,
    inputTokens: parsed.prompt_eval_count ?? 0,
    outputTokens: parsed.eval_count ?? 0,
  };
}

export { VOICE_ROLE };
