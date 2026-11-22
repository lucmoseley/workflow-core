const fs = require("node:fs");
const { readProcCwd } = require("./claude-sessions.js");
const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const {
	QUEUE_REFSPEC,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
} = require("./landing-refs.js");
const { mainCheckout } = require("./main-checkout.js");
const { REAL_PROC } = require("./proc-root.js");
const { sleepSync } = require("./sleep-sync.js");
const { readLinkedWorktrees } = require("./worktree-paths.js");

// guess, #5529
const FETCH_TRIES = 3;
// guess, #5529
const POLL_MS = 1000;

class CheckoutError extends Error {}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout]
 * @returns {string}
 */
const git = (args, cwd, timeout = GIT_TIMEOUT_MS) =>
	execGit(args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
	}).trim();

/**
 * @param {string} cwd
 * @returns {string}
 */
function rootOf(cwd) {
	const root = mainCheckout(cwd);
	if (root === null)
		throw new CheckoutError(
			`${cwd} is in no main checkout git can name — run this from inside the repository`,
		);
	return fs.realpathSync(root);
}

/**
 * @param {string} root
 * @param {number} [timeout]
 */
function fetchShared(root, timeout) {
	for (let tries = 1; ; tries++)
		try {
			git(
				[
					"fetch",
					"--quiet",
					"--prune",
					REMOTE,
					trackingRefspec(VERIFIED_BRANCH),
					QUEUE_REFSPEC,
				],
				root,
				timeout,
			);
			return;
		} catch (err) {
			if (tries >= FETCH_TRIES || !/cannot lock ref/.test(String(err)))
				throw err;
			sleepSync(POLL_MS);
		}
}

/** @param {string} dir */
function adminDirOf(dir) {
	return git(["rev-parse", "--absolute-git-dir"], dir);
}

/** @returns {{ pid: string, cwd: string }[]} */
function readProcesses() {
	/** @type {{ pid: string, cwd: string }[]} */
	const out = [];
	for (const pid of fs.readdirSync(REAL_PROC))
		if (/^\d+$/.test(pid)) {
			const cwd = readProcCwd(pid, REAL_PROC);
			if (cwd) out.push({ pid, cwd: cwd.replace(/ \(deleted\)$/, "") });
		}
	return out;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function readWorktreesOrThrow(root) {
	const registered = readLinkedWorktrees(root);
	if (registered === null)
		throw new Error(
			`git would not list the worktrees of ${root}, so none can be judged — run \`git worktree list\` there to see why`,
		);
	return registered;
}

module.exports = {
	adminDirOf,
	CheckoutError,
	fetchShared,
	git,
	POLL_MS,
	readProcesses,
	readWorktreesOrThrow,
	rootOf,
};
