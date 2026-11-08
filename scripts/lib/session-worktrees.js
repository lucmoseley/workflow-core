/*
 * session-worktrees.js — the host repository's linked worktrees, each with
 * the session it belongs to, for the readers that report a dead session's
 * uncommitted work (#4244, spec #4229).
 *
 * A WORKTREE BELONGS TO THE SESSION WHOSE CWD LIES IN IT. The launcher starts
 * each session with its worktree as cwd (#4229), so the cwd is read where it
 * is recorded: the agents oracle's listing for a listed session, else the
 * harness's job records (`<seat>/jobs/<id>/state.json`), which outlive their
 * session, so a dead session's worktree still names it. Where several do, a
 * listed session wins, else the record written last.
 *
 * A WORKTREE NO CWD LIES IN HAS NO OWNER: a session that moved into it after
 * launch, a headless run, a tool's own tree. Callers judge its dirt as they
 * judge the main checkout's.
 */

const fs = require("node:fs");
const path = require("node:path");
const { configDirs } = require("./arbiter-store");
const { caught } = require("./caught.js");
const { deref } = require("./deref.js");
const { jobStorePath, readJobRecordIn } = require("./job-paths.js");
const { isUnder, relativeUnder } = require("./is-under.js");

/**
 * @typedef {{sessionId: string, name: string|null}} Owner
 * @typedef {{id: string, seat: string, sessionId: string, name: string|null,
 *   cwd: string, at: number, state: string|null}} JobCwd
 *   `id` the job's directory name, the id `claude attach` takes; `seat` the
 *   config dir holding it
 * @typedef {{cwds?: Map<string, string>, names?: Map<string, string>}} ListedCwds
 *   the agents oracle's read: each listed session's cwd and name
 */

/**
 * A job record's id, seat, cwd, session, name and state; null where it names
 * no cwd or session.
 * @param {ReturnType<typeof readJobRecordIn>} job
 * @param {string} id the job's directory name
 * @param {string} seat the config dir holding it
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

/**
 * The id, seat, cwd, session, name and state of every job record on every
 * seat, and each job store or record that would not read. An absent store
 * holds no job; one that faults otherwise, EACCES among them, may hold a
 * resumable one, so `unread` names it for the caller to judge on.
 * @returns {{jobs: JobCwd[], unread: string[]}} `unread` as `<path>: <fault>`
 */
function readJobCwds() {
	/** @type {JobCwd[]} */
	const jobs = [];
	/** @type {string[]} */
	const unread = [];
	for (const seat of configDirs()) {
		const store = jobStorePath(seat);
		let ids;
		try {
			ids = fs.readdirSync(store);
		} catch (err) {
			if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT")
				unread.push(`${store}: ${caught(err).message}`);
			continue;
		}
		for (const id of ids) {
			const dir = path.join(store, id);
			let record;
			try {
				record = readJobRecordIn(dir);
			} catch (err) {
				unread.push(`${dir}: ${caught(err).message}`);
				continue;
			}
			const job = jobCwdOf(record, id, seat);
			if (job) jobs.push(job);
		}
	}
	return { jobs, unread };
}

/**
 * The worktree among `worktrees` that holds `cwd`, the deepest where they
 * nest; null where none does.
 * @param {string} cwd dereferenced
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
 * Each worktree a listed session's cwd lies in, with that session.
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
 * Each worktree's owner, for those any recorded cwd lies in, and readJobCwds'
 * `unread`: a worktree with no owner may belong to a job in one of those.
 * @param {string[]} worktrees dereferenced, as worktree-paths.js's readLinkedWorktrees gives them
 * @param {ListedCwds} [listed] the oracle read, whose sessions win over job
 *   records
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
 * How a worktree is named in a report: relative to the host root where it sits
 * inside it, else as given.
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
