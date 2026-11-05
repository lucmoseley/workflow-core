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
const { deref } = require("./deref.js");
const { gitRead } = require("./dirty-tree.js");
const { jobStorePath, readJobRecordIn } = require("./job-paths.js");
const { worktreePaths } = require("./worktree-paths.js");

/**
 * @typedef {{sessionId: string, name: string|null}} Owner
 * @typedef {{sessionId: string, name: string|null, cwd: string, at: number,
 *   state: string|null}} JobCwd
 * @typedef {{cwds?: Map<string, string>, names?: Map<string, string>}} ListedCwds
 *   the agents oracle's read: each listed session's cwd and name
 */

/**
 * Every linked worktree of the repository holding `root`, symlinks
 * dereferenced, the main checkout left out — or null where git will not list
 * them. A registration whose directory is gone is listed; reading it fails
 * and the caller passes it over.
 * @param {string} root
 * @returns {string[]|null}
 */
function readLinkedWorktrees(root) {
	const out = gitRead(["worktree", "list", "--porcelain", "-z"], root);
	if (out === null) return null;
	return worktreePaths(() => out)
		.slice(1)
		.map(deref);
}

/**
 * A job record's cwd, session, name and state; null where it names no cwd or
 * session.
 * @param {ReturnType<typeof readJobRecordIn>} job
 * @returns {JobCwd | null}
 */
function jobCwdOf(job) {
	if (typeof job?.cwd !== "string" || typeof job.sessionId !== "string")
		return null;
	return {
		sessionId: job.sessionId,
		name: typeof job.name === "string" ? job.name : null,
		cwd: deref(job.cwd),
		at: Date.parse(job.updatedAt ?? "") || 0,
		state: typeof job.state === "string" ? job.state : null,
	};
}

/**
 * The cwd, session, name and state of every job record on every seat.
 * @returns {JobCwd[]}
 */
function readJobCwds() {
	/** @type {JobCwd[]} */
	const out = [];
	for (const seat of configDirs()) {
		const store = jobStorePath(seat);
		let ids;
		try {
			ids = fs.readdirSync(store);
		} catch {
			continue;
		}
		for (const id of ids) {
			const job = jobCwdOf(readJobRecordIn(path.join(store, id)));
			if (job) out.push(job);
		}
	}
	return out;
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
			(cwd === wt || cwd.startsWith(`${wt}${path.sep}`)) &&
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
 * Each worktree's owner, for those any recorded cwd lies in.
 * @param {string[]} worktrees dereferenced, as readLinkedWorktrees gives them
 * @param {ListedCwds} [listed] the oracle read, whose sessions win over job
 *   records
 * @returns {Map<string, Owner>}
 */
function worktreeOwners(worktrees, listed) {
	const owners = listedOwners(worktrees, listed);
	/** @type {Map<string, JobCwd>} */
	const latest = new Map();
	for (const job of readJobCwds()) {
		const wt = worktreeHolding(job.cwd, worktrees);
		if (!wt || owners.has(wt)) continue;
		const seen = latest.get(wt);
		if (!seen || job.at > seen.at) latest.set(wt, job);
	}
	for (const [wt, { sessionId, name }] of latest)
		owners.set(wt, { sessionId, name });
	return owners;
}

/**
 * A worktree's path relative to the host root, or null where it sits outside
 * it — where no claim or ledger, both spelt host-relative, can name its files.
 * @param {string} root
 * @param {string} wt
 * @returns {string|null}
 */
function hostRelative(root, wt) {
	const rel = path.relative(deref(root), wt);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
}

/**
 * How a worktree is named in a report: host-relative where it can be, else
 * as given.
 * @param {string} root
 * @param {string} wt
 */
const worktreeLabel = (root, wt) => hostRelative(root, wt) ?? wt;

module.exports = {
	hostRelative,
	readJobCwds,
	readLinkedWorktrees,
	worktreeHolding,
	worktreeLabel,
	worktreeOwners,
};
