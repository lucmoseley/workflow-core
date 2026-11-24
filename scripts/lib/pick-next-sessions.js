const fs = require("node:fs");
const nodePath = require("node:path");
const { gitDirs } = require("./git.js");
const { holderName } = require("./parent-claims.js");

/** @typedef {import("./agent-liveness.js").ListedSessions} ListedSessions */

/**
 * @param {string[]|null|undefined} assignees
 * @param {string|null|undefined} session
 * @param {boolean|undefined} kept
 * @param {Map<string, string>|null|undefined} names
 * @returns {string}
 */
function claimHolder(assignees, session, kept, names) {
	const who =
		assignees && assignees.length > 0
			? assignees.join(", ")
			: `session ${holderName(names, session)}`;
	return kept ? `${who}, liveness unread` : who;
}

/**
 * @param {string} dir
 * @returns {string|null}
 */
function readRealOrNull(dir) {
	try {
		return fs.realpathSync(dir);
	} catch {
		return null;
	}
}

/**
 * @param {string} dir
 * @returns {string|null}
 */
function readCanonicalCheckoutOf(dir) {
	const dirs = gitDirs(dir);
	if (!dirs) return null;
	const { gitDir, common } = dirs;
	return gitDir === common
		? readRealOrNull(dir)
		: readRealOrNull(nodePath.dirname(common));
}

/**
 * @param {string} repoRoot
 * @param {string} storeRoot
 * @returns {{why: string, use: string}|null}
 */
function storeElsewhere(repoRoot, storeRoot) {
	const mine = readRealOrNull(repoRoot);
	const theirs = readRealOrNull(storeRoot);
	if (!mine || !theirs) return null;
	const want = readCanonicalCheckoutOf(mine) || mine;
	if (want === theirs) return null;
	return {
		why: `the claim store resolves to ${theirs}, not the tree this run's claims are filed under (${want})`,
		use: want,
	};
}

/**
 * @template {{why: string|null}} C
 * @param {C} claims
 * @param {{why: string, use: string}|null} elsewhere
 * @returns {C & {claimsTree?: string|null}}
 */
function claimsFromStore(claims, elsewhere) {
	return elsewhere
		? {
				...claims,
				why: claims.why
					? `${elsewhere.why}; also, ${claims.why}`
					: elsewhere.why,
				claimsTree: elsewhere.use,
			}
		: claims;
}

/**
 * @param {ListedSessions} listed
 * @param {string|null} me
 * @returns {{ok: false, error: string}|{ok: true, count: number, ids: string[]}}
 */
function reclaimableFrom(listed, me) {
	if (!listed.finished) return { ok: false, error: listed.why };
	if (!me)
		return {
			ok: false,
			error:
				"CLAUDE_CODE_SESSION_ID is unset, so this run cannot be told apart from the finished sessions it would count",
		};
	const finished = [...listed.finished].filter((id) => id !== me);
	return { ok: true, count: finished.length, ids: finished };
}

module.exports = {
	claimHolder,
	claimsFromStore,
	reclaimableFrom,
	storeElsewhere,
};
