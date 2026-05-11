/**
 * Canvas color constants for the unified orb.
 * Canvas 2D cannot read CSS custom properties, so these must be literals.
 * They mirror the visual language from the wiki-only orb (Orb.tsx).
 */

import type { UnifiedNodeKind, UnifiedEdgeKind, WikiStatus } from "./types";

// ── Node fill colors ──────────────────────────────────────────────

/** Brainstorm: warm amber */
export const COLOR_BRAINSTORM = "oklch(75% 0.17 60)";
/** Meeting: teal-green */
export const COLOR_MEETING = "oklch(68% 0.14 175)";
/** Project: neutral slate diamond */
export const COLOR_PROJECT = "oklch(58% 0.04 260)";

/** Wiki status colors (same as existing wiki-only orb) */
export const COLOR_WIKI_CANONICAL = "oklch(64% 0.20 295)";
export const COLOR_WIKI_PENDING   = "oklch(72% 0.13 270)";
export const COLOR_WIKI_ARCHIVED  = "oklch(46% 0.011 263)";
export const COLOR_WIKI_DRAFT_RING = "oklch(60% 0.08 270)"; // muted ring for draft variant

// ── Recency glow colors (per node type) ──────────────────────────
export const GLOW_BRAINSTORM = "255, 190, 80";    // amber
export const GLOW_MEETING    = "80, 210, 180";    // teal
export const GLOW_PROJECT    = "140, 155, 180";   // slate
export const GLOW_WIKI       = "168, 116, 240";   // violet (existing orb)

// ── Edge colors ───────────────────────────────────────────────────
export const COLOR_EDGE_LINEAGE     = "oklch(65% 0.18 145)"; // green
export const COLOR_EDGE_CROSS_REF   = "oklch(64% 0.20 295)"; // blue (accent)
export const COLOR_EDGE_SPAWN       = "oklch(62% 0.18 310)"; // purple

// ── Misc ──────────────────────────────────────────────────────────
export const COLOR_LABEL            = "oklch(85% 0.012 250)";
export const COLOR_RECENCY_RING     = "oklch(82% 0.15 80)";  // gold ring (same as existing promoted ring)

// ── Helpers ───────────────────────────────────────────────────────

export function nodeColor(kind: UnifiedNodeKind, wikiStatus?: WikiStatus): string {
  switch (kind) {
    case "brainstorm": return COLOR_BRAINSTORM;
    case "meeting":    return COLOR_MEETING;
    case "project":    return COLOR_PROJECT;
    case "wiki":
      switch (wikiStatus) {
        case "canonical": return COLOR_WIKI_CANONICAL;
        case "pending":   return COLOR_WIKI_PENDING;
        case "archived":  return COLOR_WIKI_ARCHIVED;
        default:          return COLOR_WIKI_PENDING;
      }
  }
}

export function nodeGlowRgb(kind: UnifiedNodeKind): string {
  switch (kind) {
    case "brainstorm": return GLOW_BRAINSTORM;
    case "meeting":    return GLOW_MEETING;
    case "project":    return GLOW_PROJECT;
    case "wiki":       return GLOW_WIKI;
  }
}

export function edgeStrokeColor(kind: UnifiedEdgeKind, alpha: number): string {
  switch (kind) {
    case "lineage":       return edgeOklchToRgba(COLOR_EDGE_LINEAGE,   alpha);
    case "wiki-cross-ref":return edgeOklchToRgba(COLOR_EDGE_CROSS_REF, alpha);
    case "project-spawn": return edgeOklchToRgba(COLOR_EDGE_SPAWN,     alpha);
  }
}

/**
 * Canvas does not render oklch() in strokeStyle in some browsers/runtimes.
 * We provide pre-converted RGBA fallbacks for edge colors.
 */
function edgeOklchToRgba(oklch: string, alpha: number): string {
  // Pre-converted approximate sRGB values for the three edge colors:
  if (oklch === COLOR_EDGE_LINEAGE)     return `rgba(60, 200, 100, ${alpha.toFixed(2)})`;
  if (oklch === COLOR_EDGE_CROSS_REF)   return `rgba(120, 100, 240, ${alpha.toFixed(2)})`;
  if (oklch === COLOR_EDGE_SPAWN)       return `rgba(180, 80, 220, ${alpha.toFixed(2)})`;
  return `rgba(160, 160, 160, ${alpha.toFixed(2)})`;
}
