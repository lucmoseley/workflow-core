#!/usr/bin/env node
/*
 * main-lag-alarm.js — the off-machine stall check (#4443), run hourly on
 * GitHub by .github/workflows/main-lag.yml: fails where `landing` is ahead of
 * `main` and `main` has not moved for lib/landing-stall.js's STALL_MS, so a
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
 * The clock is the on-machine stall's: from `main`'s last push, or from when
 * `landing` first went ahead of it where that is later (#3303). With no
 * reading to remember, `landing` counts as ahead from `main`'s push where its
 * tip at that push was already ahead, else from its first push after.
 * Residual: where every one of the PUSH_PAGE pushes listed came after
 * `main`'s, the oldest listed stands in for the first, which only shortens
 * the clock.
 *
 * THE QUEUE, read beside `landing`: it fails where the oldest
 * `queue/<name>` ref on the remote has waited past QUEUE_BACKSTOP_MS since
 * its first push after its last deletion, off the ref's activity feed, where
 * GitHub lists that push as a `branch_creation` and the later ones as `push`;
 * a ref with no push in its feed is skipped and named. The machine's queue
 * alert (lib/queue-alert.js) is the primary one, and this only catches a
 * machine that is down. It keeps no record, so it fails on every run while
 * the limit stands.
 *
 * Exit codes: 0 where `main` is level or moved within STALL_MS and no queue
 * ref has waited past QUEUE_BACKSTOP_MS; 1 on a stall; 2 where it could not
 * read `main`'s lag or the queue and found no stall in the other.
 * Needs no npm install.
 */

const {
	LANDING_BRANCH,
	LANDING_REF,
	QUEUE_PREFIX,
	VERIFIED_REF,
} = require("./lib/landing-refs.js");
const { STALL_MS, formatHoursMin } = require("./lib/landing-stall.js");
const { oldestWaiting } = require("./lib/queue-gauge.js");
const { QUEUE_ALERT_TITLES, STALL_TITLE } = require("./lib/queue-tickets.js");

/* GitHub's ceiling for one page of the activity feed. */
const PUSH_PAGE = 100;
/* An unmeasured first guess, at the figure of the lag check's STALL_MS: a
 * dead-machine backstop, so later than the machine's own alert. */
const QUEUE_BACKSTOP_MS = 2 * 60 * 60 * 1000;
/* Guesses: one API read's retries and the pause between them. */
const TRIES = 4;
const RETRY_MS = 2000;

/**
 * @typedef {{timestamp: string, after: string}} Push
 * @typedef {(path: string) => Promise<unknown>} Get the parsed JSON at an
 *   API path under the repo, throwing on any failure
 * @typedef {{stalled: boolean, line: string, title?: string,
 *   ticket?: string}} Verdict `title` and `ticket` name a stall's error
 */

/** @param {string} status a compare endpoint's status of `landing` to `main` */
const isQueued = (status) => status === "ahead" || status === "diverged";

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
 * @param {Get} get
 * @param {string} ref
 * @param {number} perPage
 * @returns {Promise<[Push, ...Push[]]>} newest first
 */
async function readPushes(get, ref, perPage) {
	const feed = await get(`/activity?ref=refs/heads/${ref}&per_page=${perPage}`);
	if (!Array.isArray(feed) || feed.length === 0)
		throw new Error(`no push to ${ref} in the activity feed`);
	if (!feed.every(isPush))
		throw new Error(`a push to ${ref} with no timestamp or sha in the feed`);
	return /** @type {[Push, ...Push[]]} */ (feed);
}

/**
 * @param {Get} get
 * @param {string} branch
 * @returns {Promise<string>} the branch's sha
 */
async function readBranchSha(get, branch) {
	const ref = /** @type {{object?: {sha?: unknown}}} */ (
		await get(`/git/ref/heads/${branch}`)
	);
	const sha = ref.object?.sha;
	if (typeof sha !== "string") throw new Error(`no sha for ${branch}`);
	return sha;
}

/**
 * @param {Get} get
 * @param {string} base
 * @param {string} head
 * @returns {Promise<string>}
 */
async function readCompareStatus(get, base, head) {
	const { status } = /** @type {{status?: unknown}} */ (
		await get(`/compare/${base}...${head}`)
	);
	if (typeof status !== "string")
		throw new Error(`no status comparing ${head} to ${base}`);
	return status;
}

/**
 * @param {Get} get
 * @param {number} now
 * @returns {Promise<Verdict>}
 */
async function judgeLag(get, now) {
	const [tip] = await readPushes(get, "main", 1);
	const mainSha = await readBranchSha(get, "main");
	/* The feed is not documented as fresh: a `main` it has not caught up
	 * with has just moved. */
	if (mainSha !== tip.after)
		return {
			stalled: false,
			line: `main is at ${mainSha.slice(0, 9)}, newer than the activity feed's last push, ${tip.timestamp}.`,
		};
	const mainAt = Date.parse(tip.timestamp);
	const status = await readCompareStatus(get, mainSha, LANDING_BRANCH);
	if (!isQueued(status))
		return {
			stalled: false,
			line: `main ${mainSha.slice(0, 9)}, last pushed ${tip.timestamp}, is level with ${LANDING_BRANCH} (${status}).`,
		};
	const landing = await readPushes(get, LANDING_BRANCH, PUSH_PAGE);
	const atMove = landing.find((p) => Date.parse(p.timestamp) <= mainAt);
	const firstAfter = landing
		.filter((p) => Date.parse(p.timestamp) > mainAt)
		.at(-1);
	const aheadAtMove =
		atMove !== undefined &&
		isQueued(await readCompareStatus(get, mainSha, atMove.after));
	const since =
		aheadAtMove || firstAfter === undefined
			? mainAt
			: Date.parse(firstAfter.timestamp);
	const age = now - since;
	const line = `main has not moved since ${tip.timestamp}, with ${LANDING_BRANCH} ${status} of it since ${new Date(since).toISOString()}: ${formatHoursMin(age)}, against ${formatHoursMin(STALL_MS)}.`;
	return {
		stalled: age > STALL_MS,
		line,
		title: "Main lagging landing",
		ticket: STALL_TITLE,
	};
}

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
	const heads = `refs/heads/${QUEUE_PREFIX}`;
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
		const name = ref.slice(heads.length);
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
 * @param {NodeJS.ProcessEnv} env
 * @returns {Get}
 */
function liveGet(env) {
	const base = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}`;
	return async (path) => {
		let last;
		for (let i = 0; i < TRIES; i++) {
			if (i > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
			try {
				const res = await fetch(`${base}${path}`, {
					headers: {
						Authorization: `Bearer ${env.GH_TOKEN}`,
						Accept: "application/vnd.github+json",
					},
				});
				if (res.ok) return await res.json();
				last = new Error(`${path}: HTTP ${res.status}`);
			} catch (e) {
				last = e;
			}
		}
		throw last;
	};
}

/**
 * @param {{get: Get, now: number, say: (line: string) => void}} deps
 * @returns {Promise<number>}
 */
async function runAlarm({ get, now, say }) {
	const reads = [
		{
			what: `main's lag behind ${LANDING_BRANCH}`,
			judge: async () => [await judgeLag(get, now)],
			way: `read git log ${VERIFIED_REF}..${LANDING_REF}`,
		},
		{
			what: "the queue refs",
			judge: () => judgeQueue(get, now),
			way: `read git ls-remote origin 'refs/heads/${QUEUE_PREFIX}*'`,
		},
	];
	let broken = false;
	let stalled = false;
	for (const { what, judge, way } of reads) {
		/** @type {Verdict[]} */
		let verdicts;
		try {
			verdicts = await judge();
		} catch (e) {
			broken = true;
			say(
				`::error title=Check broken, not a stall::Could not read ${what}: ${e instanceof Error ? e.message : String(e)}. Whether it stalled is unknown: ${way}, then this run's log.`,
			);
			continue;
		}
		for (const v of verdicts) {
			stalled ||= v.stalled;
			say(
				v.stalled
					? `::error title=${v.title}::${v.line} Look first at: the open "${v.ticket}" ticket, then wsl --list --running on Windows and memcheck in WSL, as the refill loop files that ticket only while the machine runs.`
					: v.line,
			);
		}
	}
	if (stalled) return 1;
	return broken ? 2 : 0;
}

/** @returns {Promise<number>} */
const main = () =>
	runAlarm({
		get: liveGet(process.env),
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
