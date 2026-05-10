/**
 * Context curator.
 *
 * Composes the injection payload at UserPromptSubmit. Pulls together:
 *   - top wiki page summary (canonical only)
 *   - matching glossary entries
 *   - current-task memory
 *   - last session summary thread (if relevant)
 *
 * Applies hard relevance discipline:
 *   - prompt-type filter: skip injection for greetings, syntax-only,
 *     short follow-ups
 *   - cosine floors: 0.55 wiki, 0.65 raw fallback
 *   - token budget: 600 hard cap total
 *   - diversity: drop second match if cosine to first > 0.85
 *   - canonical-only: pending pages never inject
 *   - same-session blacklist: pages corrected this session do not
 *     re-appear (held in memory; daemon process)
 *
 * Two modes:
 *   - deterministic (default): concatenate components by relevance.
 *     Fast, ~10ms.
 *   - llm-curated (opt-in): hand all components to the local model
 *     and ask "produce the right 200-400 tokens for this prompt."
 *     Slower (~1-2s on local), tighter relevance.
 */
import { embedOne } from '../embedder/index.js';
import type { Store, WikiPageMetadata } from '../store/index.js';
import { matchTerms, readGlossary, type GlossaryEntry } from './glossary.js';
import { readSummary } from './session-summarizer.js';
import { readCurrentTaskBody } from './current-task.js';
import {
  pickProvider,
  callValidated,
  type LlmProvider,
} from '../llm/index.js';
import type { Validator } from '../llm/validator.js';
import { recordInjection, recordRawInjection } from '../reinforcement/index.js';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { wikiPagesDir, wikiPendingDir } from '../paths.js';

const COSINE_FLOOR_WIKI = Number(
  process.env.DEVNEURAL_COSINE_FLOOR_WIKI ?? 0.55,
);
const COSINE_FLOOR_RAW = Number(
  process.env.DEVNEURAL_COSINE_FLOOR_RAW ?? 0.65,
);
const TOKEN_BUDGET = Number(process.env.DEVNEURAL_INJECT_TOKEN_BUDGET ?? 600);
const DIVERSITY_THRESHOLD = 0.85;
const ALWAYS_USE_LLM = process.env.DEVNEURAL_CURATOR_LLM === '1';

const sessionBlacklist = new Map<string, Set<string>>();

export function blacklistPageForSession(
  sessionId: string,
  pageId: string,
): void {
  if (!sessionBlacklist.has(sessionId))
    sessionBlacklist.set(sessionId, new Set());
  sessionBlacklist.get(sessionId)?.add(pageId);
}

export function clearSessionBlacklist(sessionId: string): void {
  sessionBlacklist.delete(sessionId);
}

function isBlacklisted(sessionId: string, pageId: string): boolean {
  return sessionBlacklist.get(sessionId)?.has(pageId) ?? false;
}

export interface CurationInput {
  prompt: string;
  sessionId: string;
  projectId: string;
}

export interface CurationOutput {
  injection: string;
  byteCount: number;
  /* CI-1: every curator decision carries a stable correlation token
   * so dashboard signals (clicks, "this looks wrong" presses,
   * follow-up classification) can attach back to the originating
   * decision row in curator_log. */
  prompt_id: string;
  /* CI-5: 0..1 confidence on the injection. Computed from how far
   * the matching score sits above the cosine floor:
   *   confidence = (score - threshold) / (1.0 - threshold), clamped.
   * A match exactly at the floor scores 0; the maximum achievable
   * cosine of 1.0 scores 1.0. Surfaced inline in the InjectionRow
   * confidence pill (Wave 2 day 4 step 17). */
  confidence?: number;
  /* The wiki page slug that won the injection. Null on silence or
   * raw-only injections; surfaced in the GET /sessions/:id
   * injected_pages array per spec section 4.2. */
  page_slug?: string | null;
  components: {
    wiki_page_id?: string;
    wiki_score?: number;
    raw_chunk_id?: string;
    raw_score?: number;
    glossary_terms: string[];
    used_session_summary: boolean;
    used_current_task: boolean;
    skipped_reason?: string;
  };
}

const SKIPPED: CurationOutput = {
  injection: '',
  byteCount: 0,
  prompt_id: '',
  page_slug: null,
  components: { glossary_terms: [], used_session_summary: false, used_current_task: false },
};

function computeConfidence(score: number, threshold: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(threshold)) return 0;
  if (threshold >= 1.0) return 0;
  const c = (score - threshold) / (1.0 - threshold);
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

/* CI-1: write a curator_log row for every decision. Failure to log
 * is non-fatal: the curator must always return its injection result
 * even if telemetry fails. */
function logCuratorDecision(
  store: Store,
  row: {
    prompt_id: string;
    session_id: string;
    project_slug: string;
    decision: 'inject' | 'silence';
    page_slug: string | null;
    score: number | null;
    threshold: number;
    confidence: number | null;
    source_class: string | null;
  },
  log: (msg: string) => void,
): void {
  try {
    store.db.insertCuratorLog({
      id: randomUUID(),
      ...row,
    });
  } catch (err) {
    log(`[curator] insertCuratorLog failed: ${(err as Error).message}`);
  }
}

const MIN_PROMPT_WORDS = 4;
const SYNTAX_PROMPTS = [
  /^(hi|hey|hello|thanks|thx|ty|ok|okay|cool|nice)\b/i,
  /^what['’]s the (typescript|js|python|go|rust|sql) syntax for/i,
  /^how do i (write|format) a (string|number|date|array|object) in/i,
];

export function shouldInject(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < MIN_PROMPT_WORDS) return false;
  for (const re of SYNTAX_PROMPTS) {
    if (re.test(trimmed)) return false;
  }
  return true;
}

export async function curate(
  store: Store,
  input: CurationInput,
  log: (msg: string) => void = () => undefined,
): Promise<CurationOutput> {
  const promptId = randomUUID();
  if (!shouldInject(input.prompt)) {
    logCuratorDecision(
      store,
      {
        prompt_id: promptId,
        session_id: input.sessionId,
        project_slug: input.projectId,
        decision: 'silence',
        page_slug: null,
        score: null,
        threshold: COSINE_FLOOR_WIKI,
        confidence: null,
        source_class: null,
      },
      log,
    );
    return {
      ...SKIPPED,
      prompt_id: promptId,
      components: { ...SKIPPED.components, skipped_reason: 'prompt_filter' },
    };
  }

  const queryVec = await embedOne(input.prompt.slice(0, 4000));

  // 1. Wiki page (canonical only, project-filter-friendly)
  let bestWiki:
    | { id: string; score: number; metadata: WikiPageMetadata }
    | undefined;
  if (store.wikiPages.size() > 0) {
    const hits = store.wikiPages.search(queryVec, {
      topK: 5,
      filter: (m) => {
        const meta = m as WikiPageMetadata;
        return meta.status === 'canonical';
      },
    });
    for (const h of hits) {
      if (isBlacklisted(input.sessionId, h.id)) continue;
      if (h.score < COSINE_FLOOR_WIKI) break;
      bestWiki = h as typeof bestWiki;
      break;
    }
  }

  // 2. Raw chunk fallback (only if no wiki hit)
  let bestRaw:
    | { id: string; score: number; metadata: Record<string, unknown> }
    | undefined;
  if (!bestWiki && store.rawChunks.size() > 0) {
    const hits = store.rawChunks.search(queryVec, {
      topK: 3,
      filter: (m) => {
        const meta = m as unknown as Record<string, unknown>;
        return !input.projectId || meta.project_id === input.projectId;
      },
    });
    for (const h of hits) {
      if (h.score < COSINE_FLOOR_RAW) break;
      bestRaw = {
        id: h.id,
        score: h.score,
        metadata: h.metadata as unknown as Record<string, unknown>,
      };
      break;
    }
  }

  // 3. Glossary entries that match the prompt
  const glossary = input.projectId
    ? readGlossary(input.projectId)
    : ([] as GlossaryEntry[]);
  const matched = matchTerms(glossary, input.prompt, 3);

  // 4. Current task & session summary
  const taskBody = readCurrentTaskBody(input.sessionId);
  const summaryBody = readSummary(input.sessionId);

  if (!bestWiki && !bestRaw && matched.length === 0 && !taskBody) {
    logCuratorDecision(
      store,
      {
        prompt_id: promptId,
        session_id: input.sessionId,
        project_slug: input.projectId,
        decision: 'silence',
        page_slug: null,
        score: null,
        threshold: COSINE_FLOOR_WIKI,
        confidence: null,
        source_class: null,
      },
      log,
    );
    return {
      ...SKIPPED,
      prompt_id: promptId,
      components: { ...SKIPPED.components, skipped_reason: 'no_signal' },
    };
  }

  // Compose deterministic version first.
  const deterministic = composeDeterministic({
    wiki: bestWiki
      ? { id: bestWiki.id, metadata: bestWiki.metadata, score: bestWiki.score }
      : undefined,
    raw: bestRaw
      ? {
          id: bestRaw.id,
          metadata: bestRaw.metadata,
          score: bestRaw.score,
        }
      : undefined,
    glossary: matched,
    taskBody,
  });

  let injection = deterministic.injection;

  // Optional LLM curator. Off by default; opt-in via env.
  const provider = pickProvider();
  if (
    ALWAYS_USE_LLM &&
    provider &&
    provider.isConfigured() &&
    deterministic.injection.length > 0
  ) {
    try {
      const polished = await llmPolish(provider, input.prompt, deterministic.injection, log);
      if (polished) injection = polished;
    } catch (err) {
      log(`[curator] llm polish failed: ${(err as Error).message}`);
    }
  }

  injection = capByBudget(injection, TOKEN_BUDGET);

  // Record the injection for reinforcement: we want to know after the
  // assistant replies whether the page actually got used. bestWiki uses
  // the canonical wiki path; bestRaw seeds a raw-pending so a follow-up
  // hit can promote the chunk into a wiki distillation pass.
  if (bestWiki) {
    const pagePath = path.posix.join(
      bestWiki.metadata.status === 'canonical' ? wikiPagesDir() : wikiPendingDir(),
      `${bestWiki.id}.md`,
    );
    const summary = `${bestWiki.metadata.title}\n\n${bestWiki.metadata.trigger} → ${bestWiki.metadata.insight}`;
    recordInjection(input.sessionId, bestWiki.id, pagePath, summary);
  } else if (bestRaw) {
    const meta = bestRaw.metadata;
    const text = typeof meta.text_preview === 'string' ? meta.text_preview : '';
    const projectId =
      typeof meta.project_id === 'string' && meta.project_id
        ? meta.project_id
        : input.projectId;
    if (text.length >= 40) {
      recordRawInjection(input.sessionId, bestRaw.id, text, projectId);
    }
  }

  /* CI-1 + CI-5: log the inject decision with confidence and the
   * resolved source_class. The confidence formula is the simple
   * (score - threshold) / (1 - threshold) heuristic; refinement to a
   * calibrated logistic regression is Wave 3 work per Appendix H. */
  const winner = bestWiki
    ? {
        page_slug: bestWiki.id,
        score: bestWiki.score,
        threshold: COSINE_FLOOR_WIKI,
        source_class: bestWiki.metadata.status === 'canonical' ? 'wiki' : 'draft',
      }
    : bestRaw
      ? {
          page_slug: null,
          score: bestRaw.score,
          threshold: COSINE_FLOOR_RAW,
          source_class: 'raw',
        }
      : {
          page_slug: null,
          score: null as number | null,
          threshold: COSINE_FLOOR_WIKI,
          source_class: matched.length > 0 ? 'glossary' : taskBody ? 'task' : null,
        };
  const confidence =
    winner.score !== null ? computeConfidence(winner.score, winner.threshold) : null;
  logCuratorDecision(
    store,
    {
      prompt_id: promptId,
      session_id: input.sessionId,
      project_slug: input.projectId,
      decision: 'inject',
      page_slug: winner.page_slug,
      score: winner.score,
      threshold: winner.threshold,
      confidence,
      source_class: winner.source_class,
    },
    log,
  );

  return {
    injection,
    byteCount: Buffer.byteLength(injection, 'utf-8'),
    prompt_id: promptId,
    page_slug: winner.page_slug,
    ...(confidence !== null ? { confidence } : {}),
    components: {
      ...(bestWiki ? { wiki_page_id: bestWiki.id, wiki_score: bestWiki.score } : {}),
      ...(bestRaw ? { raw_chunk_id: bestRaw.id, raw_score: bestRaw.score } : {}),
      glossary_terms: matched.map((m) => m.term),
      used_session_summary: false,
      used_current_task: Boolean(taskBody),
    },
  };
}

interface ComposeArgs {
  wiki?:
    | { id: string; metadata: WikiPageMetadata; score: number }
    | undefined;
  raw?:
    | { id: string; metadata: Record<string, unknown>; score: number }
    | undefined;
  glossary: GlossaryEntry[];
  taskBody: string;
}

function composeDeterministic(args: ComposeArgs): { injection: string } {
  const sections: string[] = [];

  if (args.wiki) {
    const m = args.wiki.metadata;
    sections.push(
      `[devneural-page id=${args.wiki.id} score=${args.wiki.score.toFixed(2)}]
trigger: ${m.trigger}
insight: ${m.insight}
${m.title}`,
    );
  } else if (args.raw) {
    const m = args.raw.metadata as { text_preview?: string };
    sections.push(
      `[devneural-raw id=${args.raw.id} score=${args.raw.score.toFixed(2)}]
${m.text_preview ?? ''}`,
    );
  }

  if (args.glossary.length > 0) {
    const lines = args.glossary
      .map((e) => `- "${e.term}" = ${e.definition}`)
      .join('\n');
    sections.push(`[devneural-glossary]\n${lines}`);
  }

  if (args.taskBody) {
    sections.push(`[devneural-current-task]\n${args.taskBody.slice(0, 240)}`);
  }

  if (sections.length === 0) return { injection: '' };

  const blob = sections.join('\n\n');
  const wrapped = `<devneural-context>
${blob}
</devneural-context>`;
  return { injection: wrapped };
}

interface PolishShape {
  injection: string;
}

const validatePolish: Validator<PolishShape> = (raw) => {
  if (!raw || typeof raw !== 'object')
    return { ok: false, errors: ['response not object'] };
  const obj = raw as Record<string, unknown>;
  const inj = typeof obj.injection === 'string' ? obj.injection : '';
  if (!inj) return { ok: false, errors: ['injection missing'] };
  return { ok: true, value: { injection: inj }, errors: [] };
};

async function llmPolish(
  provider: LlmProvider,
  prompt: string,
  candidate: string,
  log: (msg: string) => void,
): Promise<string | null> {
  const system = `You polish context blobs that get injected into a developer's Claude session right before they ask a question.

Output strictly this JSON shape:
{ "injection": "the polished blob" }

Hard rules:
- Output stays as a single short markdown blob with the same general structure.
- If the candidate is already perfect, return it verbatim.
- Drop any line that does not directly help answer the user's prompt.
- Total length <= 600 tokens.
- Keep <devneural-context> wrapper tags exactly.`;

  const user = `User's prompt:
${prompt.slice(0, 600)}

Candidate injection:
${candidate.slice(0, 4000)}

Polish or return verbatim.`;

  const result = await callValidated(
    provider,
    {
      role: 'self_query',
      systemBlocks: [{ text: system, cache: true }],
      user,
      maxTokens: 700,
    },
    validatePolish,
    log,
  );
  return result.value?.injection ?? null;
}

function capByBudget(text: string, tokenBudget: number): string {
  // Coarse: 1 token ~= 4 chars on average. Use 4 chars/token bound.
  const charLimit = tokenBudget * 4;
  if (text.length <= charLimit) return text;
  return text.slice(0, charLimit - 24) + '\n... [truncated]\n';
}

void DIVERSITY_THRESHOLD; // reserved for second-result diversity check
