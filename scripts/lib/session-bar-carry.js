const SESSION_PREFIX = "Current session:";

/**
 * @typedef {{ kind: string }} Limit
 * @typedef {{ harness: string, printed: string, limit: Limit }} SessionBar
 * @typedef {{
 *   harness: string,
 *   printed: string[],
 *   cache: { utilization: { limits: Limit[] } },
 *   sessionBar?: SessionBar,
 * }} Recording
 */

/**
 * @param {Recording} recording
 * @returns {SessionBar | null}
 */
function sessionBarOf(recording) {
	const printed = recording.printed.find((l) => l.startsWith(SESSION_PREFIX));
	const limit = recording.cache.utilization.limits.find(
		(l) => l.kind === "session",
	);
	if (printed && limit) return { harness: recording.harness, printed, limit };
	if (printed || limit)
		throw new Error(
			`${recording.harness} ${printed ? "printed" : "cached"} a session bar but ${printed ? "cached" : "printed"} none`,
		);
	return recording.sessionBar ?? null;
}

/**
 * @template {Recording} R
 * @param {R} probe
 * @param {Recording | null} previous
 * @returns {R & { sessionBar?: SessionBar }}
 */
function carrySessionBar(probe, previous) {
	const own = sessionBarOf({ ...probe, sessionBar: undefined });
	if (own) return probe;
	const carried = previous && sessionBarOf(previous);
	if (!carried)
		throw new Error(
			`${probe.harness} listed no session bar and no earlier recording holds one: re-record once the seat has a five-hour window open, on a plan that has one (workflow-core#3758)`,
		);
	return { ...probe, sessionBar: carried };
}

module.exports = { SESSION_PREFIX, carrySessionBar };
