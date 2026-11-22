const { caught } = require("./caught.js");

/** @typedef {import("./refill-decide.js").HeldBy} HeldBy */

/**
 * @param {import("./frontier-order.js").FrontierRow[]} rows
 * @param {{candidates: {number: number, writeSet: string[]}[],
 *   inFlight: ({candidate: number} & HeldBy)[]}} graph
 */
function withWriteSets(rows, graph) {
	const writeSetOf = new Map(
		graph.candidates.map((c) => [c.number, c.writeSet]),
	);
	const heldOf = new Map(graph.inFlight.map((h) => [h.candidate, h]));
	return rows.map((r) => {
		const held = heldOf.get(r.number);
		return {
			...r,
			writeSet: writeSetOf.get(r.number) ?? [],
			...(held
				? {
						heldBy: {
							paths: held.paths,
							session: held.session,
							sessionId: held.sessionId,
						},
					}
				: {}),
		};
	});
}

/**
 * @param {string} stdout
 * @returns {import("./refill-frontier.js").Shortlist | {error: string}}
 */
function parseShortlist(stdout) {
	try {
		const out = JSON.parse(stdout);
		if (!Array.isArray(out.pulledIn) || !Array.isArray(out.pulledInUnread))
			throw new Error("no pulledIn or pulledInUnread list");
		const graph = out.conflictGraph;
		if (!Array.isArray(graph?.candidates) || !Array.isArray(graph?.inFlight))
			throw new Error("no conflictGraph candidates or inFlight list");
		return {
			rows: withWriteSets(out.frontier, graph),
			retroBundles: out.retroBundles,
			pulledIn: out.pulledIn,
			pulledInUnread: out.pulledInUnread,
			ownRepo: out.ownRepo,
			goalSet: out.goalSet,
			running: out.running,
		};
	} catch (parseErr) {
		return { error: `unparseable --json: ${caught(parseErr).message}` };
	}
}

module.exports = { parseShortlist };
