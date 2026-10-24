/*
 * queue-exit-log.js — one JSON line per suite-queue waiter leaving the queue,
 * whatever the reason (workflow-core#1215), so a daily queue-wait figure can be computed
 * (workflow-core#1157). A pass marker cannot carry it: a killed waiter writes no marker.
 *
 * THE STORE is `.suite-queue-exits.jsonl` under the canonical checkout's
 * `.claude/tmp/markers`, rooted through `test-pass-marker.js`'s `repoRoot` so a
 * worktree's run lands in the same file. `markers` is exempt from the scratch
 * sweep, and `pruneMarkers` touches only its own prefixes, so this file's only
 * pruning is its own: lines older than `RETAIN_MS`, which must stay above the
 * 14-day series workflow-core#1157's filed issue carries. 30 days is chosen, not measured:
 * the series twice over.
 *
 * THE PRUNE RACES AN APPEND: a waiter appending between its read and rewrite
 * loses its line. It rewrites only once the oldest line is a day past
 * retention, so that window opens about once a day rather than on every exit.
 *
 * NEVER THROWS, like `queueJoin`: an unwritable log costs the record, never
 * the run.
 *
 * Line shape: `at` (ISO exit time), `waitS`, `reason`, `kind`
 * (`bare`, `changed`, `full` or `named` from `--queue`, `other` from
 * queue-run.js, workflow-core#1776), `session` (null outside a session),
 * `empty` (the run left because its selection had emptied), `pid`,
 * `signal` on a kill, `skipped` on a run that left before it queued
 * (workflow-core#1221), and `limb` on a timeout: `count` on a `timeout`, which ran anyway,
 * `memory` on a `refused`, which did not (workflow-core#2421).
 */

/** @typedef {"opened"|"left"|"timeout"|"refused"|"killed"} QueueExitReason */

const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { repoRoot } = require("./test-pass-marker.js");

const QUEUE_EXIT_LOG = ".suite-queue-exits.jsonl";
/** The gate limb a timeout's reason implies (workflow-core#2421); JSON drops the rest's.
 * @type {Partial<Record<QueueExitReason, "count"|"memory">>} */
const LIMB_OF = { timeout: "count", refused: "memory" };
const DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_MS = 30 * DAY_MS;

/**
 * The log's path for the checkout at `root`, or null where git will not
 * name a canonical checkout.
 * @param {string} [root]
 * @returns {string|null}
 */
function queueExitLogPath(root) {
	const canonical = repoRoot(root);
	return canonical ? path.join(markersDir(canonical), QUEUE_EXIT_LOG) : null;
}

/**
 * Synchronous throughout: the signal handler calls it on its way to exit.
 * @param {string|null} file
 * @param {Record<string, unknown> & { at: string }} entry
 * @returns {boolean} whether the line landed
 */
function recordQueueExit(file, entry) {
	if (!file) return false;
	try {
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
	} catch {
		return false;
	}
	try {
		const now = Date.now();
		const lines = String(fs.readFileSync(file, "utf8"))
			.split("\n")
			.filter(Boolean);
		const ageOf = (/** @type {string} */ line) => {
			try {
				return now - Date.parse(JSON.parse(line).at);
			} catch {
				return Number.POSITIVE_INFINITY;
			}
		};
		const isFresh = (/** @type {string} */ line) => ageOf(line) <= RETAIN_MS;
		const [oldest] = lines;
		if (oldest !== undefined && ageOf(oldest) > RETAIN_MS + DAY_MS)
			fs.writeFileSync(file, `${lines.filter(isFresh).join("\n")}\n`);
	} catch {
		/* the line is written; a failed prune costs disk, not the record */
	}
	return true;
}

/**
 * One waiter's exit-log writer: each call is one line, and a line that does
 * not land is said on `err`, opened by the waiter's `label`.
 *
 * @param {{ file: string|null, kind: string, session: string|null, label: string, err: { write: (s: string) => unknown } }} waiter
 * @returns {(reason: QueueExitReason, waitMs: number, extra?: object) => void}
 */
function queueExitLogger({ file, kind, session, label, err }) {
	return (reason, waitMs, extra = {}) => {
		const landed = recordQueueExit(file, {
			at: new Date().toISOString(),
			waitS: Math.round(waitMs / 1000),
			reason,
			kind,
			session,
			/* A refill after the leave rejoins the queue as a new line (REQUEUE). */
			empty: reason === "left",
			limb: LIMB_OF[reason],
			pid: process.pid,
			...extra,
		});
		if (!landed && file)
			err.write(
				`${label}: this exit was not logged to ${file}, so the daily queue-wait figure will not count it.\n`,
			);
	};
}

module.exports = {
	queueExitLogPath,
	queueExitLogger,
};
