/*
 * lander-code.js — whether a move of `main` changed the code a running queue
 * lander loaded (workflow-core#4521): read by lib/queue-lander-deps.js after each move, so
 * a run on stale code ends and a fresh one starts on what landed.
 */

const { execGit } = require("./git.js");
const { relativeUnder } = require("./is-under.js");

/**
 * The code a run executes, where it is the landed checkout's own tracked
 * code: that checkout's HEAD at the run's start, and the files it has loaded
 * so far, relative to it. Null where the run executes other code — a plugin
 * cache's, or a worktree's nested under the checkout — which no landing of
 * the checkout changes.
 * @typedef {{sha: string, loaded: () => string[]}} RunCode
 */

/** @param {string} root @param {string[]} args */
const readGit = (root, args) =>
	execGit(args, { cwd: root, encoding: "utf8" }).trim();

/**
 * @param {string} root the checkout the run lands
 * @param {string} [self] a file of the run's own code, this one where absent
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
 * The files the run loaded that `sha` changes since it started.
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
 * Whether `root`'s working tree holds each of `files` as `sha` does.
 * @param {string} root
 * @param {string} sha
 * @param {readonly string[]} files
 */
const isCarried = (root, sha, files) =>
	readGit(root, ["diff", "--name-only", sha, "--", ...files]) === "";

/* Untraced: a levelling pass's `npm ci` fits well inside it. */
const SETTLE_DEADLINE_MS = 30 * 60 * 1000;
/* Untraced: a busy pass is asked again at this pace. */
const SETTLE_RETRY_MS = 30 * 1000;

/**
 * Levels the checkout until it carries the files a fresh run needs, asking
 * again while another pass holds the levelling lock. Whether it carried them
 * by the deadline, and else the last pass's failure.
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
