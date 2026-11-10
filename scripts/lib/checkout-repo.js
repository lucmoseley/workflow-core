/*
 * checkout-repo.js — what every session-checkout step reads of the
 * repository and the machine: the main checkout a directory belongs to, the
 * shared fetch, a worktree's git directory, the linked worktrees, and every
 * live process's cwd. Its own module (#4703) so lib/dep-store.js and
 * lib/worktree-reaper.js read them without requiring lib/session-checkout.js
 * back. Its refusals are `CheckoutError`s, which the CLI prints as they
 * stand.
 */

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

/* Untraced: a neighbour's fetch holds the ref lock for well under a second. */
const FETCH_TRIES = 3;
/* Untraced: a fetch retry's and a store-lock wait's pause, short beside the
 * second-scale fetch and the minutes-scale `npm ci` either waits on. */
const POLL_MS = 1000;

/** A refusal the CLI prints as it stands. */
class CheckoutError extends Error {}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
const git = (args, cwd) =>
	execGit(args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	}).trim();

/**
 * The main checkout `cwd` belongs to, symlinks dereferenced.
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
 * Fetch `main` and every queue ref, pruning the queue refs gone from the
 * remote, again where a neighbour's fetch held a ref's lock.
 * @param {string} root
 */
function fetchShared(root) {
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
			);
			return;
		} catch (err) {
			if (tries >= FETCH_TRIES || !/cannot lock ref/.test(String(err)))
				throw err;
			sleepSync(POLL_MS);
		}
}

/**
 * The git directory of the worktree at `dir`.
 * @param {string} dir
 */
function adminDirOf(dir) {
	return git(["rev-parse", "--absolute-git-dir"], dir);
}

/**
 * Every process on this machine with a readable cwd, and that cwd. The real
 * /proc, whatever a test stands in.
 * @returns {{ pid: string, cwd: string }[]}
 */
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
 * Every linked worktree of `root`; a throw where git will not list them, as
 * each would then read unregistered.
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
