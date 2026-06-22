/**
 * Pure data-shaping for the knowledge-index orb (DRIVE-QUEUE 2B).
 *
 * Turns the daemon's project-doc browse payload (files grouped per store)
 * into a force-graph node/link set: one hub node per store, one node per
 * file, a link from each store hub to its files. Store chips filter which
 * stores are included. Kept pure + separate from the React canvas so the
 * grouping + chip filtering is unit-testable without rendering.
 */
import type { DocFile } from "@/lib/daemon-client";

/** Logical store labels the index uses. Order drives chip + legend order;
 * an unknown store still renders (falls back to a neutral color). */
export const DOC_STORES = [
  "memory",
  "docs",
  "brainstorm",
  "spec",
  "bugs",
  "global",
] as const;

/** Canvas color per store (oklch literals; canvas 2D cannot read CSS
 * vars). Mirrors the orb's visual language. */
export const STORE_COLOR: Record<string, string> = {
  memory: "oklch(75% 0.17 60)", // amber
  docs: "oklch(64% 0.20 295)", // violet
  brainstorm: "oklch(70% 0.15 30)", // warm red
  spec: "oklch(68% 0.14 175)", // teal
  bugs: "oklch(63% 0.20 25)", // red
  global: "oklch(58% 0.04 260)", // slate
};
const STORE_COLOR_FALLBACK = "oklch(60% 0.03 250)";

export function storeColor(store: string): string {
  return STORE_COLOR[store] ?? STORE_COLOR_FALLBACK;
}

export interface KnowledgeNode {
  id: string;
  type: "store" | "file";
  store: string;
  label: string;
  /** file nodes only */
  path?: string;
  chunkCount?: number;
}

export interface KnowledgeLink {
  source: string;
  target: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  links: KnowledgeLink[];
  /** Every store present in the input, in DOC_STORES order then any
   * extras alphabetically. Drives the chip set. */
  stores: string[];
}

export function storeNodeId(store: string): string {
  return `store:${store}`;
}
export function fileNodeId(path: string): string {
  return `file:${path}`;
}

/** Distinct stores present in the files, ordered: known stores first
 * (DOC_STORES order), then any unknown stores alphabetically. */
export function storesInFiles(files: DocFile[]): string[] {
  const present = new Set(files.map((f) => f.store).filter(Boolean));
  const known = DOC_STORES.filter((s) => present.has(s));
  const extra = [...present]
    .filter((s) => !(DOC_STORES as readonly string[]).includes(s))
    .sort();
  return [...known, ...extra];
}

/* Build the graph. Only files whose store is in `activeStores` are
 * included; a store hub appears only when at least one of its files is
 * visible. */
export function buildKnowledgeGraph(
  files: DocFile[],
  activeStores: ReadonlySet<string>,
): KnowledgeGraph {
  const nodes: KnowledgeNode[] = [];
  const links: KnowledgeLink[] = [];
  const hubSeen = new Set<string>();

  for (const f of files) {
    if (!f.store || !activeStores.has(f.store)) continue;
    if (!hubSeen.has(f.store)) {
      hubSeen.add(f.store);
      nodes.push({
        id: storeNodeId(f.store),
        type: "store",
        store: f.store,
        label: f.store,
      });
    }
    nodes.push({
      id: fileNodeId(f.path),
      type: "file",
      store: f.store,
      label: f.name,
      path: f.path,
      chunkCount: f.chunks.length,
    });
    links.push({ source: storeNodeId(f.store), target: fileNodeId(f.path) });
  }

  return { nodes, links, stores: storesInFiles(files) };
}
