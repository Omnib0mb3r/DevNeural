"use client";

/**
 * Knowledge-index orb (DRIVE-QUEUE 2B): the visual browse front over the
 * unified knowledge index. PROJECT-SCOPED (strictScope) - shows ONE
 * project's indexed markdown, grouped into store hubs (memory, docs,
 * brainstorm, spec, bugs, ...). Filter CHIPS toggle stores. Clicking a
 * file node opens its pointer (path + chunk headings / lines / snippets).
 *
 * Additive: a standalone view at /knowledge. It does not touch the
 * existing unified orb (/orb) or any other panel. Reuses the orb's
 * generic OrbCanvas (react-force-graph-2d) and visual language.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { projects, docIndex, type DocFile } from "@/lib/daemon-client";
import type { OrbCanvasMethods } from "@/components/OrbCanvas";
import {
  buildKnowledgeGraph,
  storeColor,
  fileNodeId,
  type KnowledgeNode,
} from "./buildKnowledgeGraph";

const OrbCanvas = dynamic(() => import("@/components/OrbCanvas"), {
  ssr: false,
  loading: () => null,
});

type ForceKNode = KnowledgeNode & { x?: number; y?: number };

function pickDefaultProject(list: { id: string; name: string }[]): string {
  const dev = list.find(
    (p) =>
      p.id.toLowerCase().includes("devneural") ||
      (p.name ?? "").toLowerCase().includes("devneural"),
  );
  return dev?.id ?? list[0]?.id ?? "";
}

export function KnowledgeOrb() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<OrbCanvasMethods | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [projectId, setProjectId] = useState<string>("");
  const [active, setActive] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<DocFile | null>(null);

  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: projects });
  const projectList = projectsQ.data?.projects ?? [];

  // Default the project once the list loads (DevNeural first).
  useEffect(() => {
    if (!projectId && projectList.length > 0) {
      setProjectId(pickDefaultProject(projectList));
    }
  }, [projectId, projectList]);

  const docQ = useQuery({
    queryKey: ["doc-index", projectId],
    queryFn: () => docIndex(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 30_000,
  });
  const files = useMemo(() => docQ.data?.files ?? [], [docQ.data]);

  // Default every present store to active when the file set changes.
  const stores = useMemo(
    () => buildKnowledgeGraph(files, new Set()).stores,
    [files],
  );
  useEffect(() => {
    setActive(new Set(stores));
    setSelected(null);
  }, [stores]);

  const graph = useMemo(
    () => buildKnowledgeGraph(files, active),
    [files, active],
  );

  // Size measurement (mirrors the orb).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function toggleStore(s: string) {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function onNodeClick(raw: object) {
    const n = raw as ForceKNode;
    if (n.type !== "file" || !n.path) return;
    setSelected(files.find((f) => f.path === n.path) ?? null);
  }

  function drawNode(raw: object, ctx: CanvasRenderingContext2D, scale: number) {
    const n = raw as ForceKNode;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const isHub = n.type === "store";
    const r = isHub ? 6 : 3.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = storeColor(n.store);
    ctx.globalAlpha = isHub ? 1 : 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    const sel = selected && n.type === "file" && n.path === selected.path;
    if (isHub || sel || scale > 3) {
      ctx.fillStyle = "oklch(85% 0.012 250)";
      ctx.font = `${isHub ? 5 : 3.5}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.fillText(n.label, x, y + r + (isHub ? 6 : 4));
    }
  }

  const loading = projectsQ.isLoading || (Boolean(projectId) && docQ.isLoading);
  const empty = !loading && files.length === 0;

  return (
    <div className="relative h-full w-full overflow-hidden flex flex-col">
      {/* Controls */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2 rounded-panel bg-surface1/80 hairline px-3 py-1.5 backdrop-blur-sm">
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="font-mono text-nano bg-surface2 text-txt1 rounded-pill px-2 py-0.5 hairline"
          aria-label="project"
        >
          {projectList.length === 0 && <option value="">no projects</option>}
          {projectList.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? p.id}
            </option>
          ))}
        </select>
        <span className="w-px h-4 bg-border/40 mx-1" />
        {stores.length === 0 && (
          <span className="font-mono text-nano text-txt3">no indexed docs</span>
        )}
        {stores.map((s) => {
          const on = active.has(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStore(s)}
              aria-pressed={on}
              className={`font-mono px-2 py-0.5 rounded-pill text-nano transition ${
                on
                  ? "text-txt1 ring-1"
                  : "text-txt3 hover:text-txt1 ring-1 ring-transparent"
              }`}
              style={
                on
                  ? { color: storeColor(s), boxShadow: `inset 0 0 0 1px ${storeColor(s)}` }
                  : undefined
              }
            >
              {s}
            </button>
          );
        })}
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 relative">
        {empty && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="rounded-panel bg-surface1 hairline px-8 py-7 max-w-md text-center pointer-events-auto">
              <div className="font-display text-xl font-emphasized mb-2">
                Nothing indexed yet
              </div>
              <p className="text-txt3 text-sm">
                Run the knowledge index for this project (POST
                /lex/index-docs) and start the watcher. The map fills in as
                docs are indexed.
              </p>
            </div>
          </div>
        )}
        {size.w > 0 && size.h > 0 && graph.nodes.length > 0 && (
          <OrbCanvas
            key={`${projectId}:${Math.round(size.w / 24)}x${Math.round(size.h / 24)}`}
            ref={fgRef}
            graphData={graph as unknown as { nodes: object[]; links: object[] }}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            nodeId="id"
            nodeRelSize={1}
            nodeVal={((n: object) => ((n as ForceKNode).type === "store" ? 36 : 10)) as never}
            nodeLabel={(() => "") as never}
            nodeCanvasObjectMode={(() => "replace") as never}
            nodeCanvasObject={drawNode as never}
            onNodeClick={onNodeClick as never}
            linkColor={(() => "rgba(150,150,170,0.25)") as never}
            cooldownTicks={120}
          />
        )}
      </div>

      {/* Side panel: file pointer */}
      {selected && (
        <div className="absolute top-3 right-3 z-10 w-80 max-h-[80%] overflow-auto rounded-panel bg-surface1/95 hairline px-4 py-3 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div
                className="font-mono text-nano uppercase tracking-wide"
                style={{ color: storeColor(selected.store) }}
              >
                {selected.store}
              </div>
              <div className="font-display text-sm font-emphasized truncate">
                {selected.name}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="font-mono text-nano text-txt3 hover:text-txt1"
              aria-label="close"
            >
              close
            </button>
          </div>
          <div className="font-mono text-nano text-txt3 mt-1 break-all">
            {selected.path}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {selected.chunks.map((c, i) => (
              <div key={`${c.line}:${i}`} className="rounded bg-surface2/60 px-2 py-1.5">
                <div className="font-mono text-nano text-txt2">
                  {c.heading || "(preamble)"}{" "}
                  <span className="text-txt3">L{c.line}</span>
                </div>
                <div className="text-xs text-txt2 mt-0.5 line-clamp-3">
                  {c.snippet}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
