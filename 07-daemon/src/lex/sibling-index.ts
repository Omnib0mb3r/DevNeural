/**
 * Sibling index for Lex spawn / reopen prompts.
 *
 * When the user names a Lex session ("Smart Compact rollout",
 * "DevNeural Testing"), other sessions that share the same label are
 * almost certainly related work the user wants Lex to know about at
 * spawn time. This module builds a tiny markdown block listing those
 * siblings: one short line per sibling with the id prefix, label,
 * started ISO timestamp, and an optional 10-word distillation pulled
 * from last_summary.
 *
 * No retrieval, no transcript reads. The block is meant to live near
 * the snapshot layer in the system prompt and stay under ~10 lines so
 * Lex's context budget is not affected.
 *
 * Single-file helper by design; spawn-lex-session is the only
 * consumer.
 */
import type {
  BrainstormSessionRow,
  IndexDb,
} from '../store/index-db.js';

export interface BuildSiblingIndexOptions {
  db: IndexDb;
  /** The new session's user_label. Comparison is case-insensitive
   * and ignores leading/trailing whitespace. Empty strings short-
   * circuit to an empty block (no label = no siblings to surface). */
  label: string | null | undefined;
  /** Exclude the just-created session so it does not list itself.
   * The caller passes the new lex_session id; the row may not yet
   * exist in brainstorm_sessions, but the guard is cheap. */
  excludeId?: string | null;
  /** Maximum sibling rows. Default 8. The block is meant to be
   * tiny; runaway labels are capped here. */
  limit?: number;
  /** Distillation word cap. Default 10. */
  distillationWords?: number;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_DISTILLATION_WORDS = 10;

function normLabel(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function truncateWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return words.slice(0, max).join(' ') + '...';
}

function formatLine(
  row: BrainstormSessionRow,
  distillationWords: number,
): string {
  const idShort = row.id.slice(0, 8);
  const label = row.user_label?.trim() || row.derived_label?.trim() || '(unnamed)';
  const startedIso = new Date(row.started_ms).toISOString();
  const distillation = row.last_summary
    ? truncateWords(row.last_summary, distillationWords)
    : '';
  const tail = distillation ? ` — ${distillation}` : '';
  return `- ${idShort} "${label}" started ${startedIso}${tail}`;
}

export function buildSiblingIndex(opts: BuildSiblingIndexOptions): string {
  const target = normLabel(opts.label);
  if (!target) return '';
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const distillationWords =
    opts.distillationWords ?? DEFAULT_DISTILLATION_WORDS;
  /* listBrainstorms returns DESC by started_ms; over-fetch a bit so
   * we can filter by label client-side and still respect limit. The
   * label space is small; an indexed query is not worth the
   * migration. */
  const rows = opts.db.listBrainstorms({ limit: 200 });
  const exclude = opts.excludeId ?? null;
  const matches = rows.filter((r) => {
    if (exclude && r.id === exclude) return false;
    return normLabel(r.user_label) === target;
  });
  if (matches.length === 0) return '';
  const capped = matches.slice(0, limit);
  const lines = capped.map((r) => formatLine(r, distillationWords));
  return [
    `# Sibling sessions (same label "${opts.label?.trim() ?? ''}")`,
    '',
    'Prior brainstorms the user named the same way. Reference if context demands; do not re-read the transcripts unless asked.',
    '',
    ...lines,
  ].join('\n');
}
