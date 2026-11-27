const path = require("node:path");
const { relativeUnder } = require("./is-under.js");

/** @param {string} file */
const isNode = (file) =>
	file === process.execPath || path.basename(file) === "node";

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join("/");

/**
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

const EXITED = "wfc_exited";

const PATH_MAX = 4096;

// guess, workflow-core#4916
const SHOWN_MAX = 200;

/**
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

/** @typedef {{env: Record<string, string>, gitAt: number}} Standing */
/**
 * @param {string} text
 * @returns {Standing}
 */
function parseStanding(text) {
	try {
		const { env, gitAt } = JSON.parse(text);
		if (env === null || typeof env !== "object") throw new Error("no env");
		return { env, gitAt: Number.isInteger(gitAt) ? gitAt : 0 };
	} catch {
		return { env: {}, gitAt: 0 };
	}
}

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
