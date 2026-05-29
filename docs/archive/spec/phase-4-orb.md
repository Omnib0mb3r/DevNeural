# Phase 4: Orb rebind and visual features

> Status: tabled. Picked up after phase 3 (dashboard) is complete and the wiki has accumulated real content to look at.
> Last updated: 2026-05-02.

The orb in `03-web-app/` was built against the v1 weights graph (nodes = projects/skills/tools, edges = co-occurrence). v2 changes the underlying graph entirely. This document captures the rework scope and the feature list discussed before phase 3 starts.

---

## Data model change

**v1:**
```
node = { id, type: "project"|"skill"|"tool", name, stage, tags }
edge = { source, target, weight }   # weight = co-occurrence count
```

**v2:**
```
node = { id, title, status: "canonical"|"pending", weight, hits, corrections, project_ids[] }
edge = { source, target, weight }   # weight = endpoint page weight
```

Nodes are wiki pages (transferable insights). Edges are explicit cross-reference links written by the LLM during ingest, not computed similarity scores. Same shape on the surface, fundamentally different semantics underneath.

The graph data is served by the daemon at `GET /graph` (already exposed in P7-lite). Per-page detail at `GET /page/:id`.

---

## Files in `03-web-app/` to rework

| File | Change |
|---|---|
| `src/ws/client.ts` | Repoint URL to the daemon (`http://127.0.0.1:3747`). Switch from old WebSocket protocol to either polling `GET /graph` or a new daemon WebSocket stream we add. |
| `src/graph/types.ts`, `src/graph/builder.ts` | New schema. `GraphNode.kind` becomes `wikiPage`. Drop project/skill/tool variants. |
| `src/orb/visuals.ts` | Color encoding: weight (cool to warm) instead of stage badge. Pulse on hit/correction events. Status color for canonical vs pending. |
| `src/orb/interaction.ts` | Single-click highlights node + 1-hop neighbors. Double-click opens the markdown page in VS Code (need the VS Code `vscode.openFolder` or `revealInExplorer` host bridge). |
| `src/ui/hud.ts` | Replace project status display with: page count, top-weight pages, recent activity feed. |
| `src/main.ts` | Bootstrap against new graph fetch. |

The Three.js scene, force layout, edge curves, dendrites, animation loop all stay. Only the data binding changes. Estimated ~50% rewrite of the web-app.

---

## Two ways to do the rework

**A. Minimal rebind first.** Get the orb correctly showing the new graph (nodes = pages, edges = cross-refs, weight = color) without any new features. Roughly 1 day of work. Then layer features on top one at a time, prioritized by what actually frustrates you when you're using it.

**B. Design all features first, then one big rewrite.** Lock the full feature set, then implement. 3-5 days of work.

**Recommendation: A.** Designing visualization in the abstract is hard; designing it against real data you produced is easy. Each feature is independent and can ship separately.

---

## Feature list (from earlier discussion)

Pick what to ship in phase 3 based on what you want from the orb after living with the daemon for a while.

| Direction | What it looks like |
|---|---|
| **Navigation** | Search bar at the top. Filter by status (canonical / pending), by project, by recency, by weight. Click a node opens the page in VS Code. Hover shows the summary. Double-click drills into evidence. |
| **Live activity feed** | Side panel showing the last N events: page injected at session X, hit recorded, correction, page promoted. Streams from daemon WebSocket. |
| **Real-time effects** | Page glows when injected. Pulses bright on a hit. Dims on a correction. Fades over time as decay runs. Edge pulses traversing cross-references when a graph hop happens at ingest. |
| **Session lens** | Highlight the pages relevant to your current Claude session. The graph shows "what your active mind is reaching for right now." |
| **Time travel** | Slider that scrubs through wiki history. See how the graph grew over weeks. Replay a day's ingest visually. The wiki git repo makes this cheap because every ingest is a commit. |
| **Privacy filters** | Toggle to hide confidential / paid-client pages. Tag-based filtering. Pages tagged sensitive never render unless you explicitly enable. |
| **Cluster view** | Auto-group nodes by cross-reference density into visual clusters with labels. Shows the "regions of your mind" the daemon has mapped. |
| **Health overlay** | Per-node badges for shape violations, low weight, age, orphan status. Lint UI on top of the graph. |
| **Cross-project bleed** | Color edges that cross project boundaries differently. See which insights have transferred between projects (high-value signal). |
| **Export** | Save graph snapshot as PNG / SVG / JSON for sharing or selling demos. |

---

## Open design questions to decide before phase 3

1. **WebSocket vs polling.** Polling `GET /graph` every 5s is simple and reliable. WebSocket gives real-time effects. Pick one.
2. **Click-to-open VS Code.** Web app can't open a VS Code file by itself. Either a custom protocol handler (`vscode://file/...`) or a small VS Code extension that listens. Decide approach.
3. **Privacy gating.** Per-page sensitivity is set how? Per-project tags in `devneural.jsonc`, or per-page frontmatter, or both?
4. **Cluster algorithm.** If we ship cluster view, do we use a force-based grouping in Three.js or run an actual community detection (Louvain, etc) on the graph and feed cluster ids to the visualizer?
5. **What does the orb show for an empty wiki on day 1?** Empty graph, or a "seed your wiki" call to action with the corpus seed status?

---

## Dependencies

Phase 4 cannot start until phase 2 (v1 burndown) and phase 3 (dashboard) are complete. Specifically:

- `02-api-server` must be archived. The orb currently points at `localhost:3747` for the v1 server; we want that port to belong to the new daemon only.
- `01-data-layer` and `04-session-intelligence` artifacts removed from the active tree so there's no confusion about which API is live.
- The `start.bat` at repo root is rewritten to launch the daemon.
- Top-level `README.md` is rewritten so newcomers see the v2 architecture, not v1.
- Phase 3 dashboard is built and exposes the underlying graph data plumbing the orb will share. Building the dashboard first means the data routes the orb consumes are already battle-tested.

After phases 2 and 3, the orb work can begin against a clean baseline with shared infrastructure.
