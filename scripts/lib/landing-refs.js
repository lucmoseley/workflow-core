/*
 * landing-refs.js — the ref switch: the one module that names the shared
 * branches (#2408, spec #2261). A reader asks one of two answers and never
 * names a branch itself:
 *
 *   - verified, or where a session starts (`VERIFIED_REF`): the worktree cut,
 *     the changed-file selection base, release, the CI verdict. It is
 *     `origin/main` in both shapes, `main` being the green tip.
 *   - pushed (`pushedRef`, `readUnpushedRef`): what a session has pushed —
 *     push coverage, the unpushed count, commit-ledger status.
 *
 * A session pushes to its own queue ref, `queue/<worktree name>`, and only
 * the lander moves `main` (#4458), so the pushed answer is that ref's
 * remote-tracking ref where it stands, and `origin/main` where it does not:
 * before the first push, once the lander has landed and deleted the ref, and
 * for a tree that is no session worktree.
 *
 *   node scripts/lib/landing-refs.js pushed|unpushed [<tree>]
 *     prints that ref for the checkout at <tree>, else the working
 *     directory, for shell and workflows (#4280, #4692)
 */

const path = require("node:path");
const { orFallback } = require("./caught.js");
const { deref } = require("./deref.js");
const { WORKTREES } = require("./worktree-dirs.js");
const { isZeroSha, parseRefLines } = require("./push-refs.js");

/* git loads where an answer first needs it, so a reader of the names alone,
 * a hook among them, does not pay for it. */

const REMOTE = "origin";
const VERIFIED_BRANCH = "main";
const VERIFIED_REF = `${REMOTE}/${VERIFIED_BRANCH}`;
/* The queue lander's own refs (#4458), which its Actions tester alone
 * writes and may force (#4910): each batch's integration commit under test,
 * and each sha it runs alone, an isolation commit or `main`'s base check;
 * the suite runs on a push to an iso-suite one (scheduled-checks.yml). */
const LANDER_PREFIX = "lander/";
const LANDER_BATCH_PREFIX = `${LANDER_PREFIX}batch-`;
/**
 * The ref a batch in flight is pushed to, one per pipeline slot (#4556).
 * @param {number} slot
 */
const batchBranch = (slot) => `${LANDER_BATCH_PREFIX}${slot}`;
const LANDER_ISO_PREFIX = `${LANDER_PREFIX}iso-`;
const LANDER_ISO_SUITE_PREFIX = `${LANDER_ISO_PREFIX}suite-`;
/* A session's queue ref (#4458), `queue/<worktree name>`, which it pushes
 * and the lander takes. */
const QUEUE_PREFIX = "queue/";
const QUEUE_HEADS = `refs/heads/${QUEUE_PREFIX}`;
/**
 * The queue ref named `name`, as a branch: `queue/<name>`.
 * @param {string} name
 */
const queueBranch = (name) => `${QUEUE_PREFIX}${name}`;
/**
 * Whether `ref`, a full ref, is a queue ref's head, a name after its prefix.
 * @param {string|null|undefined} ref
 * @returns {ref is string}
 */
const isQueueHead = (ref) =>
	typeof ref === "string" &&
	ref.startsWith(QUEUE_HEADS) &&
	ref.length > QUEUE_HEADS.length;
/**
 * Each push to a queue ref in a pre-push hook's ref lines, in order, deletions
 * dropped: the one filter the landing queue's pre-push gates share, so no gate
 * picks out queue pushes its own way.
 * @param {string} stdin
 * @returns {Array<import("./push-refs.js").RefLine & { remoteRef: string }>}
 */
function parseQueuePushes(stdin) {
	return parseRefLines(stdin).flatMap((r) =>
		!isZeroSha(r.sha) && isQueueHead(r.remoteRef)
			? /* restated so the guard's narrowing reaches the returned type */
				[{ ...r, remoteRef: r.remoteRef }]
			: [],
	);
}

/**
 * The name of the queue ref whose head is `ref`, a full ref.
 * @param {string} ref
 */
const queueNameOf = (ref) => ref.slice(QUEUE_HEADS.length);
/**
 * The head of the queue ref named `name`, in full.
 * @param {string} name
 */
const queueHead = (name) => `${QUEUE_HEADS}${name}`;
/* A queue ref the lander dropped, `dropped/<name>`, which it alone
 * writes and deletes once `main` holds the drop's work (#4950). */
const DROPPED_PREFIX = "dropped/";

/**
 * The name of the queue ref of the session in `tree`, judged on real paths,
 * so a symlinked path names the ref a land pushes: its directory's name
 * where it is a worktree under the host's `.claude/worktrees/`, else null.
 * Every reader of a session's own queue ref asks here or ownQueueRef, so no
 * two name it two ways.
 * @param {string|null|undefined} tree the session's tree top level
 * @param {string} [root] the host root, else the main checkout of `tree`
 * @returns {string|null}
 */
function ownQueueName(tree, root) {
	if (!tree) return null;
	const host = root ?? require("./main-checkout.js").mainCheckout(tree);
	if (!host) return null;
	/* realpath fails only on a path that is gone or unreadable, which no live
	 * session's tree is; its spelling is then the only name it has, and every
	 * caller reads that same fallback here (#4856). */
	const at = deref(tree);
	return path.dirname(at) === path.join(deref(host), WORKTREES)
		? path.basename(at)
		: null;
}

/**
 * The queue ref of the session in `tree`, `queue/<ownQueueName>`, else null.
 * @param {string|null|undefined} tree the session's tree top level
 * @param {string} [root] the host root, else the main checkout of `tree`
 * @returns {string|null}
 */
function ownQueueRef(tree, root) {
	const name = ownQueueName(tree, root);
	return name === null ? null : queueBranch(name);
}

/**
 * The two dropped refs `queue/<name>` at `sha` may be kept as:
 * `dropped/<name>`, else, where that holds another sha, `dropped/<name>-<sha9>`.
 * @param {string} name after `queue/`
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
 * The queue ref name a dropped ref holding `sha` was dropped from: the
 * inverse of droppedRefsOf.
 * @param {string} ref after `refs/heads/`
 * @param {string} sha
 * @returns {string}
 */
function droppedNameOf(ref, sha) {
	const name = ref.slice(DROPPED_PREFIX.length);
	const keyed = keyedSuffix(sha);
	return name.endsWith(keyed) ? name.slice(0, -keyed.length) : name;
}

/**
 * The fetch refspec that updates `branch`'s remote-tracking ref.
 * @param {string} branch
 * @returns {string}
 */
function trackingRefspec(branch) {
	return `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`;
}

/* Every queue ref's tracking ref, for a fetch, and the glob that names them. */
const QUEUE_REFSPEC = trackingRefspec(`${QUEUE_PREFIX}*`);
const QUEUE_TRACKING_GLOB = `refs/remotes/${REMOTE}/${QUEUE_PREFIX}*`;

/**
 * The remote ref holding what the session in `tree` has pushed: its queue
 * ref's remote-tracking ref where `tree` is a session worktree and that ref
 * resolves there, else `origin/main`.
 * @param {{tree?: string}} [opts] the session's tree top level
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
 * The remote ref a checkout's unpushed count reads: a named branch other than
 * `main` with an upstream, such as `spike/*`, pushes there; anything else
 * pushes to the pushed ref.
 * @param {{root?: string, tree?: string}} [opts] the checkout git runs in:
 *   `tree`, a session's own worktree (#4243), else the host `root`
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
	// Detached, or no upstream: the pushed ref.
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
