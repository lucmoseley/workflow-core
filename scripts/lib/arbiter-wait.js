/** @typedef {import("./arbiter-records.js").IssueClaimRecord} IssueClaimRecord */

/** @typedef {{sessionId: string, wants: string}} Want */

/**
 * @typedef {"RELEASED"|"NOT-HELD"|"HOLDER-ENDED"|"DEADLOCK"|"CEILING"} Verdict
 */

const issueWant = (/** @type {number} */ n) => `issue #${n}`;

/** @param {string} subject */
function issueOfWant(subject) {
	const m = /^issue #([1-9]\d*)$/.exec(subject);
	return m ? Number(m[1]) : null;
}

/**
 * @param {IssueClaimRecord[]|null} claims
 * @param {number} n
 * @param {string|null} sessionId
 */
function issueHolders(claims, n, sessionId) {
	if (claims === null) return null;
	return claims.filter((c) => c.issue === n && c.sessionId !== sessionId);
}

/**
 * @template {Want} W
 * @param {W[]} wants
 * @param {IssueClaimRecord[]|null} claims
 * @returns {W[][]}
 */
function findCycles(wants, claims) {
	const byId = new Map(wants.map((w) => [w.sessionId, w]));
	const cycles = [];
	const seenCycle = new Set();
	for (const start of wants) {
		const ring = walkToRing(start, (here) => {
			const blocker = blockerOf(here, byId, claims);
			return blocker ? byId.get(blocker) : undefined;
		});
		if (ring === null) continue;
		const key = [...ring.map((w) => w.sessionId)].sort().join("|");
		if (!seenCycle.has(key)) {
			seenCycle.add(key);
			cycles.push(ring);
		}
	}
	return cycles;
}

/**
 * @template {Want} W
 * @param {W} start
 * @param {(here: W) => W|undefined} next
 * @returns {W[]|null}
 */
function walkToRing(start, next) {
	/** @type {W[]} */
	const walk = [];
	/** @type {W|undefined} */
	let cur = start;
	while (cur) {
		const here = cur;
		const at = walk.findIndex((w) => w.sessionId === here.sessionId);
		if (at !== -1) return walk.slice(at);
		walk.push(here);
		cur = next(here);
	}
	return null;
}

/**
 * @param {Want} here
 * @param {Map<string, Want>} byId
 * @param {IssueClaimRecord[]|null} claims
 */
function blockerOf(here, byId, claims) {
	const issue = issueOfWant(here.wants);
	const holders =
		issue === null ? [] : (issueHolders(claims, issue, here.sessionId) ?? []);
	const blocker =
		holders.find((h) => h.sessionId && byId.has(h.sessionId)) ?? holders[0];
	return blocker?.sessionId ?? null;
}

/**
 * @template {Want} W
 * @param {W[][]} cycles
 * @param {string} sessionId
 */
function ringThrough(cycles, sessionId) {
	return cycles.find((r) => r.some((x) => x.sessionId === sessionId)) ?? null;
}

/**
 * @template {Want} W
 * @param {object} r
 * @param {{held?: {sessionId: string|null}, free?: unknown, holders?: {sessionId: string|null}[], doubt?: string}} r.poll
 * @param {boolean} [r.first]
 * @param {() => W[]|null} [r.ring]
 * @param {() => Set<string>|null|undefined} [r.terminal]
 * @param {() => number} [r.left]
 * @returns {{verdict: Verdict, ring?: W[]} | null}
 */
function nextVerdict({ poll, first = false, ring, terminal, left }) {
	if (poll.free !== undefined)
		return { verdict: first ? "NOT-HELD" : "RELEASED" };
	if (first) return null;
	const stuck = poll.held
		? heldVerdict(poll.held, poll.holders, ring, terminal)
		: null;
	if (stuck) return stuck;
	return left && left() <= 0 ? { verdict: "CEILING" } : null;
}

/**
 * @template {Want} W
 * @param {{sessionId: string|null}} held
 * @param {{sessionId: string|null}[]|undefined} holders
 * @param {(() => W[]|null)|undefined} ring
 * @param {(() => Set<string>|null|undefined)|undefined} terminal
 * @returns {{verdict: Verdict, ring?: W[]} | null}
 */
function heldVerdict(held, holders, ring, terminal) {
	const r = ring?.() ?? null;
	if (r) return { verdict: "DEADLOCK", ring: r };
	const ended = terminal?.();
	const allEnded =
		!!ended &&
		(holders ?? [held]).every(
			(h) => h.sessionId !== null && ended.has(h.sessionId),
		);
	return allEnded ? { verdict: "HOLDER-ENDED" } : null;
}

module.exports = {
	findCycles,
	issueHolders,
	issueOfWant,
	issueWant,
	nextVerdict,
	ringThrough,
};
