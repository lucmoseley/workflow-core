#!/usr/bin/env node
/*
 * divergence-report.js — what record-divergence.sh has collected, read across
 * every repo at once (#289).
 *
 * Usage:
 *   node scripts/divergence-report.js [--since <N>d|<ISO date>] [--rows] [--json]
 *
 * THE QUESTION IT SERVES (#289): which of `state`, `behind` and `sessions`
 * parts the two repos. That is what every summary field below is chosen for.
 *
 * READS EVERY CONFIG DIR THIS MACHINE HAS, not just this session's. The machine
 * runs three Claude plans under `.claude`, `.claude2` and `.claude3`
 * (lib/arbiter-core.js's sessionDirs), a repo's project directory is NOT
 * symlinked between them, and a session on any plan can refuse a pull. A report
 * reading one dir would attribute a plan's silence to the repo.
 *
 * DEDUPLICATION IS BY ROW, not by dir: the same log would be reached twice if a
 * plan's projects directory were symlinked to another's.
 * Identical rows in one repo ARE dropped, and the cost is real — two sessions
 * refusing in the same whole second with the same counts collapse to one. The
 * timestamp has second resolution, so that collision needs two refusals in the
 * same second at the same ahead/behind/sessions. Accepted: a doubled log would
 * over-count every row, which is worse.
 *
 * `behind` ON A PUSH ROW IS A LOWER BOUND. A rejected push has fetched nothing,
 * so its origin-tracking ref is as stale as the session left it. Reported as a
 * separate column rather than pooled with the pull rows, which are current.
 *
 * REPORTS, NEVER GATES. It is run by hand and by nothing else; there is no
 * threshold here and no exit code but 0, short of its own apparatus failing.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { sessionDirs } = require("./lib/arbiter-core.js");
const { byCodeUnit } = require("./lib/by-code-unit.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");

const USAGE =
	"usage: node scripts/divergence-report.js [--since <N>d|<ISO date>] [--rows] [--json]";

/** The columns record-divergence.sh writes, in order. */
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
 * The text of every readable `divergence.log` under one config dir's
 * projects, in directory order; an unreadable dir or log is skipped.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function logTexts(dir) {
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
		try {
			texts.push(
				fs.readFileSync(path.join(projects, entry, "divergence.log"), "utf8"),
			);
		} catch {
			/* no log in this project */
		}
	}
	return texts;
}

/**
 * Appends each well-formed line of `text` not already `seen` to `rows`.
 *
 * @param {string} text
 * @param {Set<string>} seen accumulator: each line taken is added here
 * @param {Row[]} rows accumulator: each new well-formed line's row is pushed here
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

/**
 * Every `divergence.log` under every config dir, as parsed rows.
 *
 * A malformed line is DROPPED rather than reported: the writer is a hook that
 * can be killed mid-append, so a truncated last line is ordinary.
 *
 * @returns {Row[]}
 */
function readRows() {
	/** @type {Row[]} */
	const rows = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const dir of sessionDirs())
		for (const text of logTexts(dir)) addRows(text, seen, rows);
	rows.sort((a, b) => byCodeUnit(a.when, b.when));
	return rows;
}

/**
 * `--since 7d` or `--since 2026-09-19` as an ISO prefix to compare against.
 * Returns null where nothing was asked for.
 *
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
 * The median of a numeric list, or null where it is empty. Averaged across the
 * middle pair on an even count.
 *
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

/**
 * One repo's rows, summarised into the shape the #289 question asks for.
 *
 * @param {Row[]} rows
 */
function summarise(rows) {
	/** @param {(r: Row) => boolean} p */
	const count = (p) => rows.filter(p).length;
	/** @param {Row[]} subset @param {"ahead" | "behind" | "sessions"} field */
	const numbers = (subset, field) =>
		subset.map((r) => Number(r[field])).filter((n) => Number.isFinite(n));
	const pulls = rows.filter((r) => r.kind === "pull");
	const pushes = rows.filter((r) => r.kind === "push");
	return {
		refusals: rows.length,
		pull: pulls.length,
		push: pushes.length,
		state: {
			diverged: count((r) => r.state === "diverged"),
			behind: count((r) => r.state === "behind"),
			ahead: count((r) => r.state === "ahead"),
			level: count((r) => r.state === "level"),
			unknown: count((r) => r.state === "unknown"),
		},
		medianBehindOnPull: median(numbers(pulls, "behind")),
		medianBehindOnPush: median(numbers(pushes, "behind")),
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
		console.log(
			"No divergence rows recorded yet. record-divergence.sh writes one per refused pull or rejected push;",
		);
		console.log(
			"an empty log after a day of work is itself the finding this log is after (#289).",
		);
		return;
	}
	for (const [repo, s] of repos) {
		console.log(`${repo}`);
		console.log(
			`  ${s.refusals} refusal(s): ${s.pull} pull, ${s.push} push  (${s.first} … ${s.last})`,
		);
		console.log(
			`  state      diverged ${s.state.diverged}, behind ${s.state.behind}, ahead ${s.state.ahead}, level ${s.state.level}, unknown ${s.state.unknown}`,
		);
		console.log(
			`  median     ahead ${fig(s.medianAhead)}, behind ${fig(s.medianBehindOnPull)} on pull, ${fig(s.medianBehindOnPush)} on push (lower bound)`,
		);
		console.log(`  sessions   median ${fig(s.medianSessions)} live at refusal`);
		console.log("");
	}
	if (!showRows) return;
	console.log("Rows");
	for (const r of rows) {
		console.log(
			`  ${r.when}  ${r.repo}  ${r.kind}  +${r.ahead}/-${r.behind}  ${r.state}  ${r.sessions} session(s)  ${r.ref}  ${r.marker}`,
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
		console.log(JSON.stringify({ since: bound, byRepo, rows }, null, "\t"));
		return;
	}
	print(byRepo, rows, showRows);
}

if (require.main === module) {
	try {
		main();
	} catch (e) {
		/* writeFd, not console.error: this line precedes a process.exit and
		 * an agent reads this script through a pipe, where console's buffered
		 * write can be dropped at exit (§N6). The success path exits naturally
		 * and needs no such care. */
		writeFd(2, `divergence-report: ${e instanceof Error ? e.message : e}\n`);
		process.exit(2);
	}
}
