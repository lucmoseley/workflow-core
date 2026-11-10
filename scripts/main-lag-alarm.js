#!/usr/bin/env node
/*
 * main-lag-alarm.js — the off-machine stall check (#4443, #4458), run hourly
 * on GitHub by .github/workflows/main-lag.yml: fails where the oldest
 * `queue/<name>` ref on the remote has waited past QUEUE_BACKSTOP_MS, so a
 * stall is caught with the machine off or the refill loop dead.
 *
 *   node scripts/main-lag-alarm.js
 *
 * Reads GITHUB_API_URL, GITHUB_REPOSITORY and GH_TOKEN, as Actions sets them.
 *
 * NOT A `check-*`: runCheck's alphabet reads GitHub unreachable as SKIP, exit
 * 0, and a liveness alarm that goes green whenever it cannot read the queue
 * is silent exactly when nobody can see the machine. Its own three codes keep
 * the alphabet's meanings for the rest.
 *
 * A ref has waited since its first push after its last deletion, off the
 * ref's activity feed, where GitHub lists that push as a `branch_creation`
 * and the later ones as `push`; a ref with no push in its feed is skipped
 * and named. The machine's stall check and queue alert (lib/landing-stall.js,
 * lib/queue-alert.js) are the primary ones, and this only catches a machine
 * that is down. It keeps no record, so it fails on every run while the limit
 * stands.
 *
 * Exit codes: 0 where no queue ref has waited past QUEUE_BACKSTOP_MS; 1 on a
 * stall; 2 where it could not read the queue.
 * Needs no npm install.
 */

const { actionsApi } = require("./lib/actions-api.js");
const { QUEUE_HEADS, QUEUE_PREFIX } = require("./lib/landing-refs.js");
const { formatHoursMin, oldestWaiting } = require("./lib/queue-gauge.js");
const { QUEUE_ALERT_TITLES } = require("./lib/queue-tickets.js");

/* GitHub's ceiling for one page of the activity feed. */
const PUSH_PAGE = 100;
/* An unmeasured first guess, at the figure of lib/landing-stall.js's
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
	/** @type {import("./lib/queue-gauge.js").Waiting[]} */
	const waiting = [];
	/** @type {Verdict[]} */
	const skipped = [];
	for (const r of refs) {
		const { ref, object } =
			/** @type {{ref?: unknown, object?: {sha?: unknown}}} */ (r);
		const sha = object?.sha;
		if (typeof ref !== "string" || typeof sha !== "string")
			throw new Error("a queue ref with no name or sha");
		const name = ref.slice(QUEUE_HEADS.length);
		const since = await readFirstPush(get, ref);
		if (since === null)
			skipped.push({
				stalled: false,
				line: `queue/${name} is skipped: its activity feed lists no push.`,
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
			line: `queue/${oldest.name}, the oldest of ${waiting.length} queue refs, has waited since its first push at ${new Date(oldest.since).toISOString()}: ${formatHoursMin(waited)}, against ${formatHoursMin(QUEUE_BACKSTOP_MS)}.`,
			title: "Queue ref waiting",
			ticket: QUEUE_ALERT_TITLES.age,
		},
	];
}

/**
 * @param {{get: Get, now: number, say: (line: string) => void}} deps
 * @returns {Promise<number>}
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

/** @returns {Promise<number>} */
const main = () =>
	runAlarm({
		get: (p) =>
			actionsApi(process.env).get(
				`/repos/${process.env.GITHUB_REPOSITORY}${p}`,
			),
		now: Date.now(),
		say: (line) => process.stdout.write(`${line}\n`),
	});

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			process.stderr.write(`main-lag-alarm: ${e}\n`);
			process.exitCode = 2;
		},
	);

module.exports = { QUEUE_BACKSTOP_MS, main, runAlarm };
