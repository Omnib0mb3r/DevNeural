/**
 * Worker event snippet extractor (Fix 34d.1 addendum, 2026-05-26).
 *
 * Replaces the raw-tail-bytes snippet with a per-event-type, high-
 * signal payload Lex can actually act on. The pre-addendum behavior
 * read the last N bytes of the worker's jsonl, which on SessionStart
 * was the CC skill-catalog blob and on hooks-injected ticks was the
 * hook_additional_context attachment — pure noise that derailed Lex's
 * reasoning.
 *
 * Pure module. Inputs are the event type and a raw jsonl tail. The
 * extractor walks the tail with the same meaningful-line predicate
 * brainstorm-jsonl-ingestor uses (skip system / summary / attachment /
 * compact summary / meta), pulls only assistant + user text content
 * and tool_use / tool_result parts, then per-event formats a brief.
 *
 * General invariants:
 *  - Cap output at ~600 chars total. Truncate the middle when needed.
 *  - If no meaningful content found, return '(no recent activity)' —
 *    still notify Lex; never silently swallow an event.
 *  - Strip CC meta records: system, attachment, last-prompt,
 *    queue-operation, hook_additional_context payloads, skill
 *    catalogs, session-init blobs. The text+toolUse+toolResult filter
 *    drops these naturally because they live in attachment-typed
 *    lines, not user/assistant records.
 */
import type { WorkerEventType } from './worker-event-router.js';

const MAX_SNIPPET_CHARS = 600;
const EMPTY_PLACEHOLDER = '(no recent activity)';

interface ParsedJsonl {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{
          type?: string;
          text?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
    stop_reason?: string;
  };
  attachment?: { type?: string };
}

interface ToolUse {
  name: string;
  input: unknown;
  id?: string;
}

interface ToolResult {
  tool_use_id?: string;
  text: string;
  is_error: boolean;
}

export interface MeaningfulLine {
  ts: number | null;
  type: 'user' | 'assistant';
  text: string;
  toolUses: ToolUse[];
  toolResults: ToolResult[];
  stopReason: string | null;
}

function parseTs(s: string | undefined): number | null {
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

function stringifyToolResultContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let out = '';
    for (const part of c) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: string }).type === 'text' &&
        typeof (part as { text?: string }).text === 'string'
      ) {
        out += (out ? '\n' : '') + (part as { text: string }).text;
      }
    }
    return out;
  }
  return '';
}

export function parseMeaningfulLines(jsonlTail: string): MeaningfulLine[] {
  const lines = jsonlTail.split('\n');
  const out: MeaningfulLine[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let rec: ParsedJsonl;
    try {
      rec = JSON.parse(trimmed) as ParsedJsonl;
    } catch {
      continue;
    }
    if (rec.isMeta || rec.isCompactSummary) continue;
    if (rec.attachment) continue;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const role = rec.message?.role ?? rec.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const ts = parseTs(rec.timestamp);
    let text = '';
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    const content = rec.message?.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const ptype = part.type;
        if (ptype === 'text' && typeof part.text === 'string') {
          text += (text ? '\n' : '') + part.text;
        } else if (ptype === 'tool_use') {
          toolUses.push({
            name: typeof part.name === 'string' ? part.name : '',
            input: part.input,
            id:
              typeof part.tool_use_id === 'string'
                ? part.tool_use_id
                : undefined,
          });
        } else if (ptype === 'tool_result') {
          toolResults.push({
            tool_use_id:
              typeof part.tool_use_id === 'string'
                ? part.tool_use_id
                : undefined,
            text: stringifyToolResultContent(part.content),
            is_error: !!part.is_error,
          });
        }
      }
    }
    /* Drop attachments-as-content rows (skill catalogs, session-init
     * blobs). They land as user lines with no text/tool activity once
     * the extractor finishes filtering. */
    if (!text && toolUses.length === 0 && toolResults.length === 0) continue;
    out.push({
      ts,
      type: rec.type as 'user' | 'assistant',
      text: text.trim(),
      toolUses,
      toolResults,
      stopReason: rec.message?.stop_reason ?? null,
    });
  }
  return out;
}

function truncMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 24) / 2);
  return `${s.slice(0, half)} ... [truncated ${s.length - 2 * half} chars] ... ${s.slice(-half)}`;
}

function capToMax(s: string): string {
  return s.length <= MAX_SNIPPET_CHARS ? s : truncMiddle(s, MAX_SNIPPET_CHARS);
}

function brief(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function reverse<T>(arr: readonly T[]): T[] {
  return arr.slice().reverse();
}

export interface ExtractOpts {
  /** Wall-clock ms used to compute idle stall_seconds. */
  now?: number;
  /** Override snippet for expectation_drift (the supervisor passes
   * the LLM-judged drift summary directly; the jsonl tail does not
   * carry that text). */
  driftSnippet?: string;
}

export function extractEventSnippet(
  eventType: WorkerEventType,
  rawTail: string,
  opts: ExtractOpts = {},
): string {
  if (eventType === 'expectation_drift') {
    const drift = (opts.driftSnippet ?? rawTail).trim();
    return drift ? capToMax(`drift: ${drift}`) : EMPTY_PLACEHOLDER;
  }
  const lines = parseMeaningfulLines(rawTail);

  if (eventType === 'idle') {
    /* Pre-tool ack filter: assistant turns with stop_reason='tool_use'
     * are intermediate ("Investigating...", "On it...") not real
     * replies. Skip them when picking last_assistant so Lex sees the
     * actual content of the prior turn. */
    const lastAssistant = reverse(lines).find(
      (l) =>
        l.type === 'assistant' &&
        l.text.length > 0 &&
        l.stopReason !== 'tool_use',
    );
    const lastUser = reverse(lines).find(
      (l) =>
        l.type === 'user' && l.text.length > 0 && l.toolResults.length === 0,
    );
    const lastTool = reverse(lines)
      .flatMap((l) => reverse(l.toolUses))
      .find((u) => !!u);
    const lastResult = reverse(lines)
      .flatMap((l) => reverse(l.toolResults))
      .find((r) => !!r);
    let stallSecs: number | null = null;
    if (typeof opts.now === 'number') {
      const newestAssistantTs =
        reverse(lines).find((l) => l.type === 'assistant' && l.ts !== null)
          ?.ts ?? null;
      if (newestAssistantTs !== null) {
        stallSecs = Math.max(
          0,
          Math.round((opts.now - newestAssistantTs) / 1000),
        );
      }
    }
    const parts: string[] = [];
    if (stallSecs !== null) parts.push(`stall_seconds=${stallSecs}`);
    if (lastUser?.text) parts.push(`last_user: ${brief(lastUser.text, 200)}`);
    if (lastAssistant?.text) {
      parts.push(`last_assistant: ${brief(lastAssistant.text, 200)}`);
    }
    if (lastTool) {
      const inputStr = brief(JSON.stringify(lastTool.input ?? {}), 120);
      parts.push(`last_tool: ${lastTool.name}(${inputStr})`);
    }
    if (lastResult) {
      parts.push(
        `last_tool_result: ${lastResult.is_error ? 'err' : 'ok'} ${brief(lastResult.text, 200)}`,
      );
    }
    return parts.length === 0 ? EMPTY_PLACEHOLDER : capToMax(parts.join('\n'));
  }

  if (eventType === 'permission_denied') {
    const PERM_RE = /Permission to use ([\w_-]+) has been denied/;
    let toolName: string | null = null;
    let reasonText: string | null = null;
    let matchingUseId: string | undefined;
    for (const line of reverse(lines)) {
      for (const r of reverse(line.toolResults)) {
        const m = r.text.match(PERM_RE);
        if (m) {
          toolName = m[1] ?? null;
          reasonText = r.text;
          matchingUseId = r.tool_use_id;
          break;
        }
      }
      if (toolName) break;
    }
    if (!toolName) {
      /* Fallback for synthetic / pre-CC-shape tails: regex on raw
       * bytes. Still emit the tool name so Lex has actionable signal;
       * note in the reason that the tool_result block was not in CC's
       * canonical shape. */
      const m = rawTail.match(PERM_RE);
      if (!m) return EMPTY_PLACEHOLDER;
      const rawLine =
        rawTail.match(/Permission to use [\w_-]+ has been denied[^\n]*/)?.[0] ??
        '';
      const parts = [`denied_tool: ${m[1]}`];
      if (rawLine) parts.push(`reason: ${brief(rawLine, 250)}`);
      return capToMax(parts.join('\n'));
    }
    const matchingUse = reverse(lines)
      .flatMap((l) => l.toolUses)
      .find((u) =>
        matchingUseId ? u.id === matchingUseId : u.name === toolName,
      );
    const parts: string[] = [`denied_tool: ${toolName}`];
    if (matchingUse) {
      parts.push(
        `denied_input: ${brief(JSON.stringify(matchingUse.input ?? {}), 200)}`,
      );
    }
    parts.push(`reason: ${brief(reasonText ?? '', 250)}`);
    return capToMax(parts.join('\n'));
  }

  if (eventType === 'commit') {
    const COMMIT_HEADER_RE =
      /\[((?:main|master|[\w/-]+))\s+([a-f0-9]{7,})\]\s+([^\n]+)/;
    const FILES_RE = /(\d+)\s+files?\s+changed/;
    let branch: string | null = null;
    let subject: string | null = null;
    let filesChanged: string | null = null;
    /* Search all tool_result blobs first; fall back to rawTail so a
     * commit that landed as a system-attachment shape (rare) still
     * surfaces. */
    const blobs = lines.flatMap((l) => l.toolResults.map((r) => r.text));
    blobs.push(rawTail);
    for (const blob of blobs.reverse()) {
      if (!blob) continue;
      const h = blob.match(COMMIT_HEADER_RE);
      const f = blob.match(FILES_RE);
      if (h && !branch) {
        branch = h[1] ?? null;
        subject = h[3] ?? null;
      }
      if (f && !filesChanged) filesChanged = f[1] ?? null;
      if (branch && filesChanged) break;
    }
    const parts: string[] = [];
    if (branch) parts.push(`branch: ${branch}`);
    if (subject) parts.push(`subject: ${brief(subject, 200)}`);
    if (filesChanged) parts.push(`files_changed: ${filesChanged}`);
    return parts.length === 0 ? EMPTY_PLACEHOLDER : capToMax(parts.join('\n'));
  }

  /* Fallback for pending_prompt / test_failure / bridge_disconnect:
   * surface the most recent meaningful user + assistant text so Lex
   * sees the context that triggered the event. */
  const lastAssistant = reverse(lines).find(
    (l) => l.type === 'assistant' && l.text.length > 0,
  );
  const lastUser = reverse(lines).find(
    (l) => l.type === 'user' && l.text.length > 0,
  );
  const parts: string[] = [];
  if (lastUser?.text) parts.push(`last_user: ${brief(lastUser.text, 220)}`);
  if (lastAssistant?.text) {
    parts.push(`last_assistant: ${brief(lastAssistant.text, 220)}`);
  }
  return parts.length === 0 ? EMPTY_PLACEHOLDER : capToMax(parts.join('\n'));
}
