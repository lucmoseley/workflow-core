// Unbuilt caller: scripts/lib/stale-run-plan.js (#5859)
const fs = require("node:fs");
const path = require("node:path");

const { writeFileAtomic } = require("./atomic-write.js");
const { parseErrorFirstLine } = require("./first-line.js");
const { now: clockNow } = require("./clock.js");
const { readJsonl } = require("./jsonl.js");
const { refillPath } = require("./refill-dir.js");
const { CITATION_REPO } = require("./exempt-markers.js");
const { isSameRepo } = require("./issue-ref.js");
const {
	UPSTREAM_CODE_REPO,
	UPSTREAM_TRACKER,
} = require("./workflow-core-config.js");

// ruled, #5687 Q1
const BOUND_DAYS = 7;

// guess, #5852
const RATE_WINDOW_DAYS = 7;

// guess, #5852
const MIN_PROJECT_DAYS = 1;

const MIN_REFUSE_DAYS = RATE_WINDOW_DAYS;

// guess, #5852
const UNCHANGED_ROW_DAYS = 1;

// guess, #5852
const PRUNE_DAYS = 14;

const DAY_MS = 864e5;

const HISTORY_FILE = ".gate-history.jsonl";

/**
 * @typedef {{repo: string, issue: number|null, command: string}} GateId
 * @typedef {{a: number, b: number}} Count
 * @typedef {Count & {since: number}} RowCount
 * @typedef {GateId & {at: number, counts: RowCount[]}} HistoryRow
 * @typedef {{verdict: "met"} | {verdict: "no-history", spanDays: number}
 *   | {verdict: "on-track" | "unreachable", metAt: number|null,
 *   ratePerDay: number, remaining: number, unmovedDays: number,
 *   spanDays: number, a: number}} Projection
 */

/** @param {string} reading @returns {Count[]} */
const parseCounts = (reading) =>
	[...reading.matchAll(/\b(\d+) of (\d+)\b/g)].map(([, a, b]) => ({
		a: Number(a),
		b: Number(b),
	}));

const historyPath = () =>
	process.env.WFC_GATE_HISTORY || refillPath(HISTORY_FILE);

/** @param {string} repo */
const repoKey = (repo) => repo.toLowerCase();

/** @param {GateId} r */
const gateKey = (r) => `${r.repo}\0${r.issue ?? ""}\0${r.command}`;

/** @param {unknown} c @returns {c is RowCount} */
const isRowCount = (c) =>
	typeof c === "object" &&
	c !== null &&
	["a", "b", "since"].every(
		(k) => typeof (/** @type {Record<string, unknown>} */ (c)[k]) === "number",
	);

/** @param {Record<string, unknown>} r @returns {r is HistoryRow} */
const isHistoryRow = (r) =>
	typeof r.repo === "string" &&
	(r.issue === null || Number.isInteger(r.issue)) &&
	typeof r.command === "string" &&
	typeof r.at === "number" &&
	Array.isArray(r.counts) &&
	r.counts.length > 0 &&
	r.counts.every(isRowCount);

/** @param {string} file @returns {HistoryRow[]} */
const readAll = (file) => (readJsonl(file)?.rows ?? []).filter(isHistoryRow);

/**
 * @param {HistoryRow[]} rows
 * @param {number} at
 */
function prunedRows(rows, at) {
	const cut = at - PRUNE_DAYS * DAY_MS;
	/** @type {Map<string, HistoryRow>} */
	const newest = new Map();
	for (const r of rows) {
		const held = newest.get(gateKey(r));
		if (!held || r.at >= held.at) newest.set(gateKey(r), r);
	}
	const kept = new Set(newest.values());
	return rows.filter((r) => r.at >= cut || kept.has(r));
}

/**
 * @param {HistoryRow[]} rows
 * @param {GateId} gate
 * @returns {HistoryRow|null}
 */
const newestOf = (rows, gate) =>
	rows
		.filter((r) => gateKey(r) === gateKey(gate))
		.reduce(
			(/** @type {HistoryRow|null} */ best, r) =>
				best && best.at > r.at ? best : r,
			null,
		);

/**
 * @param {{repo: string, issue?: number|null, command: string,
 *   reading: string, at?: number}} reading
 * @returns {HistoryRow|null}
 */
function appendReading({
	repo,
	issue = null,
	command,
	reading,
	at = clockNow(),
}) {
	const file = historyPath();
	const counts = parseCounts(reading);
	if (counts.length === 0) return null;
	const rows = readAll(file);
	const gate = { repo: repoKey(repo), issue, command };
	const newest = newestOf(rows, gate);
	const unchanged =
		newest !== null &&
		newest.counts.length === counts.length &&
		counts.every(
			(c, i) => newest.counts[i]?.a === c.a && newest.counts[i]?.b === c.b,
		);
	if (unchanged && at - newest.at < UNCHANGED_ROW_DAYS * DAY_MS) return null;
	/** @type {HistoryRow} */
	const row = {
		...gate,
		at,
		counts: counts.map((c, i) => {
			const held = newest?.counts[i];
			return { ...c, since: held && held.a === c.a ? held.since : at };
		}),
	};
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const kept = prunedRows(rows, at);
	if (kept.length < rows.length)
		writeFileAtomic(
			file,
			[...kept, row].map((r) => `${JSON.stringify(r)}\n`).join(""),
		);
	else fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
	return row;
}

/**
 * @param {Parameters<typeof appendReading>[0]} reading
 * @returns {string|null}
 */
function recordReading(reading) {
	try {
		appendReading(reading);
		return null;
	} catch (e) {
		return parseErrorFirstLine(e);
	}
}

/**
 * @param {{repo: string, issue?: number|null, command?: string|null}} gate
 * @returns {HistoryRow[]}
 */
function readHistory({ repo, issue = null, command = null }) {
	const rows = readAll(historyPath()).filter((r) => r.repo === repoKey(repo));
	const own = issue === null ? [] : rows.filter((r) => r.issue === issue);
	const chosen =
		own.length > 0 ? own : rows.filter((r) => r.command === command);
	return chosen.sort((x, y) => x.at - y.at);
}

/**
 * @param {{at: number, a: number}[]} points
 * @param {number} a
 * @param {number} now
 */
function measureRate(points, a, now) {
	const series = [...points, { at: now, a }];
	let run = series;
	series.forEach((p, i) => {
		if (i > 0 && p.a < (series[i - 1]?.a ?? p.a)) run = series.slice(i);
	});
	const first = run[0] ?? { at: now, a };
	const from = Math.max(now - RATE_WINDOW_DAYS * DAY_MS, first.at);
	const base = run.filter((p) => p.at <= from).at(-1) ?? first;
	const next = run.find((p) => p.at > from) ?? base;
	const startA =
		next.at > base.at
			? base.a + ((next.a - base.a) * (from - base.at)) / (next.at - base.at)
			: base.a;
	const spanDays = (now - from) / DAY_MS;
	return { ratePerDay: spanDays > 0 ? (a - startA) / spanDays : 0, spanDays };
}

/**
 * @param {HistoryRow[]} rows
 * @param {Count} c
 * @param {number} i
 * @param {number} now
 */
function judgeCount(rows, c, i, now) {
	const points = rows.flatMap((r) => {
		const p = r.counts[i];
		return p ? [{ at: r.at, a: p.a, since: p.since }] : [];
	});
	const { ratePerDay, spanDays } = measureRate(points, c.a, now);
	const remaining = c.b - c.a;
	const last = points.at(-1);
	const since = last && last.a === c.a ? last.since : now;
	return {
		a: c.a,
		ratePerDay,
		spanDays,
		remaining,
		unmovedDays: (now - since) / DAY_MS,
		metAt: ratePerDay > 0 ? now + (remaining / ratePerDay) * DAY_MS : null,
	};
}

/**
 * @param {HistoryRow[]} rows
 * @param {Count[]} counts
 * @param {number} now
 * @returns {Projection}
 */
function project(rows, counts, now) {
	if (counts.every((c) => c.a >= c.b)) return { verdict: "met" };
	const judged = counts.flatMap((c, i) =>
		c.a >= c.b ? [] : [judgeCount(rows, c, i, now)],
	);
	const spanDays = Math.min(...judged.map((j) => j.spanDays));
	if (spanDays < MIN_PROJECT_DAYS) return { verdict: "no-history", spanDays };
	const slowest = judged.reduce((x, y) =>
		y.metAt === null || (x.metAt !== null && y.metAt > x.metAt) ? y : x,
	);
	const onTrack =
		slowest.metAt !== null && slowest.metAt <= now + BOUND_DAYS * DAY_MS;
	return { verdict: onTrack ? "on-track" : "unreachable", ...slowest };
}

/**
 * @param {number} a
 * @param {number} ratePerDay
 * @returns {number}
 */
const reachableFloor = (a, ratePerDay) =>
	a + Math.floor(Math.max(0, ratePerDay) * BOUND_DAYS);

const BOUND_ROUND = { issue: 5687, round: 1 };
const FOUNDER_ROUND_RE = /#(\d+)\s+Q(\d+)\b/g;
const PASS_CLAUSE_RE = /\bpass\s*=([^;]*)/i;
const STATED_TIME_RES = [
	/\((?:about\s+)?(\d+(?:\.\d+)?)\s+(days?|weeks?)\s+at\b/gi,
	/\babout\s+(\d+(?:\.\d+)?)\s+(days?|weeks?)\b/gi,
];

/** @param {string} repo */
const isUpstreamRepo = (repo) =>
	isSameRepo(repo, UPSTREAM_TRACKER) || isSameRepo(repo, UPSTREAM_CODE_REPO);

/**
 * @param {string} textBefore
 * @param {string} gateRepo
 */
function isBoundRepoRef(textBefore, gateRepo) {
	const word = (textBefore.split(/\s/).at(-1) ?? "").replace(/^\W+/, "");
	const named = word.split("/").slice(-2);
	if (named.length === 2) return isUpstreamRepo(named.join("/"));
	if (word.toLowerCase() === CITATION_REPO) return true;
	return gateRepo === "" || isUpstreamRepo(gateRepo);
}

/**
 * @param {string} basis
 * @param {string} gateRepo
 */
const citesOtherFounderRound = (basis, gateRepo) =>
	[...basis.matchAll(FOUNDER_ROUND_RE)].some(
		({ 1: issue, 2: round, index }) =>
			!isBoundRepoRef(basis.slice(0, index), gateRepo) ||
			Number(issue) !== BOUND_ROUND.issue ||
			Number(round) !== BOUND_ROUND.round,
	);

/**
 * @param {string} basis
 * @returns {number|null}
 */
function parseStatedDays(basis) {
	const pass = PASS_CLAUSE_RE.exec(basis)?.[1] ?? "";
	const days = STATED_TIME_RES.flatMap((re) =>
		[...pass.matchAll(re)].map(
			([, n, unit]) => Number(n) * (/^w/i.test(unit ?? "") ? 7 : 1),
		),
	);
	return days.length > 0 ? Math.max(...days) : null;
}

/**
 * @typedef {Extract<Projection, {metAt: unknown}>} DatedProjection
 * @typedef {{verdict: "pass"} | {verdict: "unreachable", projection: DatedProjection}
 *   | {verdict: "stated-past-bound", days: number} | {verdict: "unprojected"}} BoundVerdict
 */

/**
 * @param {HistoryRow[]} rows
 * @param {Count[]} counts
 * @param {{basis: string, repo: string, now: number}} gate
 * @returns {BoundVerdict}
 */
function judgeBound(rows, counts, { basis, repo, now }) {
	/** @type {BoundVerdict} */
	const pass = { verdict: "pass" };
	if (counts.length === 0 || citesOtherFounderRound(basis, repo)) return pass;
	const p = project(rows, counts, now);
	if (p.verdict === "met") return pass;
	if (p.verdict !== "no-history" && p.spanDays >= MIN_REFUSE_DAYS)
		return p.verdict === "unreachable"
			? { verdict: "unreachable", projection: p }
			: pass;
	const days = parseStatedDays(basis);
	if (days === null) return { verdict: "unprojected" };
	return days > BOUND_DAYS ? { verdict: "stated-past-bound", days } : pass;
}

module.exports = {
	BOUND_DAYS,
	MIN_REFUSE_DAYS,
	judgeBound,
	project,
	parseCounts,
	readHistory,
	reachableFloor,
	recordReading,
};
