/**
 * Two-pass ingest. Per docs/spec/DEVNEURAL.md section 3.
 *
 * Pass 1 (filter): given DEVNEURAL.md (cached) + index summary + new
 * content + candidate metadata, output a JSON list of which candidate
 * pages are actually affected and whether a new pending page is
 * warranted.
 *
 * Pass 2 (write): given affected pages' bodies + new content, output
 * a structured set of page updates and zero or one new pending page.
 *
 * Daemon applies the diffs to disk, updates SQLite + vector store,
 * appends to log, and commits the wiki git repo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { embedOne } from '../embedder/index.js';
import type { Store, WikiPageMetadata } from '../store/index.js';
import {
  wikiPagesDir,
  wikiPendingDir,
  wikiArchiveDir,
} from '../paths.js';
import {
  parsePage,
  readPage,
  writePage,
  type PageFrontmatter,
  type PageSections,
  type ParsedPage,
} from './schema.js';
import { selectCandidates, type CandidatePage } from './candidates.js';
import {
  pickProvider,
  callValidated,
  validatePass1,
  validatePass2,
  type LlmProvider,
} from '../llm/index.js';
import type { Validator } from '../llm/validator.js';
import { appendLog, commitWiki } from './scaffolding.js';
import * as fs2 from 'node:fs';
import { wikiSchemaFile } from '../paths.js';

/* qwen3:8b routinely emits cross-ref entries as `./name.md`, `name.md`,
 * `name with spaces`, or with stray `#frag` / `?q` suffixes. Templating
 * `./${id}.md` against those produced on-disk garbage like
 * `././name.md.md` that the orb couldn't resolve. Slugify defensively
 * so future writes are clean even when the LLM drifts. */
function sanitizeCrossRefId(raw: string): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/[#?].*$/, '');
  s = s.replace(/^(?:\.\/+)+/, '');
  s = s.split('/').pop() ?? s;
  while (s.toLowerCase().endsWith('.md')) {
    s = s.slice(0, -3);
  }
  return s.toLowerCase().trim().replace(/\s+/g, '-');
}

export interface IngestInput {
  source: string; // identifier (session id, "corpus:<kind>", "gap:<id>")
  projectId: string;
  projectName: string;
  newContent: string;
  evidenceHints: string[]; // free-form lines that go into ## Evidence
  /** Forwarded into the LLM provider's fetch so an in-flight ingest pass
   * can be cancelled mid-call (used by backfill). */
  signal?: AbortSignal;
}

export interface Pass1Output {
  affected_pages: string[];
  new_page_warranted: boolean;
  new_page_reason?: string;
}

export interface Pass2PageUpdate {
  id: string;
  evidence_add?: string[];
  log_add?: string;
  cross_refs_add?: string[];
  cross_refs_remove?: string[];
  pattern_rewrite?: string | null;
  summary_rewrite?: string | null;
  flag_for_review?: boolean;
}

export interface Pass2NewPage {
  id: string;
  title: string;
  trigger: string;
  insight: string;
  summary: string;
  pattern_body: string;
  evidence: string[];
  cross_refs?: string[];
}

export interface Pass2Output {
  page_updates: Pass2PageUpdate[];
  new_pending_page: Pass2NewPage | null;
}

export interface IngestResult {
  pages_updated: string[];
  pages_created: string[];
  pages_flagged: string[];
  affected_candidates: number;
  candidate_pool_size: number;
  cost: { input_tokens: number; output_tokens: number; cache_read: number };
  skipped_reason?: string;
}

export async function runIngest(
  store: Store,
  input: IngestInput,
  log: (msg: string) => void = () => undefined,
): Promise<IngestResult> {
  const result: IngestResult = {
    pages_updated: [],
    pages_created: [],
    pages_flagged: [],
    affected_candidates: 0,
    candidate_pool_size: 0,
    cost: { input_tokens: 0, output_tokens: 0, cache_read: 0 },
  };

  const provider = pickProvider();
  if (!provider) {
    result.skipped_reason = 'LLM provider disabled (DEVNEURAL_LLM_PROVIDER=none)';
    return result;
  }
  if (!provider.isConfigured()) {
    result.skipped_reason = `LLM provider "${provider.name}" not configured: ${provider.configHint()}`;
    return result;
  }

  if (input.newContent.trim().length < 40) {
    result.skipped_reason = 'new content too short';
    return result;
  }

  const candidates = await selectCandidates(store, input.newContent);
  result.candidate_pool_size = candidates.length;

  const schemaText = fs2.existsSync(wikiSchemaFile())
    ? fs2.readFileSync(wikiSchemaFile(), 'utf-8')
    : '';
  const pass1Preamble = buildPass1Preamble(store, candidates, input);
  const pass1User = buildPass1User(input, candidates);

  const pass1Validated = await callValidated(
    provider,
    {
      role: 'ingest',
      systemBlocks: [
        { text: schemaText, cache: true },
        { text: pass1Preamble, cache: true },
      ],
      user: pass1User,
      maxTokens: 800,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    validatePass1,
    log,
  );

  if (input.signal?.aborted) {
    result.skipped_reason = 'aborted';
    return result;
  }
  result.cost.input_tokens += pass1Validated.totalInputTokens;
  result.cost.output_tokens += pass1Validated.totalOutputTokens;
  result.cost.cache_read += pass1Validated.totalCacheRead;

  if (!pass1Validated.value) {
    result.skipped_reason = `pass1 failed after ${pass1Validated.attempts} attempts: ${pass1Validated.errors.join('; ')}`;
    log(`[ingest] pass1 failed: ${result.skipped_reason}`);
    return result;
  }
  const pass1Output: Pass1Output = pass1Validated.value;

  result.affected_candidates = pass1Output.affected_pages.length;

  if (
    pass1Output.affected_pages.length === 0 &&
    !pass1Output.new_page_warranted
  ) {
    result.skipped_reason = 'pass1 found nothing to do';
    return result;
  }

  const affectedPages = pass1Output.affected_pages
    .map((id) => loadPageById(id))
    .filter((p): p is { page: ParsedPage; file: string } => p !== null);

  const pass2User = buildPass2User(
    input,
    affectedPages,
    pass1Output.new_page_warranted,
  );
  let pass2Validated = await callValidated(
    provider,
    {
      role: 'ingest',
      systemBlocks: [
        { text: schemaText, cache: true },
        { text: pass1Preamble, cache: true },
      ],
      user: pass2User,
      maxTokens: 2500,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    validatePass2,
    log,
  );

  if (input.signal?.aborted) {
    result.skipped_reason = 'aborted';
    return result;
  }
  result.cost.input_tokens += pass2Validated.totalInputTokens;
  result.cost.output_tokens += pass2Validated.totalOutputTokens;
  result.cost.cache_read += pass2Validated.totalCacheRead;

  /* Anthropic fallback for Pass 2. Local qwen3:8b is borderline for the
   * strict frontmatter + 80-token-summary discipline DEVNEURAL.md
   * requires; on validation exhaustion the wiki silently drops a turn
   * that should have produced a page. When DEVNEURAL_PASS2_FALLBACK
   * = anthropic and ANTHROPIC_API_KEY is set, retry the call once
   * against Anthropic Haiku (the AnthropicProvider's default ingest
   * model). One retry only: an Anthropic failure means a real schema
   * problem, not a model-quality problem, and looping further would
   * waste API spend. Off by default to preserve local-first.
   *
   * Cost ballpark on a borderline-quality install: ~15-25% of Pass 2
   * calls fall back, ~$0.004/call. ~$0.10/day at 100 ingests. Cheap
   * insurance against the wiki's keystone risk. */
  if (
    !pass2Validated.value &&
    process.env.DEVNEURAL_PASS2_FALLBACK?.toLowerCase() === 'anthropic' &&
    provider.name !== 'anthropic'
  ) {
    try {
      const { AnthropicProvider } = await import('../llm/anthropic.js');
      const fallback = new AnthropicProvider();
      if (fallback.isConfigured()) {
        log(`[ingest] pass2 fallback to anthropic after local exhaustion`);
        const retry = await callValidated(
          fallback,
          {
            role: 'ingest',
            systemBlocks: [
              { text: schemaText, cache: true },
              { text: pass1Preamble, cache: true },
            ],
            user: pass2User,
            maxTokens: 2500,
            ...(input.signal ? { signal: input.signal } : {}),
          },
          validatePass2,
          log,
        );
        result.cost.input_tokens += retry.totalInputTokens;
        result.cost.output_tokens += retry.totalOutputTokens;
        result.cost.cache_read += retry.totalCacheRead;
        if (retry.value) {
          pass2Validated = retry;
          log(`[ingest] pass2 fallback succeeded`);
        } else {
          log(
            `[ingest] pass2 fallback also failed: ${retry.errors.join('; ')}`,
          );
        }
      } else {
        log(
          `[ingest] pass2 fallback requested but anthropic not configured: ${fallback.configHint()}`,
        );
      }
    } catch (err) {
      log(`[ingest] pass2 fallback errored: ${(err as Error).message}`);
    }
  }

  if (!pass2Validated.value) {
    result.skipped_reason = `pass2 failed after ${pass2Validated.attempts} attempts: ${pass2Validated.errors.join('; ')}`;
    log(`[ingest] pass2 failed: ${result.skipped_reason}`);
    return result;
  }
  const pass2Output: Pass2Output = pass2Validated.value;

  for (const update of pass2Output.page_updates ?? []) {
    const target = affectedPages.find((p) => p.page.frontmatter.id === update.id);
    if (!target) continue;

    if (target.page.frontmatter.human_edited) {
      const onlyAdditive =
        !update.pattern_rewrite &&
        !update.summary_rewrite &&
        (update.cross_refs_remove ?? []).length === 0;
      if (!onlyAdditive) {
        // Per DEVNEURAL.md 7.4: cannot rewrite human-edited pages.
        // Flag instead.
        target.page.frontmatter.flag_for_review = true;
        await rewritePage(store, target.page, target.file);
        result.pages_flagged.push(update.id);
        continue;
      }
    }

    const wasCrossProject =
      target.page.frontmatter.projects.length >= 2 ||
      target.page.frontmatter.projects.includes(input.projectId);
    const updated = applyPageUpdate(target.page, update, input);
    /* Cross-project verification gate. DEVNEURAL.md 7.3: a pattern
     * observed only in project A becomes a cross-project page when
     * project B's evidence joins it. Without verification, "logging"
     * in two domains can falsely fuse into a single global page that
     * misleads retrieval. When this update is the FIRST mention of
     * input.projectId on a page that already had >=1 different
     * project, ask the LLM whether the new evidence genuinely
     * describes the same pattern. On no/uncertain we flip
     * flag_for_review so a human (or the next lint pass) can sort it
     * out instead of silently merging. */
    const becameCrossProject =
      !wasCrossProject && updated.frontmatter.projects.length >= 2;
    if (becameCrossProject && (update.evidence_add ?? []).length > 0) {
      try {
        const sameSource =
          await verifyCrossProjectFit(
            provider,
            updated.frontmatter,
            updated.sections.pattern ?? '',
            update.evidence_add ?? [],
            input,
            log,
          );
        if (!sameSource) {
          updated.frontmatter.flag_for_review = true;
          updated.sections.log.push(
            `${updated.frontmatter.last_touched} verifier: cross-project evidence flagged (project ${input.projectId})`,
          );
          log(
            `[ingest] ${update.id}: cross-project verifier rejected evidence from ${input.projectId}; flagged`,
          );
        }
      } catch (err) {
        log(
          `[ingest] cross-project verifier errored: ${(err as Error).message}; allowing update`,
        );
      }
    }
    await rewritePage(store, updated, target.file);
    result.pages_updated.push(update.id);
  }

  if (pass2Output.new_pending_page) {
    try {
      const file = await writeNewPendingPage(
        store,
        pass2Output.new_pending_page,
        input,
      );
      if (file) result.pages_created.push(pass2Output.new_pending_page.id);
    } catch (err) {
      log(`[ingest] new page rejected: ${(err as Error).message}`);
    }
  }

  appendLog(
    `ingest source=${input.source} project=${input.projectName} updated=${result.pages_updated.length} created=${result.pages_created.length} flagged=${result.pages_flagged.length}`,
  );
  commitWiki(`ingest ${input.source}`);

  // Always-on lint: any page touched in this pass schedules a debounced
  // lint cycle so promote/archive/decay/whats-new run within minutes of
  // the activity that produced the page, not weekly. Debounce collapses
  // bursts; single-flight + rerunRequested handles activity during a
  // running cycle.
  if (
    result.pages_created.length > 0 ||
    result.pages_updated.length > 0 ||
    result.pages_flagged.length > 0
  ) {
    try {
      const { scheduleLint } = await import('./lint-queue.js');
      scheduleLint(`ingest:${input.source}`);
    } catch {
      /* lint queue not initialized yet (early ingest during boot); fine. */
    }
  }

  return result;
}

function buildPass1Preamble(
  store: Store,
  candidates: CandidatePage[],
  input: IngestInput,
): string {
  const lines: string[] = [];
  lines.push('Wiki state preamble (cached).');
  lines.push('');
  lines.push(`Total canonical pages: ${countByStatus(store, 'canonical')}`);
  lines.push(`Total pending pages: ${countByStatus(store, 'pending')}`);
  lines.push('');
  lines.push('Candidate pages (id, status, weight, trigger):');
  for (const c of candidates) {
    const row = c.row;
    if (!row) continue;
    lines.push(
      `- ${row.id} [${row.status} w=${row.weight.toFixed(2)}] ${row.trigger.slice(0, 80)}`,
    );
  }
  lines.push('');
  lines.push(`Source: ${input.source} (project ${input.projectName})`);
  return lines.join('\n');
}

function countByStatus(store: Store, status: string): number {
  let n = 0;
  for (const { metadata } of store.wikiPages.all()) {
    if ((metadata as WikiPageMetadata).status === status) n++;
  }
  return n;
}

function buildPass1User(input: IngestInput, candidates: CandidatePage[]): string {
  const candidateBlock = candidates
    .map((c) => {
      const row = c.row;
      const title = row?.title ?? c.id;
      const summary = c.metadata?.title ?? title;
      const reasons = c.reasons.slice(0, 3).join('; ');
      return `### ${c.id}\ntitle: ${title}\nsummary: ${summary}\nreasons: ${reasons}\n`;
    })
    .join('\n');

  return `INGEST PASS 1 (filter)

Decide which candidate pages are actually affected by the new content,
and whether a new pending page is warranted.

Output strictly this JSON shape:
\`\`\`json
{
  "affected_pages": ["page-id-1", "page-id-2"],
  "new_page_warranted": true,
  "new_page_reason": "one short sentence"
}
\`\`\`

Cap affected_pages at 5. Filter aggressively. A page is affected only
if the new content meaningfully *changes* it.

----- new content (project: ${input.projectName}, source: ${input.source}) -----
${input.newContent.slice(0, 4000)}
----- end new content -----

----- candidate pages -----
${candidateBlock || '(none)'}
----- end candidates -----

Respond with the JSON only, inside one triple-backtick block.`;
}

function buildPass2User(
  input: IngestInput,
  affected: { page: ParsedPage; file: string }[],
  newPageWarranted: boolean,
): string {
  const lines: string[] = [];
  lines.push('INGEST PASS 2 (write)');
  lines.push('');
  lines.push(
    'Produce diffs for the affected pages and (optionally) one new pending page.',
  );
  lines.push('Respond as JSON inside a triple-backtick block:');
  lines.push('```json');
  lines.push(`{
  "page_updates": [
    {
      "id": "page-id",
      "evidence_add": ["session abc...: <one line>"],
      "log_add": "${new Date().toISOString().slice(0, 10)} ingest: <one line>",
      "cross_refs_add": [],
      "cross_refs_remove": [],
      "pattern_rewrite": null,
      "summary_rewrite": null,
      "flag_for_review": false
    }
  ],
  "new_pending_page": ${newPageWarranted ? '{ "id": "...", "title": "[trigger] → [insight]", "trigger": "...", "insight": "...", "summary": "...", "pattern_body": "...", "evidence": ["..."], "cross_refs": [] }' : 'null'}
}`);
  lines.push('```');
  lines.push('');
  lines.push(
    'Hard rules: keep summary <= 80 tokens. Keep pattern_body <= 800 tokens.',
  );
  lines.push(
    'Do not rewrite pattern or summary on human-edited pages (set flag_for_review).',
  );
  lines.push('');
  lines.push('----- affected page bodies -----');
  for (const a of affected) {
    lines.push(`### ${a.page.frontmatter.id}`);
    lines.push(`title: ${a.page.frontmatter.title}`);
    lines.push(`trigger: ${a.page.frontmatter.trigger}`);
    lines.push(`insight: ${a.page.frontmatter.insight}`);
    lines.push(`summary: ${a.page.frontmatter.summary}`);
    lines.push(`human_edited: ${a.page.frontmatter.human_edited}`);
    lines.push(`Pattern:`);
    lines.push(a.page.sections.pattern.slice(0, 2000));
    lines.push('');
  }
  lines.push('----- new content -----');
  lines.push(input.newContent.slice(0, 6000));
  lines.push('----- end -----');
  return lines.join('\n');
}

function applyPageUpdate(
  page: ParsedPage,
  update: Pass2PageUpdate,
  input: IngestInput,
): { frontmatter: PageFrontmatter; sections: PageSections } {
  const fm: PageFrontmatter = { ...page.frontmatter };
  const sections: PageSections = {
    pattern: page.sections.pattern,
    crossRefs: [...page.sections.crossRefs],
    crossRefsRaw: [...page.sections.crossRefsRaw],
    evidence: [...page.sections.evidence],
    openQuestions: [...page.sections.openQuestions],
    log: [...page.sections.log],
  };

  if (update.evidence_add) {
    for (const e of update.evidence_add) {
      if (e && !sections.evidence.includes(e)) sections.evidence.push(e);
    }
    while (sections.evidence.length > EVIDENCE_MAX) sections.evidence.shift();
  }

  if (update.log_add) sections.log.push(update.log_add);

  if (update.cross_refs_add) {
    for (const rawId of update.cross_refs_add) {
      const id = sanitizeCrossRefId(rawId);
      if (!id) continue;
      if (sections.crossRefs.includes(id)) continue;
      if (sections.crossRefs.length >= CROSS_REFS_MAX) break;
      sections.crossRefs.push(id);
      sections.crossRefsRaw.push({
        label: id.replace(/-/g, ' '),
        href: `./${id}.md`,
      });
    }
  }
  if (update.cross_refs_remove) {
    for (const id of update.cross_refs_remove) {
      sections.crossRefs = sections.crossRefs.filter((c) => c !== id);
      sections.crossRefsRaw = sections.crossRefsRaw.filter((c) => {
        return c.href.split('/').pop()?.replace('.md', '') !== id;
      });
    }
  }

  if (update.pattern_rewrite && !fm.human_edited) {
    sections.pattern = clipString(update.pattern_rewrite, BODY_MAX);
  }
  if (update.summary_rewrite && !fm.human_edited) {
    fm.summary = clipString(update.summary_rewrite, SUMMARY_MAX);
  }
  if (update.flag_for_review) fm.flag_for_review = true;

  fm.last_touched = new Date().toISOString().slice(0, 10);
  if (!fm.projects.includes(input.projectId)) fm.projects.push(input.projectId);

  return { frontmatter: fm, sections };
}

async function rewritePage(
  store: Store,
  page: { frontmatter: PageFrontmatter; sections: PageSections },
  file: string,
): Promise<void> {
  const dir = path.dirname(file).replace(/\\/g, '/');
  writePage(dir, page);
  await indexPage(store, page);
}

/* qwen3:8b validation failure modes seen in the wild:
 *   - title missing the → separator
 *   - summary > 600 chars (it loves long restatements)
 *   - cross_refs > 8
 *   - evidence > 20
 *   - pattern_body > 6000 chars
 *
 * All of these are recoverable: clip the lists, truncate the strings,
 * synthesise a `→` from trigger + insight when missing. We prefer
 * "save a slightly clipped page" over "throw + retry + abandon" because
 * the LLM's drift on these is non-deterministic and re-running burns
 * minutes of ollama time per attempt. */
const SUMMARY_MAX = 600;
const BODY_MAX = 6000;
const CROSS_REFS_MAX = 8;
const EVIDENCE_MAX = 20;

/* Cross-project verifier. Cheap LLM call that asks "is this new
 * evidence chunk describing the same recurring pattern as the
 * existing page, or are these two unrelated things that just share
 * vocabulary?" Returns true on confident yes, false on no or
 * uncertain. Falsing out flips flag_for_review on the caller; we
 * never silently merge across projects without confidence.
 *
 * Prompt is intentionally tiny and self-contained so it works on the
 * local model without leaning on cached system blocks. The validator
 * accepts only `{ "same_pattern": boolean }`; anything else fails
 * closed (treated as not-same so the human/lint sees it). */
async function verifyCrossProjectFit(
  provider: LlmProvider,
  fm: PageFrontmatter,
  patternBody: string,
  newEvidence: string[],
  input: IngestInput,
  log: (msg: string) => void,
): Promise<boolean> {
  const evidenceBlock = newEvidence.slice(0, 5).join('\n  - ');
  const user =
    `Existing page:\n` +
    `  trigger: ${fm.trigger}\n` +
    `  insight: ${fm.insight}\n` +
    `  pattern: ${patternBody.slice(0, 1500)}\n\n` +
    `New evidence from project "${input.projectName}":\n  - ${evidenceBlock}\n\n` +
    `Question: does the new evidence describe the SAME recurring pattern as the existing page (same trigger condition, same insight applies)? ` +
    `Or does it just share vocabulary while being a different domain or different problem?\n\n` +
    `Respond with strict JSON only: {"same_pattern": true} or {"same_pattern": false}`;
  const verifier: Validator<{ same_pattern: boolean }> = (raw) => {
    if (!raw || typeof raw !== 'object')
      return { ok: false, errors: ['not object'] };
    const v = (raw as { same_pattern?: unknown }).same_pattern;
    if (typeof v !== 'boolean')
      return { ok: false, errors: ['same_pattern not bool'] };
    return { ok: true, value: { same_pattern: v }, errors: [] };
  };
  const result = await callValidated(
    provider,
    {
      role: 'self_query',
      systemBlocks: [
        {
          text:
            'You are a strict pattern verifier for a wiki of [trigger]→[insight] pages. ' +
            'Reply ONLY with the requested JSON object. No prose.',
          cache: false,
        },
      ],
      user,
      maxTokens: 50,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    verifier,
    log,
  );
  if (!result.value) return false; // fail closed
  return result.value.same_pattern;
}

function ensureArrowTitle(title: string, trigger: string, insight: string): string {
  if (title.includes('→')) return title;
  if (trigger && insight) return `${trigger.trim()} → ${insight.trim()}`;
  // last resort: split title on " - " or " then " or first sentence break
  const sep = title.match(/\s+(then|->|to)\s+/i);
  if (sep && sep.index !== undefined) {
    const before = title.slice(0, sep.index).trim();
    const after = title.slice(sep.index + sep[0].length).trim();
    if (before && after) return `${before} → ${after}`;
  }
  return `${title.trim()} → (insight pending)`;
}

function clipString(s: string, max: number): string {
  if (s.length <= max) return s;
  // Soft-clip on the last sentence boundary before max so we don't cut
  // mid-word. Falls back to hard clip if no sentence end exists.
  const slice = s.slice(0, max);
  const lastEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
  if (lastEnd > max * 0.6) return slice.slice(0, lastEnd + 1).trim();
  return slice.trim() + '…';
}

async function writeNewPendingPage(
  store: Store,
  newPage: Pass2NewPage,
  input: IngestInput,
): Promise<string | null> {
  if (!newPage.id) return null;
  if (!newPage.evidence || newPage.evidence.length === 0) {
    throw new Error(`new page has no evidence: ${newPage.id}`);
  }

  const title = ensureArrowTitle(newPage.title, newPage.trigger, newPage.insight);
  const summary = clipString(newPage.summary ?? '', SUMMARY_MAX);
  const patternBody = clipString(newPage.pattern_body ?? '', BODY_MAX);

  const fm: PageFrontmatter = {
    id: newPage.id,
    title,
    trigger: newPage.trigger,
    insight: newPage.insight,
    summary,
    status: 'pending',
    weight: 0.3,
    hits: 0,
    corrections: 0,
    created: new Date().toISOString().slice(0, 10),
    last_touched: new Date().toISOString().slice(0, 10),
    projects: [input.projectId],
    human_edited: false,
  };

  const cleanRefs = (newPage.cross_refs ?? [])
    .map(sanitizeCrossRefId)
    .filter((id): id is string => Boolean(id))
    .slice(0, CROSS_REFS_MAX);
  const evidence = newPage.evidence.slice(0, EVIDENCE_MAX);
  const sections: PageSections = {
    pattern: patternBody,
    crossRefs: cleanRefs,
    crossRefsRaw: cleanRefs.map((id) => ({
      label: id.replace(/-/g, ' '),
      href: `./${id}.md`,
    })),
    evidence,
    openQuestions: [],
    log: [
      `${new Date().toISOString().slice(0, 10)} ingest: page created from ${input.source}`,
    ],
  };

  const file = writePage(wikiPendingDir(), { frontmatter: fm, sections });
  await indexPage(store, { frontmatter: fm, sections });
  return file;
}

async function indexPage(
  store: Store,
  page: { frontmatter: PageFrontmatter; sections: PageSections },
): Promise<void> {
  const fm = page.frontmatter;
  const tsMs = Date.now();
  const created = new Date(fm.created).getTime() || tsMs;
  store.db.upsertWikiPage(
    {
      id: fm.id,
      title: fm.title,
      trigger: fm.trigger,
      insight: fm.insight,
      status: fm.status,
      weight: fm.weight,
      hits: fm.hits,
      corrections: fm.corrections,
      created_ms: created,
      last_touched_ms: tsMs,
      projects_json: JSON.stringify(fm.projects),
      human_edited: fm.human_edited ? 1 : 0,
    },
    page.sections.pattern,
  );

  store.db.setCrossRefs(fm.id, page.sections.crossRefs);

  const embedText = `${fm.title}\n\n${fm.summary}\n\n${page.sections.pattern.slice(0, 2000)}`;
  const vec = await embedOne(embedText);
  await store.wikiPages.add({
    id: fm.id,
    vector: vec,
    metadata: {
      status: fm.status,
      weight: fm.weight,
      trigger: fm.trigger,
      insight: fm.insight,
      title: fm.title,
    },
  });
}

interface LoadedPage {
  page: ParsedPage;
  file: string;
}

function loadPageById(id: string): LoadedPage | null {
  const candidates = [
    path.posix.join(wikiPagesDir(), `${id}.md`),
    path.posix.join(wikiPendingDir(), `${id}.md`),
    path.posix.join(wikiArchiveDir(), `${id}.md`),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        return { page: readPage(file), file };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseJsonBlock<T>(text: string): T {
  const fence = text.match(/```json\s*\n([\s\S]+?)\n```/i);
  const raw = fence?.[1] ?? text;
  return JSON.parse(raw) as T;
}

void parsePage; // re-export-friendly noop
