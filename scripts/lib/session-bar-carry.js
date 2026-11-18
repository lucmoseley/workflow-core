/*
 * session-bar-carry.js — keeps a session bar in the usage-probe recording
 * when the probed seat lists none (workflow-core#5332). A seat with no five-hour window
 * open, or on a plan with no 5-hour bar (workflow-core#3758), prints no `Current
 * session:` line and caches no `session` limit, yet the fake still prints and
 * caches one for every case that sets a session percent. So a session-less
 * probe carries the previous recording's session bar forward, under the
 * harness that recorded it.
 */

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

/** `recording`'s own session bar, or the one it carries; null when it has
 * neither. Throws on a probe that printed the bar but cached none, or the
 * reverse.
 * @param {Recording} recording
 * @returns {SessionBar | null} */
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

/** `probe` as the fixture records it: as probed when it lists a session
 * bar, else carrying `previous`'s.
 * @template {Recording} R
 * @param {R} probe
 * @param {Recording | null} previous the fixture it replaces, if any
 * @returns {R & { sessionBar?: SessionBar }} */
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
