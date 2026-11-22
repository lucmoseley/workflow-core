const arbiterLedger = require("./arbiter-ledger.js");
const { gitRead } = require("./dirty-tree.js");
const { readPatchIds } = require("./patch-ids.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/**
 * @typedef {{ ledgerRoot: () => string|null,
 *   readCommitsBy: (id: string, root?: string) => string[]|null,
 *   readOwnersOf: (commits: string[], root?: string) => Map<string, string>|null }} CommitLedger
 */

/**
 * @param {string[]} commits
 * @param {string|null|undefined} sessionId
 * @param {{ ledger?: CommitLedger }} [options]
 * @returns {Map<string, string>|null}
 */
function readNeighbourCommits(
	commits,
	sessionId,
	{ ledger = arbiterLedger } = {},
) {
	const own = readOwnLedger(sessionId, ledger);
	return own && readOwnersBesides(commits, own, ledger);
}

/**
 * @param {string|null|undefined} sessionId
 * @param {CommitLedger} ledger
 * @returns {{ root: string, mine: string[] }|null}
 */
function readOwnLedger(sessionId, ledger) {
	if (!sessionId) return null;
	try {
		const root = ledger.ledgerRoot();
		if (!root) return null;
		const mine = ledger.readCommitsBy(sessionId, root);
		return mine && { root, mine };
	} catch {
		return null;
	}
}

/**
 * @param {string[]} commits
 * @param {{ root: string, mine: string[] }} own
 * @param {CommitLedger} ledger
 * @returns {Map<string, string>|null}
 */
function readOwnersBesides(commits, { root, mine }, ledger) {
	const ownSet = new Set(mine);
	try {
		return ledger.readOwnersOf(
			commits.filter((c) => !ownSet.has(c)),
			root,
		);
	} catch {
		return null;
	}
}

/** @param {string} out */
const lines = (out) =>
	out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

/**
 * @param {string} root
 * @param {string} base
 * @param {{ sessionId?: string|null, execFn?: ExecFn, ledger?: CommitLedger,
 *   tip?: string, byPatch?: boolean }} [options]
 * @returns {{ dropped: string[], kept: string[], paths: string[] }|null}
 */
function readOwnPaths(
	root,
	base,
	{ sessionId, execFn, ledger = arbiterLedger, tip, byPatch = false } = {},
) {
	if (!sessionId) return null;
	const log = gitRead(
		[
			"log",
			"--format=%x00%H",
			"--name-only",
			"--no-renames",
			"-m",
			`${base}..${tip ?? "HEAD"}`,
		],
		root,
		execFn,
	);
	if (log === null) return null;
	const touched = pathsByCommit(log);
	const own = readOwnLedger(sessionId, ledger);
	if (!own) return null;
	const neighbours = readOwnersBesides([...touched.keys()], own, ledger);
	if (!neighbours) return null;
	const nobodys = byPatch
		? readUnmatchedUnledgered(
				[...touched.keys()].filter((sha) => !neighbours.has(sha)),
				own.mine,
				root,
				execFn,
			)
		: [];
	if (!nobodys) return null;
	const notOwn = new Set([...neighbours.keys(), ...nobodys]);
	const net = gitRead(
		["diff", "--name-only", "--no-renames", base, ...(tip ? [tip] : [])],
		root,
		execFn,
	);
	const dirty = tip
		? ""
		: gitRead(["diff", "--name-only", "--no-renames", "HEAD"], root, execFn);
	if (net === null || dirty === null) return null;
	const owed = ownedPaths(dirty, touched, notOwn);
	return {
		dropped: [...touched.keys()].filter((sha) => notOwn.has(sha)),
		kept: [...touched.keys()].filter((sha) => !notOwn.has(sha)),
		paths: lines(net).filter((p) => owed.has(p)),
	};
}

/**
 * @param {string[]} commits
 * @param {string[]} mine
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {string[]|null}
 */
function readUnmatchedUnledgered(commits, mine, root, execFn) {
	const own = new Set(mine);
	const unledgered = commits.filter((sha) => !own.has(sha));
	if (unledgered.length === 0) return [];
	const theirs = readPatchIds(unledgered, root, execFn);
	const ours = readPatchIds(mine, root, execFn);
	if (!theirs || !ours) return null;
	const matched = new Set(ours.values());
	return unledgered.filter((sha) => !matched.has(theirs.get(sha) ?? ""));
}

/**
 * @param {string} log
 * @returns {Map<string, Set<string>>}
 */
function pathsByCommit(log) {
	/** @type {Map<string, Set<string>>} */
	const touched = new Map();
	for (const chunk of log.split("\0")) {
		const [sha, ...paths] = lines(chunk);
		if (!sha) continue;
		const set = touched.get(sha) ?? new Set();
		for (const p of paths) set.add(p);
		touched.set(sha, set);
	}
	return touched;
}

/**
 * @param {string} dirty
 * @param {Map<string, Set<string>>} touched
 * @param {Set<string>} notOwn
 * @returns {Set<string>}
 */
function ownedPaths(dirty, touched, notOwn) {
	const owed = new Set(lines(dirty));
	for (const [sha, paths] of touched)
		if (!notOwn.has(sha)) for (const p of paths) owed.add(p);
	return owed;
}

/**
 * @param {string} root
 * @param {string} base
 * @param {Parameters<typeof readOwnPaths>[2]} [options]
 */
function readOwnWork(root, base, options) {
	const resolved = readOwnPaths(root, base, options);
	return resolved && resolved.dropped.length > 0 ? resolved : null;
}

module.exports = { readNeighbourCommits, readOwnPaths, readOwnWork };
