/*
 * landing-status.js — where each of a session's commits stands on the landing
 * route: landed on `main`, queued on the session's own queue ref, or pushed
 * to no queue ref at all (workflow-core#2407, spec workflow-core#2261; workflow-core#4485, spec workflow-core#4458).
 */

const { caught } = require("./caught.js");
const { LANDER_GIT_TIMEOUT_MS, short } = require("./lander-git.js");
const {
	pushedRef,
	QUEUE_REFSPEC,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
} = require("./landing-refs.js");
const { execGit } = require("./git.js");

/**
 * @typedef {{kind: "landed"} | {kind: "queued"} | {kind: "unpushed"}}
 *   CommitState
 * @typedef {{
 *   pushed: string,
 *   isOn: (ref: string, sha: string) => boolean,
 * }} StatusGit `pushed` is lib/landing-refs.js's pushed ref for the session's
 *   tree
 */

/**
 * The state of each commit, in the order given. A commit on neither branch
 * that HEAD no longer holds, such as one an amend replaced, is left out.
 * @param {string[]} commits full shas
 * @param {StatusGit} git
 * @returns {{sha: string, state: CommitState}[]}
 */
function commitStates(commits, git) {
	return commits.flatMap((sha) => {
		const state = stateOf(sha, git);
		return state ? [{ sha, state }] : [];
	});
}

/**
 * @param {string} sha
 * @param {StatusGit} git
 * @returns {CommitState|null}
 */
function stateOf(sha, git) {
	if (!git.isOn(git.pushed, sha)) {
		if (git.isOn(VERIFIED_REF, sha)) return { kind: "landed" };
		return git.isOn("HEAD", sha) ? { kind: "unpushed" } : null;
	}
	return git.isOn(VERIFIED_REF, sha) ? { kind: "landed" } : { kind: "queued" };
}

/**
 * @param {{sha: string, state: CommitState}} entry
 * @param {string} subject
 * @param {string|null} queue the session's queue ref, `queue/<name>`, or null
 *   where its tree is no session worktree
 */
function buildStateLine({ sha, state }, subject, queue) {
	const head = `${short(sha)} ${subject}`;
	switch (state.kind) {
		case "landed":
			return `landed: ${head} — on main`;
		case "queued":
			return `queued: ${head} — on ${queue ?? "a queue ref"}, not yet on main`;
		case "unpushed":
			return `unpushed: ${head} — not pushed to ${queue ?? "a queue ref"}`;
	}
}

/**
 * Git in `root`, after one fetch from `origin` of `main` and every queue ref, pruning the queue refs gone from it. Every read throws where git
 * fails, the fetch included.
 * @param {string} root
 * @param {string} tree the session's tree top level
 * @returns {StatusGit & {subjectOf: (sha: string) => string}}
 */
function fetchedGit(root, tree) {
	/** @param {string[]} args */
	const git = (args) =>
		execGit(args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: LANDER_GIT_TIMEOUT_MS,
		});
	git([
		"fetch",
		"--quiet",
		"--prune",
		REMOTE,
		trackingRefspec(VERIFIED_BRANCH),
		QUEUE_REFSPEC,
	]);
	return {
		pushed: pushedRef({ root, tree }),
		isOn(ref, sha) {
			try {
				git(["merge-base", "--is-ancestor", sha, ref]);
				return true;
			} catch (err) {
				/* Exit 1 is git's "not an ancestor"; any other exit is a failed read. */
				if (caught(err).status === 1) return false;
				throw err;
			}
		},
		subjectOf: (sha) => git(["log", "-1", "--format=%s", sha]).trim(),
	};
}

module.exports = { commitStates, fetchedGit, buildStateLine };
