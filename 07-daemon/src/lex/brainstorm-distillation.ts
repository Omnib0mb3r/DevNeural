/**
 * Brainstorm session-end auto-distillation (BF-7).
 *
 * Runs Pass 2 against the full brainstorm transcript and writes
 * pending wiki_drafts rows. Refusal contract:
 *
 *   - Local LLM (ollama / qwen3:8b) only. BF-4 forbids voice-session
 *     content from any outbound call, including the Anthropic Pass 2
 *     fallback. If the active provider is Anthropic, the distillation
 *     is skipped with a log entry; the user sees zero drafts.
 *   - Gated on kind='brainstorm'. Meeting sessions follow the
 *     meeting-summary path (BF-15) and never hit this code.
 *
 * Confidence per draft is the Appendix H heuristic v1:
 *   confidence =
 *       0.40 * schema_validation_score
 *     + 0.25 * cosine_similarity_to_wiki_novelty
 *     + 0.20 * trigger_clarity
 *     + 0.15 * evidence_density
 *
 * Wave 1 ships the schema + clarity + density terms; the cosine
 * novelty term defaults to 0.5 until the embedding-against-wiki
 * lookup is wired (Wave 2). Refinement to a calibrated logistic
 * regression is Wave 3.
 *
 * Auto-promote is disabled in Wave 1 (DEVNEURAL_DRAFT_AUTO_PROMOTE
 * _ENABLED=false default). Drafts stay in 'pending' until the user
 * acts on them through /drafts.
 */
import { randomUUID } from 'node:crypto';
import { pickProvider, callValidated } from '../llm/index.js';
import type { Validator } from '../llm/validator.js';
import type { Store } from '../store/index.js';

export interface DistillationCandidate {
  id: string;        // slug-style page id; lowercase + dashes
  title: string;     // human-readable page title
  trigger: string;   // [trigger] section content
  insight: string;   // [insight] section content
  body: string;      // markdown body for wiki_drafts.body_markdown
  evidence: string[]; // evidence references (file:line, brainstorm turn refs, etc.)
}

export interface DistillationOutput {
  pages: DistillationCandidate[];
}

export interface DistillationResult {
  drafts_created: number;
  draft_ids: string[];
  skipped_reason?: string;
}

/* Validator for the LLM's JSON output. Drafts that fail the schema
 * still write rows but their schema_validation_score drops to 0.0
 * (so confidence drops). Pages with empty trigger or insight are
 * dropped entirely; the LLM should retry next time. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]+$/;

const validateDistillation: Validator<DistillationOutput> = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['response not an object'] };
  }
  const obj = raw as Record<string, unknown>;
  const pagesRaw = obj.pages;
  if (!Array.isArray(pagesRaw)) {
    return { ok: false, errors: ['pages must be array'] };
  }
  const pages: DistillationCandidate[] = [];
  const errors: string[] = [];
  for (const p of pagesRaw as unknown[]) {
    if (!p || typeof p !== 'object') {
      errors.push('page entry not an object');
      continue;
    }
    const pp = p as Record<string, unknown>;
    const id = typeof pp.id === 'string' ? pp.id : '';
    const title = typeof pp.title === 'string' ? pp.title : '';
    const trigger = typeof pp.trigger === 'string' ? pp.trigger.trim() : '';
    const insight = typeof pp.insight === 'string' ? pp.insight.trim() : '';
    const body = typeof pp.body === 'string' ? pp.body : '';
    const evidence = Array.isArray(pp.evidence)
      ? (pp.evidence as unknown[])
          .map((e) => (typeof e === 'string' ? e : ''))
          .filter(Boolean)
      : [];
    if (!SLUG_RE.test(id)) {
      errors.push(`invalid page id: ${id || '(empty)'}`);
      continue;
    }
    if (!trigger || !insight) {
      errors.push(`page ${id} missing trigger or insight`);
      continue;
    }
    pages.push({ id, title: title || id, trigger, insight, body, evidence });
  }
  return { ok: true, value: { pages }, errors };
};

/* Confidence formula per Appendix H v1. */
function computeConfidence(
  c: DistillationCandidate,
  schemaScore: number,
  cosineNovelty: number,
): number {
  const triggerClarity =
    c.trigger.length >= 10 && /[a-z]/i.test(c.trigger) ? 1.0 :
    c.trigger.length > 0 ? 0.5 : 0.0;
  const evidenceDensity = Math.min(1.0, c.evidence.length / 3);
  const raw =
    0.40 * schemaScore +
    0.25 * cosineNovelty +
    0.20 * triggerClarity +
    0.15 * evidenceDensity;
  if (raw < 0) return 0.01;
  if (raw > 1) return 1.0;
  return Math.max(0.01, raw);
}

function buildDistillationPrompt(transcript: string): string {
  /* Concise, locally-cheap prompt. Keeps token count under qwen3:8b's
   * comfortable window. The body should be markdown ready to paste
   * as-is into wiki/<slug>.md (the user can edit at promote time). */
  return [
    'You distill a brainstorm transcript into wiki page candidates.',
    'Each page MUST have a clear [trigger] (the situation that calls for the insight) and [insight] (what to do).',
    'Output STRICT JSON only, no prose, no fences, matching this shape:',
    '{ "pages": [ { "id": "slug-style-id", "title": "Title", "trigger": "...", "insight": "...", "body": "markdown body", "evidence": ["ref1", "ref2"] } ] }',
    'Constraints:',
    '- 0 to 5 pages per call. If nothing transferable was discussed, return {"pages": []}.',
    '- id must be lowercase, dashes only, start with letter or digit.',
    '- trigger and insight non-empty. Body can be empty for placeholder drafts.',
    '- evidence is brainstorm turn references or quoted phrases.',
    '',
    'TRANSCRIPT:',
    transcript.slice(0, 12000),
    '',
    'Respond with the JSON object only.',
  ].join('\n');
}

export async function distillBrainstorm(
  store: Store,
  brainstormId: string,
  transcript: string,
  log: (msg: string) => void = () => undefined,
): Promise<DistillationResult> {
  if (!transcript || transcript.trim().length < 200) {
    log(`[distill] skipped: transcript too short (${transcript.length} chars)`);
    return { drafts_created: 0, draft_ids: [], skipped_reason: 'transcript_too_short' };
  }
  const provider = pickProvider();
  if (!provider || !provider.isConfigured()) {
    log('[distill] skipped: no LLM provider configured');
    return { drafts_created: 0, draft_ids: [], skipped_reason: 'no_provider' };
  }
  /* BF-4: brainstorm content forbidden in any outbound code path
   * regardless of opt-in flags. The Anthropic provider is off-host;
   * refuse here even though provider.callValidated would normally
   * just route the call. */
  if (provider.name === 'anthropic') {
    log('[distill] skipped: BF-4 forbids anthropic for brainstorm content');
    return {
      drafts_created: 0,
      draft_ids: [],
      skipped_reason: 'bf4_anthropic_blocked',
    };
  }

  const result = await callValidated(
    provider,
    {
      role: 'ingest',
      systemBlocks: [
        {
          text:
            'You are a strict JSON-only brainstorm distiller for the DevNeural wiki. ' +
            'Output ONLY the requested JSON object. No fences. No prose.',
          cache: false,
        },
      ],
      user: buildDistillationPrompt(transcript),
      maxTokens: 1500,
    },
    validateDistillation,
    log,
  );

  if (!result.value) {
    log(`[distill] LLM call failed: ${result.errors.join('; ')}`);
    return {
      drafts_created: 0,
      draft_ids: [],
      skipped_reason: 'llm_validation_failed',
    };
  }
  const schemaScore = result.errors.length === 0 ? 1.0 : 0.5;
  const draftIds: string[] = [];
  for (const candidate of result.value.pages) {
    const cosineNovelty = 0.5;
    const confidence = computeConfidence(candidate, schemaScore, cosineNovelty);
    const id = randomUUID();
    try {
      store.db.insertWikiDraft({
        id,
        brainstorm_id: brainstormId,
        page_slug: candidate.id,
        page_title: candidate.title,
        body_markdown: buildDraftBody(candidate),
        confidence,
        status: 'pending',
      });
      draftIds.push(id);
    } catch (err) {
      log(`[distill] insertWikiDraft failed for ${candidate.id}: ${(err as Error).message}`);
    }
  }
  log(
    `[distill] brainstorm=${brainstormId} drafts_created=${draftIds.length} schemaScore=${schemaScore}`,
  );
  return { drafts_created: draftIds.length, draft_ids: draftIds };
}

function buildDraftBody(c: DistillationCandidate): string {
  const lines: string[] = [];
  lines.push(`# ${c.title}`);
  lines.push('');
  lines.push('## Pattern');
  lines.push('');
  lines.push(`**Trigger:** ${c.trigger}`);
  lines.push('');
  lines.push(`**Insight:** ${c.insight}`);
  if (c.body && c.body.trim().length > 0) {
    lines.push('');
    lines.push(c.body.trim());
  }
  if (c.evidence.length > 0) {
    lines.push('');
    lines.push('## Evidence');
    lines.push('');
    for (const e of c.evidence) lines.push(`- ${e}`);
  }
  return lines.join('\n') + '\n';
}
