/*
 * The suite's `testTimeout`/`hookTimeout`, as the single value both
 * vitest.config.ts and anything that must derive against it (currently
 * run-in-process.js's DEFAULT_STALE_MS) read — so raising the ceiling in one
 * place can't leave a derived value behind, as mantahostels#2262 did to DEFAULT_STALE_MS
 * (mantahostels#2267).
 *
 * Why 90_000: vitest.config.ts's `testTimeout` comment, unmoved here — this
 * file only relocates the value.
 */
const TEST_TIMEOUT_MS = 90_000;

module.exports = { TEST_TIMEOUT_MS };
