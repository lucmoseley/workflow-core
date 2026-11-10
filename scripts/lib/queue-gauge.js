/*
 * queue-gauge.js — the landing queue's gauge: the queue refs waiting on the
 * remote, each with the time it has waited, the 7-day baselines
 * lib/queue-log.js reads off the queue log, the limits the stall check and
 * the queue alert hold them to, and the status line (#4485, spec #4458).
 *
 * WAITING: every `refs/heads/queue/<name>` on the remote, read as the queue
 * lander reads its batch (lib/queue-lander-adapters.js): it has waited since
 * its earliest pending push in the queue log (lib/queue-log.js), so a ref
 * pushed again still ages; where none is pending, since the lander's push
 * time for the sha it holds, else that tip's committer time.
 *
 * LIMITS (untraced): the oldest waiting ref is past its limit when it has
 * waited longer than twice the 7-day p90 time in queue, or AGE_FLOOR_MS
 * where that is longer; the queue is too deep when more refs wait than
 * twice the 7-day p90 depth, or DEPTH_FLOOR where that is more. With no
 * baseline the floor alone holds.
 */

const { QUEUE_HEADS } = require("./landing-refs.js");
const { queueGit } = require("./queue-lander-adapters.js");
const {
	BASELINE_MS,
	pendingSince,
	queueBaseline,
	queueLogFile,
	readQueueRows,
} = require("./queue-log.js");
const { DAY_MS } = require("./retained-jsonl.js");

const BASELINE_DAYS = `${BASELINE_MS / DAY_MS}-day`;

const AGE_FLOOR_MS = 60 * 60 * 1000;
const DEPTH_FLOOR = 10;
const BASELINE_FACTOR = 2;

/**
 * @typedef {{name: string, sha: string, since: number}} Waiting `name` as
 *   in `queue/<name>`, `since` in ms
 * @typedef {object} QueueGauge
 * @property {number} now
 * @property {Waiting[]} waiting
 * @property {import("./queue-log.js").QueueBaseline} baseline
 * @typedef {{ageMs: number, depth: number}} QueueLimits
 * @typedef {object} QueueCrossings
 * @property {QueueLimits} limits
 * @property {(Waiting & {waitedMs: number})|null} age the oldest waiting ref,
 *   where it is past its limit
 * @property {number|null} depth the refs waiting, where more than the limit
 */

/**
 * A span as `<h> h <m> min`, rounded down.
 * @param {number} ms
 */
function formatHoursMin(ms) {
	const min = Math.floor(ms / 60_000);
	return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** @param {import("./queue-log.js").QueueBaseline} b @returns {QueueLimits} */
const queueLimits = (b) => ({
	ageMs: Math.max(BASELINE_FACTOR * (b.p90Ms ?? 0), AGE_FLOOR_MS),
	depth: Math.max(BASELINE_FACTOR * (b.depthP90 ?? 0), DEPTH_FLOOR),
});

/** @param {Waiting[]} waiting */
const oldestWaiting = (waiting) =>
	waiting.reduce(
		(/** @type {Waiting|null} */ old, w) =>
			old === null || w.since < old.since ? w : old,
		null,
	);

/**
 * @param {QueueGauge} g
 * @returns {QueueCrossings}
 */
function queueCrossings({ now, waiting, baseline }) {
	const limits = queueLimits(baseline);
	const oldest = oldestWaiting(waiting);
	const waitedMs = oldest === null ? 0 : now - oldest.since;
	return {
		limits,
		age:
			oldest !== null && waitedMs > limits.ageMs
				? { ...oldest, waitedMs }
				: null,
		depth: waiting.length > limits.depth ? waiting.length : null,
	};
}

/** @param {number|null} ms */
const span = (ms) => (ms === null ? "none" : formatHoursMin(ms));

/**
 * @param {QueueCrossings["limits"]} limits
 * @param {import("./queue-log.js").QueueBaseline} b
 */
const buildLimitText = (limits, b) => ({
	age: `${formatHoursMin(limits.ageMs)}, the larger of ${BASELINE_FACTOR} × the ${BASELINE_DAYS} p90 time in queue (${span(b.p90Ms)}) and ${AGE_FLOOR_MS / 60_000} min`,
	depth: `${limits.depth}, the larger of ${BASELINE_FACTOR} × the ${BASELINE_DAYS} p90 depth (${b.depthP90 ?? "none"}) and ${DEPTH_FLOOR}`,
});

/**
 * @param {QueueCrossings} c
 * @param {import("./queue-log.js").QueueBaseline} b
 * @returns {{age: string|null, depth: string|null}}
 */
function buildCrossingLines(c, b) {
	const limit = buildLimitText(c.limits, b);
	return {
		age:
			c.age &&
			`queue/${c.age.name} has waited ${formatHoursMin(c.age.waitedMs)}, since ${new Date(c.age.since).toISOString()}, past its limit of ${limit.age}`,
		depth:
			c.depth === null
				? null
				: `${c.depth} queue refs wait, past the limit of ${limit.depth}`,
	};
}

/** @param {QueueGauge} g */
function buildQueueLine({ now, waiting, baseline: b }) {
	const oldest = oldestWaiting(waiting);
	const head =
		oldest === null
			? "queue: none waiting"
			: `queue: ${waiting.length} waiting, the oldest queue/${oldest.name} for ${formatHoursMin(now - oldest.since)}`;
	const times =
		b.spans === 0
			? `nothing landed or dropped in ${BASELINE_MS / DAY_MS} days`
			: `time in queue over ${BASELINE_MS / DAY_MS} days p50 ${span(b.p50Ms)}, p90 ${span(b.p90Ms)} across ${b.spans} landed or dropped`;
	return `${head}; ${times}; depth p90 ${b.depthP90 ?? "none"}.`;
}

/**
 * The gauge of the remote's queue refs and the queue log's rows at `now`.
 * @param {readonly import("./queue-lander.js").QueueRef[]} queue
 * @param {import("./queue-log.js").LoggedRow[]} rows oldest first
 * @param {number} now
 * @returns {QueueGauge}
 */
function queueGaugeOf(queue, rows, now) {
	const pending = pendingSince(rows);
	return {
		now,
		waiting: queue.map(({ name, sha, pushedAt }) => ({
			name,
			sha,
			since: pending.get(`${QUEUE_HEADS}${name}`) ?? pushedAt,
		})),
		baseline: queueBaseline(rows, now),
	};
}

/**
 * The gauge of `root`'s remote and queue log at `now`. Throws where the
 * remote or the log cannot be read.
 * @param {string} root the canonical checkout's root
 * @param {number} now
 * @returns {QueueGauge}
 */
const readQueueGauge = (root, now) =>
	queueGaugeOf(
		queueGit(root).refs().queue,
		readQueueRows(queueLogFile(root)),
		now,
	);

module.exports = {
	AGE_FLOOR_MS,
	DEPTH_FLOOR,
	buildCrossingLines,
	buildQueueLine,
	formatHoursMin,
	oldestWaiting,
	queueCrossings,
	queueGaugeOf,
	readQueueGauge,
};
