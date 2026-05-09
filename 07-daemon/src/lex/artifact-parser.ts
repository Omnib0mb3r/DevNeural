/**
 * Lex artifact extraction.
 *
 * Lex emits structured artifacts as fenced JSON blocks during normal
 * conversation. The daemon scans every assistant turn coming out of
 * a brainstorm PTY for these blocks, parses them, persists the JSON
 * to disk, and links the artifact id into the brainstorm_sessions
 * row's artifacts manifest. Notes-summary artifacts also fan out to
 * the reminder system so capture survives the session ending.
 *
 * Recognised fence info-strings (case-insensitive):
 *   ```artifact:research-note
 *   ```artifact:wiki-draft
 *   ```artifact:project-intent
 *   ```artifact:notes-summary
 *
 * Equivalents accepted for tolerance to Lex's stylistic drift:
 *   ```json:research-note
 *   ```json kind=research-note
 *
 * Parsing failures (malformed JSON, unknown kind) are logged and
 * skipped rather than thrown — artifact extraction is observational
 * and must never break a turn.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_ROOT, ensureDir } from '../paths.js';
import { appendArtifact } from './brainstorm-store.js';
import { createReminder } from '../dashboard/reminders.js';

export type ArtifactKind =
  | 'research-note'
  | 'wiki-draft'
  | 'project-intent'
  | 'notes-summary';

const KIND_TO_CATEGORY: Record<
  ArtifactKind,
  'research_notes' | 'wiki_drafts' | 'spawned_projects' | 'reminders'
> = {
  'research-note': 'research_notes',
  'wiki-draft': 'wiki_drafts',
  'project-intent': 'spawned_projects',
  /* notes-summary itself is not stored as a single artifact category;
   * its reminders_to_create[] entries fan out into the reminders
   * system. We still record an audit row under research_notes so the
   * brainstorm row reflects "a notes-summary was emitted". */
  'notes-summary': 'research_notes',
};

const VALID_KINDS = new Set<ArtifactKind>([
  'research-note',
  'wiki-draft',
  'project-intent',
  'notes-summary',
]);

interface ParsedBlock {
  kind: ArtifactKind;
  data: Record<string, unknown>;
}

/* Match a fenced block whose info-string identifies the artifact kind.
 * Three accepted forms:
 *   ```artifact:<kind>          (preferred)
 *   ```json:<kind>
 *   ```json kind=<kind>
 *
 * The regex consumes the fence header, the body up to the closing
 * triple-tick, then the close. Kept on a single multiline regex
 * because we want all matches in the same string and JSON content
 * inside the body must allow newlines.
 */
const ARTIFACT_FENCE_RE =
  /```(?:artifact|json)\s*[:=]?\s*(?:kind\s*=\s*)?([a-z][a-z-]+)\s*\r?\n([\s\S]*?)\r?\n```/gi;

function classifyKind(raw: string): ArtifactKind | null {
  const norm = raw.trim().toLowerCase();
  return VALID_KINDS.has(norm as ArtifactKind) ? (norm as ArtifactKind) : null;
}

export function extractArtifactBlocks(text: string): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  if (!text || typeof text !== 'string') return out;
  let match: RegExpExecArray | null;
  ARTIFACT_FENCE_RE.lastIndex = 0;
  while ((match = ARTIFACT_FENCE_RE.exec(text))) {
    const kind = classifyKind(match[1] ?? '');
    if (!kind) continue;
    const body = match[2] ?? '';
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push({ kind, data });
  }
  return out;
}

function artifactsRoot(): string {
  return path.posix.join(DATA_ROOT.replace(/\\/g, '/'), 'lex', 'artifacts');
}

function persistArtifactFile(
  kind: ArtifactKind,
  brainstormId: string | null,
  artifactId: string,
  data: Record<string, unknown>,
): string {
  const dir = path.posix.join(artifactsRoot(), kind);
  ensureDir(dir);
  const file = path.posix.join(dir, `${artifactId}.json`);
  const envelope = {
    id: artifactId,
    kind,
    brainstorm_id: brainstormId,
    created_ms: Date.now(),
    data,
  };
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2), 'utf-8');
  return file;
}

interface ProcessOptions {
  brainstormId: string | null;
  /** Free-text title fallback used when the artifact JSON has no
   * obvious title field. Surfaces in the dashboard artifact list. */
  fallbackTitle?: string;
  /** Stable key per assistant turn (typically the jsonl record uuid)
   * so concurrent processors (voice WS and brainstorm watcher) don't
   * double-extract the same turn. Optional; callers without a key
   * just skip dedupe and may produce duplicate artifacts. */
  dedupeKey?: string;
}

/* Module-private set of dedupe keys we've already extracted. Bounded
 * by an LRU-ish trim so we don't grow unbounded over a long uptime.
 * 4096 keys is roughly 4096 turns of brainstorm history kept in
 * memory; well past any single session's turn count. */
const SEEN_KEYS = new Set<string>();
const SEEN_KEYS_MAX = 4096;

function recordSeen(key: string): void {
  SEEN_KEYS.add(key);
  if (SEEN_KEYS.size > SEEN_KEYS_MAX) {
    /* Drop the oldest entry. Set iteration is insertion order. */
    const first = SEEN_KEYS.values().next().value;
    if (first !== undefined) SEEN_KEYS.delete(first);
  }
}

export function hasProcessedTurn(key: string): boolean {
  return SEEN_KEYS.has(key);
}

export interface PersistedArtifact {
  id: string;
  kind: ArtifactKind;
  category: 'research_notes' | 'wiki_drafts' | 'spawned_projects' | 'reminders';
  title: string;
  file: string;
  /** Reminder ids fanned out from a notes-summary block, if any. */
  reminder_ids?: string[];
}

function pickTitle(
  kind: ArtifactKind,
  data: Record<string, unknown>,
  fallback: string,
): string {
  if (kind === 'research-note') {
    return (
      (data.question as string) ?? (data.synthesis as string)?.slice(0, 80) ?? fallback
    );
  }
  if (kind === 'wiki-draft') {
    return (
      (data.insight as string)?.slice(0, 80) ??
      (data.trigger as string) ??
      fallback
    );
  }
  if (kind === 'project-intent') {
    return (data.name as string) ?? fallback;
  }
  if (kind === 'notes-summary') {
    return (data.summary as string)?.slice(0, 80) ?? fallback;
  }
  return fallback;
}

function fanOutNotesSummary(
  data: Record<string, unknown>,
  brainstormId: string | null,
): string[] {
  const reminders = data.reminders_to_create;
  if (!Array.isArray(reminders)) return [];
  const ids: string[] = [];
  for (const entry of reminders) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const title = obj.title;
    if (typeof title !== 'string' || !title.trim()) continue;
    const created = createReminder({
      title: title.trim(),
      ...(typeof obj.due_at === 'string' ? { due_at: obj.due_at } : {}),
      tags: ['lex', 'notes-mode'],
    });
    ids.push(created.id);
    if (brainstormId) {
      try {
        appendArtifact(brainstormId, 'reminders', {
          id: created.id,
          title: created.title,
        });
      } catch {
        /* observability */
      }
    }
  }
  return ids;
}

/* Parse + persist every artifact block found in a single assistant
 * turn. Returns the persisted artifact records so the caller (voice
 * WS, future text WS) can echo them to the client UI. Idempotent
 * within a turn because every block gets a fresh randomUUID; calling
 * this twice on the same text just creates duplicate ids on disk,
 * which is acceptable (and easy to fix later by hashing the body). */
export function processAssistantTurn(
  text: string,
  opts: ProcessOptions,
): PersistedArtifact[] {
  if (opts.dedupeKey && SEEN_KEYS.has(opts.dedupeKey)) return [];
  const blocks = extractArtifactBlocks(text);
  if (opts.dedupeKey) recordSeen(opts.dedupeKey);
  const out: PersistedArtifact[] = [];
  for (const block of blocks) {
    const id = randomUUID();
    const category = KIND_TO_CATEGORY[block.kind];
    const title = pickTitle(block.kind, block.data, opts.fallbackTitle ?? block.kind);
    let file: string;
    try {
      file = persistArtifactFile(block.kind, opts.brainstormId, id, block.data);
    } catch {
      continue;
    }
    if (opts.brainstormId) {
      try {
        appendArtifact(opts.brainstormId, category, { id, title });
      } catch {
        /* observability */
      }
    }
    const record: PersistedArtifact = {
      id,
      kind: block.kind,
      category,
      title,
      file,
    };
    if (block.kind === 'notes-summary') {
      record.reminder_ids = fanOutNotesSummary(block.data, opts.brainstormId);
    }
    out.push(record);
  }
  return out;
}
