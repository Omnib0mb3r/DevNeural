"use client";

import { useRouter } from "next/navigation";
import type { ForceUnifiedNode, UnifiedGraphEdge, UnifiedGraphNode } from "./types";

interface SidePanelProps {
  node: ForceUnifiedNode;
  allNodes: UnifiedGraphNode[];
  edges: UnifiedGraphEdge[];
  onClose: () => void;
}

interface ConnectedItem {
  id: string;
  title: string;
  kind: UnifiedGraphNode["kind"];
  edgeKind: string;
  direction: "incoming" | "outgoing";
}

const KIND_LABEL: Record<UnifiedGraphNode["kind"], string> = {
  brainstorm: "Brainstorm",
  wiki:       "Wiki page",
  project:    "Project",
  meeting:    "Meeting",
};

const EDGE_LABEL: Record<string, string> = {
  lineage:        "lineage",
  "wiki-cross-ref": "cross-ref",
  "project-spawn":  "project",
};

function jumpUrl(node: UnifiedGraphNode): string | null {
  switch (node.kind) {
    case "wiki":       return `/wiki?page=${encodeURIComponent(node.id)}`;
    case "brainstorm": return `/brainstorms/${encodeURIComponent(node.id)}`;
    case "meeting":    return `/meetings/${encodeURIComponent(node.id)}`;
    case "project":    return `/projects`;
    default:           return null;
  }
}

export function SidePanel({ node, allNodes, edges, onClose }: SidePanelProps) {
  const router = useRouter();
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  // Collect connected items from edges.
  const connected: ConnectedItem[] = [];
  for (const edge of edges) {
    const srcId = typeof edge.source === "object"
      ? (edge.source as { id: string }).id
      : String(edge.source);
    const tgtId = typeof edge.target === "object"
      ? (edge.target as { id: string }).id
      : String(edge.target);

    if (srcId === node.id) {
      const other = nodeMap.get(tgtId);
      if (other) {
        connected.push({
          id: other.id,
          title: other.title,
          kind: other.kind,
          edgeKind: edge.kind,
          direction: "outgoing",
        });
      }
    } else if (tgtId === node.id) {
      const other = nodeMap.get(srcId);
      if (other) {
        connected.push({
          id: other.id,
          title: other.title,
          kind: other.kind,
          edgeKind: edge.kind,
          direction: "incoming",
        });
      }
    }
  }

  // Also pull source_brainstorms / source_meetings from the wiki node's own metadata.
  if (node.kind === "wiki") {
    const existing = new Set(connected.map((c) => c.id));
    for (const bId of node.source_brainstorms ?? []) {
      if (existing.has(bId)) continue;
      const other = nodeMap.get(bId);
      if (!other) continue;
      connected.push({ id: bId, title: other.title, kind: other.kind, edgeKind: "lineage", direction: "incoming" });
    }
    for (const mId of node.source_meetings ?? []) {
      if (existing.has(mId)) continue;
      const other = nodeMap.get(mId);
      if (!other) continue;
      connected.push({ id: mId, title: other.title, kind: other.kind, edgeKind: "lineage", direction: "incoming" });
    }
  }

  // Group by kind.
  const groups: Partial<Record<UnifiedGraphNode["kind"], ConnectedItem[]>> = {};
  for (const item of connected) {
    (groups[item.kind] ??= []).push(item);
  }

  const orderedKinds: UnifiedGraphNode["kind"][] = ["wiki", "brainstorm", "project", "meeting"];

  return (
    <aside
      className="absolute top-0 right-0 h-full w-72 bg-surface1/95 hairline-l backdrop-blur-sm flex flex-col z-20"
      role="complementary"
      aria-label={`Connections for ${node.title}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-3 border-b border-border/30">
        <div>
          <div className="text-nano text-txt3 uppercase tracking-wide mb-0.5">
            {KIND_LABEL[node.kind]}
          </div>
          <div className="font-display font-emphasized text-txt1 text-sm leading-snug">
            {node.title}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="text-txt3 hover:text-txt1 mt-0.5 shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Jump link for the node itself */}
      {jumpUrl(node) && (
        <div className="px-4 pt-3">
          <button
            type="button"
            onClick={() => router.push(jumpUrl(node)!)}
            className="text-xs text-brandSoft hover:text-brand transition"
          >
            Open {KIND_LABEL[node.kind].toLowerCase()} -&gt;
          </button>
        </div>
      )}

      {/* Connected items */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
        {connected.length === 0 && (
          <p className="text-xs text-txt3">No direct connections.</p>
        )}
        {orderedKinds.map((k) => {
          const items = groups[k];
          if (!items?.length) return null;
          return (
            <section key={k}>
              <h3 className="text-nano text-txt3 uppercase tracking-wide mb-1.5">
                {KIND_LABEL[k]}s ({items.length})
              </h3>
              <ul className="space-y-1">
                {items.map((item) => {
                  const url = jumpUrl(item as unknown as UnifiedGraphNode);
                  return (
                    <li key={item.id + item.edgeKind + item.direction}>
                      <button
                        type="button"
                        onClick={() => url && router.push(url)}
                        className="w-full text-left group flex items-start gap-2 rounded-soft px-2 py-1.5 hover:bg-surface2 transition"
                        disabled={!url}
                      >
                        <span className="text-nano text-txt3 mt-0.5 shrink-0">
                          {item.direction === "incoming" ? "from" : "to"}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="text-xs text-txt1 group-hover:text-brand transition leading-snug block truncate">
                            {item.title}
                          </span>
                          <span className="text-nano text-txt4">
                            {EDGE_LABEL[item.edgeKind] ?? item.edgeKind}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
