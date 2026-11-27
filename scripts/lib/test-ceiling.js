/*
 * The suite's `testTimeout`/`hookTimeout` and per-worker heap ceilings, as
 * the single values vitest.config.ts and anything that must derive against
 * them read — so raising a ceiling in one place can't leave a derived value behind, as
 * mantahostels#2262 did to DEFAULT_STALE_MS (mantahostels#2267).
 *
 * Why 90_000: vitest.config.ts's `testTimeout` comment, unmoved here — this
 * file only relocates the value.
 */
const TEST_TIMEOUT_MS = 90_000;

// workflow-core#3164 measured 759 MB RSS, the heaviest legitimate worker
const WORKER_HEAP_MB = 1024;

module.exports = { TEST_TIMEOUT_MS, WORKER_HEAP_MB };
