import { describe, expect, it } from "vitest";

import { layoutMemoryNetwork3D } from "../src/features/memory-workspace/memory-3d.js";
import { syntheticMemoryGraph, SYNTHETIC_GRAPH_SIZES } from "../src/features/memory-workspace/synthetic-memory-graph.js";

describe("synthetic demo graphs", () => {
  it("generates deterministic graphs at 2k, 10k and 50k nodes with bounded edges", () => {
    for (const size of SYNTHETIC_GRAPH_SIZES) {
      const a = syntheticMemoryGraph(size);
      const b = syntheticMemoryGraph(size);
      expect(a.nodes.length).toBe(size);
      expect(a.edges.length).toBeLessThanOrEqual(150000);
      expect(a.edges.length).toBeGreaterThanOrEqual(size);
      expect(a).toEqual(b);
    }
    const big = syntheticMemoryGraph(50000);
    expect(big.edges.length).toBe(150000);
    expect(big.nodes.some(node => node.type === "SOURCE" && node.label === "gemini.md")).toBe(true);
  });
});

describe("streaming 3D layout", () => {
  it("reports progress and converges to the same result as a single-shot run", () => {
    const { nodes, edges } = syntheticMemoryGraph(3000);
    const progress: Array<{ step: number; total: number; size: number }> = [];
    const streamed = layoutMemoryNetwork3D(nodes, edges, {
      onProgress: (positions, step, total) => { progress.push({ step, total, size: positions.size }); }
    });
    const single = layoutMemoryNetwork3D(nodes, edges);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)!.step).toBe(progress.at(-1)!.total);
    expect(progress.every(p => p.size === nodes.length)).toBe(true);
    expect([...streamed]).toEqual([...single]);
  });

  it("stays deterministic under input reordering when streaming", () => {
    const { nodes, edges } = syntheticMemoryGraph(1500);
    const a = layoutMemoryNetwork3D(nodes, edges, { onProgress: () => {} });
    const b = layoutMemoryNetwork3D([...nodes].reverse(), [...edges].reverse(), { onProgress: () => {} });
    expect([...b]).toEqual([...a]);
  });
});
