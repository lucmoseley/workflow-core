/*
 * push-review.js — the review port the guard-push-rules core reads (#2785):
 * whether the code a push carries owes a review no valid marker covers,
 * answered by scripts/push-review-owed.sh, which reads lib/code-signal.sh's
 * one definition of it (#1163).
 *
 * EVERY FAULT IS NO REVIEW OWED, the adapter's own policy: a timeout, a
 * non-zero exit or an answer this file cannot read is logged and answers null,
 * so the Stop nag, which still fires, is where the review is asked for.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { budgetMs } = require("./hook-deadline.js");

const SCRIPT = path.join(__dirname, "..", "push-review-owed.sh");

/* A ceiling, not a measurement, cut to what the dispatcher's entry budget
 * leaves (hook-deadline.js): the adapter answered in 0.5-1.3 s a call at
 * load1 20 (#2785's baseline). */
const REVIEW_TIMEOUT_MS = 6000;

/**
 * @typedef {object} ReviewOwed
 * @property {"standard" | "escalated"} tier the tier owed
 * @property {string} files the files named, space-separated
 * @property {string} base the session's start point
 * @property {string} tierLine the sentence naming the tier
 * @property {string} markerMore the sentence naming the marker lines an
 *   escalated change adds, else ""
 * @property {string} passFault why an existing marker was rejected, else ""
 * @property {string} markerScript the marker writer, as a session spells it
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
 * The adapter's stdout read back: null where it said nothing, undefined where
 * it said something this file cannot read.
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
 *   log: (what: string, detail?: string) => void }} o `tree` "" reads the
 *   repo root
 * @returns {ReviewOwed | null}
 */
function reviewOwed({ sessionId, tree, log }) {
	const r = spawnSync("bash", [SCRIPT, sessionId, tree], {
		encoding: "utf8",
		timeout: budgetMs(REVIEW_TIMEOUT_MS),
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
