/** @typedef {"opened"|"left"|"timeout"|"refused"|"killed"} QueueExitReason */
/** @typedef {"count"|"memory"|"windows"|"peer"|"turn"} HeldLimb */

const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { repoRoot } = require("./test-pass-marker.js");

const QUEUE_EXIT_LOG = ".suite-queue-exits.jsonl";
// guess, #1157
const QUEUE_EXIT_RETAIN_MS = 30 * DAY_MS;

/**
 * @param {string} [root]
 * @returns {string|null}
 */
function queueExitLogPath(root) {
	const canonical = repoRoot(root);
	return canonical ? path.join(markersDir(canonical), QUEUE_EXIT_LOG) : null;
}

/**
 * @param {{ file: string|null, kind: string, lane?: import("./part-suite-peak.js").PartKind, slotFree?: boolean, session: string|null, label: string, err: { write: (s: string) => unknown } }} waiter
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
