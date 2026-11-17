/*
 * reaped-jobs.js — the journal of the background jobs the reaper stopped
 * (#5331), one machine-wide file whatever seat the reaper ran on. The refill
 * loop reads it to reach a session the reaper stopped before the loop read
 * its synthetic stop: such a job has left the registry listing, and the job
 * store itself is thousands of records a tick.
 *
 * An entry's `at` is when it was written, so the loop's cursor past it never
 * skips an entry a slower reaper run writes later. Two reaper runs writing at
 * once can lose one's entries; check-ghost-jobs's SYNTHETIC-STOP finding still
 * reports such a job.
 */

const { refillPath } = require("./refill-dir.js");
const { readJsonOutcome, writeJson } = require("./refill-json.js");

const REAPED_FILE = ".reaped-jobs.json";

/* How long an entry is kept: longer than the loop is ever off between ticks
 * in ordinary use, so a restart still finds what was reaped meanwhile.
 * Untraced. */
const REAPED_KEEP_MS = 24 * 60 * 60_000;

/**
 * @typedef {{at: number, seat: string, jobId: string, sessionId: string,
 *   name: string, cwd: string}} ReapedJob
 */

/** @param {unknown} e @returns {e is ReapedJob} */
const isEntry = (e) =>
	typeof e === "object" &&
	e !== null &&
	typeof (/** @type {ReapedJob} */ (e).at) === "number" &&
	["seat", "jobId", "sessionId", "name", "cwd"].every(
		(k) => typeof (/** @type {Record<string, unknown>} */ (e)[k]) === "string",
	);

/**
 * `list` pruned to REAPED_KEEP_MS before `at`, with an entry stamped `at` for
 * each row of `stopped` that names its seat, job, session and cwd.
 * @param {unknown[]} list
 * @param {import("./agent-liveness.js").AgentRecord[]} stopped
 * @param {number} at
 * @returns {ReapedJob[]}
 */
function withReaped(list, stopped, at) {
	const kept = list.filter(isEntry).filter((e) => at - e.at < REAPED_KEEP_MS);
	const added = stopped.flatMap((a) =>
		a.seat && a.id && a.sessionId && a.cwd
			? [
					{
						at,
						seat: a.seat,
						jobId: a.id,
						sessionId: a.sessionId,
						name: a.name ?? a.id,
						cwd: a.cwd,
					},
				]
			: [],
	);
	return [...kept, ...added];
}

/**
 * The journal's entries, none where it is absent or will not read.
 * @returns {ReapedJob[]}
 */
function readReaped() {
	const { value } = readJsonOutcome(refillPath(REAPED_FILE));
	return Array.isArray(value) ? value.filter(isEntry) : [];
}

/**
 * Add the reaper's `stopped` rows to the journal, stamped now; nothing where
 * there are none. A journal that will not write costs the loop those
 * resumes, never the reaper its run: check-ghost-jobs still reports them.
 * @param {import("./agent-liveness.js").AgentRecord[]} stopped
 */
function recordReaped(stopped) {
	if (stopped.length === 0) return;
	try {
		writeJson(
			refillPath(REAPED_FILE),
			withReaped(readReaped(), stopped, Date.now()),
		);
	} catch {
		/* See above. */
	}
}

module.exports = { readReaped, recordReaped, withReaped };
