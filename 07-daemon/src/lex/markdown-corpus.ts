/* Markdown corpus chunker (Unified Knowledge Index, first slice).
 *
 * Walks a project's markdown stores (memory, docs/**, brainstorm, spec,
 * bugs) and chunks each file by heading, tagging every chunk with its
 * store + path + heading + 1-based line + snippet. This is the corpus
 * that the embed + scoped-query layer (next piece) indexes so "where is
 * X" returns a precise pointer instead of a grep.
 *
 * PROJECT-SCOPED by construction: a caller passes the store roots for ONE
 * project, so the corpus can never contain another project's files. The
 * one global tier (Lex behavior/feedback rules + user profile) is a
 * separate store-set the caller opts in.
 *
 * Pure + additive: filesystem access flows through injectable seams so
 * the chunker is unit-testable, and nothing here touches the existing
 * brainstorm-chunk recall path.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

export interface MarkdownStoreSpec {
  /** Logical store label carried on every chunk (e.g. 'memory', 'docs',
   * 'brainstorm', 'spec', 'bugs', 'global'). */
  store: string;
  /** Absolute directory to walk. */
  dir: string;
  /** Recurse into subdirectories (docs/** ). Default false. */
  recursive?: boolean;
}

export interface CorpusChunk {
  store: string;
  /** Absolute file path. */
  path: string;
  /** Nearest enclosing markdown heading text, or '' for preamble. */
  heading: string;
  /** 1-based line where this chunk starts (the heading line, or 1). */
  line: number;
  /** Short preview for pointer results. */
  snippet: string;
  /** Full section text (heading + body). */
  text: string;
}

export interface CorpusDeps {
  readFile: (p: string) => string | null;
  listDir: (p: string) => string[];
  isDir: (p: string) => boolean;
}

function defaultReadFile(p: string): string | null {
  try {
    return nodeFs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
function defaultListDir(p: string): string[] {
  try {
    return nodeFs.readdirSync(p);
  } catch {
    return [];
  }
}
function defaultIsDir(p: string): boolean {
  try {
    return nodeFs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 200) : flat;
}

/* Chunk one markdown file by heading. A chunk spans from a heading (or
 * the file top) to just before the next heading. Empty sections are
 * dropped. The heading line is the chunk's 1-based `line`. */
export function chunkMarkdown(
  store: string,
  path: string,
  body: string,
): CorpusChunk[] {
  const lines = body.split(/\r?\n/);
  const out: CorpusChunk[] = [];
  let heading = '';
  let startLine = 1;
  let buf: string[] = [];

  const flush = (): void => {
    const text = buf.join('\n').trim();
    if (text.length === 0 && !heading) {
      buf = [];
      return;
    }
    const full = heading ? `${'#'} ${heading}\n${text}`.trim() : text;
    if (full.trim().length === 0) {
      buf = [];
      return;
    }
    out.push({
      store,
      path,
      heading,
      line: startLine,
      snippet: snippetOf(heading ? `${heading} ${text}` : text),
      text: full,
    });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]!);
    if (m) {
      flush();
      heading = m[2]!.trim();
      startLine = i + 1; // 1-based heading line
    } else {
      buf.push(lines[i]!);
    }
  }
  flush();
  return out;
}

/* Walk one store dir (optionally recursive), collecting *.md files. */
function walkMarkdown(
  dir: string,
  recursive: boolean,
  deps: CorpusDeps,
): string[] {
  const found: string[] = [];
  for (const name of deps.listDir(dir)) {
    const full = nodePath.posix.join(dir.replace(/\\/g, '/'), name);
    if (deps.isDir(full)) {
      if (recursive) found.push(...walkMarkdown(full, true, deps));
      continue;
    }
    if (/\.md$/i.test(name)) found.push(full);
  }
  return found;
}

/* Collect + chunk all markdown across the given project stores. */
export function collectMarkdownCorpus(
  stores: MarkdownStoreSpec[],
  deps?: Partial<CorpusDeps>,
): CorpusChunk[] {
  const d: CorpusDeps = {
    readFile: deps?.readFile ?? defaultReadFile,
    listDir: deps?.listDir ?? defaultListDir,
    isDir: deps?.isDir ?? defaultIsDir,
  };
  const out: CorpusChunk[] = [];
  for (const spec of stores) {
    const files = walkMarkdown(spec.dir, spec.recursive ?? false, d);
    for (const file of files) {
      const body = d.readFile(file);
      if (!body || !body.trim()) continue;
      out.push(...chunkMarkdown(spec.store, file, body));
    }
  }
  return out;
}
