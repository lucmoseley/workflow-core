/*
 * refill-repos.js — which checkouts on this laptop adopt workflow-core, and
 * which of them away mode serves (#2003, spec #1995).
 *
 * An adopter is a direct child of the home directory carrying
 * `.claude/workflow-core.json`. A linked worktree (`.git` a file, not a
 * directory) is its main checkout's second copy and is skipped.
 * adopterCheckouts returns every one; discoverRepos leaves out those whose
 * config sets `refillLoop: false`.
 *
 * adopterCheckouts' callers: report-close-check-reading.js and
 * report-flip-line-reading.js, since every adopter runs the priced-options
 * guard whatever its refillLoop (#2121).
 * discoverRepos' callers: lib/refill-frontier.js, scripts/file-morning-review.js,
 * reading each repo's delegated-decision ledger (#2011), and refill-loop.js's
 * `start`, which starts nothing from an excluded checkout (#2014).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readConfig } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");

/**
 * @typedef {object} Discovery
 * @property {string[]} included checkout roots
 * @property {{root: string, why: string}[]} excluded
 */

/**
 * Every main checkout under `home` carrying a workflow-core config.
 * @param {string} home
 * @returns {Discovery}
 */
function adopterCheckouts(home) {
	/** @type {Discovery} */
	const found = { included: [], excluded: [] };
	for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const root = path.join(home, entry.name);
		if (!fs.existsSync(path.join(root, ".claude", "workflow-core.json")))
			continue;
		const git = fs.statSync(path.join(root, ".git"), {
			throwIfNoEntry: false,
		});
		if (!git?.isDirectory()) {
			found.excluded.push({ root, why: "not a main checkout" });
			continue;
		}
		found.included.push(root);
	}
	return found;
}

/**
 * The adopters away mode serves.
 * @param {string} home
 * @returns {Discovery}
 */
function discoverRepos(home) {
	const adopters = adopterCheckouts(home);
	/** @type {Discovery} */
	const found = { included: [], excluded: [...adopters.excluded] };
	for (const root of adopters.included) {
		const why = exclusionOf(root);
		if (why === null) found.included.push(root);
		else found.excluded.push({ root, why });
	}
	return found;
}

/**
 * Why the loop does not serve this checkout's config, or null where it does.
 * @param {string} root
 * @returns {string|null}
 */
function exclusionOf(root) {
	/* An unreadable config excludes that one repo rather than ending
	 * discovery for every repo (#2003). */
	try {
		const cfg = readConfig({ root, quiet: true });
		/* A malformed value reads as its default, in; an owner who tried to
		 * opt out is kept out instead (#2003). */
		const malformed = cfg.faults.find((f) => f.key === "refillLoop");
		if (malformed) return malformed.text;
		return cfg.refillLoop ? null : "refillLoop: false";
	} catch (err) {
		return caught(err).message;
	}
}

/**
 * The home directory discovery reads, off HOME first: os.homedir() reads the
 * OS environment, which a test setting HOME from a worker thread never
 * reaches, so it would discover the real checkouts.
 */
const homeDir = () => process.env.HOME || os.homedir();

/**
 * The environment for a child run in checkout `root` from a process that may
 * sit in another repo's session. CLAUDE_PROJECT_DIR and WFC_REPO_ROOT both
 * outrank the working directory in a script's root resolution, so both point
 * at the checkout; WFC_DISPATCH_ROOT would point every ledger read at one tree,
 * so it is dropped.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
function checkoutEnv(root, env = process.env) {
	/** @type {NodeJS.ProcessEnv} */
	const child = { ...env, CLAUDE_PROJECT_DIR: root, WFC_REPO_ROOT: root };
	delete child.WFC_DISPATCH_ROOT;
	return child;
}

module.exports = {
	adopterCheckouts,
	checkoutEnv,
	discoverRepos,
	exclusionOf,
	homeDir,
};
