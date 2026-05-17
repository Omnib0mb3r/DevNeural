/**
 * Feedback-memory loader.
 *
 * Reads the brainstorm CWD's `memory/` directory at Lex session
 * start, parses each `.md` file's frontmatter, keeps the entries
 * with `type: feedback`, and assembles them into a "Hard rules from
 * operator" block the spawn-prompt composer appends to Lex's system
 * prompt.
 *
 * Today Lex reads memory files as soft context via the cold-start
 * preload. That is best-effort: Lex can drift over a long session.
 * Feedback-class memories are hard rules the operator has accumulated
 * about how Lex should behave; they must be enforced, not suggested.
 * Baking them into the system prompt promotes them from "you have
 * memories here, go read them" to "these rules are non-negotiable".
 *
 * Scope strictly to the supplied cwd's `memory/` directory; the
 * caller (spawn-prompt) supplies the brainstorm anchor's CWD so two
 * brainstorms never cross-pollinate each other's hard rules. Other
 * memory types (user, project, reference) stay soft and are pulled
 * on demand by Lex's read tool; those are out of scope for this
 * module.
 *
 * Default cap: MAX_RULES rules baked into the prompt. If the
 * directory holds more, sort by mtime descending so the freshest
 * rules win and log a warning so the operator can audit the
 * truncation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Frontmatter shape we care about. Other keys (description, etc.)
 * are tolerated and ignored. */
export interface FeedbackMemoryFrontmatter {
  type?: string;
  name?: string;
  description?: string;
}

export interface FeedbackMemoryFile {
  /** Absolute path to the `.md` source on disk. */
  path: string;
  /** Filename without the .md extension; used as the rule's title
   * when frontmatter `name` is absent. */
  filename: string;
  /** Frontmatter `name` override, when present. */
  title: string;
  /** Body of the markdown file with frontmatter stripped. */
  body: string;
  /** Last-modified time of the file in ms since epoch. Used to
   * order entries when the directory holds more than the cap. */
  mtime_ms: number;
}

export interface LoadFeedbackMemoriesResult {
  /** The kept rules in render order (freshest mtime first, capped to
   * cap). */
  kept: FeedbackMemoryFile[];
  /** The dropped rules (over-cap entries). Surfaced so the audit
   * log can record what was truncated. */
  dropped: FeedbackMemoryFile[];
  /** Reason / status indicator. 'ok' on a happy path,
   * 'no-memory-dir' when the directory is absent (not an error),
   * 'over-cap' when truncation happened. */
  status: 'ok' | 'no-memory-dir' | 'over-cap';
}

export const DEFAULT_FEEDBACK_RULE_CAP = 30;

export interface LoadFeedbackMemoriesOptions {
  /** Cap to apply. Defaults to DEFAULT_FEEDBACK_RULE_CAP. */
  cap?: number;
  /** Test seam for fs.existsSync. */
  existsSync?: (p: string) => boolean;
  /** Test seam for fs.readdirSync. */
  readdirSync?: (p: string) => string[];
  /** Test seam for fs.statSync. */
  statSync?: (p: string) => { mtimeMs: number };
  /** Test seam for fs.readFileSync. */
  readFileSync?: (p: string, enc: 'utf-8') => string;
}

/* Permissive frontmatter parser. Splits on the standard --- delimiters
 * and reads `key: value` lines. Values are not deeply parsed (no
 * nested lists / objects); the feedback-memory frontmatter is flat.
 * Returns the parsed map plus the body string after the closing
 * --- delimiter. */
function parseFrontmatter(
  raw: string,
): { fm: FeedbackMemoryFrontmatter; body: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(raw);
  if (!match) {
    return { fm: {}, body: raw };
  }
  const block = match[1] ?? '';
  const body = raw.slice(match[0].length);
  const fm: FeedbackMemoryFrontmatter = {};
  for (const line of block.split('\n')) {
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1] as keyof FeedbackMemoryFrontmatter;
    let value: string = m[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return { fm, body };
}

export function loadFeedbackMemories(
  cwd: string,
  opts: LoadFeedbackMemoriesOptions = {},
): LoadFeedbackMemoriesResult {
  const cap = opts.cap ?? DEFAULT_FEEDBACK_RULE_CAP;
  const existsSync = opts.existsSync ?? fs.existsSync;
  const readdirSync = opts.readdirSync ?? ((p: string) => fs.readdirSync(p));
  const statSync =
    opts.statSync ?? ((p: string) => ({ mtimeMs: fs.statSync(p).mtimeMs }));
  const readFileSync =
    opts.readFileSync ??
    ((p: string, enc: 'utf-8') => fs.readFileSync(p, enc));

  if (!cwd) {
    return { kept: [], dropped: [], status: 'no-memory-dir' };
  }
  const memoryDir = path.posix.join(cwd.replace(/\\/g, '/'), 'memory');
  if (!existsSync(memoryDir)) {
    return { kept: [], dropped: [], status: 'no-memory-dir' };
  }

  let names: string[];
  try {
    names = readdirSync(memoryDir);
  } catch {
    return { kept: [], dropped: [], status: 'no-memory-dir' };
  }
  const all: FeedbackMemoryFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const filepath = path.posix.join(memoryDir, name);
    let raw: string;
    try {
      raw = readFileSync(filepath, 'utf-8');
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    if ((fm.type ?? '').trim().toLowerCase() !== 'feedback') continue;
    let mtime_ms = 0;
    try {
      mtime_ms = statSync(filepath).mtimeMs;
    } catch {
      mtime_ms = 0;
    }
    all.push({
      path: filepath,
      filename: name.replace(/\.md$/, ''),
      title: (fm.name ?? '').trim() || name.replace(/\.md$/, ''),
      body: body.trim(),
      mtime_ms,
    });
  }

  /* Sort by mtime descending so the freshest rules win when we have
   * to truncate. */
  all.sort((a, b) => b.mtime_ms - a.mtime_ms);
  if (all.length <= cap) {
    return { kept: all, dropped: [], status: 'ok' };
  }
  return {
    kept: all.slice(0, cap),
    dropped: all.slice(cap),
    status: 'over-cap',
  };
}

/* Render the loaded feedback rules into a prompt-ready markdown
 * block. Each rule renders under a `### {title}` header so the rule
 * can be cited later by name. Returns an empty string when there
 * are no rules so the caller can append unconditionally without
 * producing a dangling section header. */
export function renderFeedbackMemoriesBlock(
  result: LoadFeedbackMemoriesResult,
): string {
  if (result.kept.length === 0) return '';
  const lines: string[] = [];
  lines.push('## Hard rules from operator');
  lines.push('');
  lines.push(
    'These are the durable rules the user has set for how you behave. They are NOT suggestions. Apply them on every turn, every tool call, every decision.',
  );
  for (const rule of result.kept) {
    lines.push('');
    lines.push(`### ${rule.title}`);
    lines.push('');
    lines.push(rule.body);
  }
  return lines.join('\n');
}
