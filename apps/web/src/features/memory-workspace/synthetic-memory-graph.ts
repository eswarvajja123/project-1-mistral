import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/** Deterministic PRNG so every 2k/10k/50k demo graph is identical across runs and machines. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SYNTHETIC_GRAPH_SEED = 42;
export const SYNTHETIC_GRAPH_SIZES = [2000, 10000, 50000] as const;

/**
 * Deterministic synthetic memory graph: one SOURCE per ~250 nodes, CONTAINS edges from each
 * source to its memories, plus DERIVED_FROM / SEMANTICALLY_RELATED edges up to ~3 per node.
 * Mirrors the shape of a real snapshot so rendering can be benchmarked without a backend.
 */
export function syntheticMemoryGraph(nodeCount: number, seed = SYNTHETIC_GRAPH_SEED): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const rand = mulberry32(seed);
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const sourceCount = Math.max(1, Math.round(nodeCount / 250));
  const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
  for (let s = 0; s < sourceCount; s++) {
    nodes.push({
      id: `source-${s}`,
      label: s === 0 ? "gemini.md" : `source-${s}.md`,
      type: "SOURCE",
      sourcePath: `/demo/${months[s % months.length]}/source-${s}.md`,
      recordId: null
    });
  }
  const targetEdges = Math.min(Math.max(nodeCount * 3, 1), 150000);
  for (let i = 0; i < nodeCount - sourceCount; i++) {
    const parent = `source-${Math.floor(rand() * sourceCount)}`;
    const id = `memory-${i}`;
    nodes.push({
      id,
      label: `memory record ${i}`,
      type: "MEMORY",
      sourcePath: nodes.find(node => node.id === parent)?.sourcePath ?? null,
      recordId: id
    });
    edges.push({ id: `contains-${i}`, type: "CONTAINS", source: parent, target: id });
  }
  let added = edges.length;
  while (added < targetEdges) {
    const a = nodes[Math.floor(rand() * nodes.length)]!;
    const b = nodes[Math.floor(rand() * nodes.length)]!;
    if (a.id === b.id) continue;
    edges.push({ id: `rel-${added}`, type: rand() < 0.5 ? "DERIVED_FROM" : "SEMANTICALLY_RELATED", source: a.id, target: b.id });
    added++;
  }
  return { nodes, edges };
}
