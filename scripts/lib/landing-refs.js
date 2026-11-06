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
 * With the `landing` module on, a session pushes to its own queue ref,
 * `queue/<worktree name>`, and only the lander moves `main` (#4458), so the
 * pushed answer is that ref's remote-tracking ref where it stands, and
 * `origin/main` where it does not: before the first push, once the lander has
 * landed and deleted the ref, and for a tree that is no session worktree.
 * With the module off, it is `origin/main`. A config that will not read
 * answers off, save for `pushed-branch`, which fails.
 *
 *   node scripts/lib/landing-refs.js pushed|unpushed|pushed-branch [<tree>]
 *     prints that ref, or the pushed ref's branch, for the checkout at <tree>,
 *     else the host root, for shell and workflows
 */

const path = require("node:path");

/* The config and git load where an answer first needs them, so a reader of
 * the names alone, a hook among them, pays for neither. */

const REMOTE = "origin";
const VERIFIED_BRANCH = "main";
const VERIFIED_REF = `${REMOTE}/${VERIFIED_BRANCH}`;
const LANDING_BRANCH = "landing";
const LANDING_REF = `${REMOTE}/${LANDING_BRANCH}`;
/* The queue lander's own refs (#4458), which it alone writes and may force:
 * the integration commit under test, and each sha it runs alone, an
 * isolation commit or `main`'s base check; the suite runs on a push to an
 * iso-suite one (scheduled-checks.yml). */
const LANDER_PREFIX = "lander/";
const LANDER_BATCH_BRANCH = `${LANDER_PREFIX}batch`;
const LANDER_ISO_PREFIX = `${LANDER_PREFIX}iso-`;
const LANDER_ISO_SUITE_PREFIX = `${LANDER_ISO_PREFIX}suite-`;
/* A session's queue ref (#4458), `queue/<worktree name>`, which it pushes
 * and the lander takes. */
const QUEUE_PREFIX = "queue/";
const QUEUE_HEADS = `refs/heads/${QUEUE_PREFIX}`;
/* A queue ref the lander dropped, `dropped/<name>`, which it alone
 * writes and deletes once the drop's fix ticket closes. */
const DROPPED_PREFIX = "dropped/";

/**
 * The queue ref of the session in `tree`: `queue/<its directory's name>`
 * where it is a worktree under the host's `.claude/worktrees/`, else null.
 * @param {string} root the host root
 * @param {string|null|undefined} tree the session's tree top level
 * @returns {string|null}
 */
function queueRefOf(root, tree) {
	const { WORKTREES_DIR } = require("./project-dirs.js");
	if (!tree || path.dirname(tree) !== path.join(root, WORKTREES_DIR))
		return null;
	return `${QUEUE_PREFIX}${path.basename(tree)}`;
}

/**
 * The queue ref of the session in `tree`, judged on real paths, so a
 * symlinked path names the ref a land pushes; null where `tree` is no
 * session worktree.
 * @param {string} tree the session's tree top level
 * @param {string} [root] the host root, else the main checkout of `tree`
 * @returns {string|null}
 */
function ownQueueRef(tree, root) {
	const fs = require("node:fs");
	const real = (/** @type {string} */ p) => {
		try {
			return fs.realpathSync(p);
		} catch {
			return p;
		}
	};
	const host = root ?? require("./main-checkout.js").mainCheckout(tree);
	return host ? queueRefOf(real(host), real(tree)) : null;
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
 * The branch a remote-tracking ref of `REMOTE` names.
 * @param {string} ref
 * @returns {string}
 */
function branchOf(ref) {
	return ref.slice(REMOTE.length + 1);
}

/**
 * Whether the `landing` module is on.
 * @param {{root?: string}} [opts]
 * @returns {boolean}
 */
function landingOn(opts) {
	try {
		return require("./workflow-core-config.js").moduleOn("landing", opts);
	} catch {
		// Only readConfig throws here, "landing" being a known module.
		return false;
	}
}

/**
 * The remote ref holding what the session in `tree` has pushed: its queue
 * ref's remote-tracking ref where the `landing` module is on, `tree` is a
 * session worktree and that ref resolves there, else `origin/main`.
 * @param {{root?: string, tree?: string}} [opts] the host root whose config
 *   is read, and the session's tree top level
 * @returns {string}
 */
function pushedRef(opts) {
	const tree = opts?.tree;
	if (!tree || !landingOn(opts)) return VERIFIED_REF;
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
	try {
		const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]);
		if (branch !== VERIFIED_BRANCH)
			return git([
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{upstream}",
			]);
	} catch {
		// Detached, or no upstream: the pushed ref.
	}
	return pushedRef(opts);
}

if (require.main === module) {
	const [verb, root, ...more] = process.argv.slice(2);
	const answer = new Map([
		["pushed", pushedRef],
		["unpushed", readUnpushedRef],
		[
			"pushed-branch",
			/* Strict, for a workflow: a config that will not read fails here
			 * rather than naming `main`. */
			(/** @type {{root?: string, tree?: string}|undefined} */ o) => {
				require("./workflow-core-config.js").moduleOn("landing", o);
				return branchOf(pushedRef(o));
			},
		],
	]).get(verb ?? "");
	if (!answer || more.length > 0) {
		require("./write-fd.js").writeFd(
			2,
			"usage: landing-refs.js pushed|unpushed|pushed-branch [<tree>]\n",
		);
		process.exit(2);
	}
	process.stdout.write(`${answer(root ? { root, tree: root } : undefined)}\n`);
}

module.exports = {
	DROPPED_PREFIX,
	droppedNameOf,
	droppedRefsOf,
	LANDER_BATCH_BRANCH,
	LANDER_ISO_PREFIX,
	LANDER_ISO_SUITE_PREFIX,
	LANDER_PREFIX,
	LANDING_BRANCH,
	landingOn,
	LANDING_REF,
	pushedRef,
	ownQueueRef,
	QUEUE_HEADS,
	QUEUE_PREFIX,
	QUEUE_REFSPEC,
	QUEUE_TRACKING_GLOB,
	queueRefOf,
	REMOTE,
	readUnpushedRef,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
};
