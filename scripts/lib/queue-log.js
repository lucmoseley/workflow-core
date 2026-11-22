const path = require("node:path");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");

// guess, #4458
const BASELINE_MS = 7 * DAY_MS;
// guess, #4485
const QUEUE_LOG_RETAIN_MS = 14 * DAY_MS;

/** @param {string} root */
const queueLogFile = (root) => path.join(markersDir(root), ".queue-log.jsonl");

/**
 * @typedef {"enqueue"|"take"|"land"|"drop"|"settle"|"close"} QueueEvent
 * @typedef {{ref: string, sha: string, at: number}} QueueRow
 */

/**
 * @param {string} file
 * @param {QueueEvent} event
 * @param {QueueRow} row
 * @returns {boolean}
 */
const logQueueEvent = (file, event, { ref, sha, at }) =>
	appendRetained(
		file,
		{ at: new Date(at).toISOString(), event, ref, sha },
		QUEUE_LOG_RETAIN_MS,
	);

/**
 * @param {string} file
 * @param {QueueRow} push
 */
const logEnqueue = (file, push) => logQueueEvent(file, "enqueue", push);

/**
 * @param {string} file
 * @returns {(ref: string, sha: string) => number|null}
 */
function readEnqueueTimes(file) {
	/** @type {Map<string, number>} */
	const times = new Map();
	for (const { event, ref, sha, at } of readWrittenRows(file)) {
		if (event !== "enqueue") continue;
		const key = `${ref} ${sha}`;
		times.set(key, Math.max(at, times.get(key) ?? at));
	}
	return (ref, sha) => times.get(`${ref} ${sha}`) ?? null;
}

/**
 * @param {string} file
 * @param {string} ref
 * @param {string} sha
 * @returns {string|null}
 */
const readNewestEvent = (file, ref, sha) =>
	readWrittenRows(file).findLast((r) => r.ref === ref && r.sha === sha)
		?.event ?? null;

/**
 * @typedef {{at: number, event: QueueEvent, ref: string, sha: string}} LoggedRow
 * @typedef {{ref: string, sha: string, event: "land"|"drop", from: number,
 *   at: number}} QueueSpan
 * @typedef {{at: number, depth: number}} DepthSample
 * @typedef {object} QueueBaseline
 * @property {number} spans
 * @property {number|null} p50Ms
 * @property {number|null} p90Ms
 * @property {number|null} depthP90
 */

const EVENTS = new Set(["enqueue", "take", "land", "drop", "settle", "close"]);

/**
 * @param {string} file
 * @returns {LoggedRow[]}
 */
function readWrittenRows(file) {
	/** @type {LoggedRow[]} */
	const rows = [];
	for (const row of readJsonl(file)?.rows ?? []) {
		const at = Date.parse(String(row.at));
		if (!Number.isFinite(at) || !EVENTS.has(String(row.event))) continue;
		if (typeof row.ref !== "string" || typeof row.sha !== "string") continue;
		rows.push({
			at,
			event: /** @type {QueueEvent} */ (row.event),
			ref: row.ref,
			sha: row.sha,
		});
	}
	return rows;
}

/** @param {string} file */
const readQueueRows = (file) =>
	readWrittenRows(file).sort((a, b) => a.at - b.at);

/**
 * @param {LoggedRow[]} mine
 * @param {LoggedRow & {event: "land"|"drop"}} row
 * @returns {{span: QueueSpan|null, left: LoggedRow[]}}
 */
function leaveQueue(mine, row) {
	const same = mine.find((r) => r.sha === row.sha);
	const [start] = mine;
	const { ref, sha, event, at } = row;
	return {
		span: start === undefined ? null : { ref, sha, event, from: start.at, at },
		left: same ? mine.filter((r) => r.at > same.at) : [],
	};
}

/**
 * @param {Map<string, LoggedRow[]>} pending
 * @returns {Map<string, number>}
 */
const earliestOf = (pending) =>
	new Map(
		[...pending].flatMap(([ref, [first]]) => (first ? [[ref, first.at]] : [])),
	);

/**
 * @param {LoggedRow[]} rows
 * @returns {{spans: QueueSpan[], depths: DepthSample[],
 *   since: Map<string, number>}}
 */
function replayQueue(rows) {
	/** @type {Map<string, LoggedRow[]>} */
	const pending = new Map();
	/** @type {QueueSpan[]} */
	const spans = [];
	/** @type {DepthSample[]} */
	const depths = [];
	for (const row of rows) {
		const mine = pending.get(row.ref) ?? [];
		if (row.event === "enqueue") pending.set(row.ref, [...mine, row]);
		if (row.event === "land" || row.event === "drop") {
			depths.push({ at: row.at, depth: pending.size });
			const { span, left } = leaveQueue(mine, { ...row, event: row.event });
			if (span !== null) spans.push(span);
			if (left.length > 0) pending.set(row.ref, left);
			else pending.delete(row.ref);
		}
	}
	return { spans, depths, since: earliestOf(pending) };
}

/**
 * @param {number[]} values
 * @param {number} p
 */
function percentile(values, p) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
	return /** @type {number} */ (sorted[rank - 1]);
}

/**
 * @param {LoggedRow[]} rows
 * @param {number} now
 * @returns {QueueBaseline}
 */
function queueBaseline(rows, now) {
	const { spans, depths } = replayQueue(rows);
	/** @param {{at: number}} x */
	const inWindow = (x) => x.at > now - BASELINE_MS && x.at <= now;
	const times = spans.filter(inWindow).map((s) => s.at - s.from);
	const sampled = depths.filter(inWindow).map((d) => d.depth);
	return {
		spans: times.length,
		p50Ms: percentile(times, 50),
		p90Ms: percentile(times, 90),
		depthP90: percentile(sampled, 90),
	};
}

/** @param {LoggedRow[]} rows */
const pendingSince = (rows) => replayQueue(rows).since;

module.exports = {
	BASELINE_MS,
	logEnqueue,
	logQueueEvent,
	pendingSince,
	percentile,
	queueBaseline,
	QUEUE_LOG_RETAIN_MS,
	queueLogFile,
	readEnqueueTimes,
	readNewestEvent,
	readQueueRows,
};
