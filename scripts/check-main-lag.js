#!/usr/bin/env node
/*
 * check-main-lag.js — the off-machine stall check (#4443), run hourly on
 * GitHub by .github/workflows/main-lag.yml: fails where `landing` is ahead of
 * `main` and `main` has not moved for lib/landing-stall.js's STALL_MS, so a
 * stall is caught with the machine off or the refill loop dead.
 *
 *   node scripts/check-main-lag.js
 *
 * Reads GITHUB_API_URL, GITHUB_REPOSITORY and GH_TOKEN, as Actions sets them.
 *
 * The clock is the on-machine stall's: from `main`'s last push, or from when
 * `landing` first went ahead of it where that is later (#3303). With no
 * reading to remember, `landing` counts as ahead from `main`'s push where its
 * tip at that push was already ahead, else from its first push after.
 * Residual: where every one of the PUSH_PAGE pushes listed came after
 * `main`'s, the oldest listed stands in for the first, which only shortens
 * the clock.
 *
 * Prints GitHub annotations. Exit codes: 0 where `main` is level or moved
 * within STALL_MS; 1 on a stall, or a check that could not read the queue.
 * Needs no npm install.
 */

const { STALL_MS } = require("./lib/landing-stall.js");

/* GitHub's ceiling for one page of the activity feed. */
const PUSH_PAGE = 100;
/* Guesses: one API read's retries and the pause between them. */
const TRIES = 4;
const RETRY_MS = 2000;

/**
 * @typedef {{timestamp: string, after: string}} Push
 * @typedef {(path: string) => Promise<unknown>} Get the parsed JSON at an
 *   API path under the repo, throwing on any failure
 * @typedef {{stalled: boolean, line: string}} Verdict
 */

/** @param {number} ms */
const formatAge = (ms) => {
	const min = Math.floor(ms / 60_000);
	return `${Math.floor(min / 60)} h ${min % 60} min`;
};

/** @param {string} status a compare endpoint's status of `landing` to `main` */
const queued = (status) => status === "ahead" || status === "diverged";

/**
 * @param {Get} get
 * @param {string} ref
 * @param {number} perPage
 * @returns {Promise<[Push, ...Push[]]>} newest first
 */
async function pushes(get, ref, perPage) {
	const feed = await get(`/activity?ref=refs/heads/${ref}&per_page=${perPage}`);
	if (!Array.isArray(feed) || feed.length === 0)
		throw new Error(`no push to ${ref} in the activity feed`);
	return /** @type {[Push, ...Push[]]} */ (feed);
}

/**
 * @param {Get} get
 * @param {string} base
 * @param {string} head
 * @returns {Promise<string>}
 */
async function compareStatus(get, base, head) {
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
	const [tip] = await pushes(get, "main", 1);
	const mainAt = Date.parse(tip.timestamp);
	const status = await compareStatus(get, tip.after, "landing");
	if (!queued(status))
		return {
			stalled: false,
			line: `main ${tip.after.slice(0, 9)}, last pushed ${tip.timestamp}, is level with landing (${status}).`,
		};
	const landing = await pushes(get, "landing", PUSH_PAGE);
	const atMove = landing.find((p) => Date.parse(p.timestamp) <= mainAt);
	const after = landing.filter((p) => Date.parse(p.timestamp) > mainAt);
	const aheadAtMove =
		atMove !== undefined &&
		queued(await compareStatus(get, tip.after, atMove.after));
	const since =
		aheadAtMove || after.length === 0
			? mainAt
			: Date.parse(/** @type {Push} */ (after.at(-1)).timestamp);
	const age = now - since;
	const line = `main has not moved since ${tip.timestamp}, with landing ${status} of it since ${new Date(since).toISOString()}: ${formatAge(age)}, against ${formatAge(STALL_MS)}.`;
	return { stalled: age > STALL_MS, line };
}

/**
 * The repo's API, through fetch, retried on any failure.
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
async function main({ get, now, say }) {
	let verdict;
	try {
		verdict = await judgeLag(get, now);
	} catch (e) {
		say(
			`::error title=Check broken, not a stall::Could not read main's lag behind landing: ${e instanceof Error ? e.message : String(e)}. The queue's state is unknown: read git log origin/main..origin/landing, then this run's log.`,
		);
		return 1;
	}
	if (!verdict.stalled) {
		say(verdict.line);
		return 0;
	}
	say(
		`::error title=Main lagging landing::${verdict.line} Look first at: the open "Landing queue stalled" ticket, then wsl --list --running on Windows and memcheck in WSL, as the refill loop files that ticket only while the machine runs.`,
	);
	return 1;
}

if (require.main === module)
	main({
		get: liveGet(process.env),
		now: Date.now(),
		say: (line) => process.stdout.write(`${line}\n`),
	}).then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			process.stderr.write(`check-main-lag: ${e}\n`);
			process.exitCode = 1;
		},
	);

module.exports = { main };
