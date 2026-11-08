/*
 * sleep-sync.js — the one synchronous pause the scripts share (mantahostels#2986).
 *
 * Hooks and the arbiter's callers have no event loop to yield to, so a wait
 * between two filesystem probes has to block the thread. `Atomics.wait` on a
 * throwaway shared buffer blocks without spinning or a subprocess, and a
 * `sleep` subprocess is exactly what the capped machine cannot spare.
 *
 * A caller asserting elapsed time asserts the lower bound only.
 *
 * `Atomics.wait` throws only where the runtime cannot wait at all, and what
 * to do then is the caller's policy.
 */

/**
 * Block the thread for at least `ms` milliseconds.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = { sleepSync };
