const { isListedLive, sweepSessionIds } = require("./agent-liveness");
const core = require("./arbiter-core");
const store = require("./arbiter-store");

/**
 * @typedef {Exclude<ReturnType<typeof sweepSessionIds>, {why: string}>} SweepRead
 */

/**
 * @returns {{owned: Set<string>, why?: undefined, names: Map<string, string>, listed: SweepRead} | {why: string, owned?: undefined, names?: undefined, listed?: undefined}}
 */
function readOwnedByLive() {
	const locks = store.readLocks();
	if (locks === null) return { why: "the arbiter's lock store would not read" };
	const held = heldLockPaths(locks);
	if (!held.paths) return { why: held.why };

	const listed = sweepSessionIds();
	if (!listed.ids) return { why: listed.why };
	const live = readLiveSessionPaths(listed);
	if (live.paths === undefined) return { why: live.why };
	const owned = new Set([...held.paths, ...live.paths]);
	return { owned, names: listed.names, listed };
}

/**
 * @param {string} tree
 * @param {string} rel
 */
const ownedKey = (tree, rel) => `${tree}\0${rel}`;

/**
 * @param {any[]} locks
 * @returns {{paths: string[], why?: undefined} | {why: string, paths?: undefined}}
 */
function heldLockPaths(locks) {
	const wasResumed = core.resumedHolderTest(
		"orphaned-edits",
		"the sessions registry could not be read, so a claim held by a resumed " +
			"session cannot be told from a dead one's — the orphan check skips",
	);
	/** @type {string[]} */
	const paths = [];
	for (const lock of locks) {
		if (!lock || lock.unreadable) continue;
		if (core.liveOrResumed(lock, wasResumed))
			paths.push(
				ownedKey(store.recordTree(lock), store.subjectPath(lock.path)),
			);
	}
	if (wasResumed.registryUnreadable())
		return { why: "the sessions registry would not read" };
	return { paths };
}

/**
 * @param {any} listed
 * @returns {{paths: string[], why?: undefined} | {why: string, paths?: undefined}}
 */
function readLiveSessionPaths(listed) {
	/** @type {string[]} */
	const paths = [];
	for (const id of listed.ids) {
		if (!isListedLive(id, listed.ids, listed.terminal)) continue;
		const observed = store.readObservedEntriesBy(id);
		if (observed === null)
			return { why: "the arbiter's observation store would not read" };
		for (const o of observed)
			paths.push(ownedKey(o.tree, store.subjectPath(o.path)));
		const written = store.readWriteEntriesBy(id);
		if (written === null)
			return { why: `session ${id}'s write ledger would not read` };
		for (const w of written) paths.push(ownedKey(w.tree, w.rel));
	}
	return { paths };
}

module.exports = { ownedKey, readOwnedByLive };
