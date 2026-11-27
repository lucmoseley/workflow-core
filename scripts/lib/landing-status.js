const {
	isAncestor,
	LANDER_GIT_TIMEOUT_MS,
	readGit,
	short,
} = require("./lander-git.js");
const { fetchShared } = require("./checkout-repo.js");
const { pushedRef, VERIFIED_REF } = require("./landing-refs.js");

/**
 * @typedef {{kind: "landed"} | {kind: "queued"} | {kind: "unpushed"}} CommitState
 * @typedef {{
 *   pushed: string,
 *   isOn: (ref: string, sha: string) => boolean,
 * }} StatusGit
 */

/**
 * @param {string[]} commits
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
 * @param {string|null} queue
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
 * @param {string} root
 * @param {string} tree
 * @returns {StatusGit & {subjectOf: (sha: string) => string}}
 */
function fetchedGit(root, tree) {
	fetchShared(root, LANDER_GIT_TIMEOUT_MS);
	return {
		pushed: pushedRef({ tree }),
		isOn: (ref, sha) => isAncestor(root, sha, ref),
		subjectOf: (sha) => readGit(root, ["log", "-1", "--format=%s", sha]).trim(),
	};
}

module.exports = { commitStates, fetchedGit, buildStateLine };
