const { queueBranch, queueHead } = require("./landing-refs.js");
const { BASELINE_MS, pendingSince, queueBaseline } = require("./queue-log.js");
const { DAY_MS } = require("./retained-jsonl.js");

const BASELINE_DAYS = BASELINE_MS / DAY_MS;

// guess, #4485
const AGE_FLOOR_MS = 60 * 60 * 1000;
const DEPTH_FLOOR = 10;
const BASELINE_FACTOR = 2;

/**
 * @typedef {{name: string, sha: string, since: number}} Waiting
 * @typedef {object} QueueGauge
 * @property {number} now
 * @property {Waiting[]} waiting
 * @property {import("./queue-log.js").QueueBaseline} baseline
 * @typedef {{ageMs: number, depth: number}} QueueLimits
 * @typedef {object} QueueCrossings
 * @property {QueueLimits} limits
 * @property {(Waiting & {waitedMs: number})|null} age
 * @property {number|null} depth
 */

/** @param {number} ms */
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
	age: `${formatHoursMin(limits.ageMs)}, the larger of ${BASELINE_FACTOR} × the ${BASELINE_DAYS}-day p90 time in queue (${span(b.p90Ms)}) and ${AGE_FLOOR_MS / 60_000} min`,
	depth: `${limits.depth}, the larger of ${BASELINE_FACTOR} × the ${BASELINE_DAYS}-day p90 depth (${b.depthP90 ?? "none"}) and ${DEPTH_FLOOR}`,
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
			`${queueBranch(c.age.name)} has waited ${formatHoursMin(c.age.waitedMs)}, since ${new Date(c.age.since).toISOString()}, past its limit of ${limit.age}`,
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
			: `queue: ${waiting.length} waiting, the oldest ${queueBranch(oldest.name)} for ${formatHoursMin(now - oldest.since)}`;
	const times =
		b.spans === 0
			? `nothing landed or dropped in ${BASELINE_DAYS} days`
			: `time in queue over ${BASELINE_DAYS} days p50 ${span(b.p50Ms)}, p90 ${span(b.p90Ms)} across ${b.spans} landed or dropped`;
	return `${head}; ${times}; depth p90 ${b.depthP90 ?? "none"}.`;
}

/**
 * @param {readonly import("./queue-lander.js").QueueRef[]} queue
 * @param {import("./queue-log.js").LoggedRow[]} rows
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
			since: pending.get(queueHead(name)) ?? pushedAt,
		})),
		baseline: queueBaseline(rows, now),
	};
}

module.exports = {
	buildCrossingLines,
	buildQueueLine,
	formatHoursMin,
	oldestWaiting,
	queueCrossings,
	queueGaugeOf,
};
