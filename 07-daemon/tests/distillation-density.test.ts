/* Bug: cold-start preload surfaced reap-reason one-liners as sibling
 * distillations. Fix pins density at three layers:
 *
 *   - Generator: SYSTEM_BLOCK must request structured paragraphs that
 *     cover decisions, topics, and planted markers. maxTokens default
 *     must be high enough for a couple-paragraph reply (>= 600).
 *   - Generator wiring: a stub provider returning a rich distillation
 *     must round-trip through createLlmDistillationGenerator without
 *     truncation. Output stays > 400 chars and carries the structural
 *     tags the prompt asked for.
 *   - Injector: legacy rows that still hold a reap reason in
 *     last_summary must be treated as "no distillation yet" so they
 *     never bleed into the cold-start prompt.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  BrainstormChunkRow,
  BrainstormSessionRow,
  IndexDb,
} from '../src/store/index-db.js';
import type { LlmProvider } from '../src/llm/index.js';
import {
  createLlmDistillationGenerator,
  SYSTEM_BLOCK,
} from '../src/lex/distillation-generator.js';
import { looksLikeReapReason } from '../src/lex/sibling-index.js';

const RICH_DISTILLATION = `**Topic**: Rework the Lex cold-start preload so fresh sessions inherit real context instead of one-liner reap reasons.

**Active topics**:
- Distillation writer density (couple paragraphs over 3-4 lines).
- Reaper stomping last_summary with end-reason strings.
- Cold-start preamble counts vs. injected block parity.

**Key decisions**:
- Stop the reaper writing last_summary; that column belongs to the distillation pipeline.
- Crank distillation maxTokens to 600 so the structured block fits.
- Guard the injector against legacy reap-reason last_summary values.

**Planted markers**:
- Audit other writers that might overwrite last_summary unintentionally.

**Open**:
- Whether to backfill stomped rows on next boot or let them ride.

**Recent turns**:
- USER: cold-start sibling says "daemon restart, orphaned active session", that's useless.
- LEX: tracing the writer; reaper is overwriting the field.`;

function makeProviderStub(): LlmProvider {
  return {
    name: 'ollama',
    isConfigured: () => true,
    call: async () => ({
      text: RICH_DISTILLATION,
      raw: { stub: true },
    }),
  } as unknown as LlmProvider;
}

function makeDbStub(chunks: BrainstormChunkRow[]): IndexDb {
  return {
    listBrainstormChunks: () => chunks,
  } as unknown as IndexDb;
}

function makeRow(id: string): BrainstormSessionRow {
  return {
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: '/tmp/brainstorm',
    user_label: 'distillation-density',
    derived_label: null,
    mode: 'conversation',
    status: 'ended',
    started_ms: Date.now() - 60_000,
    ended_ms: Date.now() - 1000,
    turn_count: 3,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  } as unknown as BrainstormSessionRow;
}

describe('distillation generator density contract', () => {
  it('SYSTEM_BLOCK asks for decisions, topics, and planted markers', () => {
    const text = SYSTEM_BLOCK.text.toLowerCase();
    expect(text).toMatch(/decision/);
    expect(text).toMatch(/topic/);
    expect(text).toMatch(/marker/);
  });

  it('SYSTEM_BLOCK asks for verbatim recent turns', () => {
    expect(SYSTEM_BLOCK.text.toLowerCase()).toMatch(/recent turns/);
    expect(SYSTEM_BLOCK.text.toLowerCase()).toMatch(/verbatim/);
  });

  it('generator returns a rich body greater than 400 chars with structural tags', async () => {
    const chunks: BrainstormChunkRow[] = [
      {
        id: randomUUID(),
        brainstorm_id: 'b1',
        turn_index: 0,
        role: 'user',
        mode: 'conversation',
        text: 'one',
        model_id: 'opus',
        no_decay: 0,
        created_at: '2026-05-15T00:00:00Z',
      } as unknown as BrainstormChunkRow,
      {
        id: randomUUID(),
        brainstorm_id: 'b1',
        turn_index: 1,
        role: 'lex',
        mode: 'conversation',
        text: 'two',
        model_id: 'opus',
        no_decay: 0,
        created_at: '2026-05-15T00:00:01Z',
      } as unknown as BrainstormChunkRow,
    ];
    const generator = createLlmDistillationGenerator({
      db: makeDbStub(chunks),
      provider: makeProviderStub(),
    });
    const out = await generator(makeRow('b1'));
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(400);
    expect(out!).toMatch(/decision|topic|marker/i);
  });
});

describe('sibling-index reap-reason guard', () => {
  it('flags legacy reap-reason strings as not-a-distillation', () => {
    expect(looksLikeReapReason('daemon restart: orphaned active session')).toBe(true);
    expect(looksLikeReapReason('continuous reaper: pty no longer alive')).toBe(true);
    expect(looksLikeReapReason('pty no longer alive')).toBe(true);
    expect(looksLikeReapReason('orphaned active session: forced exit')).toBe(true);
  });

  it('lets real distillations through', () => {
    expect(looksLikeReapReason(RICH_DISTILLATION)).toBe(false);
    expect(looksLikeReapReason('**Topic**: anything substantive')).toBe(false);
    expect(looksLikeReapReason('')).toBe(false);
    expect(looksLikeReapReason(null)).toBe(false);
    expect(looksLikeReapReason(undefined)).toBe(false);
  });
});
