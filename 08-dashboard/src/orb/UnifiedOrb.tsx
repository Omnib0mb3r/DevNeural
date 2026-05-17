"use client";

/**
 * UnifiedOrb - extends the existing react-force-graph-2d canvas renderer
 * to display 4 node kinds: brainstorm, wiki, project, meeting.
 *
 * Visual idiom preserved from Orb.tsx (breathing glow, heat edges,
 * bezier particles). New additions:
 *   - 4 node shapes/colors
 *   - Filter chips per kind
 *   - Double-click side panel with connection list + click-to-jump
 *   - Recency glow per node kind
 *
 * TODO: add orb-level search (filter nodes by title match) and keyboard nav
 * (arrow keys to hop between connected nodes, Enter to open side panel).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { graphUnified } from "@/lib/daemon-client";
import type { OrbCanvasMethods } from "@/components/OrbCanvas";
import {
  nodeColor,
  nodeGlowRgb,
  edgeStrokeColor,
  COLOR_LABEL,
  COLOR_RECENCY_RING,
  COLOR_WIKI_DRAFT_RING,
} from "./colors";
import { FilterChips, type FilterState } from "./FilterChips";
import { SidePanel } from "./SidePanel";
import type { ForceUnifiedNode, ForceUnifiedLink, UnifiedGraphNode, UnifiedGraphEdge } from "./types";

const OrbCanvas = dynamic(() => import("@/components/OrbCanvas"), {
  ssr: false,
  loading: () => <OrbSkeleton />,
});

// ── Breathing / hash helpers (mirrored from Orb.tsx) ─────────────

function breathe(phase: number, low = 0.85, high = 1.15): number {
  const t = (Date.now() / 3500 + phase) * Math.PI * 2;
  return low + (Math.sin(t) * 0.5 + 0.5) * (high - low);
}

function edgeBreathe(phase: number): number {
  const t = (Date.now() / 5000 + phase) * Math.PI * 2;
  return 0.85 + (Math.sin(t) * 0.5 + 0.5) * 0.15;
}

function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function nodeRadius(weight: number): number {
  return 2.5 + Math.max(0, Math.min(1, weight)) * 5;
}

function isRecentlyActive(node: UnifiedGraphNode): boolean {
  if (!node.last_active) return false;
  const ms = Date.now() - new Date(node.last_active).getTime();
  return ms >= 0 && ms <= 24 * 60 * 60 * 1000;
}

// ── Rank-normalise edge weights (same logic as Orb.tsx) ──────────

function rankNormalize(edges: UnifiedGraphEdge[]): Map<number, number> {
  const sorted = edges
    .map((e, i) => ({ i, w: typeof e.weight === "number" ? e.weight : 0 }))
    .sort((a, b) => a.w - b.w);
  const rankOf = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    if (!entry) continue;
    let lo = i, hi = i;
    while (lo > 0 && sorted[lo - 1]?.w === entry.w) lo -= 1;
    while (hi < sorted.length - 1 && sorted[hi + 1]?.w === entry.w) hi += 1;
    const avgRank = (lo + hi) / 2;
    const denom = Math.max(1, sorted.length - 1);
    rankOf.set(entry.i, avgRank / denom);
  }
  return rankOf;
}

// ── Edge heat (reused from Orb.tsx) ──────────────────────────────

function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

function hexToRgba(hex: number, alpha: number): string {
  return `rgba(${(hex >> 16) & 0xff}, ${(hex >> 8) & 0xff}, ${hex & 0xff}, ${alpha})`;
}

function edgeHeatColor(w: number): string {
  const clamped = Math.max(0, Math.min(1, w));
  let hex: number;
  if (clamped < 0.25)      hex = lerpHex(0x0d1f5c, 0x1a5faa, clamped / 0.25);
  else if (clamped < 0.5)  hex = lerpHex(0x1a5faa, 0x22bbcc, (clamped - 0.25) / 0.25);
  else if (clamped < 0.75) hex = lerpHex(0x22bbcc, 0xeecc22, (clamped - 0.5)  / 0.25);
  else                     hex = lerpHex(0xeecc22, 0xff4411, (clamped - 0.75) / 0.25);
  const alpha = 0.32 + clamped * 0.55;
  return hexToRgba(hex, alpha);
}

// ── Component ─────────────────────────────────────────────────────

const DEFAULT_FILTERS: FilterState = {
  brainstorm: true,
  wiki:       true,
  project:    true,
  meeting:    true,
};

export function UnifiedOrb() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<OrbCanvasMethods | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hovered, setHovered] = useState<ForceUnifiedNode | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [showLabels, setShowLabels] = useState(false);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sidePanelNode, setSidePanelNode] = useState<ForceUnifiedNode | null>(null);
  const lastClickRef = useRef<{ id: string; ts: number } | null>(null);

  // Size measurement (mirrors Orb.tsx pattern).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    let stop = false;
    const start = performance.now();
    const loop = () => {
      if (stop) return;
      measure();
      if (performance.now() - start < 5000) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { stop = true; ro.disconnect(); };
  }, []);

  const q = useQuery({
    queryKey: ["graph-unified"],
    queryFn: graphUnified,
    refetchInterval: 30_000,
  });

  // Filter nodes and links based on chip state.
  const graphData = useMemo(() => {
    const rawNodes = (q.data?.nodes ?? []).filter((n) => filters[n.kind]);
    const rawEdges = q.data?.edges ?? [];
    const nodeSet = new Set(rawNodes.map((n) => n.id));
    // Only include edges where both endpoints are visible.
    const visibleEdges = rawEdges.filter(
      (e) => nodeSet.has(String(e.source)) && nodeSet.has(String(e.target)),
    );
    const rankOf = rankNormalize(visibleEdges);
    const nodes: ForceUnifiedNode[] = rawNodes.map((n) => ({ ...n }));
    const links: ForceUnifiedLink[] = visibleEdges.map((e, idx) => ({
      source: String(e.source),
      target: String(e.target),
      kind: e.kind,
      weight: rankOf.get(idx) ?? 0.5,
    }));
    return { nodes, links };
  }, [q.data, filters]);

  // Refs so canvas callbacks read current state without re-mounting.
  const graphDataRef = useRef(graphData);
  const connectedIdsRef = useRef<Set<string>>(new Set());
  const hoveredIdRef = useRef<string | null>(null);
  const showLabelsRef = useRef(false);
  useEffect(() => { graphDataRef.current = graphData; }, [graphData]);
  useEffect(() => {
    hoveredIdRef.current = hovered?.id ?? null;
  }, [hovered]);
  useEffect(() => {
    showLabelsRef.current = showLabels;
    const ids = new Set<string>();
    for (const l of graphData.links) {
      const sId = typeof l.source === "object" ? (l.source as ForceUnifiedNode).id : String(l.source);
      const tId = typeof l.target === "object" ? (l.target as ForceUnifiedNode).id : String(l.target);
      ids.add(sId);
      ids.add(tId);
    }
    connectedIdsRef.current = ids;
  }, [showLabels, graphData]);

  // d3-force tuning (mirrors Orb.tsx).
  const tuneForces = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    try {
      const charge = fg.d3Force("charge") as { strength?: (s: number) => unknown } | undefined;
      if (charge?.strength) charge.strength(-30);
      const center = fg.d3Force("center") as { strength?: (s: number) => unknown } | undefined;
      if (center?.strength) center.strength(0.35);
      const link = fg.d3Force("link") as {
        distance?: (d: ((l: { weight?: number }) => number) | number) => unknown;
        strength?: (s: ((l: { weight?: number }) => number) | number) => unknown;
      } | undefined;
      if (link) {
        if (link.distance) link.distance(((l: { weight?: number }) => 22 + (1 - (l.weight ?? 0.5)) * 18) as never);
        if (link.strength) link.strength(((l: { weight?: number }) => 0.4 + (l.weight ?? 0.5) * 0.5) as never);
      }
      type FN = ForceUnifiedNode & { vx?: number; vy?: number };
      const isolationPull = (alpha: number) => {
        const nds = (graphDataRef.current.nodes as FN[]) ?? [];
        const connected = connectedIdsRef.current;
        for (const n of nds) {
          if (connected.has(n.id)) continue;
          if (typeof n.x !== "number" || typeof n.y !== "number") continue;
          n.vx = (n.vx ?? 0) + -n.x * 0.22 * alpha;
          n.vy = (n.vy ?? 0) + -n.y * 0.22 * alpha;
        }
      };
      const globalGravity = (alpha: number) => {
        const nds = (graphDataRef.current.nodes as FN[]) ?? [];
        for (const n of nds) {
          if (typeof n.x !== "number" || typeof n.y !== "number") continue;
          n.vx = (n.vx ?? 0) + -n.x * 0.04 * alpha;
          n.vy = (n.vy ?? 0) + -n.y * 0.04 * alpha;
        }
      };
      fg.d3Force("isolation-pull", isolationPull as unknown);
      fg.d3Force("global-gravity", globalGravity as unknown);
    } catch { /* best-effort */ }
  }, []);

  const userInteractedRef = useRef(false);
  const frame = useCallback(() => {
    const fg = fgRef.current;
    if (!fg || userInteractedRef.current) return;
    if (size.w === 0 || size.h === 0) return;
    try {
      const nodes = graphData.nodes as ForceUnifiedNode[];
      const links = graphData.links;
      const connectedIds = new Set<string>();
      for (const l of links) {
        const sId = typeof l.source === "object" ? (l.source as ForceUnifiedNode).id : String(l.source);
        const tId = typeof l.target === "object" ? (l.target as ForceUnifiedNode).id : String(l.target);
        connectedIds.add(sId);
        connectedIds.add(tId);
      }
      const target = connectedIds.size >= 2
        ? nodes.filter((n) => connectedIds.has(n.id))
        : nodes;
      if (target.length === 0) { fg.zoomToFit(400, 16); return; }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let any = false;
      for (const n of target) {
        if (typeof n.x !== "number" || typeof n.y !== "number") continue;
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
        any = true;
      }
      if (!any) { fg.zoomToFit(400, 16); return; }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const w = Math.max(maxX - minX, 1) * 1.2 + 32;
      const h = Math.max(maxY - minY, 1) * 1.2 + 32;
      const targetZoom = Math.min(size.w / w, size.h / h, 4);
      fg.centerAt(cx, cy, 600);
      fg.zoom(targetZoom, 600);
    } catch { /* best-effort */ }
  }, [graphData, size.w, size.h]);

  const nodeCount = graphData.nodes.length;
  const edgeCount = graphData.links.length;

  useEffect(() => {
    if (nodeCount === 0 || size.w === 0 || size.h === 0) return;
    userInteractedRef.current = false;
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const armOnReady = () => {
      if (cancelled) return;
      const fg = fgRef.current;
      if (!fg) { timeouts.push(setTimeout(armOnReady, 80)); return; }
      tuneForces();
      timeouts.push(setTimeout(frame, 60));
      timeouts.push(setTimeout(frame, 400));
      timeouts.push(setTimeout(frame, 1500));
      timeouts.push(setTimeout(frame, 3000));
    };
    armOnReady();
    return () => { cancelled = true; for (const t of timeouts) clearTimeout(t); };
  }, [nodeCount, edgeCount, size.w, size.h, tuneForces, frame]);

  // ── Draw callbacks ────────────────────────────────────────────────

  const drawNode = useCallback(
    (raw: ForceUnifiedNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = raw.x ?? 0;
      const y = raw.y ?? 0;
      const phase = strHash(raw.id);
      const r = nodeRadius(raw.weight);
      const fillColor = nodeColor(raw.kind, raw.wiki_status);
      const glowRgb = nodeGlowRgb(raw.kind);

      // Outer glow (breathing, intensity by kind/status).
      const glowMul = raw.kind === "wiki" && raw.wiki_status === "archived" ? 0
        : raw.kind === "wiki" && raw.wiki_status === "pending" ? 0.4
        : 0.8;
      if (glowMul > 0) {
        const glowR = r * 1.7 * breathe(phase, 0.92, 1.08);
        const grad = ctx.createRadialGradient(x, y, r * 0.85, x, y, glowR);
        grad.addColorStop(0, `rgba(${glowRgb}, ${(0.22 * glowMul).toFixed(3)})`);
        grad.addColorStop(0.6, `rgba(${glowRgb}, ${(0.08 * glowMul).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${glowRgb}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, Math.PI * 2, false);
        ctx.fill();
      }

      // Core shape.
      const coreR = r * breathe(phase, 0.95, 1.06);
      ctx.fillStyle = fillColor;

      if (raw.kind === "project") {
        // Diamond shape for project nodes.
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-coreR * 0.75, -coreR * 0.75, coreR * 1.5, coreR * 1.5);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, coreR, 0, Math.PI * 2, false);
        ctx.fill();
      }

      // Meeting: dashed outer ring.
      if (raw.kind === "meeting") {
        ctx.save();
        ctx.setLineDash([2 / globalScale, 2 / globalScale]);
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, Math.PI * 2, false);
        ctx.lineWidth = 1 / Math.max(0.001, globalScale);
        ctx.strokeStyle = fillColor;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Wiki draft: muted ring variant.
      if (raw.kind === "wiki" && raw.is_draft) {
        ctx.beginPath();
        ctx.arc(x, y, r + 1.5, 0, Math.PI * 2, false);
        ctx.lineWidth = 1 / Math.max(0.001, globalScale);
        ctx.strokeStyle = COLOR_WIKI_DRAFT_RING;
        ctx.stroke();
      }

      // Recency glow: animated expanding ring (same pattern as isRecentlyPromoted).
      if (isRecentlyActive(raw)) {
        const t = ((Date.now() / 2400 + phase) % 1);
        const ringR = r + 2.5 + t * 9;
        const alpha = 1 - t;
        ctx.beginPath();
        ctx.arc(x, y, ringR, 0, Math.PI * 2, false);
        ctx.lineWidth = 1.4 / Math.max(0.001, globalScale);
        ctx.strokeStyle = `rgba(${glowRgb}, ${alpha.toFixed(2)})`;
        ctx.stroke();
        // Static inner ring.
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, Math.PI * 2, false);
        ctx.lineWidth = 1.2 / Math.max(0.001, globalScale);
        ctx.strokeStyle = `rgba(${glowRgb}, 0.8)`;
        ctx.stroke();
      }

      // Label on hover or toggle.
      const isHovered = hoveredIdRef.current === raw.id;
      if (showLabelsRef.current || isHovered) {
        const fontSize = Math.max(8, (isHovered ? 12 : 10) / globalScale * 1.3);
        ctx.font = `${isHovered ? "600 " : ""}${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = raw.title.length > 60 ? raw.title.slice(0, 57) + "..." : raw.title;
        if (isHovered) {
          const w = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
          ctx.fillRect(x - w / 2 - 4, y + r + 1, w + 8, fontSize + 4);
        }
        ctx.fillStyle = COLOR_LABEL;
        ctx.fillText(label, x, y + r + 3);
      }
    },
    [],
  );

  const onNodeHover = useCallback((n: ForceUnifiedNode | null) => {
    setHovered(n ?? null);
  }, []);

  // Single-click selects, double-click opens side panel.
  const onNodeClick = useCallback((n: ForceUnifiedNode) => {
    const now = Date.now();
    const last = lastClickRef.current;
    if (last && last.id === n.id && now - last.ts < 400) {
      // Double-click.
      setSidePanelNode(n);
      lastClickRef.current = null;
    } else {
      lastClickRef.current = { id: n.id, ts: now };
    }
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const markInteracted = useCallback(() => { userInteractedRef.current = true; }, []);

  const isEmpty = !q.isLoading && !q.isError && (q.data?.nodes.length ?? 0) === 0;

  // The complete raw edge list for the side panel (unfiltered by kind, but
  // still filtered by active nodes so the panel only lists visible connections).
  const visibleNodeIds = useMemo(
    () => new Set(graphData.nodes.map((n) => n.id)),
    [graphData.nodes],
  );
  const panelEdges = useMemo(
    () => (q.data?.edges ?? []).filter(
      (e) => visibleNodeIds.has(String(e.source)) && visibleNodeIds.has(String(e.target)),
    ),
    [q.data?.edges, visibleNodeIds],
  );

  return (
    <div
      className="relative h-full w-full overflow-hidden flex flex-col"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* Controls bar */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-panel bg-surface1/80 hairline px-3 py-1.5 backdrop-blur-sm">
        <FilterChips filters={filters} onChange={setFilters} />
        <span className="w-px h-4 bg-border/40 mx-1" />
        <button
          type="button"
          onClick={() => setShowLabels((v) => !v)}
          aria-pressed={showLabels}
          className={`font-mono px-2 py-0.5 text-nano rounded-pill transition ${
            showLabels ? "bg-brand/20 text-brandSoft ring-1 ring-brand/40" : "text-txt3 hover:text-txt1"
          }`}
        >
          labels
        </button>
        <button
          type="button"
          onClick={() => { userInteractedRef.current = false; frame(); }}
          className="font-mono px-2 py-0.5 text-nano rounded-pill text-txt3 hover:text-txt1"
        >
          recenter
        </button>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="flex-1 relative"
        onMouseMove={onMouseMove}
        onWheel={markInteracted}
        onMouseDown={markInteracted}
        onTouchStart={markInteracted}
      >
        {q.isLoading && <OrbSkeleton />}
        {q.isError && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="rounded-panel bg-surface1 hairline px-6 py-5 text-sm text-txt3 pointer-events-auto">
              Failed to load graph. The daemon may be offline.
            </div>
          </div>
        )}
        {isEmpty && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="rounded-panel bg-surface1 hairline px-8 py-7 max-w-md text-center pointer-events-auto">
              <div className="font-display text-xl font-emphasized mb-2">An empty mind</div>
              <p className="text-txt3 text-sm">
                Start brainstorming and promoting wiki pages. The graph fills in as content grows.
              </p>
            </div>
          </div>
        )}
        {size.w > 0 && size.h > 0 && graphData.nodes.length > 0 && (
          <OrbCanvas
            key={`${Math.round(size.w / 24)}x${Math.round(size.h / 24)}`}
            ref={fgRef}
            graphData={graphData as unknown as { nodes: object[]; links: object[] }}
            width={size.w}
            height={size.h}
            onEngineStop={frame as never}
            backgroundColor="rgba(0,0,0,0)"
            nodeRelSize={1}
            nodeId="id"
            nodeVal={((n: object) => Math.max(1, nodeRadius((n as ForceUnifiedNode).weight))) as never}
            nodeLabel={(() => "") as never}
            nodeCanvasObjectMode={(() => "replace") as never}
            nodeCanvasObject={
              ((raw: object, ctx: CanvasRenderingContext2D, scale: number) =>
                drawNode(raw as ForceUnifiedNode, ctx, scale)) as never
            }
            linkCanvasObjectMode={(() => "replace") as never}
            linkCanvasObject={
              ((raw: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
                const link = raw as ForceUnifiedLink & {
                  source: ForceUnifiedNode;
                  target: ForceUnifiedNode;
                };
                if (typeof link.source !== "object" || typeof link.target !== "object") return;
                const sx = link.source.x ?? 0;
                const sy = link.source.y ?? 0;
                const tx = link.target.x ?? 0;
                const ty = link.target.y ?? 0;
                const w = link.weight ?? 0.5;
                const srcId = link.source.id;
                const tgtId = link.target.id;
                const isHoveredEdge = hovered != null && (srcId === hovered.id || tgtId === hovered.id);

                const phase = strHash(`${srcId}~${tgtId}`);
                const sign = phase > 0.5 ? 1 : -1;
                const curvature = sign * (0.05 + (1 - w) * 0.18);
                const dx = tx - sx;
                const dy = ty - sy;
                const cpx = (sx + tx) / 2 + -dy * curvature;
                const cpy = (sy + ty) / 2 + dx * curvature;

                // Use kind-specific color when available, fallback to heat gradient.
                const ebb = edgeBreathe(strHash(`${srcId}->${tgtId}`));
                const baseAlpha = (0.32 + w * 0.55) * ebb;
                const stroke = isHoveredEdge
                  ? "rgba(240, 245, 255, 0.85)"
                  : link.kind
                    ? edgeStrokeColor(link.kind, baseAlpha)
                    : edgeHeatColor(w);

                const screenPx = isHoveredEdge ? 2.0 : 0.8 + Math.max(0, Math.min(1, w)) * 1.6;
                ctx.lineWidth = screenPx / Math.max(0.0001, globalScale);
                ctx.strokeStyle = stroke;
                ctx.lineCap = "round";
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.quadraticCurveTo(cpx, cpy, tx, ty);
                ctx.stroke();

                // Flowing particles along the bezier.
                const particleCount = Math.max(1, Math.round(w * 4));
                const secsPerLap = 4.5 - w * 2.5;
                const tNow = (Date.now() / 1000) / secsPerLap;
                const dotR = (1.4 + w * 1.6) / Math.max(0.0001, globalScale);
                ctx.fillStyle = stroke;
                for (let i = 0; i < particleCount; i++) {
                  const offset = i / particleCount;
                  const t = (tNow + offset) % 1;
                  const u = 1 - t;
                  const px = u * u * sx + 2 * u * t * cpx + t * t * tx;
                  const py = u * u * sy + 2 * u * t * cpy + t * t * ty;
                  ctx.beginPath();
                  ctx.arc(px, py, dotR, 0, Math.PI * 2, false);
                  ctx.fill();
                }
              }) as never
            }
            linkCurvature={
              ((l: object) => {
                const link = l as ForceUnifiedLink;
                const w = link.weight ?? 0.5;
                const srcId = typeof link.source === "object" ? (link.source as ForceUnifiedNode).id : String(link.source);
                const tgtId = typeof link.target === "object" ? (link.target as ForceUnifiedNode).id : String(link.target);
                const phase = strHash(`${srcId}~${tgtId}`);
                const sign = phase > 0.5 ? 1 : -1;
                return sign * (0.05 + (1 - w) * 0.18);
              }) as never
            }
            linkDirectionalParticles={0 as never}
            cooldownTicks={Infinity}
            cooldownTime={Infinity}
            warmupTicks={120}
            d3AlphaDecay={0.0008}
            d3VelocityDecay={0.55}
            onNodeClick={((n: object) => onNodeClick(n as ForceUnifiedNode)) as never}
            onNodeHover={((n: object | null) => onNodeHover(n as ForceUnifiedNode | null)) as never}
            enableNodeDrag={true}
            enablePointerInteraction={true}
            minZoom={0.3}
            maxZoom={6}
          />
        )}

        {/* Hover tooltip */}
        {hovered && !sidePanelNode && (
          <div
            className="pointer-events-none absolute z-10 rounded-panel bg-surface2 hairline px-3 py-2 text-xs"
            style={{
              left: Math.min(pointer.x + 12, size.w - 240),
              top: Math.min(pointer.y + 12, size.h - 80),
              maxWidth: 240,
            }}
          >
            <div className="font-display font-emphasized text-txt1 mb-0.5 leading-snug">
              {hovered.title}
            </div>
            <div className="flex items-center gap-2 text-txt3 text-nano">
              <span className="capitalize">{hovered.kind}</span>
              {hovered.wiki_status && <span>{hovered.wiki_status}</span>}
              {hovered.project_slug && <span>{hovered.project_slug}</span>}
            </div>
            <div className="text-nano text-txt4 mt-0.5">double-click to see connections</div>
          </div>
        )}
      </div>

      {/* Legend — in flex flow so canvas reserves space and legend stays clipped to panel bottom on mobile */}
      <div className="shrink-0 self-start mx-3 mb-3 rounded-panel bg-surface1/80 hairline px-3 py-2 text-nano text-txt3 backdrop-blur-sm flex items-center gap-x-3 gap-y-1 flex-wrap z-10">
        <LegendDot color="oklch(75% 0.17 60)" label="brainstorm" />
        <LegendDot color="oklch(64% 0.20 295)" label="wiki" />
        <LegendDot color="oklch(58% 0.04 260)" label="project" diamond />
        <LegendDot color="oklch(68% 0.14 175)" label="meeting" dashed />
        <span className="w-px h-4 bg-border/40 mx-1" />
        <LegendLine color="rgba(60,200,100,0.8)" label="lineage" />
        <LegendLine color="rgba(120,100,240,0.8)" label="cross-ref" />
        <LegendLine color="rgba(180,80,220,0.8)" label="project" />
      </div>

      {/* Side panel */}
      {sidePanelNode && (
        <SidePanel
          node={sidePanelNode}
          allNodes={q.data?.nodes ?? []}
          edges={panelEdges}
          onClose={() => setSidePanelNode(null)}
        />
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function LegendDot({
  color, label, diamond, dashed,
}: {
  color: string;
  label: string;
  diamond?: boolean;
  dashed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {diamond ? (
        <span
          className="inline-block h-2.5 w-2.5 shrink-0"
          style={{
            background: color,
            transform: "rotate(45deg)",
            borderRadius: "1px",
            width: "8px",
            height: "8px",
          }}
        />
      ) : (
        <span
          className="inline-block h-2 w-2 rounded-full shrink-0"
          style={{
            background: color,
            boxShadow: dashed ? `0 0 0 1.5px ${color}` : undefined,
            outline: dashed ? `1.5px dashed ${color}` : undefined,
            outlineOffset: "1.5px",
          }}
        />
      )}
      {label}
    </span>
  );
}

function LegendLine({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block w-4 h-0.5 shrink-0 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function OrbSkeleton() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="relative">
        <div
          className="h-40 w-40 rounded-full opacity-40"
          style={{
            background: "radial-gradient(closest-side, oklch(64% 0.20 295), transparent 70%)",
            filter: "blur(8px)",
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center text-nano text-txt3">
          loading orb
        </div>
      </div>
    </div>
  );
}
