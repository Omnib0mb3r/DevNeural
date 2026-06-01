/**
 * TTS sanitizer (Fix 59, 2026-06-01).
 *
 * Belt-and-suspenders filter that runs on every string entering the
 * piper synth path. Lex's voice-mode contract already says "no full
 * paths, no markup chars, no UUIDs as numbers, no telemetry
 * shorthand", but that rule has leaked through despite memory
 * because it lives only in Lex's prompt + the operator's memory
 * file. The sanitizer enforces the rule server-side so a slip in
 * model output never reaches the speaker.
 *
 * Pure function. Idempotent (running twice over the same input
 * produces identical output). No I/O. Cost matters: this fires on
 * every Lex turn, often inside the speak controller's hot path.
 *
 * Rules applied in order:
 *   1. Filesystem paths -> basename
 *   2. URLs -> host only (or "the URL" when host extraction fails)
 *   3. Long hex IDs (UUIDs, SHAs) -> "opaque id"
 *   4. Angle-bracket / JSX / HTML markup -> stripped
 *   5. Whitespace collapse + trailing whitespace trim per line
 *
 * Each rule is conservative: borderline cases stay intact rather
 * than mangle natural speech. A short hash like "Fix 47" or a small
 * number stays as written; only id-shaped tokens longer than the
 * recognisable hex threshold get replaced.
 */

/* Windows drive-letter paths: C:/dev/Projects/x or D:\code\foo.ts.
 * Match the drive letter plus one separator plus one or more path
 * segments. No extension requirement so directory-only paths
 * ("C:/dev/Projects/DevNeural") are caught too. */
const WIN_PATH_PATTERN =
  /[A-Za-z]:[\\/](?:[^\s"'`,;:!?<>()\[\]{}]+[\\/])*[^\s"'`,;:!?<>()\[\]{}]+/g;

/* POSIX absolute paths with at least two segments after the leading
 * slash so we do not accidentally rewrite phrases that start with a
 * single slash ("/var" alone is rare in speech; longer paths like
 * /home/user/code/main.py are the target). */
const POSIX_PATH_PATTERN =
  /(?<=^|\s|\()\/(?:[^\s"'`,;:!?<>()\[\]{}\/]+\/)+[^\s"'`,;:!?<>()\[\]{}]+/g;

const URL_PATTERN = /https?:\/\/([^\s"'`<>]+)/g;

const HEX_ID_PATTERNS: readonly RegExp[] = [
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  /\b[0-9a-fA-F]{32,}\b/g,
];

const ANGLE_TAG_PATTERN = /<\/?[A-Za-z][^>]*>/g;

function basenameOf(p: string): string {
  if (typeof p !== 'string') return '';
  const cleaned = p.replace(/[\\/]+$/, '');
  const lastSlash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  if (lastSlash < 0) return cleaned;
  return cleaned.slice(lastSlash + 1);
}

function hostOf(rawTail: string): string {
  const slashIdx = rawTail.indexOf('/');
  const colonIdx = rawTail.indexOf(':');
  let end = rawTail.length;
  if (slashIdx >= 0) end = Math.min(end, slashIdx);
  if (colonIdx >= 0) end = Math.min(end, colonIdx);
  const host = rawTail.slice(0, end).trim();
  return host || 'the URL';
}

export function sanitizeForTts(input: string): string {
  if (!input) return '';
  let out = input;
  /* URLs first. If we ran the Windows path regex first, "https://x"
   * would match (the `s:` looks like a drive letter), shredding the
   * URL before the URL rule got to it. Doing URLs first removes the
   * scheme so the remaining text cannot be misread as a path. */
  out = out.replace(URL_PATTERN, (_full, tail) => hostOf(String(tail)));
  /* Single-arg callback so the regex match's secondary args (offset
   * / source) never get treated as a capture group. */
  out = out.replace(WIN_PATH_PATTERN, (match) => basenameOf(match));
  out = out.replace(POSIX_PATH_PATTERN, (match) => basenameOf(match));
  for (const re of HEX_ID_PATTERNS) {
    out = out.replace(re, 'opaque id');
  }
  out = out.replace(ANGLE_TAG_PATTERN, '');
  /* Whitespace pass: collapse runs of 2+ spaces/tabs into a single
   * space, then strip trailing whitespace per line. Newlines are
   * preserved so multi-line synth text retains its line breaks. */
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
  return out;
}
