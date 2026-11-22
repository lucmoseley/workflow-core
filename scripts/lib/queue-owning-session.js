const fs = require("node:fs");
const { parseErrorFirstLine } = require("./first-line.js");
const { admissionSessionIds, isListedLive } = require("./agent-liveness.js");
const { ownQueueRef, queueBranch } = require("./landing-refs.js");
const { worktreeOwners } = require("./session-worktrees.js");
const { readLinkedWorktrees } = require("./worktree-paths.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {import("./queue-lander.js").OwningSessionState} OwningSessionState
 * @typedef {object} OwningSessionDeps
 * @property {() => string[]|null} worktrees
 * @property {() => import("./agent-liveness.js").ListedSessions} listed
 * @property {(line: string) => void} say
 */

/**
 * @param {string} root
 * @returns {OwningSessionDeps}
 */
const liveOwningSessionDeps = (root) => ({
	worktrees: () => readLinkedWorktrees(root),
	listed: () => admissionSessionIds(),
	say: (line) => writeFd(2, `${line}\n`),
});

/**
 * @param {string} root
 * @param {string} name
 * @param {OwningSessionDeps} [deps]
 * @returns {OwningSessionState}
 */
function readOwningSessionState(
	root,
	name,
	deps = liveOwningSessionDeps(root),
) {
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
		const session = worktreeOwners([tree], listed).owners.get(tree);
		return session &&
			isListedLive(session.sessionId, listed.ids, listed.terminal)
			? "working"
			: "stopped";
	} catch (err) {
		return unread(parseErrorFirstLine(err));
	}
}

module.exports = { readOwningSessionState };
