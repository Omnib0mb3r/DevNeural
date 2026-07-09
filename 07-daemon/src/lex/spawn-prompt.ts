/**
 * Lex spawn prompt composer (PLAN-lex-session-rewrite.md, step 3).
 *
 * Wraps buildLexSystemPromptVersioned with a per-spawn "session
 * header" block that tells Lex which lex_session he is and either:
 *
 *   - new variant: "session one, no prior context"
 *   - reopen variant: ordered list of transcript jsonl paths +
 *     a catch-up protocol that REQUIRES Lex to Read every file in
 *     order, lossless, then announce "caught up" before doing
 *     anything else
 *
 * Returns the composed prompt + the base version hash. The session
 * header itself is NOT folded into the version hash because the
 * transcript path list and lex_session_id are runtime detail; the
 * version represents the prompt template, not the per-spawn
 * substitutions.
 */
import {
  buildLexSystemPromptVersioned,
  type BuildLexSystemPromptResult,
  type LexPromptWorkerScope,
} from './system-prompt.js';
import {
  loadFeedbackMemories,
  renderFeedbackMemoriesBlock,
  type LoadFeedbackMemoriesResult,
} from './feedback-memories.js';

export type LexSpawnVariant = 'new' | 'reopen';

export interface BuildLexSpawnPromptOptions {
  lexSessionId: string;
  /** Ordered list of absolute jsonl paths from previous CC sessions
   * under this anchor. Empty (or omitted) selects the new variant.
   * The catch-up protocol Reads them in this exact order. */
  transcriptPaths?: string[];
  /** Forwarded to buildLexSystemPromptVersioned. Defaults to
   * 'conversation' (same default as the legacy spawn path). */
  mode?: 'conversation' | 'push-to-talk' | 'notes';
  /** Forwarded to buildLexSystemPromptVersioned. Default true; set
   * false from test harnesses so the prompt archive stays clean. */
  archive?: boolean;
  /** Brainstorm CWD. When supplied, `<cwd>/memory/*.md` with
   * frontmatter `type: feedback` is loaded and rendered into a
   * "Hard rules from operator" section appended to the system
   * prompt. Strictly scoped to this anchor's CWD; never crosses
   * brainstorms. Omitted = no hard rules block (back-compat for
   * call sites that have not threaded the cwd through yet). */
  cwd?: string;
  /** Worker scope (2026-07-08). Forwarded to
   * buildLexSystemPromptVersioned so the spawn prompt carries the
   * scope-locked snapshot + hard scope contract. Omitted = legacy
   * global snapshot. */
  scope?: LexPromptWorkerScope | null;
}

export interface BuildLexSpawnPromptResult extends BuildLexSystemPromptResult {
  variant: LexSpawnVariant;
  /** Feedback-memories loader output, surfaced for the audit-log
   * row caller. Always populated, even when no rules are loaded,
   * so the audit row can record status='no-memory-dir'. */
  feedback_memories: LoadFeedbackMemoriesResult;
}

const NEW_HEADER = (lexSessionId: string): string =>
  `# Session

You are starting a fresh brainstorm.

- lex_session_id: ${lexSessionId}
- transcripts loaded: 0
- prior context: none

This is session one. Greet briefly in your normal voice, then ask
what we are working on today.`;

const REOPEN_HEADER = (
  lexSessionId: string,
  paths: string[],
): string => {
  const numbered = paths
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');
  return `# Session

You are continuing brainstorm ${lexSessionId}.

Prior transcripts (read in order, lossless):
${numbered}

## Catch-up protocol

You MUST run this catch-up sequence on launch BEFORE doing anything
else, BEFORE responding to any user prompt that arrives in the
meantime, and BEFORE any tool call that is not a Read of one of the
transcripts above.

1. Speak verbatim, single short line: "catching up, give me a moment."
2. Use the Read tool on EVERY transcript in the list above, in
   order, top to bottom. Read each file in full. Do not skip lines.
   Do not summarise as you go. Do not stop early. The point is to
   load every prior turn back into your working context so the
   reopened brainstorm resumes losslessly.
3. After the LAST file is read, speak verbatim, single short line:
   "caught up, what are we working on, sir."

Do not introduce yourself; you are continuing. Do not re-narrate
the prior conversation; just absorb it. The user can see the same
transcripts; do not echo them back.`;
};

export function buildLexSpawnPrompt(
  opts: BuildLexSpawnPromptOptions,
): BuildLexSpawnPromptResult {
  const base = buildLexSystemPromptVersioned({
    mode: opts.mode,
    archive: opts.archive,
    scope: opts.scope,
  });
  const paths = opts.transcriptPaths ?? [];
  const variant: LexSpawnVariant = paths.length === 0 ? 'new' : 'reopen';
  const header =
    variant === 'new'
      ? NEW_HEADER(opts.lexSessionId)
      : REOPEN_HEADER(opts.lexSessionId, paths);
  /* Bake feedback-class operator rules into the prompt as a hard
   * rules block. Loader is best-effort: a missing memory directory
   * is the common case (most brainstorms have none) and is treated
   * as status='no-memory-dir' so the audit row still records the
   * non-event. */
  const feedback_memories = opts.cwd
    ? loadFeedbackMemories(opts.cwd)
    : { kept: [], dropped: [], status: 'no-memory-dir' as const };
  const hardRulesBlock = renderFeedbackMemoriesBlock(feedback_memories);
  const parts: string[] = [base.prompt, header];
  if (hardRulesBlock) parts.push(hardRulesBlock);
  return {
    prompt: parts.join('\n\n'),
    version: base.version,
    mode: base.mode,
    variant,
    feedback_memories,
  };
}
