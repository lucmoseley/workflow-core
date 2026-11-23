const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	hasConfig,
	readConfig,
	resolveKey,
} = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { forgetTestClocks } = require("./clock.js");
const { readLandingOffWhy } = require("./landing-pin.js");
const { isSameRepo } = require("./issue-ref.js");

/**
 * @typedef {{root: string, why: string}} LeftOut
 * @typedef {object} Adopters
 * @property {string[]} included
 * @property {LeftOut[]} excluded
 * @typedef {Adopters & {faulted: LeftOut[]}} Discovery
 */

const OPT_OUT = "refillLoop: false";

/**
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
 * @param {string} root
 * @returns {{isOptOut: boolean, why: string}|null}
 */
function readExclusion(root) {
	try {
		const cfg = readConfig({ root, quiet: true });
		const malformed = cfg.faults.find((f) => f.key === "refillLoop");
		if (malformed) return { isOptOut: false, why: malformed.text };
		if (!cfg.refillLoop) return { isOptOut: true, why: OPT_OUT };
		const landingOff = readLandingOffWhy(root);
		return landingOff === null ? null : { isOptOut: false, why: landingOff };
	} catch (err) {
		return { isOptOut: false, why: caught(err).message };
	}
}

/**
 * @param {string} root
 * @returns {string|null}
 */
const readExclusionWhy = (root) => readExclusion(root)?.why ?? null;

/** @param {string} root */
const isOptedOut = (root) => readExclusion(root)?.isOptOut === true;

/**
 * @param {string} home
 * @returns {{root: string, disabled: string|null}[]}
 */
const readCandidates = (home) =>
	readAdopterCheckouts(home).included.map((root) => ({
		root,
		disabled: readExclusionWhy(root),
	}));

/**
 * @param {string} name
 * @param {string} home
 * @returns {string|null}
 */
const readCheckoutRefusal = (name, home) =>
	name.includes("/") || !hasConfig(path.join(home, name))
		? `${name} is no workflow-core checkout in ${home}`
		: null;

/**
 * @param {string} name
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

const homeDir = () => process.env.HOME || os.homedir();

/**
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

/**
 * @param {string} root
 * @param {string[]} args
 * @param {(err: unknown) => void} notStarted
 */
function startDetachedIn(root, args, notStarted) {
	try {
		const env = buildCheckoutEnv(root);
		forgetTestClocks(env);
		const child = spawn(process.execPath, args, {
			cwd: root,
			env,
			detached: true,
			stdio: ["ignore", "ignore", "inherit"],
		});
		child.on("error", notStarted);
		child.unref();
	} catch (err) {
		notStarted(err);
	}
}

/** @param {unknown} e */
const errMessageOf = (e) => caught(e).code || caught(e).message;

/** @param {string} [root] */
function readHostTracker(root) {
	const tracker = resolveKey("tracker", root ? { root } : {});
	return typeof tracker === "string" ? tracker : null;
}

/** @type {Map<string, {root: string} | {why: string, unreadable: boolean}>} */
const checkoutMemo = new Map();

/**
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
	startDetachedIn,
	discoverRepos,
	readAbsence,
	readCandidates,
	readCheckoutRefusal,
	readTickRefusal,
	readExclusionWhy,
	isOptedOut,
	homeDir,
};
