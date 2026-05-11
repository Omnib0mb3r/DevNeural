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
} from './system-prompt.js';

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
}

export interface BuildLexSpawnPromptResult extends BuildLexSystemPromptResult {
  variant: LexSpawnVariant;
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
  });
  const paths = opts.transcriptPaths ?? [];
  const variant: LexSpawnVariant = paths.length === 0 ? 'new' : 'reopen';
  const header =
    variant === 'new'
      ? NEW_HEADER(opts.lexSessionId)
      : REOPEN_HEADER(opts.lexSessionId, paths);
  return {
    prompt: `${base.prompt}\n\n${header}`,
    version: base.version,
    mode: base.mode,
    variant,
  };
}
