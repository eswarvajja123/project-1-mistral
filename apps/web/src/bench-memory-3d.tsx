/**
 * Dev-only frame-time harness for the 3D memory graph (issue #62 evidence page).
 * Served at /bench-memory-3d.html?size=2000|10000|50000 in `npm run dev:web`.
 * Not part of the production bundle routes.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";

import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

import { MemoryGraph3D } from "./features/memory-workspace/MemoryGraph3D.js";
import { createMemoryAtlas } from "./features/memory-workspace/memory-atlas.js";
import type { MemoryPoint3D } from "./features/memory-workspace/memory-3d.js";
import { syntheticMemoryGraph, SYNTHETIC_GRAPH_SIZES } from "./features/memory-workspace/synthetic-memory-graph.js";
import "./features/memory-workspace/memory-atlas.css";

function Bench() {
  const sizeParam = Number(new URLSearchParams(location.search).get("size")) || 50000;
  const [size, setSize] = useState(sizeParam);
  const [coordinates, setCoordinates] = useState<Map<string, MemoryPoint3D>>(new Map());
  const [loading, setLoading] = useState(true);

  const { nodes, edges } = useMemo(() => syntheticMemoryGraph(size), [size]);
  const atlas = useMemo(() => createMemoryAtlas(nodes, edges, false), [nodes, edges]);

  useEffect(() => {
    setLoading(true);
    setCoordinates(new Map());
    const worker = new Worker(new URL("./features/memory-workspace/memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; depth?: Array<[string, MemoryPoint3D]> };
      if (message.type === "atlas") {
        // atlas already computed on the main thread for this harness
      } else if (message.type === "depth" && message.depth) {
        setCoordinates(new Map(message.depth));
      } else if (message.type === "done") {
        setLoading(false);
        worker.terminate();
      }
    };
    worker.postMessage({ nodes, edges, include2D: false });
    return () => worker.terminate();
  }, [nodes, edges]);

  return (
    <>
      <div className="bench-bar">
        {SYNTHETIC_GRAPH_SIZES.map(option => (
          <button key={option} type="button" className={option === size ? "is-active" : ""} onClick={() => setSize(option)}>{option / 1000}k</button>
        ))}
      </div>
      <MemoryGraph3D
        nodes={atlas.nodes as MemoryGraphNode[]}
        edges={atlas.edges as MemoryGraphEdge[]}
        positions={atlas.positions}
        coordinates={coordinates}
        showTitles
        selectedNodeId={null}
        onSelectNode={() => {}}
        loading={loading}
        resetToken={0}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Bench />);
