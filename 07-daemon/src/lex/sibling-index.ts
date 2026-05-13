/**
 * Sibling index for Lex spawn / cold-start preload prompts.
 *
 * Primary path (TODO.md bug 2026-05-13): anchor transcript_refs.
 * Each Lex restart re-binds the SAME brainstorm/lex_session row and
 * appends another lex_transcript_ref pointing at the new CC jsonl.
 * Prior conversation history therefore lives across N ordered refs
 * under one anchor, not across N sibling brainstorm_sessions rows
 * sharing a user_label. The previous label-match heuristic always
 * returned 0 for an anchor with one row.
 *
 * Resolution order:
 *   1. listLexTranscriptRefs(anchorId), filter ordering < current,
 *      take the last 2 by ordering DESC. For each prior ref, read
 *      its transcript_path jsonl and extract up to 5 user/assistant
 *      message pairs; render as a 'Prior session N' block with the
 *      brainstorm's last_summary (or '(no distillation yet)') and
 *      the trimmed turn list.
 *   2. Fallback to label-match only when the anchor has 0 prior
 *      refs. Preserves the original behaviour for fresh anchors that
 *      have not built any history yet.
 *
 * Pure module: filesystem read + clock are injected so tests can
 * drive both paths without touching ~/.claude/projects/.
 */
import * as fs from 'node:fs';
import type {
  BrainstormSessionRow,
  IndexDb,
  LexTranscriptRefRow,
} from '../store/index-db.js';

export interface BuildSiblingIndexOptions {
  db: IndexDb;
  /** Label for the legacy fallback path. Case-insensitive, trimmed. */
  label: string | null | undefined;
  /** Brainstorm/lex_session id of the just-bound session. Primary
   * resolution key; when supplied, listLexTranscriptRefs drives the
   * block. Also used to exclude the row from the label-match
   * fallback. */
  anchorId?: string | null;
  /** Newly-bound CC session UUID. Excluded from the prior-refs list
   * so the active session never tries to summarise itself. */
  currentCcSessionId?: string | null;
  /** Optional explicit excludeId for the fallback path. Defaults
   * to anchorId. */
  excludeId?: string | null;
  /** Max prior refs to render (default 2). */
  refLimit?: number;
  /** Max sibling rows for the label-match fallback (default 8). */
  limit?: number;
  /** Distillation word cap for the fallback label-match render. */
  distillationWords?: number;
  /** Max char budget per rendered turn snippet. */
  turnSnippetChars?: number;
  /** Max pairs per prior ref (default 5). */
  pairsPerRef?: number;
  /** Test seam: filesystem read for transcript_path jsonls. */
  readTranscript?: (path: string) => string | null;
  /** Test seam: clock. */
  now?: () => number;
}

const DEFAULT_REF_LIMIT = 2;
const DEFAULT_LIMIT = 8;
const DEFAULT_DISTILLATION_WORDS = 10;
const DEFAULT_TURN_SNIPPET_CHARS = 400;
const DEFAULT_PAIRS_PER_REF = 5;

function normLabel(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function truncateWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return words.slice(0, max).join(' ') + '...';
}

function trimSnippet(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max) + '...';
}

function formatHoursAgo(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  const h = delta / 3_600_000;
  if (h < 1) {
    const m = Math.max(1, Math.round(delta / 60_000));
    return `${m}m ago`;
  }
  if (h < 48) return `${Math.round(h)}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

interface ExtractedTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Walk a CC jsonl, extract user/assistant text turns in chronological
 * order, and return the last `2 * pairs` (one user + one assistant per
 * pair). Tool_use / tool_result blocks are skipped — they bloat the
 * cold-start block without helping Lex recall the conversation. A
 * compaction summary masquerading as a user turn is also skipped.
 */
export function extractLastTurnPairs(
  jsonlText: string,
  pairs: number,
): ExtractedTurn[] {
  const turns: ExtractedTurn[] = [];
  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: {
      type?: string;
      message?: {
        role?: string;
        content?:
          | string
          | Array<{ type?: string; text?: string }>;
      };
      isCompactSummary?: boolean;
    };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.isCompactSummary) continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const role: 'user' | 'assistant' = entry.type;
    const content = entry.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          text += (text ? '\n' : '') + part.text;
        }
      }
    }
    text = text.trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  const want = Math.max(0, pairs) * 2;
  return turns.slice(-want);
}

function defaultRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function renderPriorRefSection(args: {
  ref: LexTranscriptRefRow;
  index: number;
  total: number;
  brainstorm: BrainstormSessionRow | null;
  jsonlText: string | null;
  pairsPerRef: number;
  turnSnippetChars: number;
  now: number;
}): string | null {
  const { ref, index, total, brainstorm, jsonlText } = args;
  const turns = jsonlText
    ? extractLastTurnPairs(jsonlText, args.pairsPerRef)
    : [];
  if (turns.length === 0 && !brainstorm?.last_summary) {
    /* Nothing to surface for this ref; skip rather than render an
     * empty header that wastes context. */
    return null;
  }
  const stampMs = ref.ended_ms ?? ref.started_ms;
  const ago = formatHoursAgo(stampMs, args.now);
  /* Number prior sessions oldest-first inside the block even though
   * we feed them newest-first to the renderer, so the human-readable
   * sequence reads "session 1 (older), session 2 (newer)". */
  const seq = total - index;
  const distillation =
    brainstorm?.last_summary && brainstorm.last_summary.trim().length > 0
      ? brainstorm.last_summary.trim()
      : '(no distillation yet)';
  const lines: string[] = [
    `## Prior session ${seq} (ago: ${ago})`,
    `Summary: ${distillation}`,
  ];
  if (turns.length > 0) {
    lines.push('Last 5 turns:');
    for (const t of turns) {
      lines.push(`- ${t.role}: ${trimSnippet(t.text, args.turnSnippetChars)}`);
    }
  }
  return lines.join('\n');
}

function buildAnchorTranscriptBlock(opts: BuildSiblingIndexOptions): string {
  if (!opts.anchorId) return '';
  const refLimit = opts.refLimit ?? DEFAULT_REF_LIMIT;
  const pairsPerRef = opts.pairsPerRef ?? DEFAULT_PAIRS_PER_REF;
  const turnSnippetChars =
    opts.turnSnippetChars ?? DEFAULT_TURN_SNIPPET_CHARS;
  const now = (opts.now ?? Date.now)();
  const read = opts.readTranscript ?? defaultRead;
  const allRefs = opts.db.listLexTranscriptRefs(opts.anchorId);
  if (allRefs.length === 0) return '';
  const currentCc = opts.currentCcSessionId ?? null;
  const prior = allRefs
    .filter((r) => !currentCc || r.cc_session_id !== currentCc)
    .sort((a, b) => b.ordering - a.ordering)
    .slice(0, refLimit);
  if (prior.length === 0) return '';
  const brainstorm = opts.db.getBrainstorm(opts.anchorId);
  const total = prior.length;
  const sections: string[] = [];
  for (let i = 0; i < prior.length; i++) {
    const ref = prior[i]!;
    const jsonlText = read(ref.transcript_path);
    const section = renderPriorRefSection({
      ref,
      index: i,
      total,
      brainstorm,
      jsonlText,
      pairsPerRef,
      turnSnippetChars,
      now,
    });
    if (section) sections.push(section);
  }
  if (sections.length === 0) return '';
  const header = [
    '# Prior Lex sessions on this anchor',
    '',
    'Earlier CC sessions bound to this same Lex brainstorm. Reference if context demands; do not re-read the transcripts unless asked.',
    '',
  ].join('\n');
  return header + sections.join('\n\n');
}

function formatLabelLine(
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

function buildLabelMatchBlock(opts: BuildSiblingIndexOptions): string {
  const target = normLabel(opts.label);
  if (!target) return '';
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const distillationWords =
    opts.distillationWords ?? DEFAULT_DISTILLATION_WORDS;
  const rows = opts.db.listBrainstorms({ limit: 200 });
  const exclude = opts.excludeId ?? opts.anchorId ?? null;
  const matches = rows.filter((r) => {
    if (exclude && r.id === exclude) return false;
    return normLabel(r.user_label) === target;
  });
  if (matches.length === 0) return '';
  const capped = matches.slice(0, limit);
  const lines = capped.map((r) => formatLabelLine(r, distillationWords));
  return [
    `# Sibling sessions (same label "${opts.label?.trim() ?? ''}")`,
    '',
    'Prior brainstorms the user named the same way. Reference if context demands; do not re-read the transcripts unless asked.',
    '',
    ...lines,
  ].join('\n');
}

export function buildSiblingIndex(opts: BuildSiblingIndexOptions): string {
  if (opts.anchorId) {
    const fromRefs = buildAnchorTranscriptBlock(opts);
    if (fromRefs) return fromRefs;
  }
  return buildLabelMatchBlock(opts);
}
