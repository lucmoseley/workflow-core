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
 * THE QUEUE, read beside `landing` (#4485, spec #4458): it fails where the
 * oldest `queue/<name>` ref on the remote has waited past
 * lib/queue-gauge.js's AGE_FLOOR_MS, or more refs wait than its DEPTH_FLOOR.
 * The queue log is the machine's, so here a ref has waited since its tip's
 * committer time, which no push of it predates, and the limits are the
 * floors alone, with no 7-day baseline: it can only fail sooner than the
 * machine's alert. It keeps no record, so it fails on every run while a
 * limit stands, where the machine's alert fires once per crossing.
 *
 * Exit codes: 0 where `main` is level or moved within STALL_MS and the queue
 * is within both floors; 1 on a stall; 2 where it could not read the queue.
 * Needs no npm install.
 */

const {
	LANDING_BRANCH,
	LANDING_REF,
	QUEUE_PREFIX,
	VERIFIED_REF,
} = require("./lib/landing-refs.js");
const { STALL_MS, formatHoursMin } = require("./lib/landing-stall.js");
const { QUEUE_ALERT_TITLES } = require("./lib/queue-alert.js");
const { AGE_FLOOR_MS, DEPTH_FLOOR } = require("./lib/queue-gauge.js");

/* GitHub's ceiling for one page of the activity feed. */
const PUSH_PAGE = 100;
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
		ticket: "Landing queue stalled",
	};
}

/**
 * Each queue ref on the remote, with its tip's committer time in ms.
 * @param {Get} get
 * @returns {Promise<{name: string, since: number}[]>}
 */
async function readQueueRefs(get) {
	const refs = await get(`/git/matching-refs/heads/${QUEUE_PREFIX}`);
	if (!Array.isArray(refs)) throw new Error("no list of queue refs");
	const heads = `refs/heads/${QUEUE_PREFIX}`;
	/** @type {{name: string, since: number}[]} */
	const out = [];
	for (const r of refs) {
		const { ref, object } =
			/** @type {{ref?: unknown, object?: {sha?: unknown}}} */ (r);
		const sha = object?.sha;
		if (typeof ref !== "string" || typeof sha !== "string")
			throw new Error("a queue ref with no name or sha");
		const c = /** @type {{commit?: {committer?: {date?: unknown}}}} */ (
			await get(`/commits/${sha}`)
		);
		const since = Date.parse(String(c.commit?.committer?.date));
		if (!Number.isFinite(since))
			throw new Error(`no committer time for ${sha.slice(0, 9)}`);
		out.push({ name: ref.slice(heads.length), since });
	}
	return out;
}

/**
 * @param {Get} get
 * @param {number} now
 * @returns {Promise<Verdict[]>}
 */
async function judgeQueue(get, now) {
	const refs = await readQueueRefs(get);
	if (refs.length === 0)
		return [{ stalled: false, line: "No queue ref waits." }];
	const oldest = refs.reduce((a, b) => (b.since < a.since ? b : a));
	const waited = now - oldest.since;
	return [
		{
			stalled: waited > AGE_FLOOR_MS,
			line: `queue/${oldest.name}, the oldest of ${refs.length} queue refs, has waited since its tip's commit at ${new Date(oldest.since).toISOString()}: ${formatHoursMin(waited)}, against ${formatHoursMin(AGE_FLOOR_MS)}.`,
			title: "Queue ref waiting",
			ticket: QUEUE_ALERT_TITLES.age,
		},
		{
			stalled: refs.length > DEPTH_FLOOR,
			line: `${refs.length} queue refs wait, against ${DEPTH_FLOOR}.`,
			title: "Queue deep",
			ticket: QUEUE_ALERT_TITLES.depth,
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
	/** @type {Verdict[]} */
	let verdicts;
	try {
		verdicts = [await judgeLag(get, now), ...(await judgeQueue(get, now))];
	} catch (e) {
		say(
			`::error title=Check broken, not a stall::Could not read main's lag behind ${LANDING_BRANCH}: ${e instanceof Error ? e.message : String(e)}. The queue's state is unknown: read git log ${VERIFIED_REF}..${LANDING_REF}, then this run's log.`,
		);
		return 2;
	}
	for (const v of verdicts)
		say(
			v.stalled
				? `::error title=${v.title}::${v.line} Look first at: the open "${v.ticket}" ticket, then wsl --list --running on Windows and memcheck in WSL, as the refill loop files that ticket only while the machine runs.`
				: v.line,
		);
	return verdicts.some((v) => v.stalled) ? 1 : 0;
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

module.exports = { main, runAlarm };
