import { useEffect, useMemo, useRef } from "react";

import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

import type { MemoryAtlasPosition } from "./memory-atlas.js";

import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";

import { MemoryGraphWebGLRenderer, type Graph3DScene } from "./memory-graph-3d-webgl.js";

/** Bounded label work per frame, whatever the graph size (issue #62 label LOD requirement). */
const MAX_LABELS_DRAWN = 70;
const MAX_LABELS_PROJECTED = 400;

const hexToRgb = (hex: string) => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255] as const;
};

export function MemoryGraph3D({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken }: {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
}) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});

  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };
  const dataVersion = useRef(0);
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);
  useEffect(() => {
    const primary = canvasRef.current, overlay = overlayRef.current;
    if (!primary || !overlay) return;
    let mode: "webgl" | "canvas" = "canvas";
    let renderer: MemoryGraphWebGLRenderer | null = null;
    try {
      renderer = new MemoryGraphWebGLRenderer(primary);
      mode = "webgl";
    } catch {
      renderer = null;
      mode = "canvas";
    }
    // In WebGL mode the overlay carries the bounded text labels; after a context loss it becomes
    // the full Canvas 2D fallback surface (a canvas cannot switch from webgl2 to 2d in place).
    let drawCanvas = primary;
    let context: CanvasRenderingContext2D | null = mode === "canvas" ? primary.getContext("2d") : null;
    if (mode === "canvas") overlay.style.display = "none";
    let frame = 0, width = 1, height = 1;
    let hover: string | null = null;
    let points: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];
    let scene: Graph3DScene | null = null;
    let sceneVersion = -1;
    let labelCache: { key: string; priority: number[] } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;

    const buildScene = (): Graph3DScene | null => {
      const { nodes: ns, edges: es, positions: ps, coordinates: cs } = current.current;
      const byId = new Map(ns.map(node => [node.id, node]));
      const ids: string[] = [];
      const indexOf = new Map<string, number>();
      for (const node of ns) {
        if (!cs.has(node.id)) continue;
        indexOf.set(node.id, ids.length);
        ids.push(node.id);
      }
      const positionsArr = new Float32Array(ids.length * 3);
      const colors = new Float32Array(ids.length * 3);
      const types: string[] = [], labels: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const node = byId.get(ids[i]!)!;
        const p = cs.get(ids[i]!)!;
        positionsArr[i * 3] = p.x; positionsArr[i * 3 + 1] = p.y; positionsArr[i * 3 + 2] = p.z;
        const rgb = hexToRgb(ps.get(ids[i]!)?.color ?? "#7395ad");
        colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
        types.push(node.type); labels.push(node.label);
      }
      const edgePairs: number[] = [];
      const edgeTypes: string[] = [];
      for (const edge of es) {
        const a = indexOf.get(edge.source), b = indexOf.get(edge.target);
        if (a === undefined || b === undefined) continue;
        edgePairs.push(a, b);
        edgeTypes.push(edge.type);
      }
      return { ids, types, labels, colors, positions: positionsArr, edgePairs: new Uint32Array(edgePairs), edgeTypes, neighbors: new Uint8Array(ids.length), focus: -1 };
    };

    /** Focus/neighbors change on hover without touching graph buffers; only the small neighbor buffer re-uploads. */
    const applyFocus = (base: Graph3DScene): Graph3DScene => {
      const focusId = hover ?? current.current.selectedNodeId;
      const focus = focusId ? base.ids.indexOf(focusId) : -1;
      if (focus === base.focus) return base;
      const neighbors = new Uint8Array(base.ids.length);
      if (focus >= 0) for (let e = 0; e < base.edgePairs.length; e += 2) {
        if (base.edgePairs[e] === focus) neighbors[base.edgePairs[e + 1]!] = 1;
        if (base.edgePairs[e + 1] === focus) neighbors[base.edgePairs[e]!] = 1;
      }
      return { ...base, focus, neighbors };
    };

    const drawLabels = (s: Graph3DScene, camera: MemoryCamera3D) => {
      const overlayCtx = overlay.getContext("2d");
      if (!overlayCtx || !renderer) return;
      const glRenderer = renderer;
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      if (!current.current.showTitles) return;
      overlayCtx.setTransform(Math.min(window.devicePixelRatio || 1, 2), 0, 0, Math.min(window.devicePixelRatio || 1, 2), 0, 0);
      overlayCtx.font = "11px system-ui, sans-serif";
      const focusId = hover ?? current.current.selectedNodeId;
      // Bounded label LOD: only focus/core/source labels are prioritized; the rest are considered
      // in index order and only when zoomed in, with hard caps on projections and drawn labels.
      const cacheKey = `${sceneVersion}:${focusId ?? ""}`;
      if (!labelCache || labelCache.key !== cacheKey) {
        const priority: number[] = [];
        for (let i = 0; i < s.ids.length; i++) {
          if (s.ids[i] === focusId || isMemoryCoreLabel(s.labels[i] ?? "") || s.types[i] === "SOURCE") priority.push(i);
        }
        priority.sort((a, b) => Number(s.ids[b] === focusId) - Number(s.ids[a] === focusId) || Number(isMemoryCoreLabel(s.labels[b] ?? "")) - Number(isMemoryCoreLabel(s.labels[a] ?? "")) || Number(s.types[b] === "SOURCE") - Number(s.types[a] === "SOURCE"));
        labelCache = { key: cacheKey, priority };
      }
      const priority = labelCache.priority;
      const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
      let drawn = 0, projected = 0;
      const consider = (i: number): boolean => {
        if (drawn >= MAX_LABELS_DRAWN || projected >= MAX_LABELS_PROJECTED) return false;
        const p = glRenderer.project(i, camera);
        projected++;
        if (!p) return true;
        const label = (s.labels[i] ?? "").length > 48 ? `${s.labels[i]!.slice(0, 45)}…` : s.labels[i]!;
        const x = p.x + 9, y = p.y, w = overlayCtx.measureText(label).width;
        if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) return true;
        labelBoxes.push({ x, y, w });
        overlayCtx.fillStyle = "#09111bea"; overlayCtx.fillRect(x - 3, y - 11, w + 6, 16);
        overlayCtx.fillStyle = isMemoryCoreLabel(s.labels[i] ?? "") ? "#fff0b0" : "#c6dfed";
        overlayCtx.fillText(label, x, y + 1);
        drawn++;
        return true;
      };
      for (const i of priority) { if (!consider(i)) break; }
      if (camera.zoom >= 1.6 && drawn < MAX_LABELS_DRAWN) {
        const skip = new Set(priority);
        for (let i = 0; i < s.ids.length && drawn < MAX_LABELS_DRAWN; i++) { if (skip.has(i)) continue; if (!consider(i)) break; }
      }
    };

    const renderCanvas2D = () => {
      if (!context) return;
      const { nodes: ns, edges: es, positions: ps, coordinates: cs, showTitles: show, selectedNodeId: sel } = current.current;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const extent = Math.max(60, ...[...cs.values()].map(p => Math.hypot(p.x, p.y, p.z)));
      const scale = Math.min(width, height) * 0.4 / extent;
      const camera = cameraRef.current;
      const projected = new Map(ns.flatMap(node => {
        const p = cs.get(node.id);
        return p ? [[node.id, projectMemoryPoint(p, camera, scale, width, height)] as const] : [];
      }));
      const focus = hover ?? sel;
      const neighbors = new Set<string>();
      if (focus) for (const edge of es) { if (edge.source === focus) neighbors.add(edge.target); if (edge.target === focus) neighbors.add(edge.source); }
      context.lineWidth = 0.55;
      for (const edge of es) {
        const a = projected.get(edge.source), b = projected.get(edge.target);
        if (!a || !b) continue;
        const incident = edge.source === focus || edge.target === focus;
        context.strokeStyle = incident ? "#98dafa" : focus ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        context.lineWidth = incident ? 1.15 : 0.55;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
      points = [];
      const ordered = ns.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
      const labelBoxes: Array<{ x: number; y: number; w: number }> = [];
      for (const node of ordered) {
        const p = projected.get(node.id)!;
        const highlighted = node.id === focus;
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * p.perspective * Math.sqrt(camera.zoom)) * (highlighted ? 1.5 : 1);
        points.push({ id: node.id, ...p, radius });
        context.globalAlpha = focus && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, p.perspective));
        context.fillStyle = highlighted ? "#ffffff" : ps.get(node.id)?.color ?? "#7395ad";
        if (root || highlighted) { context.shadowColor = context.fillStyle; context.shadowBlur = 13; }
        context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill(); context.shadowBlur = 0;
      }
      context.globalAlpha = 1;
      if (show) {
        const labeled = [...ordered].sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) || Number(b.type === "SOURCE") - Number(a.type === "SOURCE"));
        context.font = "11px system-ui, sans-serif";
        for (const node of labeled) {
          if (node.type !== "SOURCE" && node.id !== focus && camera.zoom < 1.6) continue;
          const p = projected.get(node.id)!;
          const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
          const x = p.x + 9, y = p.y, w = context.measureText(label).width;
          if (x + w > width || y < 14 || y > height - 5 || labelBoxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
          labelBoxes.push({ x, y, w });
          context.fillStyle = "#09111bea"; context.fillRect(x - 3, y - 11, w + 6, 16);
          context.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed"; context.fillText(label, x, y + 1);
        }
      }
    };

    const render = () => {
      frame = 0;
      const camera = cameraRef.current;
      if (mode === "webgl" && renderer && !renderer.contextLost) {
        if (!scene || sceneVersion !== dataVersion.current) { scene = buildScene(); sceneVersion = dataVersion.current; }
        if (scene) {
          scene = applyFocus(scene);
          renderer.setScene(scene);
          renderer.render(camera, scene.focus);
          drawLabels(scene, camera);
        }
      } else {
        renderCanvas2D();
      }
      const rotation = `${camera.yaw.toFixed(3)},${camera.pitch.toFixed(3)}`;
      primary.dataset.rotation = rotation;
      overlay.dataset.rotation = rotation;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;
    const resize = () => {
      const visible = primary.style.display === "none" ? overlay : primary;
      const rect = visible.getBoundingClientRect(); width = rect.width || 1; height = rect.height || 1;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const canvas of [primary, overlay]) {
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      }
      schedule();
    };
    const hit = (x: number, y: number): string | null => {
      if (mode === "webgl" && renderer && scene) {
        const index = renderer.pick(x, y, cameraRef.current);
        return index >= 0 ? scene.ids[index] ?? null : null;
      }
      return [...points].reverse().find(p => Math.hypot(p.x - x, p.y - y) < Math.max(7, p.radius + 3))?.id ?? null;
    };
    const local = (event: PointerEvent, canvas: HTMLCanvasElement) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const attach = (canvas: HTMLCanvasElement) => {
      const down = (event: PointerEvent) => {
        canvas.focus(); canvas.setPointerCapture(event.pointerId);
        const p = local(event, canvas); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = null;
      };
      const move = (event: PointerEvent) => {
        const p = local(event, canvas), previous = pointers.get(event.pointerId);
        if (previous) {
          if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
          if (pointers.size === 2) {
            const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
            const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
            if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
          } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
          pointers.set(event.pointerId, p);
        } else { hover = hit(p.x, p.y); canvas.style.cursor = hover ? "pointer" : "grab"; }
        schedule();
      };
      const up = (event: PointerEvent) => {
        const p = local(event, canvas);
        if (!dragged && pointers.size === 1) { const id = hit(p.x, p.y); if (id) current.current.onSelectNode(id); }
        pointers.delete(event.pointerId);
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      };
      const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
      const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
      const key = (event: KeyboardEvent) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
          cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0; schedule();
        } else if (event.key === "Enter") { const node = current.current.nodes.find(node => node.id === current.current.selectedNodeId) ?? current.current.nodes.find(node => isMemoryCoreLabel(node.label)); if (node) current.current.onSelectNode(node.id); }
      };
      canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
      return () => { canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key); };
    };
    const detachPrimary = attach(primary);
    const detachOverlay = attach(overlay);
    if (renderer) renderer.onContextLost = () => {
      mode = "canvas";
      drawCanvas = overlay;
      primary.style.display = "none";
      overlay.style.display = "";
      context = overlay.getContext("2d");
      resize();
    };
    if (renderer) renderer.onContextRestored = () => {
      try {
        renderer = new MemoryGraphWebGLRenderer(primary);
        mode = "webgl";
        primary.style.display = "";
        overlay.classList.add("memory-3d-labels");
        if (renderer) renderer.onContextLost = () => { mode = "canvas"; drawCanvas = overlay; primary.style.display = "none"; overlay.style.display = ""; context = overlay.getContext("2d"); resize(); };
        scene = null;
        resize();
      } catch { mode = "canvas"; }
    };
    const observer = new ResizeObserver(resize); observer.observe(primary); resize();
    // Dev-only harness for the issue #62 frame-time/picking measurements (vite dev builds only).
    if (import.meta.env?.DEV) {
      (window as unknown as { __memory3DBench?: unknown }).__memory3DBench = {
        mode: () => mode,
        pick: (x: number, y: number) => hit(x, y),
        pickTimed: (x: number, y: number) => { const t = performance.now(); const id = hit(x, y); return { id, ms: performance.now() - t }; },
        nodeCount: () => scene ? scene.ids.length : current.current.coordinates.size,
        canvas: primary
      };
    }
    return () => {
      if (import.meta.env?.DEV) delete (window as unknown as { __memory3DBench?: unknown }).__memory3DBench;
      observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = () => {};
      detachPrimary(); detachOverlay();
      renderer?.dispose();
    };
  }, []);
  useEffect(() => { dataVersion.current++; redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  return <div className="memory-3d-surface"><canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to explore." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} /><canvas ref={overlayRef} className="memory-3d-labels" aria-hidden="true" tabIndex={-1} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} /><span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span></div>;
}
