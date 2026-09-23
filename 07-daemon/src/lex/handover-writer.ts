/**
 * Handover artifact writer (Phase 2 of LEX-STANDALONE-SUPERVISION).
 *
 * Writes `<DATA_ROOT>/brainstorms/<brainstormId>/HANDOVER-<isoTimestamp>.md`.
 * The cold and day-cap grooming passes call this so the next consumer
 * (a fresh Lex spawn, a worker SessionStart preload, an operator
 * eyeballing the dashboard) finds the freshest mid-session context
 * without having to replay the full chunks transcript.
 *
 * Pure aside from the disk write: every input is on the payload, no
 * db reads happen here, no llm calls. Callers assemble the payload
 * from grooming.ts. Tests can drive the writer with synthetic
 * payloads + an injected fs so no real disk write is needed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_ROOT, ensureDir } from '../paths.js';
import { renderHandoverFrame, type HandoverFrame } from './handover-frame.js';

export interface HandoverPayload {
  brainstormId: string;
  userLabel: string | null;
  derivedLabel: string | null;
  mode: 'conversation' | 'notes' | 'push-to-talk' | string;
  generatedAt: string; // ISO
  /** One-sentence-each lines for arcs the conversation kept circling
   * back to. Distilled by the LLM at pass time. */
  activeArcs: string[];
  /** Decisions the user marked as "park this" or that aged past the
   * decision threshold without resolution. */
  parkedDecisions: string[];
  /** Forward-looking notes / seeds. */
  plantedMarkers: string[];
  /** Verbatim tail of the conversation so the next consumer can read
   * recent context without paging the full chunks table. */
  recentTurns: Array<{ role: 'user' | 'lex' | 'tool'; text: string }>;
  /** Optional rolling summary the watcher just refreshed. Included so
   * the handover doc is self-contained. */
  rollingSummary: string | null;
}

export interface HandoverWriteOptions {
  /** Override the brainstorm artifacts root. Defaults to
   * `<DATA_ROOT>/brainstorms`. Tests inject a tmpdir. */
  rootDir?: string;
  /** Inject the writer for tests. Defaults to fs.writeFileSync. */
  writeFile?: (filePath: string, content: string) => void;
  /** Inject mkdir for tests. Defaults to ensureDir. */
  mkdir?: (dirPath: string) => void;
}

export interface HandoverWriteResult {
  filePath: string;
  bytes: number;
}

function isoToSlug(iso: string): string {
  /* Filename-safe slug. Strips ':' and 'T' / '.Z' decorations so the
   * timestamp lands inside a windows-and-posix-friendly filename
   * while still sorting lexicographically by time. */
  return iso.replace(/[:.]/g, '-').replace('T', '_');
}

export function brainstormDir(brainstormId: string, rootDir?: string): string {
  const base = rootDir ?? path.posix.join(DATA_ROOT, 'brainstorms');
  return path.posix.join(base, brainstormId);
}

export function buildHandoverFilename(generatedAt: string): string {
  return `HANDOVER-${isoToSlug(generatedAt)}.md`;
}

export function renderHandover(payload: HandoverPayload): string {
  const lines: string[] = [];
  lines.push(`# Brainstorm handover ${payload.brainstormId}`);
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  if (payload.userLabel) lines.push(`Label: ${payload.userLabel}`);
  if (payload.derivedLabel) lines.push(`Derived label: ${payload.derivedLabel}`);
  lines.push(`Mode: ${payload.mode}`);
  lines.push('');
  if (payload.rollingSummary && payload.rollingSummary.trim().length > 0) {
    lines.push('## Rolling summary');
    lines.push('');
    lines.push(payload.rollingSummary.trim());
    lines.push('');
  }
  lines.push('## Active arcs');
  lines.push('');
  if (payload.activeArcs.length === 0) {
    lines.push('_None._');
  } else {
    for (const a of payload.activeArcs) lines.push(`- ${a}`);
  }
  lines.push('');
  lines.push('## Parked decisions');
  lines.push('');
  if (payload.parkedDecisions.length === 0) {
    lines.push('_None._');
  } else {
    for (const d of payload.parkedDecisions) lines.push(`- ${d}`);
  }
  lines.push('');
  lines.push('## Planted markers');
  lines.push('');
  if (payload.plantedMarkers.length === 0) {
    lines.push('_None._');
  } else {
    for (const m of payload.plantedMarkers) lines.push(`- ${m}`);
  }
  lines.push('');
  lines.push('## Recent turns (verbatim tail)');
  lines.push('');
  if (payload.recentTurns.length === 0) {
    lines.push('_No turns captured._');
  } else {
    for (const t of payload.recentTurns) {
      const role =
        t.role === 'lex' ? 'LEX' : t.role === 'user' ? 'USER' : 'TOOL';
      lines.push(`- **${role}:** ${t.text.replace(/\n/g, ' ').trim()}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function writeHandover(
  payload: HandoverPayload,
  opts: HandoverWriteOptions = {},
): HandoverWriteResult {
  const dir = brainstormDir(payload.brainstormId, opts.rootDir);
  const mkdir = opts.mkdir ?? ensureDir;
  const writeFile = opts.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c, 'utf-8'));
  mkdir(dir);
  const filename = buildHandoverFilename(payload.generatedAt);
  const filePath = path.posix.join(dir, filename);
  const content = renderHandover(payload);
  writeFile(filePath, content);
  return { filePath, bytes: Buffer.byteLength(content, 'utf-8') };
}

/* ------------------------------------------------------------------ */
/* Phase C (2026-09-22): T5 frame files, browsing, archive             */
/* ------------------------------------------------------------------ */

export interface HandoverFsDeps {
  rootDir?: string;
  readdir?: (dir: string) => string[];
  readFile?: (p: string) => string;
  writeFile?: (p: string, content: string) => void;
  rename?: (from: string, to: string) => void;
  mkdir?: (dir: string) => void;
  exists?: (p: string) => boolean;
}

function fsDeps(opts: HandoverFsDeps): Required<Omit<HandoverFsDeps, 'rootDir'>> {
  return {
    readdir: opts.readdir ?? ((d) => fs.readdirSync(d)),
    readFile: opts.readFile ?? ((p) => fs.readFileSync(p, 'utf-8')),
    writeFile: opts.writeFile ?? ((p, c) => fs.writeFileSync(p, c, 'utf-8')),
    rename: opts.rename ?? ((a, b) => fs.renameSync(a, b)),
    mkdir: opts.mkdir ?? ensureDir,
    exists: opts.exists ?? ((p) => fs.existsSync(p)),
  };
}

/* A handover file; the index (HANDOVER-INDEX.md) is not one. */
export const HANDOVER_FILE_RE = /^HANDOVER-(?!INDEX\.md$)[0-9A-Za-z_-]+\.md$/;

/** Persist a T5 frame as HANDOVER-<iso>.md under the anchor's dir. */
export function writeFrameHandover(
  frame: HandoverFrame,
  opts: HandoverFsDeps = {},
): HandoverWriteResult & { file: string } {
  const d = fsDeps(opts);
  const dir = brainstormDir(frame.anchorId, opts.rootDir);
  d.mkdir(dir);
  const file = buildHandoverFilename(frame.createdAt);
  const filePath = path.posix.join(dir, file);
  const content = renderHandoverFrame(frame);
  d.writeFile(filePath, content);
  return { filePath, bytes: Buffer.byteLength(content, 'utf-8'), file };
}

export interface HandoverListEntry {
  file: string;
  createdAt: string | null;
  kind: string | null;
  unvetted: boolean;
  verdict: string | null;
  /** True for the pre-Phase-C grooming format (no frame headers). */
  legacy: boolean;
}

/* Newest first. Reads only the head of each file. Scoped to one anchor's
 * own directory by construction. */
export function listHandovers(anchorId: string, opts: HandoverFsDeps = {}): HandoverListEntry[] {
  const d = fsDeps(opts);
  const dir = brainstormDir(anchorId, opts.rootDir);
  if (!d.exists(dir)) return [];
  let entries: string[];
  try {
    entries = d.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((e) => HANDOVER_FILE_RE.test(e)).sort().reverse();
  const out: HandoverListEntry[] = [];
  for (const file of files) {
    let head = '';
    try {
      head = d.readFile(path.posix.join(dir, file)).slice(0, 4_000);
    } catch {
      continue;
    }
    const kind = head.match(/^Kind: (.+)$/m)?.[1]?.trim() ?? null;
    const createdAt = head.match(/^Created: (.+)$/m)?.[1]?.trim() ?? null;
    const verdict = head.match(/^## Lex review \(([a-z]+),/m)?.[1] ?? null;
    out.push({
      file,
      createdAt,
      kind,
      unvetted: /^Unvetted: yes$/m.test(head),
      verdict,
      legacy: kind === null,
    });
  }
  return out;
}

/** One file's content, or null. The name must match HANDOVER_FILE_RE so
 * a caller can never read outside the anchor's directory. */
export function readHandover(
  anchorId: string,
  file: string,
  opts: HandoverFsDeps = {},
): string | null {
  if (!HANDOVER_FILE_RE.test(file)) return null;
  const d = fsDeps(opts);
  const p = path.posix.join(brainstormDir(anchorId, opts.rootDir), file);
  if (!d.exists(p)) return null;
  try {
    return d.readFile(p);
  } catch {
    return null;
  }
}

/* T6 cleanup: archive, do not delete. Keep the newest `keep` in place,
 * move older ones into archive/ and rewrite HANDOVER-INDEX.md with one
 * line per archived file so the trail stays readable at a glance. */
export function archiveOldHandovers(
  anchorId: string,
  keep = 10,
  opts: HandoverFsDeps = {},
): { archived: string[]; indexPath: string | null } {
  const d = fsDeps(opts);
  const dir = brainstormDir(anchorId, opts.rootDir);
  if (!d.exists(dir)) return { archived: [], indexPath: null };
  const files = d.readdir(dir).filter((e) => HANDOVER_FILE_RE.test(e)).sort();
  if (files.length <= keep) return { archived: [], indexPath: null };
  const older = files.slice(0, files.length - keep);
  const archiveDir = path.posix.join(dir, 'archive');
  d.mkdir(archiveDir);
  const indexPath = path.posix.join(dir, 'HANDOVER-INDEX.md');
  const existing = d.exists(indexPath) ? d.readFile(indexPath) : '# Archived handovers\n\n';
  const lines: string[] = [];
  for (const file of older) {
    let firstLine = '';
    let kind = 'legacy';
    let created = '';
    try {
      const head = d.readFile(path.posix.join(dir, file)).slice(0, 4_000);
      kind = head.match(/^Kind: (.+)$/m)?.[1]?.trim() ?? 'legacy';
      created = head.match(/^(?:Created|Generated): (.+)$/m)?.[1]?.trim() ?? '';
      const doing = head.split(/^### What I was doing\s*$/m)[1] ?? '';
      firstLine = doing.trim().split('\n').find((l) => l.trim().length > 0)?.trim().slice(0, 120) ?? '';
    } catch {
      /* index line without detail */
    }
    d.rename(path.posix.join(dir, file), path.posix.join(archiveDir, file));
    lines.push(`- archive/${file}: ${kind}${created ? `, ${created}` : ''}${firstLine ? `, ${firstLine}` : ''}`);
  }
  d.writeFile(indexPath, `${existing.trimEnd()}\n${lines.join('\n')}\n`);
  return { archived: older, indexPath };
}

/* Surface the most recent HANDOVER-*.md path for a brainstorm. Used by
 * cold-start-preload (Phase 4) to prefer the freshest handover doc
 * over an older last_summary. Returns null when the directory does
 * not exist or contains no handover files. Sorts by filename, which
 * sorts by ISO timestamp by construction (isoToSlug above). */
export function findLatestHandover(
  brainstormId: string,
  opts: { rootDir?: string; readdir?: (dir: string) => string[]; stat?: (p: string) => { mtimeMs: number } } = {},
): { filePath: string; filename: string } | null {
  const dir = brainstormDir(brainstormId, opts.rootDir);
  const readdir = opts.readdir ?? ((d: string) => fs.readdirSync(d));
  if (!fs.existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdir(dir);
  } catch {
    return null;
  }
  const handovers = entries.filter(
    (e) => e.startsWith('HANDOVER-') && e.endsWith('.md'),
  );
  if (handovers.length === 0) return null;
  handovers.sort();
  const latest = handovers[handovers.length - 1]!;
  return { filePath: path.posix.join(dir, latest), filename: latest };
}
