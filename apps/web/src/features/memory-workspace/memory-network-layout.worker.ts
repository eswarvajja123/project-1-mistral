import { layoutMemoryNetwork3D } from "./memory-3d.js";

import { layoutMemoryNetwork } from "./memory-network-layout.js";

import { createMemoryAtlas } from "./memory-atlas.js";

import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

// The worker owns atlas construction and both layouts so a 50k graph never blocks the main thread.
// 3D positions stream out while the simulation converges; the view stays usable during layout.
self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; include2D?: boolean }>) => {
  const { nodes, edges, include2D = true } = event.data;
  const atlas = createMemoryAtlas(nodes, edges, false);
  if (include2D) {
  const positions = layoutMemoryNetwork(atlas.nodes, atlas.edges);
  self.postMessage({
    type: "atlas",
    atlas: {
      nodes: atlas.nodes,
      edges: atlas.edges,
      basePositions: [...atlas.positions],
      groups: atlas.groups,
      topics: atlas.topics,
      explicitCount: atlas.explicitCount,
      semanticCount: atlas.semanticCount
    },
    positions: [...positions]
  });
  }
  layoutMemoryNetwork3D(atlas.nodes, atlas.edges, {
    onProgress: (depth, step, total) => {
      self.postMessage({ type: "depth", step, total, depth: [...depth] });
    }
  });
  self.postMessage({ type: "done" });
};
