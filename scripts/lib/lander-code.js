const { execGit } = require("./git.js");
const { LANDER_GIT_TIMEOUT_MS } = require("./lander-git.js");
const { relativeUnder } = require("./is-under.js");

/** @typedef {{sha: string, loaded: () => string[]}} RunCode */

/** @param {string} root @param {string[]} args */
const readGit = (root, args) =>
	execGit(args, {
		cwd: root,
		encoding: "utf8",
		timeout: LANDER_GIT_TIMEOUT_MS,
	}).trim();

/**
 * @param {string} root
 * @param {string} [self]
 * @returns {RunCode|null}
 */
function readRunCode(root, self = __filename) {
	const rel = relativeUnder(root, self);
	if (rel === null) return null;
	if (readGit(root, ["ls-files", "--", rel]) === "") return null;
	return {
		sha: readGit(root, ["rev-parse", "HEAD"]),
		loaded: () =>
			Object.keys(require.cache).flatMap((f) => relativeUnder(root, f) ?? []),
	};
}

/**
 * @param {string} root
 * @param {RunCode} code
 * @param {string} sha
 * @returns {string[]}
 */
function readSupersededFiles(root, code, sha) {
	const changed = new Set(
		readGit(root, ["diff", "--name-only", code.sha, sha])
			.split("\n")
			.filter(Boolean),
	);
	return code.loaded().filter((f) => changed.has(f));
}

/**
 * @param {string} root
 * @param {string} sha
 * @param {readonly string[]} files
 */
const isCarried = (root, sha, files) =>
	readGit(root, ["diff", "--name-only", sha, "--", ...files]) === "";

// guess, #4521
const SETTLE_DEADLINE_MS = 30 * 60 * 1000;
// guess, #4521
const SETTLE_RETRY_MS = 30 * 1000;

/**
 * @param {{carried: () => boolean, level: () => string|null,
 *   wait: (ms: number) => Promise<void>, now: () => number}} io
 * @returns {Promise<{carried: true} | {carried: false, failed: string|null}>}
 */
async function levelUntilCarried({ carried, level, wait, now }) {
	const deadline = now() + SETTLE_DEADLINE_MS;
	for (;;) {
		const failed = level();
		if (carried()) return { carried: true };
		if (now() >= deadline) return { carried: false, failed };
		await wait(SETTLE_RETRY_MS);
	}
}

module.exports = {
	isCarried,
	levelUntilCarried,
	readRunCode,
	readSupersededFiles,
};
