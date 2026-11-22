const { listedSessionIds } = require("./agent-liveness");
const core = require("./arbiter-core");
const store = require("./arbiter-store");
const { readDirtyTracked, readUntrackedFiles } = require("./dirty-tree");

/**
 * @typedef {{ unreadable?: boolean, sessionId?: string, path?: string, tree?: string,
 *   pid?: number, procStart?: string|number, bootId?: string }} Lock
 */
/**
 * @typedef {{ readLocks: () => Lock[]|null,
 *   subjectPath: (p: string) => string }} LockSource
 */

/**
 * @param {string|undefined} sid
 * @param {{tree?: string, source?: LockSource}} [opts]
 * @returns {Set<string>}
 */
function readClaimedElsewhere(
	sid,
	{ tree = store.treeRoot(), source = store } = {},
) {
	const locks = source.readLocks();
	if (locks === null) return new Set();
	const wasResumed = core.resumedHolderTest(
		"neighbour-dirt",
		"the sessions registry could not be read, so a file claimed by a resumed " +
			"neighbour is judged unclaimed and may be named as this session's dirt",
	);
	/** @type {Set<string>} */
	const out = new Set();
	for (const lock of locks) {
		if (!lock || lock.unreadable) continue;
		if (lock.sessionId === sid) continue;
		if (!lock.path) continue;
		if (store.recordTree(lock) !== tree) continue;
		if (!core.liveOrResumed(lock, wasResumed)) continue;
		out.add(source.subjectPath(lock.path));
	}
	return out;
}

/**
 * @param {string} sid
 * @param {string} tree
 * @returns {{paths: Set<string>, why: string|null}}
 */
function readObservedElsewhere(sid, tree) {
	const { ids, why } = listedSessionIds();
	if (!ids) return { paths: new Set(), why };

	const paths = new Set();
	let dark = false;
	for (const id of ids) {
		if (id === sid) continue;
		const observed = store.readObservedBy(id, tree);
		if (observed === null) {
			dark = true;
			continue;
		}
		for (const rel of observed) paths.add(store.subjectPath(rel));
	}
	return {
		paths,
		why: dark ? "the arbiter's observation store could not be read" : null,
	};
}

/**
 * @param {string} sessionId
 * @param {string} tree
 * @returns {string[]}
 */
function readStrandedFiles(sessionId, tree) {
	const written = store.readWritesBy(sessionId, tree);
	if (!written || written.length === 0) return [];
	const dirty = readDirtyTracked(tree);
	if (!dirty) return [];
	const theirs = readClaimedElsewhere(sessionId, { tree });
	return [...dirty, ...(readUntrackedFiles(tree) ?? [])].filter(
		(rel) => written.includes(rel) && !theirs.has(rel),
	);
}

module.exports = {
	readClaimedElsewhere,
	readObservedElsewhere,
	readStrandedFiles,
};
