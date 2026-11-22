const fs = require("node:fs");
const path = require("node:path");
const { isListedLive } = require("./agent-liveness.js");
const { orFallback } = require("./caught.js");

const { paths, recordTree, subjectPath } = require("./arbiter-store");
const { deref } = require("./deref.js");
const { porcelainEntries } = require("./dirty-tree.js");
const { gitOrNull } = require("./git.js");
const { worktreeOwners } = require("./session-worktrees.js");
const { readLinkedWorktrees } = require("./worktree-paths.js");

/*
 * How long a claim must stand after its holder stops being listed before the
 * reports count it as stranded.
 *
 * A THRESHOLD ON WHAT IS SAID, NEVER ON WHAT IS DONE: nothing releases a claim
 * at any age (mantahostels#318 refused expiry), and the caller's oracle read already keeps
 * live sessions out of the count. So its job is keeping noise out of an
 * informational report, plus one piece of insurance: sitting above the longest
 * a claim has ever been legitimately held, so that even where the liveness
 * oracle wrongly lists a live session as gone, the count names only the
 * certainly dead.
 *
 * DERIVED at mantahostels#1746 from mantahostels#1745's census of 151 stale claims
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/stranded-claim-age-distribution.md): no holder lived more
 * than 9.2 h after taking a claim (median 0.9 h), and 12 is the smallest of
 * the census's measured candidate thresholds (1/3/6/12/24/48/72/168 h) above
 * that ceiling.
 */
const STRANDED_AFTER_HOURS = 12;

const EMPTY_IDS = new Set();

/** @param {string | undefined} claimedAt */
function hoursHeld(claimedAt) {
	const at = Date.parse(claimedAt ?? "");
	if (!Number.isFinite(at)) return null;
	return (Date.now() - at) / 3_600_000;
}

function readDirtyPaths(root = paths.repoRoot()) {
	const out = gitOrNull(["status", "--porcelain", "-z", "-uall"], {
		cwd: root,
	});
	if (out === null) return null;
	const dirty = new Set();
	for (const { path: p, source } of porcelainEntries(out)) {
		dirty.add(p);
		if (source) dirty.add(source);
	}
	return dirty;
}

/**
 * @typedef {import("./session-worktrees.js").ListedCwds} ListedCwds
 * @typedef {{worktree: string, owner: import("./session-worktrees.js").Owner,
 *   dirty: Set<string>, writtenMs: number | null}} WorktreeDirt
 * @typedef {{found: {worktree: string, dirty: Set<string>}[],
 *   unreadable: string[] | null}} DirtyWorktrees
 * @typedef {{worktrees: WorktreeDirt[], unread: string[]}} AttributedDirt
 */

/** @param {string} [root] @returns {DirtyWorktrees} */
function readDirtyWorktrees(root = paths.repoRoot()) {
	const listed = readLinkedWorktrees(root);
	/** @type {DirtyWorktrees["found"]} */
	const found = [];
	/** @type {string[]} */
	const unreadable = [];
	for (const worktree of listed ?? []) {
		const dirty = readDirtyPaths(worktree);
		if (dirty === null) unreadable.push(worktree);
		else if (dirty.size > 0) found.push({ worktree, dirty });
	}
	return { found, unreadable: listed === null ? null : unreadable };
}

/**
 * @param {DirtyWorktrees["found"]} found
 * @param {ListedCwds} [listed]
 * @returns {AttributedDirt}
 */
function attributeWorktreeDirt(found, listed) {
	if (found.length === 0) return { worktrees: [], unread: [] };
	const { owners, unread } = worktreeOwners(
		found.map((f) => f.worktree),
		listed,
	);
	const worktrees = found.flatMap(({ worktree, dirty }) => {
		const owner = owners.get(worktree);
		return owner
			? [
					{
						worktree,
						owner,
						dirty,
						writtenMs: readNewestWrite(worktree, dirty),
					},
				]
			: [];
	});
	return { worktrees, unread };
}

/** @param {string} root @param {Iterable<string>} rels */
function readNewestWrite(root, rels) {
	let newest = null;
	for (const rel of rels) {
		const mtimeMs = orFallback(
			() => fs.statSync(path.join(root, rel)).mtimeMs,
			null,
		);
		if (mtimeMs !== null && (newest === null || mtimeMs > newest))
			newest = mtimeMs;
	}
	return newest;
}

/**
 * @param {WorktreeDirt[]} worktrees
 * @param {Set<string>} listedIds
 * @param {{ hours?: number, terminal?: Set<string> }} [opts]
 * @returns {{ stranded: WorktreeDirt[], young: number }}
 */
function classifyWorktrees(
	worktrees,
	listedIds,
	{ hours = STRANDED_AFTER_HOURS, terminal = EMPTY_IDS } = {},
) {
	const now = Date.now();
	/** @type {WorktreeDirt[]} */
	const stranded = [];
	let young = 0;
	for (const w of worktrees) {
		if (isListedLive(w.owner.sessionId, listedIds, terminal)) continue;
		if (w.writtenMs !== null && (now - w.writtenMs) / 3_600_000 < hours)
			young++;
		else stranded.push(w);
	}
	return { stranded, young };
}

/**
 * @param {Set<string> | null} dirty
 * @param {DirtyWorktrees["found"]} found
 * @returns {Map<string, Set<string>> | null}
 */
function dirtByTree(dirty, found) {
	if (dirty === null) return null;
	const out = new Map([[deref(paths.repoRoot()), dirty]]);
	for (const f of found) out.set(f.worktree, f.dirty);
	return out;
}

/**
 * @param {Map<string, Set<string>> | null} dirt
 * @param {{path: string, tree?: string}} lock
 */
function isDirtyClaim(dirt, lock) {
	return (
		dirt?.get(deref(recordTree(lock)))?.has(subjectPath(lock.path)) === true
	);
}

/** @typedef {import("./arbiter-store").ListedLock} Lock */

/**
 * @param {Lock} lock
 * @param {Set<string>} listedIds
 * @param {number} [hours]
 * @param {Set<string>} [terminalIds]
 * @returns {"unreadable" | "listed" | "young" | "stranded"}
 */
function strandedVerdict(
	lock,
	listedIds,
	hours = STRANDED_AFTER_HOURS,
	terminalIds = EMPTY_IDS,
) {
	if (lock.unreadable || !lock.sessionId) return "unreadable";
	if (isListedLive(lock.sessionId, listedIds, terminalIds)) return "listed";
	const held = hoursHeld(lock.claimedAt);
	if (held !== null && held < hours) return "young";
	return "stranded";
}

/**
 * @typedef {Exclude<Lock, { unreadable: true }> & { sessionId: string }} ReadableLock
 */

/**
 * @param {Lock[]} locks
 * @param {Set<string>} listedIds
 * @param {{ hours?: number, terminal?: Set<string> }} [opts]
 * @returns {{ stranded: ReadableLock[], young: ReadableLock[], unreadable: Lock[], live: ReadableLock[] }}
 */
function classifyClaims(
	locks,
	listedIds,
	{ hours = STRANDED_AFTER_HOURS, terminal = EMPTY_IDS } = {},
) {
	/** @type {{ stranded: ReadableLock[], young: ReadableLock[], unreadable: Lock[], live: ReadableLock[] }} */
	const buckets = { stranded: [], young: [], unreadable: [], live: [] };
	for (const lock of locks) {
		if (lock.unreadable || !lock.sessionId) {
			buckets.unreadable.push(lock);
			continue;
		}
		const readable = /** @type {ReadableLock} */ (lock);
		const verdict = strandedVerdict(lock, listedIds, hours, terminal);
		if (verdict === "listed") buckets.live.push(readable);
		else if (verdict === "young") buckets.young.push(readable);
		else buckets.stranded.push(readable);
	}
	return buckets;
}

/**
 * @param {Lock[] | null} locks
 * @param {Set<string> | null | undefined} listedIds
 * @param {{dirty?: Set<string> | null, terminal?: Set<string>,
 *   found?: DirtyWorktrees["found"], attributed?: AttributedDirt}} [opts]
 */
function countStranded(
	locks,
	listedIds,
	{
		dirty = null,
		terminal = EMPTY_IDS,
		found = [],
		attributed = { worktrees: [], unread: [] },
	} = {},
) {
	if (locks === null)
		return { ok: false, error: "the file-claim store could not be read" };
	if (!listedIds)
		return { ok: false, error: "the running-session oracle could not be read" };

	const { stranded } = classifyClaims(locks, listedIds, { terminal });
	const dirt = dirtByTree(dirty, found);
	const carrying = dirt
		? stranded.filter((lock) => isDirtyClaim(dirt, lock)).length
		: null;
	return {
		ok: true,
		stranded: stranded.length,
		carrying,
		strandedWorktrees:
			attributed.unread.length > 0
				? null
				: classifyWorktrees(attributed.worktrees, listedIds, { terminal })
						.stranded.length,
	};
}

module.exports = {
	STRANDED_AFTER_HOURS,
	hoursHeld,
	classifyClaims,
	readDirtyPaths,
	readDirtyWorktrees,
	attributeWorktreeDirt,
	dirtByTree,
	classifyWorktrees,
	isDirtyClaim,
	countStranded,
};
