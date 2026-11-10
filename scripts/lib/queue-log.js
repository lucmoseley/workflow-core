/*
 * queue-log.js — the landing queue's log: one JSON line per event in a
 * queue ref's life, under the canonical checkout's markers directory,
 * machine-local and gitignored. Every session pushes from this machine, so
 * .husky/pre-push writes an enqueue row, `{at, event, ref, sha}`, for each
 * `queue/<name>` it pushes, at push time (#4485, spec #4458).
 *
 * The queue lander reads a ref's push time off it: the newest enqueue row
 * naming the ref at the sha it now holds. A row a failed push left names a
 * sha the ref never held, so it is never read. The lander adds a take row
 * when it snapshots a ref into a batch, and a land or drop row when the ref
 * leaves the queue. A dropped sha gets one more row once `main` holds its
 * work: a close row where the lander closed its fix ticket, a settle row
 * where it closed none (#4950).
 *
 * TIME IN QUEUE, per land or drop row: its `at` less the `at` of its ref's
 * earliest pending enqueue row. An enqueue row is pending from its push
 * until a land or drop row of its ref takes it. A land or drop takes the
 * ref's earliest pending row at its sha and every pending row of the ref
 * pushed before it, as a queue push only fast-forwards and the sha that left
 * holds them; rows pushed after it, at a sha the lander did not snapshot,
 * stay pending. Where no pending row names its sha, as after a push the log
 * missed, it takes them all; with none pending it gives no time.
 *
 * A WAITING REF has waited since its earliest pending row, so a ref pushed
 * again still ages.
 *
 * DEPTH: the refs with a pending row as each land or drop row reads, the ref
 * leaving among them, every row read in time order. Residual: a ref whose
 * land or drop row went unwritten stays pending, counts, and dates its next
 * stay from its old rows, until they age out of the log.
 *
 * PERCENTILES are nearest-rank: the p-th of n sorted values is the
 * ceil(p × n / 100)-th.
 */

const path = require("node:path");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");

/* Spec #4458's 7-day baseline. */
const BASELINE_MS = 7 * DAY_MS;
/* Untraced, a first guess: the baselines read 7 days back, and a ref
 * waiting at the window's start was pushed hours, never weeks, before it. */
const QUEUE_LOG_RETAIN_MS = 14 * DAY_MS;

/** @param {string} root the canonical checkout's root */
const queueLogFile = (root) => path.join(markersDir(root), ".queue-log.jsonl");

/**
 * @typedef {"enqueue"|"take"|"land"|"drop"|"settle"|"close"} QueueEvent
 * @typedef {{ref: string, sha: string, at: number}} QueueRow `ref` in full
 *   (`refs/heads/queue/<name>`), `at` in ms
 */

/**
 * Logs `event` for `ref` at `sha`. A line lost to an unwritable log costs
 * that ref its times, never the push or the landing.
 * @param {string} file
 * @param {QueueEvent} event
 * @param {QueueRow} row
 * @returns {boolean} whether the line was written
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
 * Each ref's push time at a sha, in ms, from the log's enqueue rows; null
 * where no row names the ref at that sha.
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
 * The event of the last well-formed row written naming `ref` at `sha`, null
 * where none does.
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
 *   at: number}} QueueSpan one ref's stay, enqueue `from` to `at`, in ms
 * @typedef {{at: number, depth: number}} DepthSample
 * @typedef {object} QueueBaseline over the BASELINE_MS before its reading
 * @property {number} spans land and drop rows with a time in queue
 * @property {number|null} p50Ms time in queue; null with no span
 * @property {number|null} p90Ms
 * @property {number|null} depthP90 null with no land or drop
 */

const EVENTS = new Set(["enqueue", "take", "land", "drop", "settle", "close"]);

/**
 * The log's well-formed rows as written; a line that will not parse, or
 * names no known event, is left out. An absent log has none; a read failing
 * for any reason but absence throws.
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

/**
 * readWrittenRows, oldest first.
 * @param {string} file
 */
const readQueueRows = (file) =>
	readWrittenRows(file).sort((a, b) => a.at - b.at);

/**
 * A land or drop row's act on its ref's pending rows: its time in queue,
 * null where none is pending, and the rows it leaves pending.
 * @param {LoggedRow[]} mine the ref's pending rows, oldest first
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
 * @param {Map<string, LoggedRow[]>} pending each ref's rows, oldest first
 * @returns {Map<string, number>} each ref's first row's `at`
 */
const earliestOf = (pending) =>
	new Map(
		[...pending].flatMap(([ref, [first]]) => (first ? [[ref, first.at]] : [])),
	);

/**
 * @param {LoggedRow[]} rows oldest first
 * @returns {{spans: QueueSpan[], depths: DepthSample[],
 *   since: Map<string, number>}} `since`: each pending ref's earliest
 *   pending row's `at`
 */
function replayQueue(rows) {
	/** @type {Map<string, LoggedRow[]>} each ref's pending rows, oldest first */
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
 * The nearest-rank `p`-th percentile of `values`; null where there are none.
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
 * The BASELINE_MS before `now`, from the log's rows.
 * @param {LoggedRow[]} rows oldest first
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

/**
 * When each ref with a pending row has waited since, by its full ref.
 * @param {LoggedRow[]} rows oldest first
 */
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
