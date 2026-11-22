const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");
const { resolveScriptPaths } = require("./script-path.js");

// guess, lucmoseley/mantahostels#844
const MAX_BLOCKS = 3;

/**
 * @returns {string}
 */
function repoRoot() {
	return process.env.WFC_REPO_ROOT || hostRoot();
}

/**
 * @param {string} prefix
 * @returns {string}
 */
function guardName(prefix) {
	const entry = process.argv[1];
	return entry ? path.basename(entry) : prefix;
}

/**
 * @param {string} prefix
 * @param {number} max
 * @returns {string}
 */
function buildLastBlockNotice(prefix, max) {
	const spent =
		max === 1 ? "the single block" : `all ${String(max)} of the blocks`;
	return (
		`\n\nThis was ${guardName(prefix)}'s last Stop block on this check — its \`${prefix}\` counter has now spent ${spent} its cap allows. ` +
		"The rule still binds; nothing will refuse a repeat of this defect for the rest of the session. " +
		"Other checks in the same guard count on their own prefixes and may still block."
	);
}

/**
 * @param {string} prefix
 * @param {string} sessionId
 * @returns {string}
 */
function counterPath(prefix, sessionId) {
	return path.join(markersDir(repoRoot()), prefix + sessionId);
}

/**
 * @param {string} prefix
 * @param {string} sessionId
 * @returns {number}
 */
function readCount(prefix, sessionId) {
	try {
		return (
			Number.parseInt(
				fs.readFileSync(counterPath(prefix, sessionId), "utf8").trim(),
				10,
			) || 0
		);
	} catch {
		return 0;
	}
}

/**
 * @param {{prefix: string, sessionId: string, max?: number}} spec
 * @returns {boolean}
 */
function capSpent({ prefix, sessionId, max = MAX_BLOCKS }) {
	return readCount(prefix, sessionId) >= max;
}

/**
 * @param {{prefix: string, sessionId: string, max?: number}} spec
 * @returns {boolean}
 */
function charge({ prefix, sessionId, max = MAX_BLOCKS }) {
	const count = readCount(prefix, sessionId);
	if (count >= max) return false;
	try {
		fs.writeFileSync(counterPath(prefix, sessionId), `${String(count + 1)}\n`);
	} catch {
		return false;
	}
	return true;
}

/**
 * @param {{prefix: string, sessionId: string, max?: number}} spec
 * @returns {boolean}
 */
const isLastBlock = ({ prefix, sessionId, max = MAX_BLOCKS }) =>
	readCount(prefix, sessionId) === max - 1;

/**
 * @param {{prefix: string, sessionId: string, reason: string,
 *   max?: number}} spec
 * @returns {boolean}
 */
function blockStop({ prefix, sessionId, reason, max = MAX_BLOCKS }) {
	const counter = counterPath(prefix, sessionId);
	const count = readCount(prefix, sessionId);
	if (count >= max) return false;
	const isLast = isLastBlock({ prefix, sessionId, max });
	try {
		fs.writeFileSync(counter, `${String(count + 1)}\n`);
	} catch {
		return false;
	}

	const text = isLast ? reason + buildLastBlockNotice(prefix, max) : reason;
	process.stdout.write(
		JSON.stringify({ decision: "block", reason: resolveScriptPaths(text) }),
	);
	return true;
}

module.exports = {
	blockStop,
	capSpent,
	charge,
	counterPath,
	isLastBlock,
	readCount,
	repoRoot,
	MAX_BLOCKS,
};
