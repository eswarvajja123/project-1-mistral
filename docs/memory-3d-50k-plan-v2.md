# Plan v2 — close the remaining gaps of the 50k 3D memory graph work (follow-up to issue #62 plan)

Base: branch `feat/memory-3d-webgl-50k` (commit bfef66a) in `C:\Users\91903\Downloads\project-1`.
Phases 1–5 of the original plan are implemented and browser-measured (see `docs/memory-3d-50k.md`).
This plan covers only what is still open. Each item is checked off only after its verification runs green.

## Phase A — make the API test suite runnable on Windows and cover the new `limit` end-to-end

1. A1. [DONE] Fix the pre-existing Windows blocker: `packages/streaming/src/credential-store.ts` rejects
   `os.tmpdir()`-derived paths because they don't start with `/`. Accept any absolute path
   (`path.isAbsolute`) so `createApp`-based tests run on Windows. Verify by running the existing
   `tests/memory-graph-api.test.ts` unmodified.
2. A2. [DONE] Add route-level tests for the overview `limit` in `apps/api/tests/memory-graph-overview-limit.test.ts`
   (using the same `createApp` harness pattern as `memory-graph-api.test.ts`):
   default request unchanged (≤2,000 nodes / ≤6,000 edges), `limit=50000` returns up to 50,000 nodes
   and ≤150,000 edges with `truncated` set when the snapshot is larger, `limit=999999` is clamped to
   the 50,000 hard max, route still requires admin auth, and node redaction (`redactedNode`) still applies.

## Phase B — measure and report server-side 50k cost

1. B1. [DONE] One-off measurement (not committed as a slow test): build the overview route against a
   synthetic 50,000-node / 150,000-edge snapshot, request with `limit=50000`, record response
   JSON size (bytes) and server handler time (ms), plus default-request size for comparison.
2. B2. [DONE] Record the numbers in `docs/memory-3d-50k.md`.

## Phase C — full verification of the branch

1. C1. [DONE] `tsc --noEmit` for `@space/web` and `@space/api` (clean).
2. C2. [DONE] Web memory suites: `vitest run memory` in `apps/web` (expect only the one pre-existing
   `memory-calendar-view` failure that also fails on pristine `main`).
3. C3. [DONE] API memory-graph suites in `apps/api` after A1 (all `memory-graph*` tests, including the
   pre-existing `memory-graph-api.test.ts`).

## Phase D — demo assets and final browser benchmark

1. D1. [DONE] Add a demo script (exact click path + bench page commands) and a mermaid architecture
   diagram to `docs/memory-3d-50k.md`.
2. D2. [DONE] Re-run the browser harness at 2k, 10k and 50k (`bench-memory-3d.html?size=…`) and fill the
   final results table in `docs/memory-3d-50k.md`, naming browser/GPU/canvas size.
3. D3. [DONE] Verify Canvas fallback once more after all changes (`--disable-webgl` → mode `canvas`).

## Phase E — commit

1. E1. [DONE after this commit] Commit all changes on `feat/memory-3d-webgl-50k` with a message listing what each phase closed.

## Out of scope (recorded, not implemented)

- Post-hackathon business validation (user task-time studies) is research, not code.
- Pushing to the upstream repo / opening a PR requires explicit authorization; not done.

## Verification log (2026-11-05)
- A1: memory-graph-api.test.ts 25/25 on Windows after isAbsolute fixes (credential-store.ts, demo-projects/credentials.ts, streaming-service.ts dispose guard).
- A2: memory-graph-overview-limit.test.ts 9/9 (4 unit + 5 route-level: 401 unauthenticated, default 2000/<=6000 truncated, limit=50000 -> 50000/<=150000, limit=999999 clamped, redaction intact).
- B1: 50k/150k overview = 19.4 MB JSON, ~1.07 s handler; default = 499 KB, ~288 ms.
- C1: tsc clean for @space/web and @space/api. C2: web memory suites 46/47 (1 pre-existing failure on pristine main). C3: api memory-graph-api 25/25; service tests fail on pristine main too (POSIX-only assumptions), unchanged by this branch.
- D2: 2k p95 17.5 / 10k p95 17.2 / 50k p95 17.6-26.6 rotate, zoom 33.7-37.5, picks p95 2.1-4.2 ms (Intel UHD, HeadlessChrome 156, canvas ~960-1080 px wide). D3: --disable-webgl -> canvas mode, pick 0.3 ms @2k.
