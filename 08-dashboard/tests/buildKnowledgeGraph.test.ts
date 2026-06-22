import { describe, it, expect } from "vitest";
import {
  buildKnowledgeGraph,
  storesInFiles,
  storeNodeId,
  fileNodeId,
} from "@/src/knowledge/buildKnowledgeGraph";
import type { DocFile } from "@/lib/daemon-client";

const FILES: DocFile[] = [
  {
    store: "docs",
    path: "/p/docs/a.md",
    name: "a.md",
    chunks: [
      { heading: "Intro", line: 1, snippet: "intro" },
      { heading: "Body", line: 5, snippet: "body" },
    ],
  },
  {
    store: "memory",
    path: "/p/memory/m.md",
    name: "m.md",
    chunks: [{ heading: "Rule", line: 1, snippet: "rule" }],
  },
  {
    store: "docs",
    path: "/p/docs/b.md",
    name: "b.md",
    chunks: [{ heading: "B", line: 1, snippet: "b" }],
  },
];

describe("buildKnowledgeGraph", () => {
  it("builds store hubs + file nodes + hub->file links", () => {
    const g = buildKnowledgeGraph(FILES, new Set(["docs", "memory"]));
    const hubs = g.nodes.filter((n) => n.type === "store").map((n) => n.store).sort();
    expect(hubs).toEqual(["docs", "memory"]); // one hub per present store
    const fileNodes = g.nodes.filter((n) => n.type === "file");
    expect(fileNodes).toHaveLength(3);
    /* every file links from its store hub */
    expect(g.links).toContainEqual({
      source: storeNodeId("docs"),
      target: fileNodeId("/p/docs/a.md"),
    });
    /* file node carries the chunk count for sizing/labels */
    const a = fileNodes.find((n) => n.path === "/p/docs/a.md")!;
    expect(a.chunkCount).toBe(2);
    expect(a.label).toBe("a.md");
  });

  it("chip filter excludes a deselected store entirely (hub + files)", () => {
    const g = buildKnowledgeGraph(FILES, new Set(["memory"]));
    expect(g.nodes.some((n) => n.store === "docs")).toBe(false);
    expect(g.nodes.filter((n) => n.type === "file")).toHaveLength(1);
    expect(g.links).toHaveLength(1);
  });

  it("a hub appears only when it has a visible file", () => {
    const g = buildKnowledgeGraph(FILES, new Set());
    expect(g.nodes).toEqual([]);
    expect(g.links).toEqual([]);
    /* but the chip set still reflects every present store */
    expect(g.stores).toEqual(["memory", "docs"]);
  });
});

describe("storesInFiles", () => {
  it("orders known stores first (DOC_STORES order) then extras alphabetically", () => {
    const files: DocFile[] = [
      { store: "bugs", path: "/x/q.md", name: "q.md", chunks: [] },
      { store: "zeta", path: "/x/z.md", name: "z.md", chunks: [] },
      { store: "memory", path: "/x/m.md", name: "m.md", chunks: [] },
      { store: "alpha", path: "/x/a.md", name: "a.md", chunks: [] },
    ];
    expect(storesInFiles(files)).toEqual(["memory", "bugs", "alpha", "zeta"]);
  });

  it("empty input yields no stores", () => {
    expect(storesInFiles([])).toEqual([]);
  });
});
