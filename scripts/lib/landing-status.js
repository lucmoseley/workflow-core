/*
 * landing-status.js — where each of a session's commits stands on the landing
 * route (#2407, spec #2261): landed on `main`, queued on `landing`, reverted by
 * a revert that sits on `landing`, or not on `landing` at all.
 *
 * A REVERT is a commit on `landing` whose message carries lib/lander.js's
 * revertLine.
 */

const { execFileSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { GIT_TIMEOUT_MS, revertLine } = require("./lander.js");
const {
	LANDING_BRANCH,
	LANDING_REF,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
} = require("./landing-refs.js");

/**
 * @typedef {{kind: "landed"} | {kind: "queued"} | {kind: "reverted", by: string}
 *   | {kind: "unpushed"}} CommitState
 * @typedef {{
 *   isOn: (ref: string, sha: string) => boolean,
 *   revertOf: (sha: string) => string|null,
 * }} StatusGit `revertOf` answers the oldest commit on `landing`, after
 *   `sha`, that reverts it
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
	if (!git.isOn(LANDING_REF, sha)) {
		if (git.isOn(VERIFIED_REF, sha)) return { kind: "landed" };
		return git.isOn("HEAD", sha) ? { kind: "unpushed" } : null;
	}
	const by = standingRevert(sha, git);
	if (by) return { kind: "reverted", by };
	return git.isOn(VERIFIED_REF, sha) ? { kind: "landed" } : { kind: "queued" };
}

/**
 * The revert of `sha` still in force on `landing`, or null: down the chain of
 * reverts, an odd link stands and an even one restores `sha`.
 * @param {string} sha
 * @param {StatusGit} git
 * @returns {string|null}
 */
function standingRevert(sha, git) {
	const first = git.revertOf(sha);
	if (!first) return null;
	return standingRevert(first, git) ? null : first;
}

/**
 * @param {{sha: string, state: CommitState}} entry
 * @param {string} subject
 */
function stateLine({ sha, state }, subject) {
	const head = `${sha.slice(0, 9)} ${subject}`;
	switch (state.kind) {
		case "landed":
			return `landed: ${head} — on main`;
		case "queued":
			return `queued: ${head} — on landing, not yet on main`;
		case "reverted":
			return `reverted by ${state.by.slice(0, 9)}: ${head}`;
		case "unpushed":
			return `unpushed: ${head} — not on landing`;
	}
}

/**
 * Git in `root`, after one fetch of both branches from `origin`. Every read
 * throws where git fails, the fetch included.
 * @param {string} root
 * @returns {StatusGit & {subjectOf: (sha: string) => string}}
 */
function fetchedGit(root) {
	/** @param {string[]} args */
	const git = (args) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
	git([
		"fetch",
		"--quiet",
		REMOTE,
		trackingRefspec(VERIFIED_BRANCH),
		trackingRefspec(LANDING_BRANCH),
	]);
	return {
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
		revertOf(sha) {
			const found = git([
				"rev-list",
				"--reverse",
				"--fixed-strings",
				`--grep=${revertLine(sha)}`,
				`${sha}..${LANDING_REF}`,
			])
				.split("\n")
				.filter(Boolean);
			return found[0] ?? null;
		},
		subjectOf: (sha) => git(["log", "-1", "--format=%s", sha]).trim(),
	};
}

module.exports = { commitStates, fetchedGit, stateLine };
