import { describe, expect, it } from "vitest";

import { selectOverviewNodes } from "../src/memory-graph-routes.js";

import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphSnapshot } from "@space/contracts";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY"): MemoryGraphNode => ({ id, label: id, type, sourcePath: `/demo/${id}.md`, recordId: type === "MEMORY" ? id : null });

describe("selectOverviewNodes cap", () => {
  it("keeps the historical 2,000-node default", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => node(`n-${i}`));
    expect(selectOverviewNodes(nodes, [])).toHaveLength(2000);
    expect(selectOverviewNodes(nodes, [], 2000)).toHaveLength(2000);
  });

  it("honors a larger explicit cap up to 50,000", () => {
    const nodes = Array.from({ length: 60000 }, (_, i) => node(`n-${i}`));
    expect(selectOverviewNodes(nodes, [], 50000)).toHaveLength(50000);
    expect(selectOverviewNodes(nodes, [], 10000)).toHaveLength(10000);
  });

  it("returns all nodes when under the cap", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => node(`n-${i}`));
    expect(selectOverviewNodes(nodes, [], 50000)).toHaveLength(100);
  });

  it("reserves topics and sources before filling by id order at any cap", () => {
    const nodes: MemoryGraphNode[] = [node("m-0"), node("topic-1", "TOPIC"), node("src-1", "SOURCE")];
    const edges: MemoryGraphEdge[] = [{ id: "e-1", type: "TAGGED_WITH", source: "m-0", target: "topic-1", origin: "EXPLICIT_TAG" }];
    const selected = new Set(selectOverviewNodes([...nodes, ...Array.from({ length: 5000 }, (_, i) => node(`n-${i}`))], edges, 2000).map(n => n.id));
    expect(selected.has("topic-1")).toBe(true);
    expect(selected.has("src-1")).toBe(true);
  });
});

// Route-level coverage for the overview `limit` query parameter (issue #62 data criterion).
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const routeSecret = "test-secret-with-enough-length";
const routeCookie = `space_session=${signSession({ id: "user:operator", email: "operator@space.test", role: "OPERATOR" }, routeSecret)}`;

function bigSnapshot(totalNodes: number): MemoryGraphSnapshot {
  const nodes: MemoryGraphNode[] = [
    { id: "source:big", type: "SOURCE", label: "secret token=raw-route-value", sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md", recordId: null },
    ...Array.from({ length: totalNodes - 1 }, (_, index) => ({
      id: `memory:big-${index}`,
      type: "MEMORY" as const,
      label: `Big memory ${index}`,
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      recordId: null
    }))
  ];
  const edges: MemoryGraphEdge[] = nodes.slice(1).map((target, index) => ({
    id: `edge:big-${index}`,
    type: "CONTAINS" as const,
    source: "source:big",
    target: target.id
  }));
  return {
    version: 2,
    generatedAt: "2026-07-13T08:00:00.000Z",
    sourceHash: "a".repeat(64),
    revisionHash: "d".repeat(64),
    records: [],
    nodes,
    edges,
    issues: [],
    layoutVersion: 2,
    taxonomyVersion: 1,
    summary: { sourceCount: 1, recordCount: totalNodes - 1, nodeCount: totalNodes, edgeCount: edges.length, issueCount: 0 }
  } as MemoryGraphSnapshot;
}

async function overviewApp(graphSnapshot: MemoryGraphSnapshot) {
  return createApp({
    store: new InMemorySpaceStore(),
    config: getApiConfig({
      SPACE_MEMORY_GRAPH_ENABLED: "true",
      SPACE_MEMORY_MAINTENANCE_ENABLED: "false",
      SPACE_MEMORY_MUTATIONS_ENABLED: "false",
      SPACE_BROWSER_EVIDENCE_ENABLED: "false"
    }),
    auth: { sessionSecret: routeSecret, devLogin: false, secureCookies: false },
    canonicalMemory: { async list() { return []; }, async save() { throw new Error("not used"); } },
    memoryGraphService: {
      async getSnapshot() { return { snapshot: graphSnapshot, isStale: false }; },
      async getCachedSnapshot() { return graphSnapshot; },
      async invalidateCachedSnapshot() {},
      async getArchiveSnapshot() { return graphSnapshot; },
      async listAvailableMonths() { return ["2026-07"]; },
      async getSourceContent() { throw new Error("not used"); }
    }
  });
}

describe("overview limit route", () => {
  it("requires authentication", async () => {
    const app = await overviewApp(bigSnapshot(10));
    const response = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("keeps the default 2,000-node / 6,000-edge cap without limit", async () => {
    const app = await overviewApp(bigSnapshot(60000));
    const response = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview", headers: { cookie: routeCookie } });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.data.nodes.length).toBe(2000);
    expect(payload.data.edges.length).toBeLessThanOrEqual(6000);
    expect(payload.data.truncated).toBe(true);
    expect(payload.data.totalMatchingNodes).toBe(60000);
    await app.close();
  });

  it("serves up to 50,000 nodes and 150,000 edges with limit=50000", async () => {
    const app = await overviewApp(bigSnapshot(60000));
    const response = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=50000", headers: { cookie: routeCookie } });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.data.nodes.length).toBe(50000);
    expect(payload.data.edges.length).toBeLessThanOrEqual(150000);
    expect(payload.data.truncated).toBe(true);
    await app.close();
  });

  it("clamps an over-max limit to the 50,000 hard server maximum", async () => {
    const app = await overviewApp(bigSnapshot(60000));
    const response = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=999999", headers: { cookie: routeCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.nodes.length).toBe(50000);
    await app.close();
  });

  it("still redacts node labels at the larger limit", async () => {
    const app = await overviewApp(bigSnapshot(10));
    const response = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=50", headers: { cookie: routeCookie } });
    expect(response.statusCode).toBe(200);
    const labels = response.json().data.nodes.map((entry: { label: string }) => entry.label);
    expect(labels.some((label: string) => label.includes("raw-route-value"))).toBe(false);
    await app.close();
  });
});
