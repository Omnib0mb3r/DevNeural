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
