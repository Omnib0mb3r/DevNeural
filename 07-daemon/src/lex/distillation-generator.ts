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
   * 3000 to keep prompts cheap on ollama. */
  maxTranscriptBytes?: number;
  /** Cap the provider's reply tokens. Default 180 to fit the 3-4 line
   * cold-start handoff format below. */
  maxTokens?: number;
  /** Cap the chunks pulled per session. Default 50. */
  chunkLimit?: number;
  /** Test seam: override the active provider. */
  provider?: LlmProvider | null;
}

const SYSTEM_BLOCK = {
  text:
    'Summarize the brainstorm transcript for the next Lex session to ' +
    'pick up where this one left off. Output 3-4 short lines, plain ' +
    'prose, no fences or markdown. Cover: line 1 the headline topic, ' +
    'line 2 the most recent concrete decision or commit landed, line ' +
    '3 the open questions or unresolved items, line 4 (optional) any ' +
    'blockers or next-action queued. Keep the whole thing under 80 ' +
    'words. Be specific. Skip pleasantries.',
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
  const maxTranscriptBytes = opts.maxTranscriptBytes ?? 3000;
  const maxTokens = opts.maxTokens ?? 180;
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
