const fs = require("node:fs");
const path = require("node:path");
const {
	parseErrLine,
	gh,
	ghIssuesUpdatedSince,
	ghIssueListAll,
	SINCE_SKEW_MS,
} = require("./gh.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { MARKERS_REL } = require("./marker-root.js");
const { hostRoot } = require("./host-root.js");
const { writeFd } = require("./write-fd.js");

// guess, workflow-core#2755
const REFRESH_MS = 60 * 60 * 1000;

/**
 * @typedef {{number: number, title: string, state: string}} Row
 * @typedef {{stamp: string, closed: Record<string, string>}} Cache
 * @typedef {object} Deps
 * @property {() => number} now
 * @property {string} file
 * @property {() => Row[]} listAll
 * @property {() => Row[]} listOpen
 * @property {(since: string) => Row[]} listSince
 * @property {(text: string) => void} warn
 */

/** @param {string} repo */
const cacheFile = (repo) =>
	path.join(
		hostRoot(),
		MARKERS_REL,
		"closed-titles",
		`${repo.replace("/", "__")}.json`,
	);

/**
 * @param {string} repo
 * @param {import("./gh.js").GhRun} [run]
 * @returns {Deps}
 */
function buildGhDeps(repo, run = gh) {
	/** @param {"all"|"open"} state */
	const listState = (state) =>
		ghIssueListAll(
			state === "all" ? "issues" : "open issues",
			["--repo", repo, "--state", state, "--json", "number,title,state"],
			{},
			run,
		);
	return {
		now: Date.now,
		file: cacheFile(repo),
		listAll: () => listState("all"),
		listOpen: () => listState("open"),
		listSince: (since) =>
			ghIssuesUpdatedSince(repo, since, run).map((i) => ({
				number: i.number,
				title: i.title,
				state: i.state,
			})),
		warn: (text) => writeFd(2, `similar-titles: ${text}\n`),
	};
}

/**
 * @param {Deps} deps
 * @returns {Cache|null}
 */
function readCache(deps) {
	let bytes;
	try {
		bytes = fs.readFileSync(deps.file, "utf8");
	} catch {
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
		deps.warn(`could not write the closed-title cache (${parseErrLine(e)}).`);
	}
}

/** @param {Row} r */
const isOpen = (r) => r.state.toUpperCase() === "OPEN";

/**
 * @param {string} repo
 * @param {Partial<Deps>} [over]
 * @param {import("./gh.js").GhRun} [run]
 * @returns {Row[]}
 */
function readTrackerTitles(repo, over = {}, run = gh) {
	const deps = { ...buildGhDeps(repo, run), ...over };
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
		const since = new Date(
			Date.parse(cache.stamp) - SINCE_SKEW_MS,
		).toISOString();
		try {
			closed = { ...closed };
			for (const r of deps.listSince(since)) {
				if (isOpen(r)) delete closed[r.number];
				else closed[r.number] = r.title;
			}
			writeCache(deps, { stamp, closed });
		} catch (e) {
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
