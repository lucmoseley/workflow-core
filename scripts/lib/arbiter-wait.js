/*
 * arbiter-wait.js — the deadlock walk `list` and `wait` share, and `wait`'s
 * verdict for one poll (#1500).
 *
 * PURE: readings in, a verdict out. It reads no store, no clock and no
 * registry — session-arbiter.js takes every reading and keeps every line of
 * wording, the timer and the exit codes.
 *
 * It sits above the families, as arbiter-sweep.js does: the walk needs the
 * lock family's holder answer, which arbiter-wants.js may not require
 * (arbiter-store.js's SPLIT RULE). Here that answer is a parameter instead.
 */

/** @typedef {import("./arbiter-records.js").IssueClaimRecord} IssueClaimRecord */

/**
 * One waiter's record, as `readWants()` hands it back — only `sessionId` and
 * `wants` are read here.
 * @typedef {{sessionId: string, wants: string}} Want
 */

/**
 * #1492's holder query for one file subject, as `sessionId` asks — `null`
 * where the store could not be read.
 * @typedef {(subject: string, sessionId: string) => ({holder: {sessionId: string|null}|null} | null)} FileHolder
 */

/**
 * @typedef {"RELEASED"|"HOLDER-DEAD"|"NOT-HELD"|"HOLDER-ENDED"|"DEADLOCK"|"CEILING"} Verdict
 */

/** The want subject an issue wait registers — never a path any file claims. */
const issueWant = (/** @type {number} */ n) => `issue #${n}`;

/**
 * The issue number a want names, or null for a file subject.
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
 * Follow each waiter to whoever holds what it wants, and that session to
 * whatever IT is waiting for, until the walk repeats a session or runs out.
 *
 * A repeat is a deadlock: every member is blocked by another, so none will ever
 * release (mantahostels#1195).
 *
 * An issue want is followed to that issue's claimant (#542) — one already
 * waiting where there are several, as the one that can close a ring. `claims`
 * is ONE reading for the whole walk, so every step judges the same store state.
 * @template {Want} W
 * @param {W[]} wants
 * @param {FileHolder} fileHolder
 * @param {IssueClaimRecord[]|null} claims null where the store would not read
 * @returns {W[][]}
 */
function findCycles(wants, fileHolder, claims) {
	const byId = new Map(wants.map((w) => [w.sessionId, w]));
	const cycles = [];
	const seenCycle = new Set();
	for (const start of wants) {
		const ring = walkToRing(start, (here) => {
			const blocker = blockerOf(here, byId, fileHolder, claims);
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
 * The session id of whoever blocks `here` — a waiting one where several hold
 * it — or null where nobody does or the holder is unknown. A holder that is
 * not itself waiting is returned too; the walk ends on it finding no want.
 * @param {Want} here
 * @param {Map<string, Want>} byId the wants by session id
 * @param {FileHolder} fileHolder
 * @param {IssueClaimRecord[]|null} claims
 */
function blockerOf(here, byId, fileHolder, claims) {
	const issue = issueOfWant(here.wants);
	const holders =
		issue === null
			? [fileHolder(here.wants, here.sessionId)?.holder]
			: // An unreadable store ends the walk as an UNKNOWN holder does,
				// for the reason below — never a ring asserted (mantahostels#174).
				(issueHolders(claims, issue, here.sessionId) ?? []);
	const blocker =
		holders.find((h) => h?.sessionId && byId.has(h.sessionId)) ?? holders[0];
	// An UNKNOWN holder ends the walk: a ring cannot be asserted over a
	// session the walk cannot name.
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
 * there was nothing to wait for — and afterwards HOLDER-DEAD where a dead
 * claim is still on disk, else RELEASED. DOUBT NEVER FREES: a poll neither held
 * nor free only ever reaches CEILING. An issue is stale only once EVERY
 * claimant is terminal.
 *
 * `ring` and `terminal` are read only where the table reaches them, because
 * each costs: the ring a read of three stores, the oracle ~465 ms
 * (mantahostels#317). `left` is read last, so time those reads took counts
 * against the ceiling.
 * @template {Want} W
 * @param {object} r
 * @param {{held?: {sessionId: string|null}, free?: unknown, holders?: {sessionId: string|null}[], doubt?: string}} r.poll
 *   this poll: `free` set (null where the claim is gone) or `held`, or neither
 *   where the poll was in doubt
 * @param {boolean} [r.first] the poll before any wait
 * @param {() => W[]|null} [r.ring] the ring through this session
 * @param {() => Set<string>|null|undefined} [r.terminal] the oracle's terminal
 *   sessions, null or undefined where it refused; absent where no read is due
 * @param {() => number} [r.left] ms left before the ceiling; absent, none
 * @returns {{verdict: Verdict, ring?: W[]} | null}
 */
function nextVerdict({ poll, first = false, ring, terminal, left }) {
	if (poll.free !== undefined) {
		if (first) return { verdict: "NOT-HELD" };
		return { verdict: poll.free ? "HOLDER-DEAD" : "RELEASED" };
	}
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
 * @param {{sessionId: string|null}[]|undefined} holders an issue's claimants
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
