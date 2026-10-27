/*
 * closed-title-cache.js — the titles similarTitles scores against (workflow-core#2755):
 * open issues read live on every call, closed ones off an on-disk cache.
 *
 * ONLY THE CLOSED SET IS CACHED. similarOpen returns open issues alone, so a
 * cached open list could hide an issue another session filed a moment ago —
 * the duplicate the check exists to catch. Closed titles only weight the word
 * frequencies, so a stale closed set shifts a score by a hair and never hides
 * a candidate.
 *
 * No cache, or one that does not parse, is a full pull, written back. A cache
 * past REFRESH_MS fetches the issues updated since its stamp and merges them:
 * closing moves a title in, reopening moves it out. A failed refresh scores
 * against the cache it has and says so on stderr; a failed full pull throws.
 *
 * One file per tracker under the gitignored markers directory, which the
 * scratch sweep leaves alone, written by rename so a concurrent reader never
 * sees half of one. Last writer wins: every write is a whole, valid corpus.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseErrLine, ghApiSlurp, ghIssueListAll } = require("./gh.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { MARKERS_REL } = require("./marker-root.js");
const { hostRoot } = require("./host-root.js");
const { mainCheckout } = require("./main-checkout.js");
const { writeFd } = require("./write-fd.js");

/*
 * An hour: a batch of filings and its --distinct-from re-runs fall inside one,
 * so they pay no closed read at all. The score drift a stale hour leaves is
 * unmeasured (workflow-core#2755).
 */
const REFRESH_MS = 60 * 60 * 1000;

/*
 * The refresh reads from this far before the stamp, so a clock running ahead
 * of GitHub's loses no update. Re-reading an issue merges to the same entry.
 * Five minutes is a guess.
 */
const SKEW_MS = 5 * 60 * 1000;

/**
 * @typedef {{number: number, title: string, state: string}} Row
 * @typedef {{stamp: string, closed: Record<string, string>}} Cache
 * @typedef {object} Deps
 * @property {() => number} now
 * @property {string} file
 * @property {() => Row[]} listAll every issue, open and closed
 * @property {() => Row[]} listOpen
 * @property {(since: string) => Row[]} listSince every issue updated at or after `since`
 * @property {(text: string) => void} warn
 */

/*
 * The main checkout's, so every worktree shares one cache and only the first
 * call anywhere pays the full pull.
 */
/** @param {string} repo */
const cacheFile = (repo) =>
	path.join(
		mainCheckout(hostRoot()) ?? hostRoot(),
		MARKERS_REL,
		"closed-titles",
		`${repo.replace("/", "__")}.json`,
	);

/**
 * @param {string} repo
 * @returns {Deps}
 */
function buildGhDeps(repo) {
	/** @param {"all"|"open"} state */
	const listState = (state) =>
		ghIssueListAll(state === "all" ? "issues" : "open issues", [
			"--repo",
			repo,
			"--state",
			state,
			"--json",
			"number,title,state",
		]);
	return {
		now: Date.now,
		file: cacheFile(repo),
		listAll: () => listState("all"),
		listOpen: () => listState("open"),
		/* REST's `since` rather than an `updated:>` search: the same filter, with
		 * no 1,000-result cap. Its rows carry pull requests, which the issue list
		 * leaves out. */
		listSince: (since) =>
			ghApiSlurp([
				`repos/${repo}/issues`,
				"-X",
				"GET",
				"-f",
				"state=all",
				"-f",
				`since=${since}`,
				"-f",
				"per_page=100",
			])
				.filter((i) => !i.pull_request)
				.map((i) => ({ number: i.number, title: i.title, state: i.state })),
		warn: (text) => writeFd(2, `similar-titles: ${text}\n`),
	};
}

/**
 * The cache at `deps.file`, or null where it is absent or not one — saying so
 * where a file is there but unusable, since that costs a full pull.
 * @param {Deps} deps
 * @returns {Cache|null}
 */
function readCache(deps) {
	let bytes;
	try {
		bytes = fs.readFileSync(deps.file, "utf8");
	} catch {
		// Absent or unreadable: a cold cache, which the full pull rebuilds.
		return null;
	}
	const unusable = () => {
		deps.warn(
			"the closed-title cache is unusable — pulling the whole tracker.",
		);
		return null;
	};
	try {
		const c = JSON.parse(bytes);
		const closed = c?.closed;
		if (
			typeof c?.stamp !== "string" ||
			Number.isNaN(Date.parse(c.stamp)) ||
			!closed ||
			typeof closed !== "object" ||
			Array.isArray(closed) ||
			!Object.values(closed).every((t) => typeof t === "string")
		)
			return unusable();
		return { stamp: c.stamp, closed };
	} catch {
		return unusable();
	}
}

/**
 * @param {Deps} deps
 * @param {Cache} cache
 */
function writeCache(deps, cache) {
	try {
		writeFileAtomic(deps.file, JSON.stringify(cache), { mkdir: true });
	} catch (e) {
		// The cache only saves time: the next call pulls again.
		deps.warn(`could not write the closed-title cache (${parseErrLine(e)}).`);
	}
}

/** @param {Row} r */
const isOpen = (r) => r.state.toUpperCase() === "OPEN";

/**
 * Every title to score against: the open issues, live, then the closed ones.
 * Throws where the open read fails, or the full pull does with no cache.
 * @param {string} repo
 * @param {Partial<Deps>} [over]
 * @returns {Row[]}
 */
function readTrackerTitles(repo, over = {}) {
	const deps = { ...buildGhDeps(repo), ...over };
	const stamp = new Date(deps.now()).toISOString();
	const cache = readCache(deps);
	if (!cache) {
		const all = deps.listAll();
		writeCache(deps, {
			stamp,
			closed: Object.fromEntries(
				all.filter((r) => !isOpen(r)).map((r) => [r.number, r.title]),
			),
		});
		return all;
	}
	const open = deps.listOpen();
	let closed = cache.closed;
	if (deps.now() - Date.parse(cache.stamp) >= REFRESH_MS) {
		const since = new Date(Date.parse(cache.stamp) - SKEW_MS).toISOString();
		try {
			closed = { ...closed };
			for (const r of deps.listSince(since)) {
				if (isOpen(r)) delete closed[r.number];
				else closed[r.number] = r.title;
			}
			writeCache(deps, { stamp, closed });
		} catch (e) {
			// Stale closed titles shift a weight, never hide an open candidate.
			closed = cache.closed;
			deps.warn(
				`could not refresh the closed-title cache (${parseErrLine(e)}) — scoring against its ${cache.stamp} copy.`,
			);
		}
	}
	const live = new Set(open.map((r) => String(r.number)));
	return [
		...open,
		...Object.entries(closed)
			.filter(([n]) => !live.has(n))
			.map(([n, title]) => ({ number: Number(n), title, state: "CLOSED" })),
	];
}

module.exports = { readTrackerTitles };
