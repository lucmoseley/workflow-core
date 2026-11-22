const path = require("node:path");
const { orFallback } = require("./caught.js");
const { deref } = require("./deref.js");
const { WORKTREES } = require("./worktree-dirs.js");
const { isZeroSha, parseRefLines } = require("./push-refs.js");

const REMOTE = "origin";
const VERIFIED_BRANCH = "main";
const VERIFIED_REF = `${REMOTE}/${VERIFIED_BRANCH}`;
const LANDER_PREFIX = "lander/";
const LANDER_BATCH_PREFIX = `${LANDER_PREFIX}batch-`;
/** @param {number} slot */
const batchBranch = (slot) => `${LANDER_BATCH_PREFIX}${slot}`;
const LANDER_ISO_PREFIX = `${LANDER_PREFIX}iso-`;
const LANDER_ISO_SUITE_PREFIX = `${LANDER_ISO_PREFIX}suite-`;
const QUEUE_PREFIX = "queue/";
const QUEUE_HEADS = `refs/heads/${QUEUE_PREFIX}`;
/** @param {string} name */
const queueBranch = (name) => `${QUEUE_PREFIX}${name}`;
/**
 * @param {string|null|undefined} ref
 * @returns {ref is string}
 */
const isQueueHead = (ref) =>
	typeof ref === "string" &&
	ref.startsWith(QUEUE_HEADS) &&
	ref.length > QUEUE_HEADS.length;
/**
 * @param {string} stdin
 * @returns {Array<import("./push-refs.js").RefLine & { remoteRef: string }>}
 */
function parseQueuePushes(stdin) {
	return parseRefLines(stdin).flatMap((r) =>
		!isZeroSha(r.sha) && isQueueHead(r.remoteRef)
			? [{ ...r, remoteRef: r.remoteRef }]
			: [],
	);
}

/** @param {string} ref */
const queueNameOf = (ref) => ref.slice(QUEUE_HEADS.length);
/** @param {string} name */
const queueHead = (name) => `${QUEUE_HEADS}${name}`;
const DROPPED_PREFIX = "dropped/";

/**
 * @param {string|null|undefined} tree
 * @param {string} [root]
 * @returns {string|null}
 */
function ownQueueName(tree, root) {
	if (!tree) return null;
	const host = root ?? require("./main-checkout.js").mainCheckout(tree);
	if (!host) return null;
	const at = deref(tree);
	return path.dirname(at) === path.join(deref(host), WORKTREES)
		? path.basename(at)
		: null;
}

/**
 * @param {string|null|undefined} tree
 * @param {string} [root]
 * @returns {string|null}
 */
function ownQueueRef(tree, root) {
	const name = ownQueueName(tree, root);
	return name === null ? null : queueBranch(name);
}

/**
 * @param {string} name
 * @param {string} sha
 * @returns {[string, string]}
 */
function droppedRefsOf(name, sha) {
	const plain = `${DROPPED_PREFIX}${name}`;
	return [plain, `${plain}${keyedSuffix(sha)}`];
}

/** @param {string} sha */
const keyedSuffix = (sha) => `-${sha.slice(0, 9)}`;

/**
 * @param {string} ref
 * @param {string} sha
 * @returns {string}
 */
function droppedNameOf(ref, sha) {
	const name = ref.slice(DROPPED_PREFIX.length);
	const keyed = keyedSuffix(sha);
	return name.endsWith(keyed) ? name.slice(0, -keyed.length) : name;
}

/**
 * @param {string} branch
 * @returns {string}
 */
function trackingRefspec(branch) {
	return `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`;
}

const QUEUE_REFSPEC = trackingRefspec(`${QUEUE_PREFIX}*`);
const QUEUE_TRACKING_GLOB = `refs/remotes/${REMOTE}/${QUEUE_PREFIX}*`;

/**
 * @param {{tree?: string}} [opts]
 * @returns {string}
 */
function pushedRef(opts) {
	const tree = opts?.tree;
	if (!tree) return VERIFIED_REF;
	const own = ownQueueRef(tree);
	if (own === null) return VERIFIED_REF;
	const ref = `${REMOTE}/${own}`;
	const { commitSha } = require("./commit-sha.js");
	return commitSha(tree, `refs/remotes/${ref}`) === null ? VERIFIED_REF : ref;
}

/**
 * @param {{root?: string, tree?: string}} [opts]
 * @returns {string}
 */
function readUnpushedRef(opts) {
	const { execGit } = require("./git.js");
	const git = (/** @type {string[]} */ args) =>
		execGit(args, {
			cwd: opts?.tree ?? opts?.root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	const upstream = orFallback(
		() =>
			git(["symbolic-ref", "--short", "-q", "HEAD"]) === VERIFIED_BRANCH
				? null
				: git([
						"rev-parse",
						"--abbrev-ref",
						"--symbolic-full-name",
						"@{upstream}",
					]),
		null,
	);
	return upstream ?? pushedRef({ tree: opts?.tree });
}

if (require.main === module) {
	const usage = "usage: landing-refs.js pushed|unpushed [<tree>]";
	const verb = { usage, max: 1 };
	const { command, positionals } = require("./cli-args.js").parseOrExit(
		process.argv.slice(2),
		{ usage, commands: { pushed: verb, unpushed: verb } },
	);
	const answer = command === "pushed" ? pushedRef : readUnpushedRef;
	const [tree] = positionals;
	require("./write-fd.js").writeFd(
		1,
		`${answer(tree ? { tree } : undefined)}\n`,
	);
}

module.exports = {
	DROPPED_PREFIX,
	droppedNameOf,
	droppedRefsOf,
	LANDER_BATCH_PREFIX,
	batchBranch,
	LANDER_ISO_PREFIX,
	LANDER_ISO_SUITE_PREFIX,
	LANDER_PREFIX,
	pushedRef,
	ownQueueName,
	ownQueueRef,
	isQueueHead,
	parseQueuePushes,
	queueBranch,
	queueHead,
	queueNameOf,
	QUEUE_HEADS,
	QUEUE_PREFIX,
	QUEUE_REFSPEC,
	QUEUE_TRACKING_GLOB,
	REMOTE,
	readUnpushedRef,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
};
