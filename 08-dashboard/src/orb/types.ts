/**
 * Shared types for the unified orb graph.
 * Mirrors the daemon's UnifiedGraphPayload shape for client-side use.
 */

export type UnifiedNodeKind = "brainstorm" | "wiki" | "project" | "meeting";
export type UnifiedEdgeKind = "lineage" | "wiki-cross-ref" | "project-spawn";
export type WikiStatus = "canonical" | "pending" | "archived";

export interface UnifiedGraphNode {
  id: string;
  kind: UnifiedNodeKind;
  title: string;
  weight: number;
  last_active: string;
  // wiki-specific
  wiki_status?: WikiStatus;
  is_draft?: boolean;
  source_brainstorms?: string[];
  source_meetings?: string[];
  // brainstorm/meeting-specific
  project_slug?: string | null;
}

export interface UnifiedGraphEdge {
  source: string;
  target: string;
  kind: UnifiedEdgeKind;
  weight: number;
}

export interface UnifiedGraphResponse {
  ok: boolean;
  nodes: UnifiedGraphNode[];
  edges: UnifiedGraphEdge[];
}

/** Node as it appears after force-graph hydrates position. */
export interface ForceUnifiedNode extends UnifiedGraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export interface ForceUnifiedLink {
  source: string | ForceUnifiedNode;
  target: string | ForceUnifiedNode;
  kind?: UnifiedEdgeKind;
  weight?: number;
}
