/*
 * queue-exit-log.js — one JSON line per suite-queue waiter leaving the queue,
 * whatever the reason (workflow-core#1215), so a daily queue-wait figure can be computed
 * (workflow-core#1157). A pass marker cannot carry it: a killed waiter writes no marker.
 *
 * THE STORE is `.suite-queue-exits.jsonl` under the canonical checkout's
 * `.claude/tmp/markers`, rooted through `test-pass-marker.js`'s `repoRoot` so a
 * worktree's run lands in the same file. `markers` is exempt from the scratch
 * sweep, and `pruneMarkers` touches only its own prefixes, so this file's only
 * pruning is its own: lines older than `QUEUE_EXIT_RETAIN_MS`.
 *
 * NEVER THROWS, like `queueJoin`: an unwritable log costs the record, never
 * the run.
 *
 * Line shape: `at` (ISO exit time), `waitS` (awake seconds, `monotonicMs`),
 * `reason`, `kind`
 * (`bare`, `touched`, `changed`, `full` or `named` from `--queue`, `other` from
 * queue-run.js, workflow-core#1776, `seat` from queue-run.js `--seat` and from a `--queue`
 * run inside its seat, workflow-core#2918), `slotFree` (whether the run is a touched run,
 * which never waits for the whole-suite slot, workflow-core#2935; absent from queue-run.js),
 * `session` (null outside a session),
 * `empty` (the run left because its selection had emptied), `pid`,
 * `signal` on a kill, `skipped` on a run that left before it queued
 * (workflow-core#1221), and `limb` where the wait ended held at the queue's bound: what
 * held it, `count`, `memory`, `windows` (the Windows-memory hold, workflow-core#4557),
 * `peer` (an older waiter in the other queue the climb charge holds, workflow-core#4760)
 * or `turn`. A `timeout` ran anyway, a part-suite
 * past the bound; a `refused` did not run, and carries no `limb` where the
 * load hold refused it (workflow-core#2421, workflow-core#2714).
 * `climbMb` is the highest charge for other launches'
 * climb that held the wait with MemAvailable alone clearing the rung (workflow-core#3806),
 * absent where none did.
 * `peerS`, the seconds the wait was held on that peer, to its last poll on a
 * killed line or one a failed re-check refuses; absent where none held it, and on every line before workflow-core#4765.
 * Where waiters ahead in its own queue close the turn too, the turn names
 * them, so that time is not `peerS` and a refusal there says `turn`.
 * `noWait`, true on a `--tsc` line from a try under TSC_NO_WAIT_ENV, the
 * pre-commit hook's, bar a killed one, absent otherwise (workflow-core#3803).
 * `chargeMb`, on a `--tsc` line, the peak of the compiler the launch ran,
 * which the slot charged it (workflow-core#4892), a killed line's included (workflow-core#4921); absent
 * on every line before workflow-core#4892, whose type-checks all ran on TypeScript 5, and
 * on a killed line before workflow-core#4921, whose compiler is unknown.
 * `passed`, on an `opened` part-suite line, counts the older part-suites the
 * memory rung held that its turn passed (workflow-core#3058, workflow-core#3115), 0 where none. Absent
 * from a whole suite's line, every other reason's, and a `seat` line, whose
 * runs take no turn (workflow-core#2918).
 */

/** @typedef {"opened"|"left"|"timeout"|"refused"|"killed"} QueueExitReason */
/** @typedef {"count"|"memory"|"windows"|"peer"|"turn"} HeldLimb */

const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { repoRoot } = require("./test-pass-marker.js");

const QUEUE_EXIT_LOG = ".suite-queue-exits.jsonl";
/* Must stay above the 14-day series workflow-core#1157's filed issue carries; twice over,
 * chosen, not measured. */
const QUEUE_EXIT_RETAIN_MS = 30 * DAY_MS;

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
 * @param {{ file: string|null, kind: string, lane?: import("./part-suite-peak.js").PartKind, slotFree?: boolean, session: string|null, label: string, err: { write: (s: string) => unknown } }} waiter
 *   `lane` the lane the run queues in were it a part-suite (workflow-core#5367), which
 *   its `kind` does not always tell; read only off a part-suite's line
 * @returns {(reason: QueueExitReason, waitMs: number, extra?: object) => void}
 */
function queueExitLogger({ file, kind, lane, slotFree, session, label, err }) {
	return (reason, waitMs, extra = {}) => {
		const landed = appendRetained(
			file,
			{
				at: new Date().toISOString(),
				waitS: Math.round(waitMs / 1000),
				reason,
				kind,
				...(lane === undefined ? {} : { lane }),
				...(slotFree === undefined ? {} : { slotFree }),
				session,
				/* A refill after the leave rejoins the queue as a new line (REQUEUE). */
				empty: reason === "left",
				pid: process.pid,
				...extra,
			},
			QUEUE_EXIT_RETAIN_MS,
		);
		if (!landed && file)
			err.write(
				`${label}: this exit was not logged to ${file}, so the daily queue-wait figure will not count it.\n`,
			);
	};
}

module.exports = {
	QUEUE_EXIT_RETAIN_MS,
	queueExitLogPath,
	queueExitLogger,
};
