/**
 * LLM-backed generator for the sibling distillation pipeline.
 *
 * Plugs into preloadSiblingDistillations + runDistillationBackfill via
 * the existing DistillationGenerator shape. Reads the brainstorm's
 * chunk transcript, prompts the active LLM provider for a one-sentence
 * plain-prose summary, returns the trimmed text (or null on
 * skip / failure).
 *
 * Respects BF-4: never sends brainstorm content out to the anthropic
 * provider. Local-only (ollama) by design. The shipped
 * brainstorm-distillation pipeline already enforces this on the
 * wiki-draft path; mirror the gate here so a wired backfill cannot
 * leak content if env flips DEVNEURAL_LLM_PROVIDER=anthropic mid-run.
 *
 * Pure module aside from the provider call: db reads are injected and
 * the provider is swappable so the scheduler tests can drive the
 * pipeline with a stub.
 */
import type {
  BrainstormSessionRow,
  IndexDb,
} from '../store/index-db.js';
import type { LlmProvider } from '../llm/index.js';
import { pickProvider } from '../llm/index.js';
import type { DistillationGenerator } from './sibling-distillation-preload.js';

export interface CreateGeneratorOptions {
  db: IndexDb;
  log?: (msg: string) => void;
  /** Cap the bytes of transcript shipped to the provider. Default
   * 8000 so the structured-density prompt has enough source material
   * to extract decisions, planted markers, and recent verbatim turns
   * without truncating mid-conversation. */
  maxTranscriptBytes?: number;
  /** Cap the provider's reply tokens. Default 600 to fit the
   * couple-paragraph structured cold-start handoff (Topic, Active
   * topics, Key decisions, Planted markers, Open, Recent turns). */
  maxTokens?: number;
  /** Cap the chunks pulled per session. Default 50. */
  chunkLimit?: number;
  /** Test seam: override the active provider. */
  provider?: LlmProvider | null;
}

export const SYSTEM_BLOCK = {
  text:
    'Summarize this brainstorm transcript for the next Lex session ' +
    'so it can pick up where this one left off without re-reading ' +
    'the full history. The user is a brainstormer-first; their work ' +
    'must never decay to lossy one-liners. Output structured ' +
    "Markdown with the following bolded sections in this order, " +
    'each on its own line:\n\n' +
    '**Topic**: one sentence on the headline subject.\n\n' +
    '**Active topics**: 2-5 bullets, the threads the conversation ' +
    'kept circling back to. Be specific (named files, components, ' +
    'protocols), not generic ("we discussed the project").\n\n' +
    '**Key decisions**: 2-5 bullets, concrete decisions or commits ' +
    'landed during the session. Include enough context that the ' +
    'decision is meaningful out of conversation. Empty bullet ' +
    'allowed when no decisions were made; do not invent.\n\n' +
    '**Planted markers**: 1-3 bullets, forward-looking notes / ' +
    'seeds / TODOs the user wanted to revisit. Empty allowed.\n\n' +
    '**Open**: 1-3 bullets, unresolved questions or blockers.\n\n' +
    '**Recent turns** (verbatim, last 5-10): each bullet is ' +
    "ROLE: <text>, trimmed to ~200 chars, in chronological order " +
    'so the new session can resume the thread without paging ' +
    'transcript. Use USER / LEX / TOOL.\n\n' +
    'Total target: two short paragraphs of structured content plus ' +
    'the recent-turns block. No fences, no preamble, no commentary ' +
    'about the summary itself. Skip pleasantries. Be specific.',
  cache: true,
};

function buildTranscript(
  db: IndexDb,
  row: BrainstormSessionRow,
  chunkLimit: number,
  maxBytes: number,
): string {
  const chunks = db.listBrainstormChunks(row.id, chunkLimit);
  if (chunks.length === 0) return '';
  const lines = chunks.map((c) => {
    const role =
      c.role === 'lex' ? 'LEX' : c.role === 'user' ? 'USER' : 'TOOL';
    return `${role}: ${c.text}`;
  });
  return lines.join('\n').slice(0, maxBytes);
}

export function createLlmDistillationGenerator(
  opts: CreateGeneratorOptions,
): DistillationGenerator {
  const log = opts.log ?? (() => undefined);
  const maxTranscriptBytes = opts.maxTranscriptBytes ?? 8000;
  const maxTokens = opts.maxTokens ?? 600;
  const chunkLimit = opts.chunkLimit ?? 50;
  return async (row: BrainstormSessionRow): Promise<string | null> => {
    const provider = opts.provider ?? pickProvider();
    if (!provider) {
      log(`[distill-gen] no provider; skip ${row.id.slice(0, 8)}`);
      return null;
    }
    if (!provider.isConfigured()) {
      log(
        `[distill-gen] provider ${provider.name} not configured; skip ${row.id.slice(0, 8)}`,
      );
      return null;
    }
    /* BF-4 mirror: brainstorm chunks never leave the host. */
    if (provider.name === 'anthropic') {
      log(
        `[distill-gen] BF-4 skip ${row.id.slice(0, 8)}: anthropic provider blocked for brainstorm content`,
      );
      return null;
    }
    const transcript = buildTranscript(
      opts.db,
      row,
      chunkLimit,
      maxTranscriptBytes,
    );
    if (transcript.length === 0) {
      log(`[distill-gen] no chunks for ${row.id.slice(0, 8)}`);
      return null;
    }
    try {
      const result = await provider.call('distillation', {
        systemBlocks: [SYSTEM_BLOCK],
        user: transcript,
        maxTokens,
        temperature: 0.2,
      });
      const text = result.text.trim();
      if (!text) return null;
      /* Strip surrounding quotes the model sometimes adds, drop any
       * trailing fence the prompt told it not to use. */
      return text
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/^```\w*\n?|```$/g, '')
        .trim();
    } catch (err) {
      log(
        `[distill-gen] provider call failed for ${row.id.slice(0, 8)}: ${(err as Error).message}`,
      );
      return null;
    }
  };
}
