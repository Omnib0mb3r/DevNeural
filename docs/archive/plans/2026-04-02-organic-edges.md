# Organic Edge Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace straight-line THREE.Line edges with organic Catmull-Rom splines that have heat-based thickness using Line2/LineMaterial, plus subtle per-edge drift animation.

**Architecture:** New `src/graph/edge-curve.ts` generates seeded organic curves (no Three.js dep). `builder.ts` switches from `THREE.Line`/`LineBasicMaterial` to `Line2`/`LineGeometry`/`LineMaterial` (Three.js addons). `main.ts` calls `updateEdgeDrift(driftTime, ...)` each frame instead of manually interpolating straight-line positions.

**Tech Stack:** Three.js 0.183.2, `three/examples/jsm/lines/` (Line2/LineGeometry/LineMaterial), vitest

**Baseline:** 5 pre-existing failures in `tests/graph/builder.test.ts` due to missing `BufferAttribute` mock — these get fixed in Task 4.

---

### Task 1: `getEdgeLinewidth` in visuals.ts

**Files:**
- Modify: `03-web-app/src/orb/visuals.ts`
- Test: `03-web-app/tests/orb/visuals.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the bottom of `tests/orb/visuals.test.ts`:

```typescript
import {
  getMaterialForNodeType,
  getEdgeColor,
  getEdgeOpacity,
  getEdgeLinewidth,
  highlightMaterialConfig,
  dimmedMaterialConfig,
  defaultMaterialConfig,
} from '../../src/orb/visuals';

describe('getEdgeLinewidth', () => {
  it('returns minimum 1.5 at heat=0 (cold edge)', () => {
    expect(getEdgeLinewidth(0)).toBeCloseTo(1.5, 5);
  });

  it('returns maximum 3.0 at heat=1 (hot edge)', () => {
    expect(getEdgeLinewidth(1)).toBeCloseTo(3.0, 5);
  });

  it('is monotonically increasing — heat=0.75 > heat=0.25', () => {
    expect(getEdgeLinewidth(0.75)).toBeGreaterThan(getEdgeLinewidth(0.25));
  });

  it('clamps below 0 to 1.5', () => {
    expect(getEdgeLinewidth(-1)).toBeCloseTo(1.5, 5);
  });

  it('clamps above 1 to 3.0', () => {
    expect(getEdgeLinewidth(2)).toBeCloseTo(3.0, 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd 03-web-app && npx vitest run tests/orb/visuals.test.ts
```

Expected: FAIL — `getEdgeLinewidth is not a function`

- [ ] **Step 3: Add `getEdgeLinewidth` to `src/orb/visuals.ts`**

Append to the end of `src/orb/visuals.ts`:

```typescript
/**
 * Map normalized heat [0,1] to linewidth in screen pixels.
 * Cold (0.0) = 1.5px, Hot (1.0) = 3.0px.
 */
export function getEdgeLinewidth(heat: number): number {
  const h = Math.max(0, Math.min(1, heat));
  return 1.5 + h * 1.5;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd 03-web-app && npx vitest run tests/orb/visuals.test.ts
```

Expected: all visuals tests PASS (previously 4 suites pass, now 5 suites pass)

- [ ] **Step 5: Commit**

```bash
cd 03-web-app && git add src/orb/visuals.ts tests/orb/visuals.test.ts
git commit -m "feat(orb): add getEdgeLinewidth for heat-based Line2 width"
```

---

### Task 2: `edge-curve.ts` — organic curve generation

**Files:**
- Create: `03-web-app/src/graph/edge-curve.ts`
- Create: `03-web-app/tests/graph/edge-curve.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/graph/edge-curve.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateEdgeCurve, CURVE_SEGMENTS } from '../../src/graph/edge-curve';

describe('generateEdgeCurve', () => {
  it('returns a Float32Array of length (CURVE_SEGMENTS+1)*3', () => {
    const pts = generateEdgeCurve(0, 0, 0, 10, 0, 0, 12345);
    expect(pts).toBeInstanceOf(Float32Array);
    expect(pts.length).toBe((CURVE_SEGMENTS + 1) * 3);
  });

  it('first point equals src', () => {
    const pts = generateEdgeCurve(1, 2, 3, 10, 5, 7, 99);
    expect(pts[0]).toBeCloseTo(1, 4);
    expect(pts[1]).toBeCloseTo(2, 4);
    expect(pts[2]).toBeCloseTo(3, 4);
  });

  it('last point equals tgt', () => {
    const n = CURVE_SEGMENTS;
    const pts = generateEdgeCurve(1, 2, 3, 10, 5, 7, 99);
    expect(pts[n * 3]).toBeCloseTo(10, 4);
    expect(pts[n * 3 + 1]).toBeCloseTo(5, 4);
    expect(pts[n * 3 + 2]).toBeCloseTo(7, 4);
  });

  it('midpoint is displaced from straight line (seed 12345)', () => {
    const pts = generateEdgeCurve(0, 0, 0, 10, 0, 0, 12345);
    const mid = Math.floor(CURVE_SEGMENTS / 2);
    // On a straight X-axis edge, a displaced midpoint has non-zero Y or Z
    const midY = pts[mid * 3 + 1];
    const midZ = pts[mid * 3 + 2];
    expect(Math.abs(midY) + Math.abs(midZ)).toBeGreaterThan(0.01);
  });

  it('same seed produces identical curves', () => {
    const a = generateEdgeCurve(0, 0, 0, 10, 0, 0, 777);
    const b = generateEdgeCurve(0, 0, 0, 10, 0, 0, 777);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 6);
  });

  it('different seeds produce different midpoints', () => {
    const a = generateEdgeCurve(0, 0, 0, 10, 0, 0, 1);
    const b = generateEdgeCurve(0, 0, 0, 10, 0, 0, 2);
    const mid = Math.floor(CURVE_SEGMENTS / 2);
    // At least one midpoint coordinate differs
    const differs = a[mid * 3] !== b[mid * 3] ||
                    a[mid * 3 + 1] !== b[mid * 3 + 1] ||
                    a[mid * 3 + 2] !== b[mid * 3 + 2];
    expect(differs).toBe(true);
  });

  it('driftTime shifts midpoints but preserves endpoints', () => {
    const n = CURVE_SEGMENTS;
    const base = generateEdgeCurve(0, 0, 0, 10, 0, 0, 42, 0);
    const drifted = generateEdgeCurve(0, 0, 0, 10, 0, 0, 42, 100);
    // Endpoints unchanged
    expect(drifted[0]).toBeCloseTo(base[0], 4);
    expect(drifted[n * 3]).toBeCloseTo(base[n * 3], 4);
    // Some midpoint has moved
    const mid = Math.floor(n / 2);
    const changed = base[mid * 3] !== drifted[mid * 3] ||
                    base[mid * 3 + 1] !== drifted[mid * 3 + 1] ||
                    base[mid * 3 + 2] !== drifted[mid * 3 + 2];
    expect(changed).toBe(true);
  });

  it('degenerate edge (src === tgt) returns all-src positions without throwing', () => {
    expect(() => generateEdgeCurve(5, 5, 5, 5, 5, 5, 1)).not.toThrow();
    const pts = generateEdgeCurve(5, 5, 5, 5, 5, 5, 1);
    expect(pts[0]).toBeCloseTo(5, 4);
    expect(pts[1]).toBeCloseTo(5, 4);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd 03-web-app && npx vitest run tests/graph/edge-curve.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Create `src/graph/edge-curve.ts`**

```typescript
/** Number of segments per organic edge curve. More = smoother. */
export const CURVE_SEGMENTS = 24;

/**
 * Deterministic pseudo-random float in [0,1] from two integer seeds.
 * Uses integer multiply-xorshift — no external library required.
 */
function seededRand(seed: number, index: number): number {
  let h = ((seed * 2654435761) ^ (index * 1234567891)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

/**
 * Catmull-Rom basis evaluation at local parameter t in [0,1]
 * through segment defined by four consecutive control points.
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  );
}

/**
 * Generate an organic Catmull-Rom spline between two 3-D points.
 * Three noise-displaced midpoints create the curve shape; driftTime
 * adds a slow sinusoidal oscillation on top for the living-synapse effect.
 *
 * @param sx,sy,sz  Source point
 * @param tx,ty,tz  Target point
 * @param seed      Integer seed derived from edge IDs — same seed = same base shape
 * @param driftTime Monotonically increasing time value (seconds * 0.3) for animation
 * @returns         Flat Float32Array of (CURVE_SEGMENTS+1)*3 values [x,y,z, x,y,z, ...]
 */
export function generateEdgeCurve(
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
  seed: number,
  driftTime = 0,
): Float32Array {
  const n = CURVE_SEGMENTS + 1;
  const positions = new Float32Array(n * 3);

  const dx = tx - sx, dy = ty - sy, dz = tz - sz;
  const edgeLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Degenerate edge — all positions at src
  if (edgeLen < 0.001) {
    for (let i = 0; i < n; i++) {
      positions[i * 3] = sx;
      positions[i * 3 + 1] = sy;
      positions[i * 3 + 2] = sz;
    }
    return positions;
  }

  // Unit direction vector
  const ux = dx / edgeLen, uy = dy / edgeLen, uz = dz / edgeLen;

  // Perpendicular basis vectors (perp1, perp2) for displacement
  let rx = 0, ry = 1, rz = 0;
  if (Math.abs(uy) > 0.9) { rx = 1; ry = 0; rz = 0; }
  // perp1 = normalize(u × right)
  let p1x = uy * rz - uz * ry;
  let p1y = uz * rx - ux * rz;
  let p1z = ux * ry - uy * rx;
  const p1len = Math.sqrt(p1x * p1x + p1y * p1y + p1z * p1z);
  p1x /= p1len; p1y /= p1len; p1z /= p1len;
  // perp2 = u × perp1 (already unit length)
  const p2x = uy * p1z - uz * p1y;
  const p2y = uz * p1x - ux * p1z;
  const p2z = ux * p1y - uy * p1x;

  // 5 Catmull-Rom control points: [src, mid1, mid2, mid3, tgt]
  // src and tgt are exact endpoints; the 3 midpoints are noise-displaced
  const cx = new Float32Array(5);
  const cy = new Float32Array(5);
  const cz = new Float32Array(5);
  cx[0] = sx; cy[0] = sy; cz[0] = sz;
  cx[4] = tx; cy[4] = ty; cz[4] = tz;

  const ctrlT = [0.25, 0.5, 0.75];
  for (let i = 0; i < 3; i++) {
    const t = ctrlT[i];
    // Base midpoint on straight line
    const bx = sx + dx * t, by = sy + dy * t, bz = sz + dz * t;
    // Noise displacement along perp1 and perp2 (~25% of edge length)
    const d1 = (seededRand(seed, i * 2) * 2 - 1) * edgeLen * 0.25;
    const d2 = (seededRand(seed, i * 2 + 1) * 2 - 1) * edgeLen * 0.25;
    // Drift: slow sinusoidal oscillation, amplitude ~5% of edge length
    const driftAmp = edgeLen * 0.05 * (0.4 + seededRand(seed, i + 10) * 0.6);
    const driftFreq = 0.25 + seededRand(seed, i + 20) * 0.15; // 0.25–0.40 Hz
    const driftPhase = seededRand(seed, i + 30) * Math.PI * 2;
    const drift = driftAmp * Math.sin(driftTime * driftFreq * Math.PI * 2 + driftPhase);

    cx[i + 1] = bx + p1x * (d1 + drift) + p2x * d2;
    cy[i + 1] = by + p1y * (d1 + drift) + p2y * d2;
    cz[i + 1] = bz + p1z * (d1 + drift) + p2z * d2;
  }

  // Sample Catmull-Rom spline at CURVE_SEGMENTS+1 evenly-spaced points
  for (let v = 0; v < n; v++) {
    const tGlobal = v / (n - 1);
    const seg = Math.min(Math.floor(tGlobal * 4), 3); // segment index 0..3
    const tLocal = tGlobal * 4 - seg;
    const i0 = Math.max(0, seg - 1);
    const i1 = seg;
    const i2 = Math.min(4, seg + 1);
    const i3 = Math.min(4, seg + 2);

    positions[v * 3]     = catmullRom(cx[i0], cx[i1], cx[i2], cx[i3], tLocal);
    positions[v * 3 + 1] = catmullRom(cy[i0], cy[i1], cy[i2], cy[i3], tLocal);
    positions[v * 3 + 2] = catmullRom(cz[i0], cz[i1], cz[i2], cz[i3], tLocal);
  }

  return positions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd 03-web-app && npx vitest run tests/graph/edge-curve.test.ts
```

Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
cd 03-web-app && git add src/graph/edge-curve.ts tests/graph/edge-curve.test.ts
git commit -m "feat(orb): add generateEdgeCurve for organic Catmull-Rom splines"
```

---

### Task 3: Update `builder.ts` — switch to Line2

**Files:**
- Modify: `03-web-app/src/graph/builder.ts`

Note: Tests for builder come in Task 4. This task gets the implementation right first.

- [ ] **Step 1: Replace `builder.ts` with this complete rewrite**

```typescript
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { getMaterialForNodeType, getEdgeColor, getEdgeOpacity, getEdgeLinewidth } from '../orb/visuals';
import { generateEdgeCurve, CURVE_SEGMENTS } from './edge-curve';
import { createSimulation } from '../orb/physics';
import type { PhysicsNode, PhysicsEdge, Simulation } from '../orb/physics';
import type { SceneState, NodeType, OrbNode, OrbEdge } from './types';

export interface GraphNode {
  id: string;
  label: string;
  /** Primary type field. If absent, id prefix is used as fallback. */
  type?: NodeType;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BuildResult extends SceneState {
  meshes: Map<string, THREE.Mesh>;
  edgeMeshes: Line2[];
  simulation: Simulation;
}

const NODE_RADII: Record<NodeType, number> = {
  project: 1.8,
  skill:   1.2,
  tool:    0.9,
};

function inferType(id: string): NodeType {
  if (id.startsWith('project:')) return 'project';
  if (id.startsWith('skill:')) return 'skill';
  return 'tool';
}

/**
 * Different geometry per node type so they are visually distinct at a glance:
 *  project → sphere  (familiar, central hub shape)
 *  skill   → octahedron  (diamond / gem — knowledge)
 *  tool    → box  (cube — a physical tool)
 */
function createNodeGeometry(type: NodeType, r: number): THREE.BufferGeometry {
  switch (type) {
    case 'project': return new THREE.SphereGeometry(r, 20, 20);
    case 'skill':   return new THREE.OctahedronGeometry(r * 1.1);
    case 'tool':    return new THREE.BoxGeometry(r * 1.5, r * 1.5, r * 1.5);
    default:        return new THREE.SphereGeometry(r, 12, 12);
  }
}

function randomInSphere(radius: number): { x: number; y: number; z: number } {
  const theta = 2 * Math.PI * Math.random();
  const phi = Math.acos(2 * Math.random() - 1);
  const r = radius * Math.cbrt(Math.random());
  return {
    x: r * Math.sin(phi) * Math.cos(theta),
    y: r * Math.sin(phi) * Math.sin(theta),
    z: r * Math.cos(phi),
  };
}

/** Deterministic integer seed from two node ID strings. */
export function hashEdgeSeed(sourceId: string, targetId: string): number {
  const str = sourceId + '|' + targetId;
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h ^ str.charCodeAt(i), 0x9e3779b9)) >>> 0;
  }
  return h;
}

/** Create a Line2 edge mesh and add it to the scene. */
export function createEdgeMesh(
  scene: THREE.Scene,
  resolution: THREE.Vector2,
  initialOpacity: number,
): Line2 {
  const geo = new LineGeometry();
  // Placeholder positions — updated by recomputeEdgeHeat / updateEdgeDrift
  geo.setPositions(new Float32Array((CURVE_SEGMENTS + 1) * 3));
  geo.setColors(new Float32Array((CURVE_SEGMENTS + 1) * 3));
  const mat = new LineMaterial({
    linewidth: 1.5,
    vertexColors: true,
    transparent: true,
    opacity: initialOpacity,
    resolution,
  });
  const line = new Line2(geo, mat);
  scene.add(line);
  return line;
}

export function build(
  graphData: GraphData,
  scene: THREE.Scene,
  resolution = new THREE.Vector2(1920, 1080),
): BuildResult {
  if (graphData.nodes.length === 0 && graphData.edges.length === 0) {
    const sim = createSimulation([], []);
    return {
      nodes: new Map(),
      edges: [],
      highlightedNodeIds: new Set(),
      focusedNodeId: null,
      simulationCooled: false,
      meshes: new Map(),
      edgeMeshes: [],
      simulation: sim,
    };
  }

  const meshMap = new Map<string, THREE.Mesh>();
  const physicsNodes: PhysicsNode[] = [];
  const orbNodes = new Map<string, OrbNode>();

  for (const node of graphData.nodes) {
    const nodeType = node.type ?? inferType(node.id);
    const radius = NODE_RADII[nodeType] ?? NODE_RADII.tool;
    const materialConfig = getMaterialForNodeType(nodeType);

    const geometry = createNodeGeometry(nodeType, radius);
    const material = new THREE.MeshStandardMaterial(materialConfig);
    const mesh = new THREE.Mesh(geometry, material);

    const initPos = randomInSphere(10);
    mesh.position.set(initPos.x, initPos.y, initPos.z);
    scene.add(mesh);
    meshMap.set(node.id, mesh);

    const sharedPos = mesh.position as unknown as { x: number; y: number; z: number };
    const velocity = { x: 0, y: 0, z: 0 };

    const physNode: PhysicsNode = { id: node.id, position: sharedPos, velocity };
    physicsNodes.push(physNode);

    orbNodes.set(node.id, {
      id: node.id,
      label: node.label,
      type: nodeType,
      position: sharedPos,
      velocity,
    });
  }

  const physicsEdges: PhysicsEdge[] = [];
  const orbEdges: OrbEdge[] = [];
  const edgeMeshes: Line2[] = [];

  for (const edge of graphData.edges) {
    const srcMesh = meshMap.get(edge.sourceId);
    const tgtMesh = meshMap.get(edge.targetId);
    if (!srcMesh || !tgtMesh) continue;

    const line = createEdgeMesh(scene, resolution, getEdgeOpacity(0.25));
    edgeMeshes.push(line);
    physicsEdges.push({ sourceId: edge.sourceId, targetId: edge.targetId, weight: edge.weight });
    orbEdges.push({ sourceId: edge.sourceId, targetId: edge.targetId, weight: 0.25 });
  }

  recomputeEdgeHeat(orbEdges, edgeMeshes);

  const simulation = createSimulation(physicsNodes, physicsEdges);

  return {
    nodes: orbNodes,
    edges: orbEdges,
    highlightedNodeIds: new Set(),
    focusedNodeId: null,
    simulationCooled: false,
    meshes: meshMap,
    edgeMeshes,
    simulation,
  };
}

/** Number of segments per edge line — drives CURVE_SEGMENTS from edge-curve.ts. */
export const N_SEGMENTS = CURVE_SEGMENTS;

/** Power applied to the dissipation curve. t^HEAT_POWER keeps heat near the source longer. */
const HEAT_POWER = 2;

/**
 * Assigns per-vertex colors and linewidth to each Line2 edge using heat-dissipation.
 * Heat flows from the hotter endpoint (more connections) to the cooler endpoint.
 * Also sets edge.weight to average heat for the opacity pulse.
 */
export function recomputeEdgeHeat(edges: OrbEdge[], edgeMeshes: Line2[]): void {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
    degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
  }
  let maxDeg = 0;
  for (const d of degree.values()) if (d > maxDeg) maxDeg = d;

  const c = new THREE.Color();

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const mesh = edgeMeshes[i];
    if (!mesh) continue;

    const srcDeg = degree.get(edge.sourceId) ?? 1;
    const tgtDeg = degree.get(edge.targetId) ?? 1;
    const srcHeat = maxDeg <= 1 ? 0.25 : 0.25 + ((srcDeg - 1) / (maxDeg - 1)) * 0.75;
    const tgtHeat = maxDeg <= 1 ? 0.25 : 0.25 + ((tgtDeg - 1) / (maxDeg - 1)) * 0.75;

    edge.weight = (srcHeat + tgtHeat) / 2;

    const geo = mesh.geometry as LineGeometry;
    const mat = mesh.material as LineMaterial;

    // Colors: per-vertex heat gradient
    const colors = new Float32Array((N_SEGMENTS + 1) * 3);
    const hotFirst = srcDeg >= tgtDeg;
    const hotHeat  = hotFirst ? srcHeat : tgtHeat;
    const coldHeat = hotFirst ? tgtHeat : srcHeat;

    for (let v = 0; v <= N_SEGMENTS; v++) {
      const t = hotFirst ? v / N_SEGMENTS : (N_SEGMENTS - v) / N_SEGMENTS;
      const heat = hotHeat + (coldHeat - hotHeat) * Math.pow(t, HEAT_POWER);
      c.set(getEdgeColor(heat));
      colors[v * 3]     = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
    geo.setColors(colors);

    // Linewidth: driven by average heat (hotter = thicker)
    mat.linewidth = getEdgeLinewidth(edge.weight);
  }
}

/**
 * Update edge curve positions each animation frame.
 * Reads live node positions (physics-updated) and applies organic curve + drift.
 *
 * @param driftTime  Slowly-advancing time value (pass performance.now()/1000 * 0.3)
 */
export function updateEdgeDrift(
  driftTime: number,
  edges: OrbEdge[],
  edgeMeshes: Line2[],
  meshes: Map<string, THREE.Mesh>,
): void {
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const mesh = edgeMeshes[i];
    if (!mesh || !edge) continue;
    const src = meshes.get(edge.sourceId);
    const tgt = meshes.get(edge.targetId);
    if (!src || !tgt) continue;

    const seed = hashEdgeSeed(edge.sourceId, edge.targetId);
    const positions = generateEdgeCurve(
      src.position.x, src.position.y, src.position.z,
      tgt.position.x, tgt.position.y, tgt.position.z,
      seed,
      driftTime,
    );
    (mesh.geometry as LineGeometry).setPositions(positions);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd 03-web-app && npx tsc --noEmit
```

Expected: No errors (or only errors in main.ts due to type mismatches — those get fixed in Task 5)

- [ ] **Step 3: Commit**

```bash
cd 03-web-app && git add src/graph/builder.ts src/graph/edge-curve.ts
git commit -m "feat(orb): switch edges to Line2 + organic curve generation"
```

---

### Task 4: Fix `builder.test.ts` — update mocks for Line2

**Files:**
- Modify: `03-web-app/tests/graph/builder.test.ts`

The existing 5 failures are due to `BufferAttribute` missing from the mock. With Line2 there's no `BufferAttribute` at all. Replace the mock and assertions.

- [ ] **Step 1: Replace `tests/graph/builder.test.ts` with this**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('three', () => ({
  SphereGeometry: vi.fn(),
  OctahedronGeometry: vi.fn(),
  BoxGeometry: vi.fn(),
  MeshStandardMaterial: vi.fn(),
  Mesh: vi.fn(() => ({
    position: { set: vi.fn(), x: 0, y: 0, z: 0, length: vi.fn(() => 0) },
  })),
  Color: vi.fn(() => ({ r: 0, g: 0, b: 0, set: vi.fn() })),
  Vector2: vi.fn(() => ({ x: 1920, y: 1080 })),
  Scene: vi.fn(() => ({ add: vi.fn() })),
  AmbientLight: vi.fn(),
  DirectionalLight: vi.fn(),
}));

vi.mock('three/examples/jsm/lines/LineGeometry.js', () => ({
  LineGeometry: vi.fn(() => ({
    setPositions: vi.fn(),
    setColors: vi.fn(),
  })),
}));

vi.mock('three/examples/jsm/lines/LineMaterial.js', () => ({
  LineMaterial: vi.fn(() => ({
    linewidth: 1.5,
    opacity: 0.38,
    needsUpdate: false,
  })),
}));

vi.mock('three/examples/jsm/lines/Line2.js', () => ({
  Line2: vi.fn(() => ({
    geometry: { setPositions: vi.fn(), setColors: vi.fn() },
    material: { linewidth: 1.5, opacity: 0.38, needsUpdate: false },
  })),
}));

import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { build, recomputeEdgeHeat, hashEdgeSeed } from '../../src/graph/builder';
import type { GraphData } from '../../src/graph/builder';
import { getMaterialForNodeType, getEdgeOpacity, getEdgeLinewidth } from '../../src/orb/visuals';

function makeScene(): THREE.Scene {
  return { add: vi.fn() } as unknown as THREE.Scene;
}

const projectNode = { id: 'project:foo', label: 'Foo', type: 'project' as const };
const skillNode   = { id: 'skill:bar',   label: 'Bar', type: 'skill'   as const };
const toolNode    = { id: 'tool:baz',    label: 'Baz', type: 'tool'    as const };

describe('build(graphData)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('project nodes use SphereGeometry, skill use OctahedronGeometry, tool use BoxGeometry', () => {
    build({ nodes: [projectNode, skillNode, toolNode], edges: [] }, makeScene());
    expect(THREE.SphereGeometry).toHaveBeenCalledTimes(1);
    expect(THREE.OctahedronGeometry).toHaveBeenCalledTimes(1);
    expect(THREE.BoxGeometry).toHaveBeenCalledTimes(1);
  });

  it('project nodes use a larger radius than skill nodes', () => {
    build({ nodes: [projectNode, skillNode], edges: [] }, makeScene());
    const projectRadius = vi.mocked(THREE.SphereGeometry).mock.calls[0][0] as number;
    const skillRadius = vi.mocked(THREE.OctahedronGeometry).mock.calls[0][0] as number;
    expect(projectRadius).toBeGreaterThan(skillRadius);
  });

  it('skill nodes use a medium radius (between project and tool)', () => {
    build({ nodes: [projectNode, skillNode, toolNode], edges: [] }, makeScene());
    const projectR = vi.mocked(THREE.SphereGeometry).mock.calls[0][0] as number;
    const skillR = (vi.mocked(THREE.OctahedronGeometry).mock.calls[0][0] as number) / 1.1;
    const toolR = (vi.mocked(THREE.BoxGeometry).mock.calls[0][0] as number) / 1.5;
    expect(skillR).toBeLessThan(projectR);
    expect(toolR).toBeLessThan(skillR);
  });

  it('tool nodes use the smallest radius', () => {
    build({ nodes: [projectNode, skillNode, toolNode], edges: [] }, makeScene());
    const projectR = vi.mocked(THREE.SphereGeometry).mock.calls[0][0] as number;
    const skillR = (vi.mocked(THREE.OctahedronGeometry).mock.calls[0][0] as number) / 1.1;
    const toolR = (vi.mocked(THREE.BoxGeometry).mock.calls[0][0] as number) / 1.5;
    expect(toolR).toBeLessThan(projectR);
    expect(toolR).toBeLessThan(skillR);
  });

  it('project nodes: MeshStandardMaterial called with a blue-tinted color config', () => {
    build({ nodes: [projectNode], edges: [] }, makeScene());
    const matArgs = vi.mocked(THREE.MeshStandardMaterial).mock.calls[0][0] as { color: number };
    expect(matArgs.color).toBe(getMaterialForNodeType('project').color);
  });

  it('skill nodes: MeshStandardMaterial called with a green-tinted color config', () => {
    build({ nodes: [skillNode], edges: [] }, makeScene());
    const matArgs = vi.mocked(THREE.MeshStandardMaterial).mock.calls[0][0] as { color: number };
    expect(matArgs.color).toBe(getMaterialForNodeType('skill').color);
  });

  it('tool nodes: MeshStandardMaterial called with an orange-tinted color config', () => {
    build({ nodes: [toolNode], edges: [] }, makeScene());
    const matArgs = vi.mocked(THREE.MeshStandardMaterial).mock.calls[0][0] as { color: number };
    expect(matArgs.color).toBe(getMaterialForNodeType('tool').color);
  });

  it('edges: LineMaterial constructed with initial opacity = getEdgeOpacity(0.25)', () => {
    const data: GraphData = {
      nodes: [projectNode, skillNode],
      edges: [{ sourceId: projectNode.id, targetId: skillNode.id, weight: 1 }],
    };
    build(data, makeScene());
    const matArgs = vi.mocked(LineMaterial).mock.calls[0][0] as { opacity: number };
    expect(matArgs.opacity).toBeCloseTo(getEdgeOpacity(0.25), 5);
  });

  it('edges: LineMaterial constructed with linewidth = 1.5 (default before heat)', () => {
    const data: GraphData = {
      nodes: [projectNode, skillNode],
      edges: [{ sourceId: projectNode.id, targetId: skillNode.id, weight: 1 }],
    };
    build(data, makeScene());
    const matArgs = vi.mocked(LineMaterial).mock.calls[0][0] as { linewidth: number };
    expect(matArgs.linewidth).toBeCloseTo(1.5, 5);
  });

  it('build() called with empty graph → no Three.js constructors called, no errors', () => {
    expect(() => build({ nodes: [], edges: [] }, makeScene())).not.toThrow();
    expect(THREE.SphereGeometry).not.toHaveBeenCalled();
    expect(THREE.MeshStandardMaterial).not.toHaveBeenCalled();
    expect(THREE.Mesh).not.toHaveBeenCalled();
  });

  it('returned BuildResult has a simulation with tick, isCooled, reset methods', () => {
    const result = build({ nodes: [projectNode, skillNode], edges: [] }, makeScene());
    expect(typeof result.simulation.tick).toBe('function');
    expect(typeof result.simulation.isCooled).toBe('function');
    expect(typeof result.simulation.reset).toBe('function');
  });
});

describe('hashEdgeSeed', () => {
  it('returns a non-negative integer', () => {
    expect(hashEdgeSeed('project:foo', 'skill:bar')).toBeGreaterThanOrEqual(0);
  });

  it('same inputs produce the same seed', () => {
    expect(hashEdgeSeed('a', 'b')).toBe(hashEdgeSeed('a', 'b'));
  });

  it('different inputs produce different seeds (with high probability)', () => {
    expect(hashEdgeSeed('project:a', 'skill:b')).not.toBe(hashEdgeSeed('skill:b', 'project:a'));
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd 03-web-app && npx vitest run tests/graph/builder.test.ts
```

Expected: all 13 tests PASS (0 failures)

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
cd 03-web-app && npx vitest run
```

Expected: all tests pass (previously 5 failures in builder.test.ts are now fixed, everything else unchanged)

- [ ] **Step 4: Commit**

```bash
cd 03-web-app && git add tests/graph/builder.test.ts
git commit -m "test(orb): update builder tests for Line2 — fix pre-existing mock failures"
```

---

### Task 5: Update `main.ts` — wire Line2, drift animation, highlights

**Files:**
- Modify: `03-web-app/src/main.ts`

- [ ] **Step 1: Update imports at the top of `src/main.ts`**

Replace the current import block (lines 1–14) with:

```typescript
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { createScene, addResizeListener } from '../webview/renderer';
import { createCameraController } from '../webview/camera';
import { initVoice } from '../webview/voice';
import { detectVoiceIntent, evaluateQuery } from '../webview/search';
import { createTooltip, deriveGitHubUrl } from '../webview/nodeActions';
import {
  build,
  recomputeEdgeHeat,
  updateEdgeDrift,
  createEdgeMesh,
  N_SEGMENTS,
} from './graph/builder';
import type { BuildResult, GraphData } from './graph/builder';
import { getMaterialForNodeType, getEdgeColor, getEdgeOpacity } from './orb/visuals';
import { connect } from './ws/client';
import type { SceneRef } from './ws/handlers';
import type { GraphSnapshot, GraphNode, GraphEdge } from './types';
import { initHud, setConnectionStatus, setCameraMode, updateVoiceStatus } from './ui/hud';
```

- [ ] **Step 2: Update `clearBuild` to handle Line2**

Replace the `clearBuild` function (currently lines 39–54):

```typescript
function clearBuild(scene: THREE.Scene, b: AppState): void {
  for (const mesh of b.meshes.values()) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach(m => m.dispose());
    else mat.dispose();
  }
  for (const line of b.edgeMeshes) {
    scene.remove(line);
    line.geometry.dispose();
    (line.material as LineMaterial).dispose();
  }
}
```

- [ ] **Step 3: Update `applySearchHighlight` for Line2**

Replace the edge-dimming section inside `applySearchHighlight` (the `for (let i = 0; i < b.edgeMeshes.length; i++)` loop, currently lines 118–133):

```typescript
  recomputeEdgeHeat(b.edges, b.edgeMeshes);
  const dimColors = new Float32Array((N_SEGMENTS + 1) * 3);
  for (let v = 0; v <= N_SEGMENTS; v++) {
    dimColors[v * 3] = 0.04; dimColors[v * 3 + 1] = 0.06; dimColors[v * 3 + 2] = 0.10;
  }
  for (let i = 0; i < b.edgeMeshes.length; i++) {
    const mesh = b.edgeMeshes[i];
    const mat = mesh.material as LineMaterial;
    if (connectedEdgeIdx.has(i)) {
      mat.opacity = 0.85;
    } else {
      (mesh.geometry as LineGeometry).setColors(dimColors);
      mat.opacity = 0.04;
    }
    mat.needsUpdate = true;
  }
```

- [ ] **Step 4: Update `clearHighlights` for Line2**

Replace the edge-reset loop inside `clearHighlights` (the `for (let i = 0; i < b.edgeMeshes.length; i++)` loop, currently lines 151–158):

```typescript
  recomputeEdgeHeat(b.edges, b.edgeMeshes);
  for (let i = 0; i < b.edgeMeshes.length; i++) {
    const edge = b.edges[i];
    if (!edge) continue;
    const mat = b.edgeMeshes[i].material as LineMaterial;
    mat.opacity = getEdgeOpacity(edge.weight);
    mat.needsUpdate = true;
  }
```

- [ ] **Step 5: Update `applyHighlight` for Line2**

Replace the edge-coloring loop inside `applyHighlight` (the `for (let i = 0; i < b.edgeMeshes.length; i++)` loop, currently lines 200–219):

```typescript
  recomputeEdgeHeat(b.edges, b.edgeMeshes);
  const whiteColors = new Float32Array((N_SEGMENTS + 1) * 3);
  for (let v = 0; v <= N_SEGMENTS; v++) {
    whiteColors[v * 3] = 1; whiteColors[v * 3 + 1] = 1; whiteColors[v * 3 + 2] = 1;
  }
  const dimColors = new Float32Array((N_SEGMENTS + 1) * 3);
  for (let v = 0; v <= N_SEGMENTS; v++) {
    dimColors[v * 3] = 0.04; dimColors[v * 3 + 1] = 0.06; dimColors[v * 3 + 2] = 0.10;
  }
  for (let i = 0; i < b.edgeMeshes.length; i++) {
    const mesh = b.edgeMeshes[i];
    const mat = mesh.material as LineMaterial;
    if (connectedEdgeIdx.has(i)) {
      (mesh.geometry as LineGeometry).setColors(whiteColors);
      mat.opacity = 1.0;
    } else {
      (mesh.geometry as LineGeometry).setColors(dimColors);
      mat.opacity = 0.04;
    }
    mat.needsUpdate = true;
  }
```

- [ ] **Step 6: Add `edgeResolution` tracking and resize listener** _(do this before steps 7–8 which reference `edgeResolution`)_

After the `const { scene, camera, controls, startAnimationLoop } = createScene(canvas);` line, add:

```typescript
  // Track canvas resolution for LineMaterial (needed for pixel-accurate linewidth)
  const edgeResolution = new THREE.Vector2(canvas.clientWidth || 1920, canvas.clientHeight || 1080);
  addResizeListener((w: number, h: number) => {
    edgeResolution.set(w, h);
    if (currentBuild) {
      for (const line of currentBuild.edgeMeshes) {
        (line.material as LineMaterial).resolution.set(w, h);
        (line.material as LineMaterial).needsUpdate = true;
      }
    }
  });
```

Then update the `build(toGraphData(snapshot), scene)` call inside `sceneRef.rebuild` to pass `edgeResolution`:

```typescript
      const result = build(toGraphData(snapshot), scene, edgeResolution);
```

- [ ] **Step 7: Update the animation loop — replace straight-line interpolation with `updateEdgeDrift`**

Inside `startAnimationLoop`, replace the entire edge-position loop (currently lines 507–527 — the `for (let i = 0; i < currentBuild.edgeMeshes.length; i++)` block that does straight-line lerp) with:

```typescript
      // Update organic edge curves (positions + drift)
      const driftTime = t * 0.3; // 0.3 Hz drift
      updateEdgeDrift(driftTime, currentBuild.edges, currentBuild.edgeMeshes, currentBuild.meshes);
```

Keep the opacity pulse loop below it (the "Living synaptic pulse" comment block) unchanged.

- [ ] **Step 7: Update `addEdge` in sceneRef for Line2**

Replace the `addEdge` handler (currently lines 465–479):

```typescript
    addEdge(edge) {
      if (!currentBuild) return;
      const srcMesh = currentBuild.meshes.get(edge.source);
      const tgtMesh = currentBuild.meshes.get(edge.target);
      if (!srcMesh || !tgtMesh) return;
      const line = createEdgeMesh(scene, edgeResolution, getEdgeOpacity(0.25));
      currentBuild.edgeMeshes.push(line);
      currentBuild.edges.push({ sourceId: edge.source, targetId: edge.target, weight: 0 });
      recomputeEdgeHeat(currentBuild.edges, currentBuild.edgeMeshes);
    },
```

- [ ] **Step 9: Verify TypeScript compiles clean**

```bash
cd 03-web-app && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 10: Run full test suite**

```bash
cd 03-web-app && npx vitest run
```

Expected: all tests pass

- [ ] **Step 11: Commit**

```bash
cd 03-web-app && git add src/main.ts
git commit -m "feat(orb): wire Line2 into main — drift animation, highlights, resize"
```

---

## Visual Verification

After all tasks complete, run the dev server and confirm:

```bash
cd 03-web-app && npm run dev
```

Open the orb in browser and verify:
- [ ] Edges are curved organic splines (not straight lines)
- [ ] Each edge has a unique shape that stays consistent
- [ ] Edges near hub nodes (many connections) are visibly thicker than leaf edges
- [ ] Heat gradient (cool blue → hot orange-red) is preserved
- [ ] Edges very slowly drift/writhe over time
- [ ] Click a node — connected edges highlight white, others dim correctly
- [ ] Search highlight dims non-matching edges correctly
- [ ] Resize window — linewidths stay consistent (no scaling artifacts)
