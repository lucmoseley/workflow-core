const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { budgetMs } = require("./hook-deadline.js");
const { capMs } = require("./cap-ms.js");

const SCRIPT = path.join(__dirname, "..", "push-review-owed.sh");

// guess, #2785
const REVIEW_TIMEOUT_MS = 6000;

/**
 * @typedef {object} ReviewOwed
 * @property {"standard" | "escalated"} tier
 * @property {string} files
 * @property {string} base
 * @property {string} tierLine
 * @property {string} markerMore
 * @property {string} passFault
 * @property {string} markerScript
 */

const FIELDS = /** @type {const} */ ([
	"tier",
	"files",
	"base",
	"tierLine",
	"markerMore",
	"passFault",
	"markerScript",
]);

/**
 * @param {string} out
 * @returns {ReviewOwed | null | undefined}
 */
function readOwed(out) {
	if (out === "") return null;
	const fields = out.split("\0");
	if (fields.length !== FIELDS.length + 1 || fields.at(-1) !== "") return;
	const [tier, files, base, tierLine, markerMore, passFault, markerScript] =
		/** @type {string[]} */ (fields);
	if (tier !== "standard" && tier !== "escalated") return;
	return /** @type {ReviewOwed} */ ({
		tier,
		files,
		base,
		tierLine,
		markerMore,
		passFault,
		markerScript,
	});
}

/**
 * @param {{ sessionId: string, tree: string,
 *   log: (what: string, detail?: string) => void }} o
 * @returns {ReviewOwed | null}
 */
function reviewOwed({ sessionId, tree, log }) {
	const r = spawnSync("bash", [SCRIPT, sessionId, tree], {
		encoding: "utf8",
		timeout: budgetMs(capMs("WFC_PUSH_REVIEW_TIMEOUT_MS", REVIEW_TIMEOUT_MS)),
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (r.error || r.status !== 0) {
		log(
			"push-review-owed.sh did not answer — push not checked for review",
			r.error ? r.error.message : `exit ${r.status}`,
		);
		return null;
	}
	const owed = readOwed(r.stdout);
	if (owed === undefined) {
		log(
			"push-review-owed.sh answered unreadably — push not checked for review",
		);
		return null;
	}
	return owed;
}

module.exports = { reviewOwed };
