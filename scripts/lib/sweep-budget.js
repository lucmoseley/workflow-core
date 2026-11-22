const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { gitCommonDir } = require("./git.js");

// lucmoseley/mantahostels#3495 guess sized on GitHub Free minutes
const AUTOFIRE_DAILY_CAP = 3;
const AUTOFIRE_MARKER = ".sweep-autofire";

/**
 * @param {number} t
 * @returns {string}
 */
function dayOf(t) {
	return new Date(t).toISOString().slice(0, 10);
}

/**
 * @param {string} repo
 * @returns {string|null}
 */
function markerPath(repo) {
	const dir = gitCommonDir(repo);
	return dir ? path.join(dir, AUTOFIRE_MARKER) : null;
}

/**
 * @param {string} marker
 * @returns {{state: {last?: number, day?: string, count?: number}, error: unknown}}
 */
function readState(marker) {
	try {
		return { state: JSON.parse(fs.readFileSync(marker, "utf8")), error: null };
	} catch (e) {
		if (caught(e).code === "ENOENT") return { state: {}, error: null };
		return { state: {}, error: e };
	}
}

/**
 * @param {{day?: string, count?: number}} state
 * @param {number} t
 * @returns {number}
 */
function spentToday(state, t) {
	return state.day === dayOf(t) ? Number(state.count) || 0 : 0;
}

/**
 * @param {string} marker
 * @param {number} t
 * @param {number} spent
 */
function recordFiring(marker, t, spent) {
	fs.writeFileSync(
		marker,
		JSON.stringify({ last: t, day: dayOf(t), count: spent + 1 }),
	);
}

/**
 * @param {string} repo
 * @param {number} t
 * @returns {{ out: boolean, spent: number, cap: number, day: string } | { fault: string }}
 */
function spendFire(repo, t) {
	const marker = markerPath(repo);
	if (!marker) return { fault: "git would not name a common dir" };
	const { state, error } = readState(marker);
	if (error !== null)
		return {
			fault: `could not read ${AUTOFIRE_MARKER}: ${caught(error).message}`,
		};
	const spent = spentToday(state, t);
	const day = dayOf(t);
	if (spent >= AUTOFIRE_DAILY_CAP)
		return { out: true, spent, cap: AUTOFIRE_DAILY_CAP, day };
	recordFiring(marker, t, spent);
	return { out: false, spent: spent + 1, cap: AUTOFIRE_DAILY_CAP, day };
}

module.exports = {
	AUTOFIRE_DAILY_CAP,
	markerPath,
	readState,
	recordFiring,
	spendFire,
	spentToday,
};
