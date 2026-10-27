/*
 * queue-exit-log.js — one JSON line per suite-queue waiter leaving the queue,
 * whatever the reason (#1215), so a daily queue-wait figure can be computed
 * (#1157). A pass marker cannot carry it: a killed waiter writes no marker.
 *
 * THE STORE is `.suite-queue-exits.jsonl` under the canonical checkout's
 * `.claude/tmp/markers`, rooted through `test-pass-marker.js`'s `repoRoot` so a
 * worktree's run lands in the same file. `markers` is exempt from the scratch
 * sweep, and `pruneMarkers` touches only its own prefixes, so this file's only
 * pruning is its own: lines older than `RETAIN_MS`, which must stay above the
 * 14-day series #1157's filed issue carries. 30 days is chosen, not measured:
 * the series twice over.
 *
 * NEVER THROWS, like `queueJoin`: an unwritable log costs the record, never
 * the run.
 *
 * Line shape: `at` (ISO exit time), `waitS`, `reason`, `kind`
 * (`bare`, `touched`, `changed`, `full` or `named` from `--queue`, `other` from
 * queue-run.js, #1776, `seat` from queue-run.js `--seat` and from a `--queue`
 * run inside its seat, #2918), `slotFree` (whether the run is a touched run,
 * which never waits for the whole-suite slot, #2935; absent from queue-run.js),
 * `session` (null outside a session),
 * `empty` (the run left because its selection had emptied), `pid`,
 * `signal` on a kill, `skipped` on a run that left before it queued
 * (#1221), and `limb` where the wait ended held at the queue's bound: what
 * held it, `count`, `memory` or `turn`. A `timeout` ran anyway, a part-suite
 * past the bound; a `refused` did not run, and carries no `limb` where the
 * load hold refused it (#2421, #2714).
 * `passed`, on an `opened` part-suite line, counts the older part-suites the
 * memory rung held that its turn passed (#3058, #3115), 0 where none. Absent
 * from a whole suite's line, every other reason's, and a `seat` line, whose
 * runs take no turn (#2918).
 */

/** @typedef {"opened"|"left"|"timeout"|"refused"|"killed"} QueueExitReason */
/** @typedef {"count"|"memory"|"turn"} HeldLimb */

const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { repoRoot } = require("./test-pass-marker.js");

const QUEUE_EXIT_LOG = ".suite-queue-exits.jsonl";
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
 * One waiter's exit-log writer: each call is one line, and a line that does
 * not land is said on `err`, opened by the waiter's `label`.
 *
 * @param {{ file: string|null, kind: string, slotFree?: boolean, session: string|null, label: string, err: { write: (s: string) => unknown } }} waiter
 * @returns {(reason: QueueExitReason, waitMs: number, extra?: object) => void}
 */
function queueExitLogger({ file, kind, slotFree, session, label, err }) {
	return (reason, waitMs, extra = {}) => {
		const landed = appendRetained(
			file,
			{
				at: new Date().toISOString(),
				waitS: Math.round(waitMs / 1000),
				reason,
				kind,
				...(slotFree === undefined ? {} : { slotFree }),
				session,
				/* A refill after the leave rejoins the queue as a new line (REQUEUE). */
				empty: reason === "left",
				pid: process.pid,
				...extra,
			},
			RETAIN_MS,
		);
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
