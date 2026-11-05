/*
 * queue-log.js — the landing queue's log (#4485, spec #4458): one JSON line
 * per event in a queue ref's life, under the canonical checkout's markers
 * directory, machine-local and gitignored. Every session pushes from this
 * machine, so .husky/pre-push writes an enqueue row, `{at, event, ref, sha}`,
 * for each `queue/<name>` it pushes, at push time.
 *
 * The queue lander reads a ref's push time off it: the newest enqueue row
 * naming the ref at the sha it now holds. A row a failed push left names a
 * sha the ref never held, so it is never read.
 */

const path = require("node:path");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");

/* Untraced, a first guess and stated as one: an enqueue row is read only
 * while its sha waits on its ref, which is hours, never weeks. */
const QUEUE_LOG_RETAIN_MS = 14 * DAY_MS;

/** @param {string} root the canonical checkout's root */
const queueLogFile = (root) => path.join(markersDir(root), ".queue-log.jsonl");

/**
 * @typedef {"enqueue"|"take"|"land"|"drop"} QueueEvent
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
	for (const row of readJsonl(file)?.rows ?? []) {
		if (row.event !== "enqueue") continue;
		const at = Date.parse(String(row.at));
		if (typeof row.ref !== "string" || typeof row.sha !== "string") continue;
		if (!Number.isFinite(at)) continue;
		const key = `${row.ref} ${row.sha}`;
		times.set(key, Math.max(at, times.get(key) ?? at));
	}
	return (ref, sha) => times.get(`${ref} ${sha}`) ?? null;
}

/**
 * The event of the newest row naming `ref` at `sha`, null where none does.
 * @param {string} file
 * @param {string} ref
 * @param {string} sha
 * @returns {string|null}
 */
function readNewestEvent(file, ref, sha) {
	let newest = null;
	for (const row of readJsonl(file)?.rows ?? [])
		if (row.ref === ref && row.sha === sha && typeof row.event === "string")
			newest = row.event;
	return newest;
}

module.exports = {
	logEnqueue,
	logQueueEvent,
	queueLogFile,
	readEnqueueTimes,
	readNewestEvent,
};
