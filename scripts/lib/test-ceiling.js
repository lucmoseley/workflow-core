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

/*
 * Each fork worker's V8 old-space cap, in MiB, so a test that allocates
 * without yielding dies as a named heap OOM in its own worker rather than
 * growing until earlyoom kills whatever ranks highest (#3112). vitest.config.ts
 * passes it as `execArgv`, and a command-line flag beats an inherited
 * NODE_OPTIONS, so it binds every launcher, a driver script's bare
 * `vitest run` included.
 *
 * Why 1024: the heaviest legitimate worker memwatch has recorded peaked at
 * 759 MB RSS, which contains its heap; every heavier one was a hanging
 * mutant (#3164). At 2048, the npm scripts' NODE_OPTIONS, a runaway reaches
 * ~2.4 GB resident, past the ~1.5 GB of headroom docs/environment.md §2
 * measures under load. 1024 is a round pick between those bounds; no source
 * gives the margin.
 */
const WORKER_HEAP_MB = 1024;

module.exports = { TEST_TIMEOUT_MS, WORKER_HEAP_MB };
