#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { writeFd } = require("./lib/write-fd.js");
const { parse, exitWith, CliExit } = require("./lib/cli-args");
const { gh, parseErrLine, SEARCH_CAP } = require("./lib/gh");
const { commitsSince } = require("./lib/seat-utilisation");
const { worktreeRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { parseJsonlRow, readJsonl } = require("./lib/jsonl.js");
const { takesLabel } = require("./lib/takes-label.js");
const { writeFileAtomic } = require("./lib/atomic-write.js");

const CHILDREN_LABEL = takesLabel("children");

const SERIES_LABEL = "docs/data/cost-per-unit.jsonl";

// workflow-core#4438
const SERIES = path.join(worktreeRoot(), ...SERIES_LABEL.split("/"));

// guess: the founder's no-headroom ceiling, lucmoseley/mantahostels#1734
const MONTHLY_BILL = 600;

// guess: the seats the bill buys, lucmoseley/mantahostels#2750
const LIVE_SEATS = 3;

// guess, lucmoseley/mantahostels#1737
const WINDOW_DAYS = 30;

// guess, lucmoseley/mantahostels#1740
const CADENCE_DAYS = 7;

const DAY_MS = 864e5;

// lucmoseley/mantahostels#2880
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @typedef {{ date: string, total: number, notPlanned: number, children: number, counted: number, truncated: boolean }} DayCount */

/**
 * @param {Date} now
 * @returns {string[]}
 */
function windowDays(now) {
	const end = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
	return Array.from({ length: WINDOW_DAYS }, (_, i) =>
		new Date(end - (WINDOW_DAYS - i) * DAY_MS).toISOString().slice(0, 10),
	);
}

// lucmoseley/mantahostels#1737
/**
 * @param {string} date
 * @returns {DayCount}
 */
function countDay(date) {
	const rows = JSON.parse(
		gh([
			"issue",
			"list",
			"--state",
			"closed",
			"--limit",
			String(SEARCH_CAP),
			"--search",
			`closed:${date}`,
			"--json",
			"number,stateReason,labels",
		]),
	);
	let notPlanned = 0;
	let children = 0;
	let counted = 0;
	for (const r of rows) {
		const isNotPlanned = r.stateReason === "NOT_PLANNED";
		const isParent = (r.labels || []).some(
			(/** @type {{ name?: string }} */ l) => l?.name === CHILDREN_LABEL,
		);
		if (isNotPlanned) notPlanned++;
		if (isParent) children++;
		if (!isNotPlanned && !isParent) counted++;
	}
	return {
		date,
		total: rows.length,
		notPlanned,
		children,
		counted,
		truncated: rows.length >= SEARCH_CAP,
	};
}

/** @param {Date} now */
function reading(now) {
	const days = windowDays(now).map(countDay);
	const sum = (/** @type {(d: DayCount) => number} */ f) =>
		days.reduce((a, d) => a + f(d), 0);
	const counted = sum((d) => d.counted);
	const [first] = days;
	const last = days.at(-1);
	if (first === undefined || last === undefined)
		throw new Error("the window holds no day");
	return {
		from: first.date,
		to: last.date,
		days,
		total: sum((d) => d.total),
		notPlanned: sum((d) => d.notPlanned),
		children: sum((d) => d.children),
		counted,
		truncated: days.filter((d) => d.truncated).map((d) => d.date),
		costPerUnit: counted === 0 ? null : MONTHLY_BILL / counted,
	};
}

/** @typedef {{ taken: string, from: string, to: string, total: number, notPlanned: number, children: number, counted: number, bill: number, seats: number, costPerUnit: number | null, truncated: string[] }} Row */

/** @returns {{ rows: Row[], bad: number[], zeroed: number[] }} */
function readSeries() {
	const read = readJsonl(SERIES);
	if (!read) return { rows: [], bad: [], zeroed: [] };
	/** @type {Row[]} */
	const rows = [];
	const bad = [...read.bad];
	for (const { row, line } of read.entries) {
		if (ISO_DATE.test(String(row.taken))) rows.push(/** @type {Row} */ (row));
		else bad.push(line);
	}
	return { rows, bad: bad.sort((x, y) => x - y), zeroed: read.zeroed };
}

/**
 * @param {Row[]} rows
 * @returns {string | null}
 */
function lastTaken(rows) {
	const dates = rows
		.map((r) => r.taken)
		.filter(Boolean)
		.sort();
	return dates.at(-1) ?? null;
}

/**
 * @param {ReturnType<typeof reading>} r
 * @param {string} taken
 * @returns {Row}
 */
const rowFor = (r, taken) => ({
	taken,
	from: r.from,
	to: r.to,
	total: r.total,
	notPlanned: r.notPlanned,
	children: r.children,
	counted: r.counted,
	bill: MONTHLY_BILL,
	seats: LIVE_SEATS,
	costPerUnit: r.costPerUnit,
	truncated: r.truncated,
});

// lucmoseley/mantahostels#250 workflow-core#2334
/**
 * @param {Row} row
 * @param {boolean} replace
 */
function writeRow(row, replace) {
	fs.mkdirSync(path.dirname(SERIES), { recursive: true });
	const line = JSON.stringify(row);
	if (!replace) {
		fs.appendFileSync(SERIES, `${line}\n`);
		return;
	}
	const kept = fs
		.readFileSync(SERIES, "utf8")
		.split("\n")
		.filter((l) => l.trim() && takenOf(l) !== row.taken);
	writeFileAtomic(SERIES, `${[...kept, line].join("\n")}\n`);
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function takenOf(line) {
	const taken = parseJsonlRow(line)?.taken;
	return typeof taken === "string" ? taken : null;
}

/**
 * @param {number[]} bad
 * @param {number[]} zeroed
 */
function warnLost(bad, zeroed) {
	if (bad.length > 0)
		writeFd(
			1,
			`⚠ ${bad.length} unparseable line(s) in ${SERIES_LABEL}, skipped: ${bad.join(", ")}. Repair them by hand.\n`,
		);
	if (zeroed.length > 0)
		writeFd(
			1,
			`⚠ ${zeroed.length} record(s) in ${SERIES_LABEL} zeroed by a crash, lost, at line(s) ${zeroed.join(", ")}.\n`,
		);
}

/** @param {number} n */
const commas = (n) => n.toLocaleString("en-GB");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `usage: node ${scriptPath("report-cost-per-unit.js")} [--dry-run] [--force]`,
	flags: { "--dry-run": "boolean", "--force": "boolean" },
};

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const { flags } = parse(argv, CLI);

	const today = (process.env.COST_TODAY || new Date().toISOString()).slice(
		0,
		10,
	);
	// lucmoseley/mantahostels#2880
	if (!ISO_DATE.test(today) || Number.isNaN(Date.parse(`${today}T00:00:00Z`))) {
		writeFd(2, `COST_TODAY is not an ISO date: ${today}\n`);
		return 2;
	}
	const { rows, bad, zeroed } = readSeries();
	warnLost(bad, zeroed);

	const last = lastTaken(rows);
	if (last && last > today)
		writeFd(
			1,
			`⚠ The newest row is dated ${last}, which is after ${today}. The cadence gate ` +
				"reads that as never due; delete or correct that row, or pass --force.\n",
		);
	const dueIn =
		last === null
			? -1
			: CADENCE_DAYS -
				Math.floor((Date.parse(today) - Date.parse(last)) / DAY_MS);
	// lucmoseley/mantahostels#2880
	if (dueIn > 0 && !flags["--force"] && !flags["--dry-run"]) {
		writeFd(
			1,
			`Not due: the series was last read ${last}, next in ${dueIn} day(s). ` +
				"Pass --force to take a reading anyway.\n",
		);
		return 0;
	}

	let r;
	try {
		r = reading(new Date(`${today}T00:00:00Z`));
	} catch (e) {
		writeFd(
			1,
			`No reading taken: the closed-issue series could not be assembled (${parseErrLine(e)}). ` +
				"Nothing written; run it again.\n",
		);
		return 0;
	}
	const perUnit =
		r.costPerUnit === null ? "no units" : `$${r.costPerUnit.toFixed(3)}/unit`;
	// lucmoseley/mantahostels#1737
	writeFd(
		1,
		`${r.from}..${r.to}: ${commas(r.counted)} units, ${perUnit} at $${MONTHLY_BILL}/month across ${LIVE_SEATS} seats ` +
			`(co-indicator: ${commitsSince(WINDOW_DAYS * 24) ?? "?"} commits).\n`,
	);
	if (r.truncated.length > 0)
		writeFd(
			1,
			`⚠ ${r.truncated.length} day(s) hit the ${commas(SEARCH_CAP)}-result search cap: ${r.truncated.join(", ")}. ` +
				"The unit count is a FLOOR and the cost per unit a ceiling.\n",
		);

	if (flags["--dry-run"]) {
		writeFd(1, `--dry-run: nothing appended to ${SERIES_LABEL}.\n`);
		return 0;
	}

	const sameDay = rows.filter((x) => x.taken === today).length;
	// lucmoseley/mantahostels#2880
	writeRow(rowFor(r, today), sameDay > 0);
	writeFd(
		1,
		`${
			sameDay
				? `Replaced the row dated ${today} in ${SERIES_LABEL} (${rows.length - sameDay + 1} row(s)).`
				: `Appended to ${SERIES_LABEL} (${rows.length + 1} row(s)).`
		}\n`,
	);
	writeFd(1, `Commit it: git commit -m "…" -- ${SERIES_LABEL}\n`);
	return 0;
}

if (require.main === module) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (e) {
		if (e instanceof CliExit) exitWith(e);
		writeFd(2, `${caught(e).message}\n`);
		process.exit(1);
	}
}
