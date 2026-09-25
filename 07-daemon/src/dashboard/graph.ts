/**
 * Wiki graph builder for the dashboard /graph endpoint.
 *
 * Reads every page under wiki/pages (canonical), wiki/pending (pending),
 * and wiki/archive (archived). Parses frontmatter via the existing wiki
 * schema parser. Edges come from explicit `## Cross-references` markdown
 * link entries authored by the ingest LLM. We also tolerate `[[wiki-link]]`
 * style references inside the body in case future pipelines emit them.
 *
 * Edges are emitted only when both endpoints exist as nodes; dangling
 * cross-refs are silently dropped because partial graphs are noisier than
 * filtered ones in a force layout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  wikiPagesDir,
  wikiPendingDir,
  wikiArchiveDir,
} from '../paths.js';
import { readPage, type ParsedPage, type PageStatus } from '../wiki/schema.js';

export interface GraphNode {
  id: string;
  title: string;
  status: PageStatus;
  project_id?: string;
  last_modified: string;
  promoted_at?: string;
  weight: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind?: 'reference' | 'sibling' | 'glossary';
  /** Average of endpoint node weights; orb maps this to a cool→warm
   * heat gradient and to line width. Range [0,1]. */
  weight: number;
}

export interface GraphPayload {
  ok: true;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface PageEntry {
  page: ParsedPage;
  file: string;
  mtime: number;
  status: PageStatus;
}

const WIKI_LINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;

function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

function loadDir(dir: string, fallbackStatus: PageStatus): PageEntry[] {
  const out: PageEntry[] = [];
  for (const file of readDirSafe(dir)) {
    const full = path.posix.join(dir, file);
    try {
      const page = readPage(full);
      const stat = fs.statSync(full);
      // Trust the disk location over the frontmatter status; the daemon
      // moves files between dirs to reflect lifecycle, and frontmatter
      // can lag during a half-applied lint pass.
      out.push({
        page,
        file: full,
        mtime: stat.mtimeMs,
        status: fallbackStatus,
      });
    } catch {
      // Skip malformed pages; they will surface in lint, not in the orb.
    }
  }
  return out;
}

function loadAllPages(): PageEntry[] {
  return [
    ...loadDir(wikiPagesDir(), 'canonical'),
    ...loadDir(wikiPendingDir(), 'pending'),
    ...loadDir(wikiArchiveDir(), 'archived'),
  ];
}

/* BUG-042 (2026-09-24): buildGraph parses every wiki page from disk on
 * every call (500 ms, 720 KB on this box) and the home-page orb asks for
 * it on mount and every 30 s. The parse is synchronous CPU work, so it
 * froze the daemon for half a second per call. The payload only changes
 * when a page file changes, so it is rebuilt only then: a fingerprint of
 * every page's name, size and mtime across the three wiki dirs (a few
 * hundred stats, single-digit ms) decides whether the cached payload is
 * still current. */
function wikiFingerprint(): string {
  const parts: string[] = [];
  for (const dir of [wikiPagesDir(), wikiPendingDir(), wikiArchiveDir()]) {
    for (const file of readDirSafe(dir)) {
      try {
        const st = fs.statSync(path.posix.join(dir, file));
        parts.push(`${dir}/${file}:${st.size}:${st.mtimeMs}`);
      } catch {
        /* vanished between readdir and stat; the next call sees the
         * new listing */
      }
    }
  }
  return parts.join('|');
}

let graphCache: { fingerprint: string; payload: GraphPayload } | null = null;

export function buildGraphCached(): GraphPayload {
  const fingerprint = wikiFingerprint();
  if (graphCache && graphCache.fingerprint === fingerprint) {
    return graphCache.payload;
  }
  const payload = buildGraph();
  graphCache = { fingerprint, payload };
  return payload;
}

/** Test seam. */
export function _resetGraphCacheForTests(): void {
  graphCache = null;
}

function recencyBoost(mtime: number): number {
  const ageDays = (Date.now() - mtime) / (1000 * 60 * 60 * 24);
  if (ageDays <= 1) return 1.0;
  if (ageDays <= 7) return 0.6;
  if (ageDays <= 30) return 0.3;
  return 0.1;
}

function pickPromotedAt(entry: PageEntry): string | undefined {
  if (entry.status !== 'canonical') return undefined;
  // Without an explicit promotion timestamp in the schema, treat the
  // canonical-page mtime as the most recent promotion-relevant event.
  // This is what drives the "recently promoted" gold ring on the orb.
  const ageMs = Date.now() - entry.mtime;
  if (ageMs > 24 * 60 * 60 * 1000) return undefined;
  return new Date(entry.mtime).toISOString();
}

export function buildGraph(): GraphPayload {
  const entries = loadAllPages();
  const idToEntry = new Map<string, PageEntry>();
  for (const e of entries) {
    if (!idToEntry.has(e.page.frontmatter.id)) {
      idToEntry.set(e.page.frontmatter.id, e);
    }
  }

  // First pass: collect edges as endpoint pairs, compute per-node degrees.
  // Weight assignment needs node weights, which depend on degree, so this
  // is a three-pass walk: edges (untyped), nodes, then back-fill edge weights.
  interface EdgeStub {
    source: string;
    target: string;
    kind: 'reference' | 'sibling' | 'glossary';
  }
  const edgeStubs: EdgeStub[] = [];
  const incomingCount = new Map<string, number>();
  for (const entry of idToEntry.values()) {
    const sourceId = entry.page.frontmatter.id;
    const seen = new Set<string>();

    for (const ref of entry.page.sections.crossRefs) {
      if (!ref || ref === sourceId) continue;
      if (!idToEntry.has(ref)) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      edgeStubs.push({ source: sourceId, target: ref, kind: 'reference' });
      incomingCount.set(ref, (incomingCount.get(ref) ?? 0) + 1);
    }

    // Also accept [[wiki-link]] style references in the pattern body.
    const body = entry.page.sections.pattern;
    let m: RegExpExecArray | null;
    WIKI_LINK_RE.lastIndex = 0;
    while ((m = WIKI_LINK_RE.exec(body)) !== null) {
      const target = m[1];
      if (!target || target === sourceId) continue;
      if (!idToEntry.has(target)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      edgeStubs.push({ source: sourceId, target, kind: 'reference' });
      incomingCount.set(target, (incomingCount.get(target) ?? 0) + 1);
    }
  }

  const nodes: GraphNode[] = [];
  const idToNodeWeight = new Map<string, number>();
  for (const entry of idToEntry.values()) {
    const fm = entry.page.frontmatter;
    const inDeg = incomingCount.get(fm.id) ?? 0;
    const outDeg = edgeStubs.filter((e) => e.source === fm.id).length;
    const edgeWeight = Math.min(1, (inDeg + outDeg) / 8);
    const weight = Math.max(
      0.05,
      Math.min(1, fm.weight * 0.5 + edgeWeight * 0.3 + recencyBoost(entry.mtime) * 0.2),
    );
    idToNodeWeight.set(fm.id, weight);

    const node: GraphNode = {
      id: fm.id,
      title: fm.title,
      status: entry.status,
      last_modified: new Date(entry.mtime).toISOString(),
      weight,
    };
    if (fm.projects.length > 0 && fm.projects[0]) {
      node.project_id = fm.projects[0];
    }
    const promoted = pickPromotedAt(entry);
    if (promoted) node.promoted_at = promoted;
    nodes.push(node);
  }

  // Edge weight = average of endpoint node weights. Old orb used
  // co-occurrence count; v2 graph uses page weight as the heat signal so
  // visually-prominent edges connect visually-prominent nodes.
  const edges: GraphEdge[] = edgeStubs.map((s) => {
    const sw = idToNodeWeight.get(s.source) ?? 0;
    const tw = idToNodeWeight.get(s.target) ?? 0;
    return { ...s, weight: (sw + tw) / 2 };
  });

  return { ok: true, nodes, edges };
}
