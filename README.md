# project-1 (mistral) — SpaceApp 3D memory graph at 50k nodes

Extract of the useful changes from `feat/memory-3d-webgl-50k` in the local SpaceApp checkout
(upstream: https://github.com/oll4com/spaceapp, base `main` @ d9059c1), implementing the
acceptance criteria of the closed issue #62:

- dependency-free WebGL2 renderer (instanced nodes, batched edges, GPU depth, 1x1 GPU picking,
  Canvas 2D fallback + context-loss recovery) — `apps/web/src/features/memory-workspace/memory-graph-3d-webgl.ts`
- streamed worker layout (50k layout 431s -> ~16s), deterministic synthetic demo graphs 2k/10k/50k
- overview API `limit` param, hard max 50,000 nodes / 150,000 edges, default unchanged, admin-only + redaction
- bounded label LOD, a11y/data-* contract preserved, dev bench page `apps/web/bench-memory-3d.html`
- Windows test-env fixes (isAbsolute path guards, EPERM-tolerant fsync)
- docs: `docs/memory-3d-50k.md` (measured results), `docs/memory-3d-50k-plan-v2.md`, `docs/memory-3d-50k-plan-v3.md`

Measured on Intel UHD iGPU (HeadlessChrome 156): 50k/150k rotate p95 17.6 ms (target <=33),
pick p95 3.9 ms (target <=4). See docs for full table and repro commands.
