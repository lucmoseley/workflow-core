/*
 * landing-refs.js — which remote ref a reader of "what has been pushed" reads,
 * and which a reader of "what has been verified or released" reads (workflow-core#2408,
 * spec workflow-core#2261). The choice lives here alone: a reader calls `pushedRef` or
 * `unpushedRef`, or names the refs exported here, never the `landing` module.
 *
 * With the `landing` module on, sessions push to `landing` and only the lander
 * moves `main`, so the pushed base is `origin/landing`. With it off, both are
 * `origin/main`. A config that will not read answers off, as `wfc_module_on`
 * does.
 *
 *   node scripts/lib/landing-refs.js pushed|unpushed [<root>]
 *     prints that ref for the checkout at <root>, else the host root, for
 *     shell
 */

const { execFileSync } = require("node:child_process");
const { moduleOn } = require("./workflow-core-config.js");
const { writeFd } = require("./write-fd.js");

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
 * The remote ref holding every commit sessions have pushed.
 * @param {{root?: string}} [opts] the host root whose config is read
 * @returns {string}
 */
function pushedRef(opts) {
	try {
		return moduleOn("landing", opts) ? LANDING_REF : VERIFIED_REF;
	} catch {
		// Only readConfig throws here, "landing" being a known module.
		return VERIFIED_REF;
	}
}

/**
 * The remote ref a checkout's unpushed count reads: a named branch other than
 * `main` with an upstream, such as `spike/*`, pushes there; anything else
 * pushes to the pushed ref.
 * @param {{root?: string}} [opts] the checkout, whose config is read
 * @returns {string}
 */
function unpushedRef(opts) {
	const git = (/** @type {string[]} */ args) =>
		execFileSync("git", args, {
			cwd: opts?.root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	try {
		const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]);
		if (branch !== "main")
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
		["unpushed", unpushedRef],
	]).get(verb ?? "");
	if (!answer || more.length > 0) {
		writeFd(2, "usage: landing-refs.js pushed|unpushed [<root>]\n");
		process.exit(2);
	}
	process.stdout.write(`${answer(root ? { root } : undefined)}\n`);
}

module.exports = {
	LANDING_BRANCH,
	LANDING_REF,
	pushedRef,
	REMOTE,
	trackingRefspec,
	unpushedRef,
	VERIFIED_BRANCH,
	VERIFIED_REF,
};
