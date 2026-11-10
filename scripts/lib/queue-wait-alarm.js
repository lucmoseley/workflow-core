/*
 * queue-wait-alarm.js — the core of scripts/queue-wait-alarm.js (#4443, #4458):
 * judges the remote's `queue/<name>` refs against QUEUE_BACKSTOP_MS.
 *
 * A ref has waited since its first push after its last deletion, off the
 * ref's activity feed, where GitHub lists that push as a `branch_creation`
 * and the later ones as `push`; a ref with no push in its feed is skipped
 * and named. It keeps no record, so it fails on every run while the limit
 * stands.
 */

const {
	QUEUE_HEADS,
	QUEUE_PREFIX,
	queueBranch,
	queueNameOf,
} = require("./landing-refs.js");
const { formatHoursMin, oldestWaiting } = require("./queue-gauge.js");
const { QUEUE_ALERT_TITLES } = require("./queue-tickets.js");

/* GitHub's ceiling for one page of the activity feed. */
const PUSH_PAGE = 100;
/* An unmeasured first guess, at the figure of landing-stall.js's
 * STALL_MS: a dead-machine backstop, so later than the machine's own alert. */
const QUEUE_BACKSTOP_MS = 2 * 60 * 60 * 1000;

/**
 * @typedef {{timestamp: string, after: string}} Push
 * @typedef {(path: string) => Promise<unknown>} Get the parsed JSON at an
 *   API path under the repo, throwing on any failure
 * @typedef {{stalled: boolean, line: string, title?: string,
 *   ticket?: string}} Verdict `title` and `ticket` name a stall's error
 */

/** @param {unknown} p @returns {p is Push} */
const isPush = (p) =>
	typeof p === "object" &&
	p !== null &&
	"timestamp" in p &&
	typeof p.timestamp === "string" &&
	Number.isFinite(Date.parse(p.timestamp)) &&
	"after" in p &&
	typeof p.after === "string";

/**
 * When `ref` was first pushed since its last deletion, in ms; null where its
 * feed lists no push. Residual: where every one of the PUSH_PAGE entries
 * listed came after that push, the oldest listed stands in for it, which
 * only shortens the wait.
 * @param {Get} get
 * @param {string} ref in full
 * @returns {Promise<number|null>}
 */
async function readFirstPush(get, ref) {
	const feed = await get(
		`/activity?ref=${encodeURIComponent(ref)}&per_page=${PUSH_PAGE}`,
	);
	if (!Array.isArray(feed)) throw new Error(`no activity feed for ${ref}`);
	if (!feed.every(isPush))
		throw new Error(`a push to ${ref} with no timestamp or sha in the feed`);
	const deleted = feed.findIndex(
		(a) =>
			/** @type {{activity_type?: unknown}} */ (a).activity_type ===
			"branch_deletion",
	);
	const first = (deleted === -1 ? feed : feed.slice(0, deleted)).at(-1);
	return first === undefined ? null : Date.parse(first.timestamp);
}

/**
 * @param {Get} get
 * @param {number} now
 * @returns {Promise<Verdict[]>}
 */
async function judgeQueue(get, now) {
	const refs = await get(`/git/matching-refs/heads/${QUEUE_PREFIX}`);
	if (!Array.isArray(refs)) throw new Error("no list of queue refs");
	/** @type {import("./queue-gauge.js").Waiting[]} */
	const waiting = [];
	/** @type {Verdict[]} */
	const skipped = [];
	for (const r of refs) {
		const { ref, object } =
			/** @type {{ref?: unknown, object?: {sha?: unknown}}} */ (r);
		const sha = object?.sha;
		if (typeof ref !== "string" || typeof sha !== "string")
			throw new Error("a queue ref with no name or sha");
		const name = queueNameOf(ref);
		const since = await readFirstPush(get, ref);
		if (since === null)
			skipped.push({
				stalled: false,
				line: `${queueBranch(name)} is skipped: its activity feed lists no push.`,
			});
		else waiting.push({ name, sha, since });
	}
	const oldest = oldestWaiting(waiting);
	if (oldest === null)
		return [...skipped, { stalled: false, line: "No queue ref waits." }];
	const waited = now - oldest.since;
	return [
		...skipped,
		{
			stalled: waited > QUEUE_BACKSTOP_MS,
			line: `${queueBranch(oldest.name)}, the oldest of ${waiting.length} queue refs, has waited since its first push at ${new Date(oldest.since).toISOString()}: ${formatHoursMin(waited)}, against ${formatHoursMin(QUEUE_BACKSTOP_MS)}.`,
			title: "Queue ref waiting",
			ticket: QUEUE_ALERT_TITLES.age,
		},
	];
}

/**
 * @param {{get: Get, now: number, say: (line: string) => void}} deps
 * @returns {Promise<number>} the exit code
 */
async function runAlarm({ get, now, say }) {
	/** @type {Verdict[]} */
	let verdicts;
	try {
		verdicts = await judgeQueue(get, now);
	} catch (e) {
		say(
			`::error title=Check broken, not a stall::Could not read the queue refs: ${e instanceof Error ? e.message : String(e)}. Whether it stalled is unknown: read git ls-remote origin '${QUEUE_HEADS}*', then this run's log.`,
		);
		return 2;
	}
	let stalled = false;
	for (const v of verdicts) {
		stalled ||= v.stalled;
		say(
			v.stalled
				? `::error title=${v.title}::${v.line} Look first at: the open "${v.ticket}" ticket, then wsl --list --running on Windows and memcheck in WSL, as the refill loop files that ticket only while the machine runs.`
				: v.line,
		);
	}
	return stalled ? 1 : 0;
}

module.exports = { runAlarm };
