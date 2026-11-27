const fs = require("node:fs");
const path = require("node:path");
const { configDirs } = require("./arbiter-store");
const { caught } = require("./caught.js");
const { deref } = require("./deref.js");
const {
	isAbsentFault,
	jobStorePath,
	readJobRecordAt,
} = require("./job-paths.js");
const { isUnder, relativeUnder } = require("./is-under.js");

/**
 * @typedef {{sessionId: string, name: string|null}} Owner
 * @typedef {{id: string, seat: string, sessionId: string, name: string|null,
 *   cwd: string, at: number, state: string|null}} JobCwd
 * @typedef {{cwds?: Map<string, string>, names?: Map<string, string>}} ListedCwds
 */

/**
 * @param {any} job
 * @param {string} id
 * @param {string} seat
 * @returns {JobCwd | null}
 */
function jobCwdOf(job, id, seat) {
	if (typeof job?.cwd !== "string" || typeof job.sessionId !== "string")
		return null;
	return {
		id,
		seat,
		sessionId: job.sessionId,
		name: typeof job.name === "string" ? job.name : null,
		cwd: deref(job.cwd),
		at: Date.parse(job.updatedAt ?? "") || 0,
		state: typeof job.state === "string" ? job.state : null,
	};
}

/** @returns {{jobs: JobCwd[], unread: string[]}} */
function readJobCwds() {
	/** @type {JobCwd[]} */
	const jobs = [];
	/** @type {string[]} */
	const unread = [];
	for (const seat of configDirs()) readSeatJobs(seat, jobs, unread);
	return { jobs, unread };
}

/**
 * @param {string} seat
 * @param {JobCwd[]} jobs
 * @param {string[]} unread
 */
function readSeatJobs(seat, jobs, unread) {
	const store = jobStorePath(seat);
	let ids;
	try {
		ids = fs.readdirSync(store);
	} catch (err) {
		if (!isAbsentFault(err)) unread.push(`${store}: ${caught(err).message}`);
		return;
	}
	for (const id of ids) {
		const dir = path.join(store, id);
		const r = readJobRecordAt(dir);
		if (r.state === "unreadable") unread.push(`${dir}: ${r.message}`);
		const job = r.state === "read" ? jobCwdOf(r.data, id, seat) : null;
		if (job) jobs.push(job);
	}
}

/**
 * @param {string} cwd
 * @param {string[]} worktrees
 */
function worktreeHolding(cwd, worktrees) {
	let best = null;
	for (const wt of worktrees)
		if (
			isUnder(cwd, [wt], path.sep) &&
			(best === null || wt.length > best.length)
		)
			best = wt;
	return best;
}

/**
 * @param {string[]} worktrees
 * @param {ListedCwds} [listed]
 * @returns {Map<string, Owner>}
 */
function listedOwners(worktrees, listed) {
	/** @type {Map<string, Owner>} */
	const owners = new Map();
	for (const [sessionId, cwd] of listed?.cwds ?? []) {
		const wt = cwd ? worktreeHolding(deref(cwd), worktrees) : null;
		if (wt && !owners.has(wt))
			owners.set(wt, {
				sessionId,
				name: listed?.names?.get(sessionId) || null,
			});
	}
	return owners;
}

/**
 * @param {string[]} worktrees
 * @param {ListedCwds} [listed]
 * @returns {{owners: Map<string, Owner>, unread: string[]}}
 */
function worktreeOwners(worktrees, listed) {
	const owners = listedOwners(worktrees, listed);
	const { jobs, unread } = readJobCwds();
	/** @type {Map<string, JobCwd>} */
	const latest = new Map();
	for (const job of jobs) {
		const wt = worktreeHolding(job.cwd, worktrees);
		if (!wt || owners.has(wt)) continue;
		const seen = latest.get(wt);
		if (!seen || job.at > seen.at) latest.set(wt, job);
	}
	for (const [wt, { sessionId, name }] of latest)
		owners.set(wt, { sessionId, name });
	return { owners, unread };
}

/**
 * @param {string} root
 * @param {string} wt
 * @returns {string}
 */
function worktreeLabel(root, wt) {
	return relativeUnder(deref(root), wt) || wt;
}

module.exports = {
	readJobCwds,
	worktreeHolding,
	worktreeLabel,
	worktreeOwners,
};
