/*
 * read-audit-paths.js — the path tests, limits and environment readings
 * the read audit's modules share (workflow-core#4916).
 * lib/read-audit-preload.js loads it into every audited process, so it
 * requires nothing beside Node's own modules and lib/is-under.js, which the
 * preload loads already.
 */

const path = require("node:path");
const { relativeUnder } = require("./is-under.js");

/**
 * Whether `file` runs Node: this process's own binary, or one of its name.
 * @param {string} file
 */
const isNode = (file) =>
	file === process.execPath || path.basename(file) === "node";

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join("/");

/**
 * `abs` repo-relative, with POSIX separators, where it lies under `root`
 * outside every `node_modules`; else null.
 * @param {string} root
 * @param {string} abs
 * @returns {string|null}
 */
function repoPath(root, abs) {
	const rel = relativeUnder(root, abs);
	if (rel === null) return null;
	const posix = toPosix(rel || ".");
	return posix.split("/").includes("node_modules") ? null : posix;
}

/* The event the preload appends to a git child's event log once that git
 * has exited, naming its pid (lib/read-audit-git-events.js). */
const EXITED = "wfc_exited";

/* Linux's PATH_MAX: a longer piece is no path the kernel would take. */
const PATH_MAX = 4096;

/* How much of a call a doubt line quotes: a guess, long enough to name the
 * call, short enough to keep the cached-run banner readable. */
const SHOWN_MAX = 200;

/**
 * The value an environment's pairs give `name`; undefined where they set
 * none.
 * @param {unknown} envPairs
 * @param {string} name
 * @returns {string|undefined}
 */
function pairValue(envPairs, name) {
	if (!Array.isArray(envPairs)) return;
	const pair = envPairs.find(
		(e) => typeof e === "string" && e.startsWith(`${name}=`),
	);
	return pair === undefined ? undefined : String(pair).slice(name.length + 1);
}

/**
 * @typedef {{env: Record<string, string>, gitAt: number}} Standing
 *   the environment a suite's setup settled, and how many bytes the owner's
 *   git log held then: what the guard logged before is the setup's own
 */
/**
 * A standing file's content; none where it will not parse, so every
 * variable reads as set apart and every git call as made after it.
 * @param {string} text
 * @returns {Standing}
 */
function parseStanding(text) {
	try {
		const { env, gitAt } = JSON.parse(text);
		if (env === null || typeof env !== "object") throw new Error("no env");
		return { env, gitAt: Number.isInteger(gitAt) ? gitAt : 0 };
	} catch {
		// A torn or missing file settles nothing: the reader doubts (#5017).
		return { env: {}, gitAt: 0 };
	}
}

/* The variable naming git's event target (git's api-trace2), which the
 * audit hands each git itself. */
const GIT_EVENTS = "GIT_TRACE2_EVENT";

module.exports = {
	parseStanding,
	GIT_EVENTS,
	EXITED,
	isNode,
	PATH_MAX,
	pairValue,
	repoPath,
	SHOWN_MAX,
	toPosix,
};
