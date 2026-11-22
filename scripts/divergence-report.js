#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { ignoreFailure } = require("./lib/caught.js");
const path = require("node:path");
const { sessionDirs } = require("./lib/arbiter-core.js");
const { byCodeUnit } = require("./lib/by-code-unit.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");

const USAGE = `usage: node ${scriptPath("divergence-report.js")} [--since <N>d|<ISO date>] [--rows] [--json]`;

const FIELDS = [
	"when",
	"repo",
	"kind",
	"ahead",
	"behind",
	"state",
	"sessions",
	"ref",
	"marker",
];

/**
 * @typedef {{ when: string, repo: string, kind: string, ahead: string,
 *   behind: string, state: string, sessions: string, ref: string,
 *   marker: string }} Row
 */

/**
 * @param {string} dir
 * @returns {string[]}
 */
function readLogTexts(dir) {
	const projects = path.join(dir, "projects");
	/** @type {string[]} */
	let entries;
	try {
		entries = fs.readdirSync(projects);
	} catch {
		return [];
	}
	/** @type {string[]} */
	const texts = [];
	for (const entry of entries) {
		ignoreFailure(() =>
			texts.push(
				fs.readFileSync(path.join(projects, entry, "divergence.log"), "utf8"),
			),
		);
	}
	return texts;
}

/**
 * @param {string} text
 * @param {Set<string>} seen
 * @param {Row[]} rows
 */
function addRows(text, seen, rows) {
	for (const line of text.split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length !== FIELDS.length) continue;
		if (seen.has(line)) continue;
		seen.add(line);
		rows.push(
			/** @type {Row} */ (
				Object.fromEntries(FIELDS.map((f, i) => [f, parts[i]]))
			),
		);
	}
}

/** @returns {Row[]} */
function readRows() {
	/** @type {Row[]} */
	const rows = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const dir of sessionDirs())
		for (const text of readLogTexts(dir)) addRows(text, seen, rows);
	rows.sort((a, b) => byCodeUnit(a.when, b.when));
	return rows;
}

/**
 * @param {string | undefined} since
 * @returns {string | null}
 */
function sinceBound(since) {
	if (!since) return null;
	const days = since.match(/^(\d+)d$/);
	if (days) {
		const ms = Date.now() - Number(days[1]) * 86_400_000;
		return new Date(ms).toISOString();
	}
	if (/^\d{4}-\d{2}-\d{2}/.test(since)) return since;
	throw new Error(`--since wants <N>d or an ISO date, not ${since}`);
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const upper = sorted[mid];
	if (upper === undefined) return null;
	if (sorted.length % 2) return upper;
	const lower = sorted[mid - 1];
	if (lower === undefined)
		throw new Error(`median: no lower middle in ${sorted.length} values`);
	return Math.round(((lower + upper) / 2) * 10) / 10;
}

/** @param {Row[]} rows */
function summarise(rows) {
	/** @param {(r: Row) => boolean} p */
	const count = (p) => rows.filter(p).length;
	/** @param {Row[]} subset @param {"ahead" | "behind" | "sessions"} field */
	const numbers = (subset, field) =>
		subset.map((r) => Number(r[field])).filter((n) => Number.isFinite(n));
	const pulls = rows.filter((r) => r.kind === "pull");
	const pushes = rows.filter((r) => r.kind === "push");
	const lands = rows.filter((r) => r.kind === "land");
	return {
		refusals: rows.length,
		pull: pulls.length,
		push: pushes.length,
		land: lands.length,
		state: {
			diverged: count((r) => r.state === "diverged"),
			behind: count((r) => r.state === "behind"),
			ahead: count((r) => r.state === "ahead"),
			level: count((r) => r.state === "level"),
			unknown: count((r) => r.state === "unknown"),
		},
		medianBehindOnPull: median(numbers(pulls, "behind")),
		medianBehindOnPush: median(numbers(pushes, "behind")),
		medianBehindOnLand: median(numbers(lands, "behind")),
		medianAhead: median(numbers(rows, "ahead")),
		medianSessions: median(numbers(rows, "sessions")),
		first: rows[0]?.when ?? null,
		last: rows.at(-1)?.when ?? null,
	};
}

/** @param {number | null} n */
const fig = (n) => (n === null ? "-" : String(n));

/**
 * @param {Record<string, ReturnType<typeof summarise>>} byRepo
 * @param {Row[]} rows
 * @param {boolean} showRows
 */
function print(byRepo, rows, showRows) {
	const repos = Object.entries(byRepo).sort(([a], [b]) => byCodeUnit(a, b));
	if (repos.length === 0) {
		writeFd(
			1,
			"No divergence rows recorded yet. record-divergence.js writes one per refused pull or rejected push, session-checkout.js one per land a neighbour beat;\n",
		);
		writeFd(
			1,
			"an empty log after a day of work is itself the finding this log is after (#289).\n",
		);
		return;
	}
	for (const [repo, s] of repos) {
		writeFd(1, `${repo}\n`);
		writeFd(
			1,
			`  ${s.refusals} refusal(s): ${s.pull} pull, ${s.push} push, ${s.land} land  (${s.first} … ${s.last})\n`,
		);
		writeFd(
			1,
			`  state      diverged ${s.state.diverged}, behind ${s.state.behind}, ahead ${s.state.ahead}, level ${s.state.level}, unknown ${s.state.unknown}\n`,
		);
		writeFd(
			1,
			`  median     ahead ${fig(s.medianAhead)}, behind ${fig(s.medianBehindOnPull)} on pull, ${fig(s.medianBehindOnPush)} on push (lower bound), ${fig(s.medianBehindOnLand)} on land\n`,
		);
		writeFd(
			1,
			`  sessions   median ${fig(s.medianSessions)} live at refusal\n`,
		);
		writeFd(1, "\n");
	}
	if (!showRows) return;
	writeFd(1, "Rows\n");
	for (const r of rows) {
		writeFd(
			1,
			`  ${r.when}  ${r.repo}  ${r.kind}  +${r.ahead}/-${r.behind}  ${r.state}  ${r.sessions} session(s)  ${r.ref}  ${r.marker}\n`,
		);
	}
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--json": "boolean", "--rows": "boolean", "--since": "value" },
	});
	const asJson = flags["--json"] === true;
	const showRows = flags["--rows"] === true;
	const bound = sinceBound(flagValue(flags, "--since"));

	const rows = readRows().filter((r) => !bound || r.when >= bound);
	/** @type {Record<string, Row[]>} */
	const grouped = {};
	for (const r of rows) {
		const list = grouped[r.repo];
		if (list) list.push(r);
		else grouped[r.repo] = [r];
	}
	/** @type {Record<string, ReturnType<typeof summarise>>} */
	const byRepo = {};
	for (const [repo, repoRows] of Object.entries(grouped))
		byRepo[repo] = summarise(repoRows);

	if (asJson) {
		writeFd(
			1,
			`${JSON.stringify({ since: bound, byRepo, rows }, null, "\t")}\n`,
		);
		return;
	}
	print(byRepo, rows, showRows);
}

if (require.main === module) {
	try {
		main();
	} catch (e) {
		writeFd(2, `divergence-report: ${e instanceof Error ? e.message : e}\n`);
		process.exit(2);
	}
}
