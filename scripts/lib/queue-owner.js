/*
 * queue-owner.js — whether a queue ref's owning session is still working,
 * for the queue lander, which files no fix ticket for a drop while it is
 * (#4950, spec #4947).
 *
 * A queue ref is named after its owning session's worktree
 * (lib/landing-refs.js), so the read finds that worktree among the host's
 * linked worktrees, takes its owner from lib/session-worktrees.js, the
 * session whose cwd lies in it, and asks lib/agent-liveness.js whether that
 * session is listed and not terminal.
 *
 * DOUBT IS `stopped`, and nothing here throws. A drop is then ticketed
 * rather than deferred for good on a guess, and a read that failed says so
 * on stderr.
 * Residual: a listed session left idle reads `working` for as long as it is
 * listed.
 */

const fs = require("node:fs");
const { parseErrorFirstLine } = require("./first-line.js");
const { admissionSessionIds, isListedLive } = require("./agent-liveness.js");
const { ownQueueRef, queueBranch } = require("./landing-refs.js");
const { worktreeOwners } = require("./session-worktrees.js");
const { readLinkedWorktrees } = require("./worktree-paths.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {import("./queue-lander.js").OwnerRead} OwnerRead
 * @typedef {object} OwnerDeps
 * @property {() => string[]|null} worktrees the host's linked worktrees,
 *   null where git will not list them
 * @property {() => import("./agent-liveness.js").ListedSessions} listed the
 *   agents oracle's listing, or why it would not read
 * @property {(line: string) => void} say
 */

/**
 * The lander runs as no session, so an empty listing reads as nothing live.
 * @param {string} root the canonical checkout
 * @returns {OwnerDeps}
 */
const liveOwnerDeps = (root) => ({
	worktrees: () => readLinkedWorktrees(root),
	listed: () => admissionSessionIds(),
	say: (line) => writeFd(2, `${line}\n`),
});

/**
 * Whether the owning session of `queue/<name>` is working.
 * @param {string} root the canonical checkout
 * @param {string} name after `queue/`
 * @param {OwnerDeps} [deps]
 * @returns {OwnerRead}
 */
function readOwner(root, name, deps = liveOwnerDeps(root)) {
	const queued = queueBranch(name);
	/** @param {string} why */
	const unread = (why) => {
		deps.say(
			`queue-lander: the owning session of ${queued} could not be read, so it reads as stopped: ${why}`,
		);
		return /** @type {const} */ ("stopped");
	};
	try {
		const trees = deps.worktrees();
		if (trees === null) return unread("git listed no worktrees");
		const tree = trees.find((wt) => ownQueueRef(wt, root) === queued);
		if (tree === undefined || !fs.existsSync(tree)) return "stopped";
		const listed = deps.listed();
		if (listed.why !== undefined) return unread(listed.why);
		const owner = worktreeOwners([tree], listed).owners.get(tree);
		return owner && isListedLive(owner.sessionId, listed.ids, listed.terminal)
			? "working"
			: "stopped";
	} catch (err) {
		return unread(parseErrorFirstLine(err));
	}
}

module.exports = { readOwner };
