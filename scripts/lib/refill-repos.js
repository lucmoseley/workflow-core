/*
 * refill-repos.js — which checkouts on this laptop adopt workflow-core, and
 * which of them the refill loop may tick (#2003, spec #1995).
 *
 * An adopter is a direct child of the home directory carrying
 * `.claude/workflow-core.json`. A linked worktree (`.git` a file, not a
 * directory) is its main checkout's second copy and is skipped.
 * readAdopterCheckouts returns every one; discoverRepos leaves out those whose
 * config sets `refillLoop: false`, and separates those whose config is at fault,
 * which only the morning review reads (#3834).
 *
 * readAdopterCheckouts' callers: report-close-check-reading.js and
 * report-flip-line-reading.js, since every adopter runs the priced-options
 * guard whatever its refillLoop (#2121), and lib/dispatch-ledger.js, since a
 * checkout opted out of the loop may still have spent an overflow key (#3695).
 * discoverRepos' callers: lib/refill-frontier.js, scripts/file-morning-review.js,
 * reading each repo's delegated-decision ledger (#2011),
 * scripts/answer-review-reversals.js, finding the checkout an entry's
 * tracker names (#2017), and refill-loop.js's
 * `start`, which starts nothing from an excluded checkout (#2014).
 *
 * It also links checkouts and trackers: readHostTracker reads a checkout's
 * configured tracker, for check-duplicate-dispatch.js, pick-next.js and
 * lib/gate-check.js, and
 * readCheckoutTracking finds the adopter that tracks a repo, so pick-next.js
 * and lib/parent-claims.js read that repo's claim store, and lib/gate-check.js
 * runs a `check:` in that repo's tree.
 *
 * buildCheckoutEnv builds the environment for a child run in another checkout,
 * for refill-loop.js, lib/refill-batch.js, lib/refill-frontier.js,
 * lib/lander-start.js, lib/file-through.js, lib/gate-check.js, lib/refill-tick.js
 * and lib/repo-holds.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	hasConfig,
	readConfig,
	resolveKey,
} = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { isSameRepo } = require("./issue-ref.js");

/**
 * @typedef {{root: string, why: string}} LeftOut
 * @typedef {object} Adopters
 * @property {string[]} included checkout roots
 * @property {LeftOut[]} excluded left out on purpose
 * @typedef {Adopters & {faulted: LeftOut[]}} Discovery `faulted`: left out by a
 *   config that will not read or a malformed `refillLoop`
 */

const OPT_OUT = "refillLoop: false";

/**
 * Every main checkout under `home` carrying a workflow-core config.
 * @param {string} home
 * @returns {Adopters}
 */
function readAdopterCheckouts(home) {
	/** @type {Adopters} */
	const found = { included: [], excluded: [] };
	for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const root = path.join(home, entry.name);
		if (!hasConfig(root)) continue;
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
 * The adopters the loop may serve.
 * @param {string} home
 * @returns {Discovery}
 */
function discoverRepos(home) {
	const adopters = readAdopterCheckouts(home);
	/** @type {Discovery} */
	const found = { included: [], excluded: [...adopters.excluded], faulted: [] };
	for (const root of adopters.included) {
		const exclusion = readExclusion(root);
		if (exclusion === null) found.included.push(root);
		else
			(exclusion.isOptOut ? found.excluded : found.faulted).push({
				root,
				why: exclusion.why,
			});
	}
	return found;
}

/**
 * Whether this checkout's config keeps the loop out, by its owner's choice or
 * by a fault, or null where the loop serves it.
 * @param {string} root
 * @returns {{isOptOut: boolean, why: string}|null}
 */
function readExclusion(root) {
	/* An unreadable config excludes that one repo rather than ending
	 * discovery for every repo (#2003). */
	try {
		const cfg = readConfig({ root, quiet: true });
		/* A malformed value reads as its default, in; an owner who tried to
		 * opt out is kept out instead (#2003). */
		const malformed = cfg.faults.find((f) => f.key === "refillLoop");
		if (malformed) return { isOptOut: false, why: malformed.text };
		return cfg.refillLoop ? null : { isOptOut: true, why: OPT_OUT };
	} catch (err) {
		return { isOptOut: false, why: caught(err).message };
	}
}

/**
 * Why the loop does not serve this checkout's config, or null where it does.
 * @param {string} root
 * @returns {string|null}
 */
const readExclusionWhy = (root) => readExclusion(root)?.why ?? null;

/**
 * Whether this checkout's owner has opted it out of the loop, which unticks it
 * (#4188). A faulted config is no opt-out and keeps its tick: a fault is no
 * choice of the owner's, and the loop serves the repo again once it is fixed.
 * @param {string} root
 */
const isOptedOut = (root) => readExclusion(root)?.isOptOut === true;

/**
 * Every checkout that gets a tick box, ticked or not, with why it cannot be
 * ticked, null where it can.
 * @param {string} home
 * @returns {{root: string, disabled: string|null}[]}
 */
const readCandidates = (home) =>
	readAdopterCheckouts(home).included.map((root) => ({
		root,
		disabled: readExclusionWhy(root),
	}));

/**
 * Why `name` is no direct child of `home` carrying a workflow-core config, null
 * where it is: discovery's own reach, so a checkout elsewhere is never served
 * (#2123).
 * @param {string} name
 * @param {string} home
 * @returns {string|null}
 */
const readCheckoutRefusal = (name, home) =>
	name.includes("/") || !hasConfig(path.join(home, name))
		? `${name} is no workflow-core checkout in ${home}`
		: null;

/**
 * Why the checkout named `name` may not be ticked, null where it may.
 * @param {string} name a directory name in `home`
 * @param {string} home
 * @returns {string|null}
 */
function readTickRefusal(name, home) {
	const refusal = readCheckoutRefusal(name, home);
	if (refusal !== null) return refusal;
	const root = path.join(home, name);
	const adopters = readAdopterCheckouts(home);
	if (!adopters.included.includes(root)) {
		const left = adopters.excluded.find((l) => l.root === root);
		return `${name} is ${left?.why ?? "not a main checkout"}`;
	}
	const why = readExclusionWhy(root);
	return why === null ? null : `${name} cannot be ticked: ${why}`;
}

/**
 * Why a checkout discovery did not list is missing, for one the morning review
 * carries (#3835): `carried` while what it lost may come back, false once its
 * directory is gone. Null for one that stays out unnamed: a linked worktree, or
 * one its owner opted out.
 * @param {string} root
 * @returns {{carried: boolean, why: string} | null}
 */
function readAbsence(root) {
	const stat = fs.statSync(root, { throwIfNoEntry: false });
	if (!stat?.isDirectory()) return { carried: false, why: "directory gone" };
	const git = fs.statSync(path.join(root, ".git"), { throwIfNoEntry: false });
	if (git?.isFile()) return null;
	if (!hasConfig(root))
		return { carried: true, why: "no workflow-core config" };
	if (readExclusion(root)?.isOptOut) return null;
	return git ? null : { carried: true, why: "no .git" };
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
function buildCheckoutEnv(root, env = process.env) {
	/** @type {NodeJS.ProcessEnv} */
	const child = { ...env, CLAUDE_PROJECT_DIR: root, WFC_REPO_ROOT: root };
	delete child.WFC_DISPATCH_ROOT;
	return child;
}

/** @param {unknown} e */
const errMessageOf = (e) => caught(e).code || caught(e).message;

/**
 * The tracker of the host checkout, where the candidates' own claims live.
 * @param {string} [root]
 */
function readHostTracker(root) {
	const tracker = resolveKey("tracker", root ? { root } : {});
	return typeof tracker === "string" ? tracker : null;
}

/** @type {Map<string, {root: string} | {why: string, unreadable: boolean}>} */
const checkoutMemo = new Map();

/**
 * The main checkout under `home` whose tracker is `repo`, as `{root}`, or
 * `{why}` where none tracks it or `home` will not read. An adopter whose config
 * will not read is skipped, so it hides no other's, and is named in the `why`.
 * `unreadable` says either fault may be hiding a checkout that does track it.
 * @param {string} repo
 * @param {string} home
 * @returns {{root: string} | {why: string, unreadable: boolean}}
 */
function readCheckoutTracking(repo, home) {
	const key = `${home}\0${repo.toLowerCase()}`;
	const memo = checkoutMemo.get(key);
	if (memo) return memo;
	/** @type {{root: string} | {why: string, unreadable: boolean}} */
	let found;
	try {
		/** @type {string[]} */
		const unread = [];
		const root = readAdopterCheckouts(home).included.find((r) => {
			try {
				return isSameRepo(readHostTracker(r), repo);
			} catch (e) {
				unread.push(`${r} (${errMessageOf(e)})`);
				return false;
			}
		});
		const skipped =
			unread.length > 0 ? `, and ${unread.join(", ")} would not read` : "";
		found = root
			? { root }
			: {
					why: `no checkout under ${home} tracks ${repo}${skipped}`,
					unreadable: unread.length > 0,
				};
	} catch (e) {
		found = {
			why: `${home} could not be read (${errMessageOf(e)})`,
			unreadable: true,
		};
	}
	checkoutMemo.set(key, found);
	return found;
}

module.exports = {
	readAdopterCheckouts,
	readCheckoutTracking,
	readHostTracker,
	buildCheckoutEnv,
	discoverRepos,
	readAbsence,
	readCandidates,
	readCheckoutRefusal,
	readTickRefusal,
	readExclusionWhy,
	isOptedOut,
	homeDir,
};
