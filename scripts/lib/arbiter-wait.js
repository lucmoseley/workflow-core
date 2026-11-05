/*
 * arbiter-wait.js — the deadlock walk `list` and `wait` share, and `wait`'s
 * verdict for one poll (#1500).
 *
 * PURE: readings in, a verdict out. It reads no store, no clock and no
 * registry — session-arbiter.js takes every reading and keeps every line of
 * wording, the timer and the exit codes.
 */

/** @typedef {import("./arbiter-records.js").IssueClaimRecord} IssueClaimRecord */

/**
 * One waiter's record, as `readWants()` hands it back — only `sessionId` and
 * `wants` are read here.
 * @typedef {{sessionId: string, wants: string}} Want
 */

/**
 * @typedef {"RELEASED"|"NOT-HELD"|"HOLDER-ENDED"|"DEADLOCK"|"CEILING"} Verdict
 */

/** The want subject an issue wait registers. */
const issueWant = (/** @type {number} */ n) => `issue #${n}`;

/**
 * The issue number a want names, or null for a subject that names none.
 * @param {string} subject
 */
function issueOfWant(subject) {
	const m = /^issue #([1-9]\d*)$/.exec(subject);
	return m ? Number(m[1]) : null;
}

/**
 * Every other session's claim on issue `n`, or null where `claims` is — the
 * store would not read — never [] on a fault (mantahostels#174).
 *
 * No liveness test: an issue claim carries no pid for `holderAlive` to read,
 * so only `wait`'s oracle read judges one.
 * @param {IssueClaimRecord[]|null} claims
 * @param {number} n
 * @param {string|null} sessionId
 */
function issueHolders(claims, n, sessionId) {
	if (claims === null) return null;
	return claims.filter((c) => c.issue === n && c.sessionId !== sessionId);
}

/**
 * Follow each waiter to whoever claims the issue it wants, and that session to
 * whatever IT is waiting for, until the walk repeats a session or runs out.
 *
 * A repeat is a deadlock: every member is blocked by another, so none will ever
 * release (mantahostels#1195).
 *
 * Where an issue has several claimants the walk follows one already waiting
 * (#542), as the one that can close a ring. `claims` is ONE reading for the
 * whole walk, so every step judges the same store state.
 * @template {Want} W
 * @param {W[]} wants
 * @param {IssueClaimRecord[]|null} claims null where the store would not read
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
		// One report per ring, whichever member the walk entered it from.
		const key = [...ring.map((w) => w.sessionId)].sort().join("|");
		if (!seenCycle.has(key)) {
			seenCycle.add(key);
			cycles.push(ring);
		}
	}
	return cycles;
}

/**
 * One walk of findCycles: from `start` to whoever blocks it, and on, until a
 * session repeats — the ring it closes — or the walk runs out (null).
 * @template {Want} W
 * @param {W} start
 * @param {(here: W) => W|undefined} next the waiting session blocking `here`
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
 * The session id of whoever blocks `here` — a waiting one where several claim
 * the issue — or null where nobody does or the claimant is unknown. A
 * claimant that is not itself waiting is returned too; the walk ends on it
 * finding no want.
 * @param {Want} here
 * @param {Map<string, Want>} byId the wants by session id
 * @param {IssueClaimRecord[]|null} claims
 */
function blockerOf(here, byId, claims) {
	const issue = issueOfWant(here.wants);
	// An unreadable store ends the walk as an unnamed claimant does: a ring
	// cannot be asserted over a session the walk cannot name (mantahostels#174).
	const holders =
		issue === null ? [] : (issueHolders(claims, issue, here.sessionId) ?? []);
	const blocker =
		holders.find((h) => h.sessionId && byId.has(h.sessionId)) ?? holders[0];
	return blocker?.sessionId ?? null;
}

/**
 * The ring `sessionId` is a member of, or null — never a ring it only leads
 * into, which it could not break by releasing.
 * @template {Want} W
 * @param {W[][]} cycles findCycles' answer
 * @param {string} sessionId
 */
function ringThrough(cycles, sessionId) {
	return cycles.find((r) => r.some((x) => x.sessionId === sessionId)) ?? null;
}

/**
 * `wait`'s verdict for one poll, or null to keep waiting.
 *
 * The order: free before held, a ring before the
 * oracle, and the ceiling last. A free target is NOT-HELD on the first poll —
 * there was nothing to wait for — and RELEASED afterwards. DOUBT NEVER FREES:
 * a poll neither held nor free only ever reaches CEILING. An issue is stale
 * only once EVERY claimant is terminal.
 *
 * `ring` and `terminal` are read only where the table reaches them, because
 * each costs: the ring a read of two stores, the oracle ~465 ms
 * (mantahostels#317). `left` is read last, so time those reads took counts
 * against the ceiling.
 * @template {Want} W
 * @param {object} r
 * @param {{held?: {sessionId: string|null}, free?: unknown, holders?: {sessionId: string|null}[], doubt?: string}} r.poll
 *   this poll: `free` set (null: no claim stands) or `held`, or neither where
 *   the poll was in doubt
 * @param {boolean} [r.first] the poll before any wait
 * @param {() => W[]|null} [r.ring] the ring through this session
 * @param {() => Set<string>|null|undefined} [r.terminal] the oracle's terminal
 *   sessions, null or undefined where it refused; absent where no read is due
 * @param {() => number} [r.left] ms left before the ceiling; absent, none
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
 * A held poll's early exit: DEADLOCK, then HOLDER-ENDED — the latter never
 * where the oracle refused, and never for a holder naming no session.
 * @template {Want} W
 * @param {{sessionId: string|null}} held
 * @param {{sessionId: string|null}[]|undefined} holders the issue's claimants
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
