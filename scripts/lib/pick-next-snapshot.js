/*
 * pick-next-snapshot.js — the file every pick-next.js run leaves its whole
 * `--json` payload in (its writeRunSnapshot), and the one reader of it outside
 * pick-next: scripts/file-morning-review.js, asking why an issue went
 * unlaunched (#2693).
 */

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
 *   frontier?: {number: number}[]}} Snapshot the payload fields read here
 */

/** @param {string} root a checkout */
const snapshotFile = (root) =>
	path.join(markersDir(root), ".pick-next", "last-run.json");

/**
 * The last pick-next run in checkout `root`, as `snapshot`, or null with
 * `why` where it would not read. Null and no `why` where none has run, or
 * the last run read another tracker than `repo` (its `--repo`).
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
 * Why the snapshot's run left issue `n` unlaunched: its exclusion, else its
 * park, which the refill loop never launches (lib/refill-decide.js; #2722),
 * else its wait on someone outside, else its not-launched reason, else its
 * place in the launch set. Null where there is no snapshot or it does not list `n`.
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
			? "parked — the refill loop never launches it"
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
