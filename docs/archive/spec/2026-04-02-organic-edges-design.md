# Organic Edge Visualization — Design Spec
_2026-04-02_

## Goal

Replace straight line edges in the DevNeural orb with organic, neural-network-like curves. Edges should look alive — irregular, unique, slightly animated — while preserving the existing heat-dissipation color gradient system.

---

## Decisions

| Property | Value |
|---|---|
| Curve type | Catmull-Rom spline with seeded noise-displaced midpoints |
| Curve deviation | ~25% of edge length (between medium and pronounced) |
| Animation | Subtle slow drift, ~0.3 Hz, amplitude scales with heat |
| Thickness | Heat-based: 1.5px (cold) → 3.0px (hot) |
| Segments | 24 (up from 8) |
| Line type | `Line2` + `LineGeometry` + `LineMaterial` from `three/addons` |
| Color gradient | Unchanged — existing heat-dissipation system preserved |

---

## Architecture

### New file: `src/graph/edge-curve.ts`

```
generateEdgeCurve(src: Vector3, tgt: Vector3, seed: number): Vector3[]
```

- Generates 3 midpoints along the edge
- Each midpoint displaced perpendicular to the edge direction
- Displacement = `edgeLength × 0.25 × seededNoise(seed + i)`
- Seeded noise = fast integer hash (no external library)
- Returns 26 points (24 segments + 2 endpoints)

### Modified: `src/graph/builder.ts`

- `OrbEdge` mesh type changes from `THREE.Line` to `Line2`
- `colorizeEdges()` writes positions via `LineGeometry.setPositions()` instead of BufferGeometry
- `recomputeEdgeHeat()` also calls `getEdgeLinewidth(heat)` and sets `LineMaterial.linewidth`
- `N_SEGMENTS` 8 → 24
- New export: `updateEdgeDrift(driftTime: number)` — applies per-frame sinusoidal midpoint offset

### Modified: `src/orb/visuals.ts`

- New export: `getEdgeLinewidth(heat: number): number`
  - Maps `[0.25, 1.0]` → `[1.5, 3.0]` linearly

### Modified: `src/main.ts`

- Add `driftClock` advancing at ~0.3 Hz in animation loop
- Call `updateEdgeDrift(driftClock)` throttled to ~10fps
- Live WebSocket edges (`connection:new`) use same `generateEdgeCurve` path

---

## Behavior

- Each edge has a unique, permanently seeded curve shape (seeded by source+target node ID hash)
- All edges slowly drift — midpoints oscillate with a small sinusoidal offset
- Hot edges (high-degree nodes) drift with slightly more amplitude than cool edges
- Linewidth is per-edge, set once in `recomputeEdgeHeat()`, not per-frame
- Search/highlight behavior unchanged — opacity dims on non-matching edges as before

---

## Out of Scope

- Animated signal "pulses" traveling along edges (not in this pass)
- Per-segment linewidth variation (uniform per edge)
- TubeGeometry (deferred — too costly)
