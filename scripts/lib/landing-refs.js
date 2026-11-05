/*
 * landing-refs.js — the ref switch: the one module that names the shared
 * branches (#2408, spec #2261; #4485). A reader asks one of two answers, sorted
 * by #4458's reader classes, and never names a branch itself:
 *
 *   - start (`startRef`): what is verified, or where a session starts — the
 *     worktree cut, the changed-file selection base, the CI verdict. Release
 *     reads `VERIFIED_REF`, which is `origin/main` in both shapes.
 *   - pushed (`pushedRef`, `readUnpushedRef`): what a session has pushed —
 *     push coverage, the unpushed count, commit-ledger status.
 *
 * With the `landing` module on, sessions push to `landing` and only the lander
 * moves `main`, so both answers are `origin/landing`. With it off, both are
 * `origin/main`. A config that will not read answers off, as `wfc_module_on`
 * does. A reader already holding the module's state asks `startRefFor` or
 * `pushedRefFor`.
 *
 *   node scripts/lib/landing-refs.js pushed|unpushed|pushed-branch [<root>]
 *     prints that ref, or the pushed ref's branch, for the checkout at <root>,
 *     else the host root, for shell and workflows
 */

/* The config and git load where an answer first needs them, so a reader of
 * the names alone, a hook among them, pays for neither. */

const REMOTE = "origin";
const VERIFIED_BRANCH = "main";
const VERIFIED_REF = `${REMOTE}/${VERIFIED_BRANCH}`;
const LANDING_BRANCH = "landing";
const LANDING_REF = `${REMOTE}/${LANDING_BRANCH}`;

/**
 * The fetch refspec that updates `branch`'s remote-tracking ref.
 * @param {string} branch
 * @returns {string}
 */
function trackingRefspec(branch) {
	return `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`;
}

/**
 * The branch a remote-tracking ref of `REMOTE` names.
 * @param {string} ref
 * @returns {string}
 */
function branchOf(ref) {
	return ref.slice(REMOTE.length + 1);
}

/**
 * Whether the `landing` module is on, for a reader asking both answers.
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
 * The start answer, given the `landing` module's state.
 * @param {boolean} on
 * @returns {string}
 */
function startRefFor(on) {
	return on ? LANDING_REF : VERIFIED_REF;
}

/**
 * The pushed answer, given the `landing` module's state.
 * @param {boolean} on
 * @returns {string}
 */
function pushedRefFor(on) {
	return on ? LANDING_REF : VERIFIED_REF;
}

/**
 * The remote ref a session starts from and is judged against.
 * @param {{root?: string}} [opts] the host root whose config is read
 * @returns {string}
 */
function startRef(opts) {
	return startRefFor(landingOn(opts));
}

/**
 * The remote ref holding every commit sessions have pushed.
 * @param {{root?: string}} [opts] the host root whose config is read
 * @returns {string}
 */
function pushedRef(opts) {
	return pushedRefFor(landingOn(opts));
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
		/* Strict, for a workflow: a config that will not read fails here rather
		 * than naming `main`, which would watch the wrong branch unseen. */
		[
			"pushed-branch",
			(/** @type {{root?: string}|undefined} */ o) =>
				branchOf(
					pushedRefFor(
						require("./workflow-core-config.js").moduleOn("landing", o),
					),
				),
		],
	]).get(verb ?? "");
	if (!answer || more.length > 0) {
		require("./write-fd.js").writeFd(
			2,
			"usage: landing-refs.js pushed|unpushed|pushed-branch [<root>]\n",
		);
		process.exit(2);
	}
	process.stdout.write(`${answer(root ? { root } : undefined)}\n`);
}

module.exports = {
	branchOf,
	LANDING_BRANCH,
	landingOn,
	LANDING_REF,
	pushedRef,
	pushedRefFor,
	REMOTE,
	readUnpushedRef,
	startRef,
	startRefFor,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
};
