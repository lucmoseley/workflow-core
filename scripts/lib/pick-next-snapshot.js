const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { markersDir } = require("./marker-root.js");

/**
 * @typedef {{number: number, reason: string, detail?: {takes?: string[]}}} Reasoned
 * @typedef {{generatedAt: string, repo: string, argv?: string[],
 *   excluded?: Reasoned[], notLaunched?: Reasoned[],
 *   waiting?: {number: number, days: number | null}[],
 *   parked?: {number: number}[],
 *   frontier?: {number: number}[]}} Snapshot
 */

/** @param {string} root */
const snapshotFile = (root) =>
	path.join(markersDir(root), ".pick-next", "last-run.json");

/**
 * @param {string} root
 * @param {string} repo
 * @returns {{snapshot: Snapshot | null, why: string | null}}
 */
function readSnapshot(root, repo) {
	/** @type {Snapshot} */
	let snapshot;
	try {
		snapshot = JSON.parse(fs.readFileSync(snapshotFile(root), "utf8"));
	} catch (e) {
		return caught(e).code === "ENOENT"
			? { snapshot: null, why: null }
			: { snapshot: null, why: caught(e).message };
	}
	const otherTracker =
		snapshot.argv?.includes("--repo") && snapshot.repo !== repo;
	return { snapshot: otherTracker ? null : snapshot, why: null };
}

/**
 * @param {Snapshot | null} snapshot
 * @param {number} n
 * @returns {string | null}
 */
function whyNotLaunched(snapshot, n) {
	if (!snapshot) return null;
	/** @template {{number: number}} T @param {T[] | undefined} rows */
	const row = (rows) => rows?.find((r) => r.number === n);
	const waiting = row(snapshot.waiting);
	const notLaunched = row(snapshot.notLaunched);
	const why =
		row(snapshot.excluded)?.reason ??
		(row(snapshot.parked)
			? "parked — an away-mode refill loop skips it; a normal-mode one resumes it ahead of new work, oldest park first"
			: null) ??
		(waiting
			? `waiting on someone outside${waiting.days === null ? "" : ` for ${waiting.days} days`}`
			: null) ??
		(notLaunched
			? `${notLaunched.reason}${notLaunched.detail?.takes ? ` (takes: ${notLaunched.detail.takes.join("+") || "none"})` : ""}`
			: null) ??
		(row(snapshot.frontier) ? "in its launch set" : null);
	return why === null ? null : `${why} (pick-next, ${snapshot.generatedAt})`;
}

module.exports = { readSnapshot, snapshotFile, whyNotLaunched };
