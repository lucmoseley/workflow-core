/* Module-level state, so run-in-process.test.ts can show that a second call
 * starts from a purged registry rather than carrying the first call's (mantahostels#1907). */
module.exports = { calls: 0 };
