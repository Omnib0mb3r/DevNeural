/**
 * LLM-backed distillation generators.
 *
 * Two factories:
 *
 * 1. createLlmDistillationGenerator (anchor-flat, legacy).
 *    Plugs into preloadSiblingDistillations + runDistillationBackfill
 *    + idle-watcher via the DistillationGenerator shape. Reads the
 *    brainstorm's full chunk transcript (ordered by turn_index, anchor
 *    -wide), prompts for a structured Markdown summary, returns the
 *    trimmed text or null. Anchor-flat semantics: the summary
 *    describes the entire brainstorm, not a single CC session.
 *
 * 2. createPerSessionDistillationGenerator (Stage 2 of
 *    LEX-AUTONOMY-PAYLOAD-SPEC).
 *    Takes ({brainstorm_id, cc_session_id, ...}), reads chunks
 *    scoped to that pair via listBrainstormChunksForSession, prompts
 *    with PER_SESSION_SYSTEM_BLOCK (per-session semantics distinct
 *    from the rolling aggregate), and returns {summary, provenance}
 *    so callers can land source_chunk_count, source_session_ids,
 *    coverage_score on lex_transcript_ref. Returns null on every
 *    skip path (no provider, BF-4 blocked, no scoped chunks, empty
 *    LLM reply, validation throw) - the session-end pipeline logs
 *    the structured skip reason rather than synthesising a summary.
 *
 * Respects BF-4 on both paths: never sends brainstorm content out to
 * the anthropic provider. Local-only (ollama) by design.
 *
 * Pure module aside from the provider call: db reads are injected and
 * the provider is swappable so tests can drive the pipeline with a
 * stub.
 */
import { randomUUID } from 'node:crypto';
import type {
  BrainstormSessionRow,
  IndexDb,
} from '../store/index-db.js';
import type { LlmProvider } from '../llm/index.js';
import { pickProvider } from '../llm/index.js';
import type { DistillationGenerator } from './sibling-distillation-preload.js';
import { readTranscriptFromJsonlRefs } from './jsonl-transcript-reader.js';
import { spawnHeadlessOpus, type SpawnHeadlessOpus } from './headless-opus.js';

/* Codex item 6 (Fix 43): every null-return path in the per-session
 * generator writes a structured row to distillation_error_log so the
 * stale-watch + dashboard can correlate "ref_summary stayed NULL"
 * back to the reason. error_class is a stable tag; error_message is
 * the verbatim provider error text when available. Pure helper so
 * the generator stays a one-liner per branch. */
function logDistillationOutcome(
  db: IndexDb,
  args: {
    brainstormId: string | null;
    ccSessionId: string | null;
    generator: 'per-session' | 'anchor-flat';
    errorClass: string;
    errorMessage?: string | null;
    detail?: string | null;
  },
): void {
  try {
    db.insertDistillationError({
      id: randomUUID(),
      brainstorm_id: args.brainstormId,
      cc_session_id: args.ccSessionId,
      generator: args.generator,
      error_class: args.errorClass,
      error_message: args.errorMessage ?? null,
      detail: args.detail ?? null,
    });
  } catch {
    /* observational; the log line in the surrounding caller still
     * lands in stdout so this is purely additive */
  }
}

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
  /* LEX-AUTONOMY Stage 5 / codex item 4 (Fix 2026-05-26): fetch the
   * NEWEST chunkLimit chunks and reverse to chronological for the
   * prompt. Pre-fix this used the listBrainstormChunks default order
   * (ASC) which on any active brainstorm distilled the oldest N
   * turns globally and ignored recent activity entirely. The tail of
   * the conversation is the load-bearing context for the next-session
   * handoff; the head is already covered by prior per-session
   * summaries upstream of the rolling aggregate.
   *
   * The maxBytes cap also moves from "head of string" to "tail of
   * string" so when the transcript exceeds the byte budget we keep
   * the most recent content instead of dropping it. */
  const fetched = db.listBrainstormChunks(row.id, chunkLimit, {
    order: 'desc',
  });
  if (fetched.length === 0) return '';
  const chunks = fetched.slice().reverse();
  const lines = chunks.map((c) => {
    const role =
      c.role === 'lex' ? 'LEX' : c.role === 'user' ? 'USER' : 'TOOL';
    return `${role}: ${c.text}`;
  });
  const joined = lines.join('\n');
  return joined.length <= maxBytes
    ? joined
    : joined.slice(joined.length - maxBytes);
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
    let transcript = buildTranscript(
      opts.db,
      row,
      chunkLimit,
      maxTranscriptBytes,
    );
    let source: 'chunks' | 'jsonl-fallback' = 'chunks';
    if (transcript.length === 0) {
      /* Chunkless brainstorm: read directly from the lex_transcript_ref
       * jsonl files. Closes the gap that left sessions which ended
       * before brainstorm_chunks landed (or before chunk writes had a
       * chance to flush) un-distillable forever. */
      transcript = readTranscriptFromJsonlRefs(opts.db, row.id, {
        maxBytes: maxTranscriptBytes,
        log,
      });
      if (transcript.length === 0) {
        log(
          `[distill-gen] no chunks and no jsonl-refs for ${row.id.slice(0, 8)}`,
        );
        return null;
      }
      source = 'jsonl-fallback';
      log(
        `[distill-gen] using jsonl-fallback for ${row.id.slice(0, 8)} (chunkless)`,
      );
    }
    void source;
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

/* Headless pass timeout (2026-07-17). The old 60s default killed
 * essentially every real pass on this box: a trivial `claude -p` takes
 * ~26s, a realistic 8KB distillation prompt ~57s, and real transcripts
 * with full structured replies run past 60s. Result: 12+ hours of
 * "[distill-headless] empty reply" lines (dozens of attempts, zero
 * successes) that were all silent timeouts. 180s gives generation 3x
 * the observed floor; env-overridable without a rebuild. */
export const HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT = Number(
  process.env.DEVNEURAL_DISTILL_TIMEOUT_MS ?? 180_000,
);

export interface CreateHeadlessGeneratorOptions {
  db: IndexDb;
  log?: (msg: string) => void;
  /** Cap the bytes of transcript shipped to the engine. Default 8000,
   * matching the ollama path so the swap is content-equivalent. */
  maxTranscriptBytes?: number;
  /** Cap the chunks pulled per brainstorm. Default 50. */
  chunkLimit?: number;
  /** cwd the `claude -p` pass runs in. Default process.cwd(). Kept
   * neutral by default so a project CLAUDE.md does not bias the
   * summary; pass a project dir only when that context is wanted. */
  cwd?: string;
  /** Headless pass timeout. Default HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT. */
  timeoutMs?: number;
  /** Test seam; prod uses spawnHeadlessOpus. */
  spawnHeadless?: SpawnHeadlessOpus;
}

/* Headless Opus distillation generator (sliver 2b).
 *
 * Same DistillationGenerator shape + same SYSTEM_BLOCK prompt as
 * createLlmDistillationGenerator, but runs the summary through the
 * shared headless `claude -p` engine (spawnHeadlessOpus) instead of
 * provider.call(). This is the Hole-4 unification: distill becomes one
 * job on the investigator's engine, so there is ONE writer on the
 * staleness signal, not an ollama writer split from the Opus reader.
 *
 * BF-4: NO anthropic gate here. The headless pass is the user's own
 * `claude` CLI subprocess on their own auth, NOT a daemon
 * provider.call(), so brainstorm content never leaves the host via an
 * automated off-host API call. (Contrast createLlmDistillationGenerator,
 * which must block the anthropic provider.)
 *
 * Fail-safe by contract: returns null on no transcript, spawn failure,
 * timeout, or empty reply - the backfill buckets that exactly like the
 * ollama path so selection/stamping logic is unchanged. */
export function createHeadlessDistillationGenerator(
  opts: CreateHeadlessGeneratorOptions,
): DistillationGenerator {
  const log = opts.log ?? (() => undefined);
  const maxTranscriptBytes = opts.maxTranscriptBytes ?? 8000;
  const chunkLimit = opts.chunkLimit ?? 50;
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT;
  const spawnHeadless = opts.spawnHeadless ?? spawnHeadlessOpus;
  return async (row: BrainstormSessionRow): Promise<string | null> => {
    let transcript = buildTranscript(
      opts.db,
      row,
      chunkLimit,
      maxTranscriptBytes,
    );
    if (transcript.length === 0) {
      /* Chunkless brainstorm: same jsonl fallback as the ollama path. */
      transcript = readTranscriptFromJsonlRefs(opts.db, row.id, {
        maxBytes: maxTranscriptBytes,
        log,
      });
      if (transcript.length === 0) {
        log(
          `[distill-headless] no chunks and no jsonl-refs for ${row.id.slice(0, 8)}`,
        );
        return null;
      }
      log(
        `[distill-headless] using jsonl-fallback for ${row.id.slice(0, 8)} (chunkless)`,
      );
    }
    const prompt = `${SYSTEM_BLOCK.text}\n\n--- TRANSCRIPT ---\n${transcript}`;
    let raw: string | null;
    try {
      raw = await spawnHeadless(prompt, cwd, timeoutMs, (line) =>
        log(`[distill-headless] ${row.id.slice(0, 8)}: ${line}`),
      );
    } catch (err) {
      log(
        `[distill-headless] spawn failed for ${row.id.slice(0, 8)}: ${(err as Error).message}`,
      );
      return null;
    }
    if (!raw || !raw.trim()) {
      log(`[distill-headless] empty reply for ${row.id.slice(0, 8)}; skip`);
      return null;
    }
    /* Same cleanup as the ollama path: strip stray wrapping quotes and
     * any fence the prompt told it not to emit. */
    return raw
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^```\w*\n?|```$/g, '')
      .trim();
  };
}

/* Stage 2 of LEX-AUTONOMY-PAYLOAD-SPEC. Per-CC-session system block.
 * Distinct artifact from the anchor-flat rolling aggregate: this
 * summary describes ONE Lex/CC session, with full awareness that
 * other sessions on the same anchor exist and that the rolling
 * aggregate is composed downstream from N of these per-session
 * artifacts. Wording emphasises self-containment, single-session
 * vocabulary, and ends with a "session boundary" marker that the
 * rolling aggregate's separator pass can lean on. */
export const PER_SESSION_SYSTEM_BLOCK = {
  text:
    'Summarize ONE Claude Code session of an ongoing Lex brainstorm ' +
    'so a downstream rolling aggregate can stitch this with other ' +
    'per-session summaries from the same anchor. This artifact is ' +
    'about THIS session only - do not generalise to the anchor, do ' +
    'not reference earlier sessions, do not pre-empt the aggregate. ' +
    'The user is a brainstormer-first; their work must never decay ' +
    'to lossy one-liners. Output structured Markdown with the ' +
    "following bolded sections in this order, each on its own line:\n\n" +
    '**Session topic**: one sentence on what THIS session worked on.\n\n' +
    '**Threads**: 2-5 bullets, the concrete threads this session ' +
    'kept circling back to. Be specific (named files, components, ' +
    'protocols), not generic.\n\n' +
    '**Decisions this session**: 2-5 bullets, concrete decisions ' +
    'made or commits landed DURING this session. Empty bullet ' +
    'allowed when no decisions were made; do not invent. Do not ' +
    'restate decisions from earlier sessions.\n\n' +
    '**Planted markers**: 1-3 bullets, forward-looking notes the ' +
    'user wanted to revisit later. Empty allowed.\n\n' +
    '**Open at session end**: 1-3 bullets, unresolved questions or ' +
    'blockers as of the moment this session closed. Empty allowed.\n\n' +
    '**Recent turns** (verbatim, last 5-10): each bullet is ' +
    "ROLE: <text>, trimmed to ~200 chars, in chronological order. " +
    'Use USER / LEX / TOOL.\n\n' +
    'Total target: two short paragraphs of structured content plus ' +
    'the recent-turns block. No fences, no preamble, no commentary ' +
    'about the summary itself. Skip pleasantries. Be specific.',
  cache: true,
};

export interface PerSessionGeneratorInput {
  brainstorm_id: string;
  cc_session_id: string;
  /** Total chunks the session produced (denominator for coverage_
   * score). Caller computes via countBrainstormChunksForSession so
   * the generator stays pure / does not duplicate the count query. */
  totalChunksInSession: number;
}

export interface PerSessionGeneratorOutput {
  summary: string;
  /** Provenance fields the caller writes onto lex_transcript_ref. */
  source_chunk_count: number;
  source_session_ids: string;
  coverage_score: number;
}

export type PerSessionDistillationGenerator = (
  input: PerSessionGeneratorInput,
) => Promise<PerSessionGeneratorOutput | null>;

export function createPerSessionDistillationGenerator(
  opts: CreateGeneratorOptions,
): PerSessionDistillationGenerator {
  const log = opts.log ?? (() => undefined);
  const maxTranscriptBytes = opts.maxTranscriptBytes ?? 8000;
  const maxTokens = opts.maxTokens ?? 600;
  const chunkLimit = opts.chunkLimit ?? 50;
  return async (input) => {
    const tag = `${input.brainstorm_id.slice(0, 8)}/${input.cc_session_id.slice(0, 8)}`;
    const provider = opts.provider ?? pickProvider();
    if (!provider) {
      log(`[per-session-distill] no provider; skip ${tag}`);
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'no_provider',
      });
      return null;
    }
    if (!provider.isConfigured()) {
      log(
        `[per-session-distill] provider ${provider.name} not configured; skip ${tag}`,
      );
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'provider_not_configured',
        detail: provider.name,
      });
      return null;
    }
    /* BF-4 mirror: brainstorm chunks never leave the host. */
    if (provider.name === 'anthropic') {
      log(
        `[per-session-distill] BF-4 skip ${tag}: anthropic provider blocked for brainstorm content`,
      );
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'bf4_anthropic_blocked',
      });
      return null;
    }
    /* Pull the newest chunkLimit chunks scoped to this CC session.
     * DESC fetch + reverse so the LLM sees them oldest-first; the
     * tail of a long session is what matters most for distillation
     * but the model still expects chronological prompt order. */
    const fetched = opts.db.listBrainstormChunksForSession(
      input.brainstorm_id,
      input.cc_session_id,
      chunkLimit,
      'desc',
    );
    if (fetched.length === 0) {
      /* Structured skip signal. NULL cc_session_id chunks land here
       * as well (since they would not match the scoped WHERE) but
       * the session-end pipeline only calls this generator with a
       * non-null cc_session_id; the explicit NULL-skip path lives
       * upstream so the structured log reason is unambiguous. */
      log(
        `[per-session-distill] no_session_scoped_chunks ${tag}; skip`,
      );
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'no_session_scoped_chunks',
      });
      return null;
    }
    const ordered = fetched.slice().reverse();
    const transcript = ordered
      .map((c) => {
        const role =
          c.role === 'lex' ? 'LEX' : c.role === 'user' ? 'USER' : 'TOOL';
        return `${role}: ${c.text}`;
      })
      .join('\n')
      .slice(0, maxTranscriptBytes);
    if (transcript.length === 0) {
      log(`[per-session-distill] empty_transcript ${tag}; skip`);
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'empty_transcript',
      });
      return null;
    }
    let text: string;
    try {
      const result = await provider.call('distillation', {
        systemBlocks: [PER_SESSION_SYSTEM_BLOCK],
        user: transcript,
        maxTokens,
        temperature: 0.2,
      });
      text = result.text
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/^```\w*\n?|```$/g, '')
        .trim();
    } catch (err) {
      log(
        `[per-session-distill] provider call failed for ${tag}: ${(err as Error).message}`,
      );
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'provider_threw',
        errorMessage: (err as Error).message,
      });
      return null;
    }
    if (!text) {
      log(`[per-session-distill] empty_llm_reply ${tag}; skip`);
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'empty_llm_reply',
      });
      return null;
    }
    /* coverage_score = chunks shipped to LLM / total chunks in
     * session. Total is the denominator the caller computed BEFORE
     * the prompt was built (cheap COUNT scoped to the same pair).
     * Guard against div-by-zero (shouldn't happen since fetched
     * .length > 0 implies total > 0, but be explicit) and clamp into
     * the [0,1] range the CHECK constraint enforces. */
    const denom = Math.max(input.totalChunksInSession, fetched.length);
    const coverage = denom > 0 ? Math.min(1, fetched.length / denom) : 0;
    return {
      summary: text,
      source_chunk_count: fetched.length,
      source_session_ids: JSON.stringify([input.cc_session_id]),
      coverage_score: Math.max(0, coverage),
    };
  };
}

export interface CreateHeadlessPerSessionGeneratorOptions {
  db: IndexDb;
  log?: (msg: string) => void;
  maxTranscriptBytes?: number;
  chunkLimit?: number;
  /** cwd the `claude -p` pass runs in. Default process.cwd(). */
  cwd?: string;
  /** Headless pass timeout. Default HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT. */
  timeoutMs?: number;
  /** Test seam; prod uses spawnHeadlessOpus. */
  spawnHeadless?: SpawnHeadlessOpus;
}

/* Headless Opus per-session distillation generator (sliver A: route the
 * session-end context distill onto the shared engine).
 *
 * Same PerSessionGeneratorOutput shape + same PER_SESSION_SYSTEM_BLOCK
 * prompt + same provenance + same structured skip-logging as
 * createPerSessionDistillationGenerator, but runs through the shared
 * headless `claude -p` engine instead of provider.call(). BF-4 exempt
 * (own-auth subprocess, not an off-host API call), so no anthropic gate.
 * Fail-safe: returns null on no scoped chunks, spawn failure, or empty
 * reply, exactly like the ollama path, so session-end's "leave the prior
 * ref_summary in place" fallback is unchanged. */
export function createHeadlessPerSessionDistillationGenerator(
  opts: CreateHeadlessPerSessionGeneratorOptions,
): PerSessionDistillationGenerator {
  const log = opts.log ?? (() => undefined);
  const maxTranscriptBytes = opts.maxTranscriptBytes ?? 8000;
  const chunkLimit = opts.chunkLimit ?? 50;
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? HEADLESS_DISTILL_TIMEOUT_MS_DEFAULT;
  const spawnHeadless = opts.spawnHeadless ?? spawnHeadlessOpus;
  return async (input) => {
    const tag = `${input.brainstorm_id.slice(0, 8)}/${input.cc_session_id.slice(0, 8)}`;
    const fetched = opts.db.listBrainstormChunksForSession(
      input.brainstorm_id,
      input.cc_session_id,
      chunkLimit,
      'desc',
    );
    if (fetched.length === 0) {
      log(`[per-session-headless] no_session_scoped_chunks ${tag}; skip`);
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'no_session_scoped_chunks',
      });
      return null;
    }
    const ordered = fetched.slice().reverse();
    const transcript = ordered
      .map((c) => {
        const role =
          c.role === 'lex' ? 'LEX' : c.role === 'user' ? 'USER' : 'TOOL';
        return `${role}: ${c.text}`;
      })
      .join('\n')
      .slice(0, maxTranscriptBytes);
    if (transcript.length === 0) {
      log(`[per-session-headless] empty_transcript ${tag}; skip`);
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'empty_transcript',
      });
      return null;
    }
    const prompt = `${PER_SESSION_SYSTEM_BLOCK.text}\n\n--- TRANSCRIPT ---\n${transcript}`;
    let raw: string | null;
    try {
      raw = await spawnHeadless(prompt, cwd, timeoutMs, (line) =>
        log(`[per-session-headless] ${tag}: ${line}`),
      );
    } catch (err) {
      log(
        `[per-session-headless] spawn failed ${tag}: ${(err as Error).message}`,
      );
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'provider_threw',
        errorMessage: (err as Error).message,
      });
      return null;
    }
    const text = (raw ?? '')
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^```\w*\n?|```$/g, '')
      .trim();
    if (!text) {
      log(`[per-session-headless] empty_llm_reply ${tag}; skip`);
      logDistillationOutcome(opts.db, {
        brainstormId: input.brainstorm_id,
        ccSessionId: input.cc_session_id,
        generator: 'per-session',
        errorClass: 'empty_llm_reply',
      });
      return null;
    }
    const denom = Math.max(input.totalChunksInSession, fetched.length);
    const coverage = denom > 0 ? Math.min(1, fetched.length / denom) : 0;
    return {
      summary: text,
      source_chunk_count: fetched.length,
      source_session_ids: JSON.stringify([input.cc_session_id]),
      coverage_score: Math.max(0, coverage),
    };
  };
}

/* Engine selection (sliver A). One switch, read once per caller, so
 * every distillation writer - backfill scheduler, session-end pipeline,
 * cold-start preload - agrees on the engine. DEVNEURAL_DISTILL_HEADLESS
 * =1 routes through the shared headless Opus engine (BF-4 exempt);
 * default OFF keeps the ollama provider path as the steady state until
 * the live engine-swap verify lands. */
export function useHeadlessDistillEngine(): boolean {
  return process.env.DEVNEURAL_DISTILL_HEADLESS === '1';
}

export interface SelectGeneratorOptions {
  db: IndexDb;
  log?: (msg: string) => void;
  /** Test seam for the headless engine. */
  spawnHeadless?: SpawnHeadlessOpus;
  /** Test seam for the ollama path. */
  provider?: LlmProvider | null;
}

export function selectAnchorFlatGenerator(
  opts: SelectGeneratorOptions,
): DistillationGenerator {
  if (useHeadlessDistillEngine()) {
    return createHeadlessDistillationGenerator({
      db: opts.db,
      ...(opts.log ? { log: opts.log } : {}),
      ...(opts.spawnHeadless ? { spawnHeadless: opts.spawnHeadless } : {}),
    });
  }
  return createLlmDistillationGenerator({
    db: opts.db,
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
  });
}

export function selectPerSessionGenerator(
  opts: SelectGeneratorOptions,
): PerSessionDistillationGenerator {
  if (useHeadlessDistillEngine()) {
    return createHeadlessPerSessionDistillationGenerator({
      db: opts.db,
      ...(opts.log ? { log: opts.log } : {}),
      ...(opts.spawnHeadless ? { spawnHeadless: opts.spawnHeadless } : {}),
    });
  }
  return createPerSessionDistillationGenerator({
    db: opts.db,
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
  });
}
