/**
 * Unified graph builder for the /graph/unified endpoint.
 *
 * Returns four node kinds: brainstorm, wiki, project, meeting.
 * Edges come from:
 *   - wiki frontmatter source_brainstorms (lineage)
 *   - wiki frontmatter source_meetings (lineage)
 *   - brainstorm_sessions.project_slug matching a project node (project-spawn)
 *   - wiki cross-references section (wiki-cross-ref)
 *
 * Files are never nodes. Drafts are a wiki-node variant (is_draft=true),
 * not separate nodes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  wikiPagesDir,
  wikiPendingDir,
  wikiArchiveDir,
} from '../paths.js';
import { readPage, type ParsedPage, type PageStatus } from '../wiki/schema.js';
import { listProjects } from '../identity/registry.js';
import type { IndexDb, BrainstormSessionRow } from '../store/index-db.js';

// ── Types ─────────────────────────────────────────────────────────

export type UnifiedNodeKind = 'brainstorm' | 'wiki' | 'project' | 'meeting';
export type UnifiedEdgeKind =
  | 'lineage'
  | 'wiki-cross-ref'
  | 'project-spawn';

export interface UnifiedGraphNode {
  id: string;
  kind: UnifiedNodeKind;
  title: string;
  /** Normalized [0,1]. Drives node radius and glow intensity. */
  weight: number;
  /** ISO timestamp of last significant activity (used for recency glow). */
  last_active: string;
  /** Present on wiki nodes only. */
  wiki_status?: PageStatus;
  /** True when the wiki node is in the pending (draft) dir. */
  is_draft?: boolean;
  /** Present on brainstorm/meeting nodes. */
  project_slug?: string | null;
  /** Brainstorm IDs that contributed to this wiki page (wiki nodes). */
  source_brainstorms?: string[];
  /** Meeting IDs that contributed to this wiki page (wiki nodes). */
  source_meetings?: string[];
}

export interface UnifiedGraphEdge {
  source: string;
  target: string;
  kind: UnifiedEdgeKind;
  weight: number;
}

export interface UnifiedGraphPayload {
  ok: true;
  nodes: UnifiedGraphNode[];
  edges: UnifiedGraphEdge[];
}

// ── Wiki page loading ──────────────────────────────────────────

interface WikiPageEntry {
  page: ParsedPage;
  mtime: number;
  status: PageStatus;
}

function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

function loadDirPages(dir: string, fallbackStatus: PageStatus): WikiPageEntry[] {
  const out: WikiPageEntry[] = [];
  for (const file of readDirSafe(dir)) {
    const full = path.posix.join(dir, file);
    try {
      const page = readPage(full);
      const stat = fs.statSync(full);
      out.push({ page, mtime: stat.mtimeMs, status: fallbackStatus });
    } catch {
      // Skip malformed pages silently.
    }
  }
  return out;
}

function loadAllWikiPages(): WikiPageEntry[] {
  return [
    ...loadDirPages(wikiPagesDir(), 'canonical'),
    ...loadDirPages(wikiPendingDir(), 'pending'),
    ...loadDirPages(wikiArchiveDir(), 'archived'),
  ];
}

// ── Weight helpers ─────────────────────────────────────────────

function recencyScore(lastActiveMs: number): number {
  const ageDays = (Date.now() - lastActiveMs) / (1000 * 60 * 60 * 24);
  if (ageDays <= 1) return 1.0;
  if (ageDays <= 7) return 0.7;
  if (ageDays <= 30) return 0.4;
  if (ageDays <= 90) return 0.2;
  return 0.1;
}

function wikiWeight(entry: WikiPageEntry): number {
  const fm = entry.page.frontmatter;
  const recency = recencyScore(entry.mtime);
  return Math.max(0.05, Math.min(1, fm.weight * 0.6 + recency * 0.4));
}

function brainstormWeight(row: BrainstormSessionRow): number {
  const lastMs = row.ended_ms ?? row.started_ms;
  const recency = recencyScore(lastMs);
  // turn_count is a proxy for content richness; cap at 100 turns for normalization.
  const richness = Math.min(1, row.turn_count / 100);
  return Math.max(0.05, Math.min(1, richness * 0.5 + recency * 0.5));
}

function projectWeight(lastSeen: string): number {
  const ms = new Date(lastSeen).getTime();
  return Math.max(0.2, Math.min(1, recencyScore(ms)));
}

// ── Builder ────────────────────────────────────────────────────

export function buildUnifiedGraph(db: IndexDb): UnifiedGraphPayload {
  const nodes: UnifiedGraphNode[] = [];
  const edges: UnifiedGraphEdge[] = [];
  const nodeIds = new Set<string>();

  function addNode(n: UnifiedGraphNode): void {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  }

  // ── 1. Wiki nodes ──────────────────────────────────────────
  const wikiEntries = loadAllWikiPages();
  const wikiIdToWeight = new Map<string, number>();

  for (const entry of wikiEntries) {
    const fm = entry.page.frontmatter;
    const w = wikiWeight(entry);
    wikiIdToWeight.set(fm.id, w);
    addNode({
      id: fm.id,
      kind: 'wiki',
      title: fm.title,
      weight: w,
      last_active: new Date(entry.mtime).toISOString(),
      wiki_status: entry.status,
      is_draft: entry.status === 'pending',
      source_brainstorms: fm.source_brainstorms ?? [],
      source_meetings: fm.source_meetings ?? [],
    });
  }

  // ── 2. Brainstorm and meeting nodes ────────────────────────
  // Include sessions with at least 1 turn to reduce noise.
  const allSessions = db.listBrainstorms({ limit: 500 });
  const sessions = allSessions.filter((r) => r.turn_count >= 1);
  const brainstormIdToProjectSlug = new Map<string, string | null>();

  for (const row of sessions) {
    const isMeeting = row.kind === 'meeting';
    const kind: UnifiedNodeKind = isMeeting ? 'meeting' : 'brainstorm';
    const label =
      row.user_label ?? row.derived_label ?? `Session ${row.id.slice(0, 8)}`;
    const lastMs = row.ended_ms ?? row.started_ms;
    const w = brainstormWeight(row);
    brainstormIdToProjectSlug.set(row.id, row.project_slug ?? null);
    addNode({
      id: row.id,
      kind,
      title: label,
      weight: w,
      last_active: new Date(lastMs).toISOString(),
      project_slug: row.project_slug ?? null,
    });
  }

  // ── 3. Project nodes ───────────────────────────────────────
  const projectList = listProjects();
  for (const p of projectList) {
    const w = projectWeight(p.last_seen);
    addNode({
      id: `project:${p.id}`,
      kind: 'project',
      title: p.name,
      weight: w,
      last_active: p.last_seen,
    });
  }

  // ── 4. Edges ────────────────────────────────────────────────

  // 4a. lineage: wiki source_brainstorms -> wiki node
  // 4b. lineage: wiki source_meetings -> wiki node
  // 4c. wiki-cross-ref: wiki cross-ref section links
  for (const entry of wikiEntries) {
    const fm = entry.page.frontmatter;
    const wikiW = wikiIdToWeight.get(fm.id) ?? 0.5;

    for (const bId of fm.source_brainstorms ?? []) {
      if (!nodeIds.has(bId)) continue;
      const bW = nodes.find((n) => n.id === bId)?.weight ?? 0.5;
      edges.push({
        source: bId,
        target: fm.id,
        kind: 'lineage',
        weight: (wikiW + bW) / 2,
      });
    }

    for (const mId of fm.source_meetings ?? []) {
      if (!nodeIds.has(mId)) continue;
      const mW = nodes.find((n) => n.id === mId)?.weight ?? 0.5;
      edges.push({
        source: mId,
        target: fm.id,
        kind: 'lineage',
        weight: (wikiW + mW) / 2,
      });
    }

    for (const ref of entry.page.sections.crossRefs) {
      if (!ref || ref === fm.id) continue;
      if (!nodeIds.has(ref)) continue;
      const refW = wikiIdToWeight.get(ref) ?? 0.5;
      edges.push({
        source: fm.id,
        target: ref,
        kind: 'wiki-cross-ref',
        weight: (wikiW + refW) / 2,
      });
    }
  }

  // 4d. project-spawn: brainstorm_sessions.project_slug -> project node
  for (const [bId, slug] of brainstormIdToProjectSlug) {
    if (!slug) continue;
    const projNodeId = `project:${slug}`;
    if (!nodeIds.has(projNodeId)) continue;
    const bW = nodes.find((n) => n.id === bId)?.weight ?? 0.5;
    const pW = nodes.find((n) => n.id === projNodeId)?.weight ?? 0.5;
    edges.push({
      source: bId,
      target: projNodeId,
      kind: 'project-spawn',
      weight: (bW + pW) / 2,
    });
  }

  return { ok: true, nodes, edges };
}
