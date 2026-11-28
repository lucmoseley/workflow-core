const fs = require("node:fs");
const path = require("node:path");

const { refillPath } = require("./refill-dir.js");

// #5687
const BOUND_DAYS = 7;

// guess, #5852
const RATE_WINDOW_DAYS = 7;

// guess, #5852
const MIN_PROJECT_DAYS = 1;

// guess, #5852
const MIN_REFUSE_DAYS = 7;

// guess, #5852
const PRUNE_DAYS = 14;

const DAY_MS = 864e5;

const HISTORY_FILE = ".gate-history.jsonl";

/**
 * @typedef {{a: number, b: number}} Count
 * @typedef {Count & {since: number}} RowCount
 * @typedef {{repo: string, issue: number|null, command: string, at: number,
 *   counts: RowCount[]}} HistoryRow
 * @typedef {{verdict: "met"} | {verdict: "no-history", spanDays: number}
 *   | {verdict: "on-track" | "unreachable", metAt: number|null,
 *   ratePerDay: number, remaining: number, unmovedDays: number,
 *   spanDays: number, a: number}} Projection
 */

/** @param {string} reading @returns {Count[]} */
const readCounts = (reading) =>
	[...reading.matchAll(/\b(\d+) of (\d+)\b/g)].map(([, a, b]) => ({
		a: Number(a),
		b: Number(b),
	}));

const historyPath = () =>
	process.env.WFC_GATE_HISTORY || refillPath(HISTORY_FILE);

/** @param {string} repo */
const repoKey = (repo) => repo.toLowerCase();

/** @param {{repo: string, issue: number|null, command: string}} r */
const gateKey = (r) => `${r.repo}\0${r.issue ?? ""}\0${r.command}`;

/** @param {unknown} c @returns {c is RowCount} */
const isRowCount = (c) =>
	typeof c === "object" &&
	c !== null &&
	["a", "b", "since"].every(
		(k) => typeof (/** @type {Record<string, unknown>} */ (c)[k]) === "number",
	);

/** @param {string} line @returns {HistoryRow|null} */
function parseRow(line) {
	let r;
	try {
		r = JSON.parse(line);
	} catch {
		return null;
	}
	const ok =
		typeof r === "object" &&
		r !== null &&
		typeof r.repo === "string" &&
		(r.issue === null || Number.isInteger(r.issue)) &&
		typeof r.command === "string" &&
		typeof r.at === "number" &&
		Array.isArray(r.counts) &&
		r.counts.length > 0 &&
		r.counts.every(isRowCount);
	return ok ? r : null;
}

/** @param {string} file @returns {HistoryRow[]} */
function readAll(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.map(parseRow)
		.filter((r) => r !== null);
}

/**
 * @param {HistoryRow[]} rows
 * @param {number} now
 */
function prunedRows(rows, now) {
	const cut = now - PRUNE_DAYS * DAY_MS;
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
 * @param {string} file
 * @param {HistoryRow[]} rows
 */
function rewrite(file, rows) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
	fs.renameSync(tmp, file);
}

/**
 * #5861
 * @param {{repo: string, issue?: number|null, command: string,
 *   reading: string, at?: number, file?: string}} reading
 * @returns {HistoryRow|null}
 */
function appendReading({
	repo,
	issue = null,
	command,
	reading,
	at = Date.now(),
	file = historyPath(),
}) {
	const counts = readCounts(reading);
	if (counts.length === 0) return null;
	const rows = readAll(file);
	const gate = { repo: repoKey(repo), issue, command };
	const newest = rows
		.filter((r) => gateKey(r) === gateKey(gate))
		.reduce(
			(/** @type {HistoryRow|null} */ best, r) =>
				best && best.at > r.at ? best : r,
			null,
		);
	const unchanged =
		newest !== null &&
		newest.counts.length === counts.length &&
		counts.every(
			(c, i) => newest.counts[i]?.a === c.a && newest.counts[i]?.b === c.b,
		);
	if (unchanged && at - newest.at < DAY_MS) return null;
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
	const oldest = rows.reduce(
		(t, r) => Math.min(t, r.at),
		Number.POSITIVE_INFINITY,
	);
	if (oldest < at - PRUNE_DAYS * DAY_MS)
		rewrite(file, [...prunedRows(rows, at), row]);
	else fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
	return row;
}

/**
 * #5861
 * @param {{repo: string, issue?: number|null, command?: string|null,
 *   file?: string}} gate
 * @returns {HistoryRow[]}
 */
function readHistory({ repo, issue = null, command = null, file }) {
	const rows = readAll(file ?? historyPath()).filter(
		(r) => r.repo === repoKey(repo),
	);
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
	const spanDays = (now - from) / DAY_MS;
	return { ratePerDay: spanDays > 0 ? (a - base.a) / spanDays : 0, spanDays };
}

/**
 * #5861
 * @param {HistoryRow[]} rows
 * @param {Count[]} counts
 * @param {number} now
 * @returns {Projection}
 */
function project(rows, counts, now) {
	if (counts.every((c) => c.a >= c.b)) return { verdict: "met" };
	const oldest = rows[0];
	const historyDays = oldest ? (now - oldest.at) / DAY_MS : 0;
	if (historyDays < MIN_PROJECT_DAYS)
		return { verdict: "no-history", spanDays: historyDays };
	const judged = counts.flatMap((c, i) => {
		if (c.a >= c.b) return [];
		const points = rows.flatMap((r) => {
			const p = r.counts[i];
			return p ? [{ at: r.at, a: p.a, since: p.since }] : [];
		});
		const { ratePerDay, spanDays } = measureRate(points, c.a, now);
		const remaining = c.b - c.a;
		const last = points.at(-1);
		const since = last && last.a === c.a ? last.since : now;
		return [
			{
				a: c.a,
				ratePerDay,
				spanDays,
				remaining,
				unmovedDays: (now - since) / DAY_MS,
				metAt: ratePerDay > 0 ? now + (remaining / ratePerDay) * DAY_MS : null,
			},
		];
	});
	const slowest = judged.reduce((x, y) =>
		y.metAt === null || (x.metAt !== null && y.metAt > x.metAt) ? y : x,
	);
	const onTrack =
		slowest.metAt !== null && slowest.metAt <= now + BOUND_DAYS * DAY_MS;
	return { verdict: onTrack ? "on-track" : "unreachable", ...slowest };
}

/**
 * #5861
 * @param {number} a
 * @param {number} ratePerDay
 * @returns {number}
 */
const reachableFloor = (a, ratePerDay) =>
	a + Math.floor(Math.max(0, ratePerDay) * BOUND_DAYS);

module.exports = {
	BOUND_DAYS,
	DAY_MS,
	MIN_REFUSE_DAYS,
	appendReading,
	historyPath,
	project,
	readCounts,
	readHistory,
	reachableFloor,
};
