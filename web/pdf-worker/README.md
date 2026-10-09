# Reviewed PDF Worker

`vite-plugin.ts` emits `worker-adapter.mjs`'s non-instrumented output as a local content-hashed asset and exposes its URL through `virtual:xdrive-pdf-worker`. The viewer imports the URL lazily after the PDF library and checks teardown ownership again before creating the Worker. Development's `/@xdrive/pdf.worker.mjs` route uses the same generator and sends JavaScript with no-store.

`worker-adapter.mjs` checks the exact installed PDF.js6.3.289 legacy Worker digest before each build. It retains the upstream license and dense implementation for documents through64MiB, integrates `chunk-store.ts` and `adapter-core.js` above that limit, and verifies every internal patch has exactly one match. Production does not use diagnostic instrumentation. The source cache limit is32MiB and an individual materialized range is limited to16MiB; these are not limits on arbitrary parser structures or decoded images.

Large complete-data repair is unsupported and must present original-file download. Do not re-enable `requestAllChunks()` by assembling a whole-file buffer. Small complete-data repair remains the original upstream behavior. Worker teardown closes/wipes owned chunks; this cannot erase bytes already transferred to PDF.js, canvas, browser internals or OS buffers.

For an upstream update, review the actual new Worker internals, license and each adapted call site, then deliberately update the pinned hash and exact dependency version. Run dense/sparse boundary, range grouping, real small repair, large non-linearized rendering, cache eviction, cancellation and release asset tests. Merely replacing the digest until the build passes is not a compatibility review.

The old `docs/spikes/fixtures/pdf-sparse` entries reexport this implementation for historical tooling. No production runtime imports from documentation. See ADR-083 through ADR-089 for measurements, failures, limits and provenance.
