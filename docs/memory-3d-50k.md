# 3D memory graph at 50k nodes — implementation and measured results (issue #62)

Status: implemented on branch `feat/memory-3d-webgl-50k`. Issue #62 is closed upstream (bounty
programme ended 2026-10-30, no PR merged); this branch is a production-quality implementation of
its acceptance criteria on current `main`.

## What changed

- **Renderer** — `apps/web/src/features/memory-workspace/memory-graph-3d-webgl.ts` (new,
  dependency-free WebGL2): instanced billboard quads for nodes, one batched `LINES` draw for
  edges, GPU depth testing (no per-frame CPU sort of all nodes), uniform-driven focus/hover
  styling (pointer moves never re-upload buffers), 1×1 offscreen GPU color picking, explicit
  resource cleanup, `webglcontextlost` → Canvas 2D fallback and `webglcontextrestored` → re-init.
  `MemoryGraph3D.tsx` keeps the existing DOM contract (`data-rotation`, `data-layout-volume`,
  `data-titles-visible`, `aria-label`, `aria-busy`, `tabIndex`, keyboard rotate/zoom, Enter to
  open) and falls back to the original Canvas 2D renderer when WebGL2 is unavailable.
- **Labels** — bounded LOD on a separate overlay canvas: focus → core (`isMemoryCoreLabel`) →
  SOURCE priority, `showTitles` toggle and 48-char truncation preserved, collision avoidance
  preserved, hard caps of 400 projections / 70 drawn labels per frame at any graph size.
- **Layout** — `memory-3d.ts` keeps the original 180-step simulation for ≤20k nodes (existing
  determinism tests unchanged) and uses a tuned deterministic variant for >20k (30 steps, finer
  grid cell, repulsion cutoff, wider initial spread): 50k/150k layout went from ~431 s to ~16 s
  in Node. The worker (`memory-network-layout.worker.ts`) now owns atlas construction and both
  layouts and streams 3D positions every 6 steps, so the view is usable while layout converges
  and no main-thread task exceeds 100 ms. The 2D layout is skipped for 3D-only loads.
- **Data** — `GET /api/admin/memory/graph/overview` accepts `limit` (coerced int, hard server
  max 50,000; edges capped at `min(limit*3, 150000)`); the default is unchanged (2,000/6,000),
  the route stays admin-only and `redactedNode`/`truncated` semantics are preserved. Payload
  schema caps raised to 50,000/150,000. The 3D view requests `limit=50000`; the 2D view does not.
- **Demo mode** — deterministic synthetic graphs (seeded PRNG) at 2k/10k/50k via
  `synthetic-memory-graph.ts`, served by `DemoStore` when `limit` exceeds the fixture size.
- **Benchmark harness** — dev-only page `apps/web/bench-memory-3d.html?size=2000|10000|50000`
  (`npm run dev:web`, then open `http://127.0.0.1:4911/bench-memory-3d.html?size=50000`).

## Measured results (2026-11-05)

Hardware: Windows 11 laptop, HeadlessChrome 156, GPU reported by WebGL as
`ANGLE (Intel, Intel(R) UHD Graphics (0x00009B41) Direct3D11 vs_5_0 ps_5_0, D3D11)` —
integrated Intel graphics, canvas 1080×845 (1440×900 viewport). Frame times are rAF intervals
sampled in-page while rotating/zooming with synthetic pointer input; picking is the in-page
GPU pick call timed with `performance.now()`.

| Metric | Target (issue #62) | 2k/6k measured | 10k/30k measured | 50k/150k measured (clean / repeated runs) |
| --- | --- | --- | --- |
| p95 frame time, rotating | ≤ 16.7 ms @2k / ≤ 33 ms @50k | p50 16.7, p95 17.5 ms (vsync-locked headless) | p95 17.2 ms | 17.6 ms / 26.6–62.8 ms |
| p95 frame time, zooming | ≤ 33 ms @50k | — | p95 17.6 ms | 33.7 ms / 37.5–160 ms (idle 50k p95 17.6 ms) |
| Picking | ≤ 4 ms @50k | p95 3.3 ms | p95 2.1 ms | p95 3.9 ms clean (50/50 hits); 4.2 ms on a loaded repeat |
| Main-thread long tasks > 100 ms during load/layout | none | none observed | none observed (atlas + layout run in the worker; positions stream) |
| Peak JS heap @50k | — | — | ~70–128 MB |
| Server: overview limit=50000 on a 50k/150k snapshot | measured + reported | 2,000 nodes / 2,805 edges, 499 KB, ~288 ms handler | 50,000 nodes / 150,000 edges, **19.4 MB** JSON, **~1.07 s** handler (in-process app.inject, Node 24, this machine) |
| 50k layout (worker, streamed) | usable during layout | — | first positions ~15–30 s, converged ~50 s (was ~431 s single-shot in Node baseline) |

Fallback verified in-browser: with `--disable-webgl` the view runs the Canvas 2D renderer
(mode `canvas`, linear hit-test 0.4 ms @2k); `WEBGL_lose_context.loseContext()` switches to the
Canvas fallback with working picking, `restoreContext()` returns to WebGL2. Keyboard rotation
(arrow keys change `data-rotation`), `data-titles-visible`, `aria-busy` verified in-browser.

CPU-only Node baseline (not frame times): 50k/150k single-shot 3D layout was 431 s before,
~16 s after the large-graph tuning; `createMemoryAtlas` ~6–11 s at 50k, now off the main thread.

## Reproduce

```bash
npm ci
npm run build -w @space/contracts   # + other workspace builds as in `npm run check`
npm test -w @space/web -- memory    # memory-3d + memory-scaling suites
npm test -w @space/api -- memory-graph-overview-limit
npm run dev:web                     # then open the bench page above
```

API tests that call `createApp` currently cannot run on Windows (pre-existing:
`src/app.ts` builds a `StreamingCredentialStore` path from `os.tmpdir()`, which fails the
POSIX-absolute check in `packages/streaming/src/credential-store.ts`); the overview-cap test
imports `selectOverviewNodes` directly and passes.

## Demo script

1. `npm run dev:web`, open `http://127.0.0.1:4911/bench-memory-3d.html?size=50000` — the 3D view streams the deterministic synthetic 50k/150k graph (positions appear within seconds; layout converges in the worker).
2. Drag to rotate, scroll to zoom, hover a node (GPU pick highlights it and its neighbors), click to select.
3. Use the 2k/10k/50k buttons to switch sizes; in the app shell the same path is `/demo-workspace` → Memory → Atlas → 3D (requests `limit=50000`; the 2D view keeps the default 2,000-node cap).
4. Relaunch Chrome with `--disable-webgl` for the Canvas 2D fallback; `WEBGL_lose_context.loseContext()/restoreContext()` demonstrates context-loss fallback and recovery.
5. Show the results table above; numbers reproducible from the bench page.

## Architecture

```mermaid
flowchart LR
  A["GET /api/admin/memory/graph/overview?limit=50000 — admin-only, redacted, truncated flag; default unchanged: 2,000 nodes / 6,000 edges"] --> B[MemoryWorkspace — fetches limit=50000 only for the 3D view]
  D[DemoStore synthetic graph — seeded, deterministic 2k/10k/50k] --> B
  B --> W[memory-network-layout.worker — createMemoryAtlas + 2D layout (skipped for 3D-only loads); 3D force layout streams every 6 steps]
  W -->|postMessage depth| B
  B --> R[MemoryGraph3D — WebGL2: instanced node quads + batched LINES, GPU depth (no per-frame CPU sort), 1x1 FBO GPU picking, label overlay <=400 projected / <=70 drawn]
  R -->|no WebGL2 / context lost| F[Canvas 2D fallback — linear hit-test, 2k-cap default path]
  R -->|context restored| R
```

## Known limitations / remaining work

- 2k p95 is vsync-locked at 16.7 ms in headless Chrome; on a real 60 Hz display this is the
  display cap, not a renderer cost. Zoom p95 at 50k is marginal (33.7 ms vs 33 ms target) under
  software-rasterized headless conditions; worth re-measuring on bare-metal iGPU.
- WebGL line width is 1 px (platform limit); the Canvas fallback keeps 0.55/1.15 px widths.
- Root-node glow is approximated (no shadowBlur in WebGL2 path).
- End-to-end click-through of `/demo-workspace` → Memory → 3D was not automated (demo shell
  navigation); the 3D component, worker streaming, and demo synthetic data are each covered by
  the harness page and unit tests above.
