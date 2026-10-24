#!/usr/bin/env node
/*
 * report-cost-per-unit.js — the cost-per-unit-of-work reading, appended to the
 * tracked series at docs/data/cost-per-unit.jsonl (mantahostels#2880).
 *
 * Usage:
 *   node scripts/report-cost-per-unit.js [--dry-run] [--force]
 *   --dry-run prints the reading and writes nothing
 *   --force ignores the weekly cadence gate
 *
 * THE UNIT (mantahostels#1737, approved by the founder 28 August 2026). One closed GitHub
 * issue over a rolling 30 days, excluding `not planned` closes and parents
 * labelled `takes:children`. Cost per unit is the standing monthly bill divided
 * by that count. Each row records the bill and seat count it was computed
 * against (mantahostels#2750), because the arrangement can change mid-series and the ratio
 * alone cannot say that it did.
 *
 * REPORTED, NEVER TRIGGERED ON (mantahostels#1740). At a fixed ceiling the ratio moves only
 * through its denominator, so a rising figure means fewer issues closed — which
 * argues for routing work or for more capacity, never for a cut. No threshold
 * is wired to it, deliberately. Anyone adding a threshold here is reversing
 * mantahostels#1740.
 *
 * WHY DAY BY DAY. GitHub's search cap TRUNCATES AT 1,000 RESULTS SILENTLY, and
 * this repo closes ~850 issues a week — a single 30-day query would return a
 * wrong number without saying so (mantahostels#1737, mantahostels#1738). So the window is assembled one
 * UTC day at a time, ~30 sequential queries at ~2-3 s each. That is minutes and
 * it fails offline, so this is not a SessionStart hook: run it by hand, weekly,
 * or read it without writing through `npm run check:cost-per-unit`.
 *
 * WHY A TRACKED FILE AND NOT AN ISSUE (mantahostels#2880, reversing mantahostels#2757). The series used
 * to live in a GitHub issue body, rotated weekly — closed and refiled on each
 * reading so that no issue stayed permanently open (mantahostels#678), which turned one
 * perpetual issue into an endless stream of closeable ones. It was forced by
 * the autonomy ceiling: timer-triggered
 * work is capped at R1, file or refresh an issue and never commit
 * (docs/agents/autonomy-ceiling.md, mantahostels#1169), so the scheduled sweep could not
 * write a file. The escape is to stop running it on a timer at all — a driven
 * session may reach R2, so it commits the row like any other work.
 *
 * The justification the old design rested on does not hold: a past window IS
 * reconstructable. `countDay` queries `closed:<date>` one day at a time, and
 * those queries answer for arbitrary past dates well under the cap. So a missed
 * week is backfillable with `COST_TODAY=<date> --force`, subject to one caveat:
 * `stateReason` and `labels` are read as they stand AT QUERY
 * TIME, so a backfilled row differs from a contemporaneous one wherever a
 * closed issue was relabelled since. A relabel is bounded by the exclusions
 * themselves — 74 of 2,628 closes in the 3 Sep 2026 window, at most 2.8% — but a
 * REOPEN AND RECLOSE is not: it moves an issue's `closed:` date out of the
 * window entirely, and nothing here bounds how often that happens.
 *
 * ONE ROW A DATE. A reading on a date the series already holds replaces that
 * row, written last; every other non-blank line, a broken one included, is kept
 * verbatim (#2334).
 */

const fs = require("node:fs");
const path = require("node:path");
const { parse, exitWith, CliExit } = require("./lib/cli-args");
const { gh, errLine } = require("./lib/gh");
const { commitsSince } = require("./lib/seat-utilisation");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { takesLabel } = require("./lib/takes-label.js");
const { writeFileAtomic } = require("./lib/atomic-write.js");

const CHILDREN_LABEL = takesLabel("children");

/** How the series is spelled in output, and where it actually lives. */
const SERIES_LABEL = "docs/data/cost-per-unit.jsonl";

/* Resolved off the host root rather than the cwd (#1): a cwd-relative path run
 * from a throwaway worktree would `mkdirSync` a SECOND series there, report
 * success, and leave the cadence gate reading empty in that cwd for ever. The
 * series is host content — it lives under the host repo's docs/, not beside
 * this script — so `__dirname` would in a plugin install name the plugin cache
 * instead. */
const SERIES = path.join(hostRoot(), ...SERIES_LABEL.split("/"));

/**
 * The standing monthly bill, in dollars. A CEILING with no headroom, set by the
 * founder at mantahostels#1734 — not a target and not a budget to spend up to. It is the
 * numerator because no absolute allowance is readable anywhere: every
 * `limit_dollars`, `used_dollars` and `remaining_dollars` in the usage cache is
 * `null` (mantahostels#1738), so a dollar-denominated unit rests on bill / count and never
 * on metered consumption.
 *
 * Change this only when the bill itself changes — which is itself a
 * re-assessment trigger on `docs/capacity-procurement-ladder.md`. Move
 * `LIVE_SEATS` in the same edit: the two are one fact, and a row recording a
 * bill against the wrong seat count is worse than one recording neither.
 */
const MONTHLY_BILL = 600;

/**
 * How many seats that bill is buying. Recorded beside it in every row so the
 * series says what it was measuring, rather than leaving a reader to assume
 * today's arrangement held all the way back (mantahostels#2750).
 */
const LIVE_SEATS = 3;

/** Rolling window, matching the ~30-day transcript roll-off: no longer window
 *  is back-testable at all, the corpus floor being 29 July 2026 (mantahostels#1737). */
const WINDOW_DAYS = 30;

/** How often a reading is taken. Weekly, per mantahostels#1740. */
const CADENCE_DAYS = 7;

/** GitHub's silent search cap. A day returning exactly this was truncated, and
 *  its count is a floor rather than a count. */
const SEARCH_CAP = 1000;

const DAY_MS = 864e5;

/* The gate sorts `taken` lexicographically, which is only a date order while
 * every value is ISO. One `4/9/26` or `2026-9-4` would sort to the head or the
 * tail and wedge the cadence. So a row failing this is not the newest reading,
 * and a COST_TODAY failing it is refused before any query runs. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @typedef {{ date: string, total: number, notPlanned: number, children: number, counted: number, truncated: boolean }} DayCount */

/**
 * The `WINDOW_DAYS` complete UTC days ending yesterday. Today is excluded: a
 * day still running is a partial count that would read as a fall in throughput.
 *
 * @param {Date} now
 * @returns {string[]}
 */
function windowDays(now) {
	const end = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
	return Array.from({ length: WINDOW_DAYS }, (_, i) =>
		new Date(end - (WINDOW_DAYS - i) * DAY_MS).toISOString().slice(0, 10),
	);
}

/**
 * One day's closes, filtered as mantahostels#1737 settled.
 *
 * `not planned` (2.7% of closes) is an abandoned issue, which is not completed
 * work; `takes:children` (1.2%) marks a parent that closes only once its
 * children have, so counting it double-counts. `takes:wayfinder` COUNTS, at
 * 43.6% — excluding decision work would make a planning-heavy fortnight read as
 * a failure.
 *
 * @param {string} date  `YYYY-MM-DD`
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

/**
 * The whole window, and the reading it gives.
 *
 * @param {Date} now
 */
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
		/* null rather than Infinity on a window that closed nothing: a
		 * cost-per-unit with no units is not a large number, it is no reading. */
		costPerUnit: counted === 0 ? null : MONTHLY_BILL / counted,
	};
}

/** @typedef {{ taken: string, from: string, to: string, total: number, notPlanned: number, children: number, counted: number, bill: number, seats: number, costPerUnit: number | null, truncated: string[] }} Row */

/**
 * Every row in the series, oldest first.
 *
 * A line that will not parse, or parses to something that is not a row with an
 * ISO `taken` date, is REPORTED and skipped — never dropped in silence: the only
 * reader is the founder at a review months later, and a series quietly one row
 * short is indistinguishable from a week nobody ran. Syntax alone is not enough:
 * a bare `null` or `[]` is valid JSON and would reach `lastTaken` as a row.
 *
 * @returns {{ rows: Row[], bad: number[] }}
 */
function readSeries() {
	if (!fs.existsSync(SERIES)) return { rows: [], bad: [] };
	/** @type {Row[]} */
	const rows = [];
	/** @type {number[]} */
	const bad = [];
	const lines = fs.readFileSync(SERIES, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (!line.trim()) return;
		try {
			const row = JSON.parse(line);
			if (!row || typeof row !== "object" || !ISO_DATE.test(row.taken))
				bad.push(i + 1);
			else rows.push(row);
		} catch {
			bad.push(i + 1);
		}
	});
	return { rows, bad };
}

/**
 * When the newest row was taken, or null where there is none. Read off the
 * `taken` field rather than the last line, so an out-of-order backfill does not
 * make the next reading look overdue. Every row `readSeries` returns carries an
 * ISO date, so the sort is a date order; a caller passing rows from anywhere
 * else must guarantee the same.
 *
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
 * The row a reading writes.
 *
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

/**
 * Write one row: appended where its date is new, `appendFileSync` rather than a
 * read-modify-write, since a rewrite would take a snapshot that loses a row a
 * parallel session appended between the read and the write (mantahostels#250's shape).
 * A row whose date the series holds replaces it, through that rewrite: the
 * window is accepted only on this path, a forced re-reading of a day (#2334).
 *
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
 * A line's `taken` date, or null where it is not a parseable row.
 *
 * @param {string} line
 * @returns {string | null}
 */
function takenOf(line) {
	try {
		const taken = JSON.parse(line)?.taken;
		return typeof taken === "string" ? taken : null;
	} catch {
		return null;
	}
}

/** @param {number} n */
const commas = (n) => n.toLocaleString("en-GB");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: "usage: node scripts/report-cost-per-unit.js [--dry-run] [--force]",
	flags: { "--dry-run": "boolean", "--force": "boolean" },
};

/**
 * @param {string[]} argv
 * @returns {number}  process exit code; throws lib/cli-args.js's CliExit on
 *   `--help` or a bad command line, before anything is read
 */
function main(argv) {
	const { flags } = parse(argv, CLI);

	const today = (process.env.COST_TODAY || new Date().toISOString()).slice(
		0,
		10,
	);
	/* Refused here, not later: a malformed COST_TODAY passes the cadence gate
	 * (its arithmetic yields NaN, which is never > 0), spends ~30 GitHub queries
	 * and then surfaces as "the closed-issue series could not be assembled" —
	 * blaming the subject for a typo, and exiting 0. */
	if (!ISO_DATE.test(today) || Number.isNaN(Date.parse(`${today}T00:00:00Z`))) {
		console.error(`COST_TODAY is not an ISO date: ${today}`);
		return 2;
	}
	const { rows, bad } = readSeries();
	if (bad.length > 0)
		console.log(
			`⚠ ${bad.length} unparseable line(s) in ${SERIES_LABEL}, skipped: ${bad.join(", ")}. Repair them by hand.`,
		);

	const last = lastTaken(rows);
	if (last && last > today)
		console.log(
			`⚠ The newest row is dated ${last}, which is after ${today}. The cadence gate ` +
				"reads that as never due; delete or correct that row, or pass --force.",
		);
	const dueIn =
		last === null
			? -1
			: CADENCE_DAYS -
				Math.floor((Date.parse(today) - Date.parse(last)) / DAY_MS);
	/* --dry-run is exempt from the gate, not merely from the write. The gate
	 * exists to stop the series filling with rows nobody asked for; a run that
	 * appends nothing cannot do that, and gating it made the documented read-only
	 * route print "Not due" and no figure on six days in seven. */
	if (dueIn > 0 && !flags["--force"] && !flags["--dry-run"]) {
		console.log(
			`Not due: the series was last read ${last}, next in ${dueIn} day(s). ` +
				"Pass --force to take a reading anyway.",
		);
		return 0;
	}

	/* A GitHub outage or one flaky day-query is the SUBJECT being unavailable,
	 * not this reporter breaking. Exiting 1 would lose nothing but a week's row,
	 * which the next run takes anyway. */
	let r;
	try {
		r = reading(new Date(`${today}T00:00:00Z`));
	} catch (e) {
		console.log(
			`No reading taken: the closed-issue series could not be assembled (${errLine(e)}). ` +
				"Nothing written; run it again.",
		);
		return 0;
	}
	const perUnit =
		r.costPerUnit === null ? "no units" : `$${r.costPerUnit.toFixed(3)}/unit`;
	console.log(
		/* The commit co-indicator beside the unit, printed and never stored: it
		 * re-expresses the meter at one remove, so it corroborates the unit rather
		 * than standing in for it (mantahostels#1737, mantahostels#1738 — 0.07 s, r = 0.918 against turns). */
		`${r.from}..${r.to}: ${commas(r.counted)} units, ${perUnit} at $${MONTHLY_BILL}/month across ${LIVE_SEATS} seats ` +
			`(co-indicator: ${commitsSince(WINDOW_DAYS * 24) ?? "?"} commits).`,
	);
	if (r.truncated.length > 0)
		console.log(
			`⚠ ${r.truncated.length} day(s) hit the ${commas(SEARCH_CAP)}-result search cap: ${r.truncated.join(", ")}. ` +
				"The unit count is a FLOOR and the cost per unit a ceiling.",
		);

	if (flags["--dry-run"]) {
		console.log(`--dry-run: nothing appended to ${SERIES_LABEL}.`);
		return 0;
	}

	const sameDay = rows.filter((x) => x.taken === today).length;
	/* NOT wrapped, unlike the read above, and the change is deliberate: the old
	 * design swallowed a filing failure because it ran unattended on a sweep,
	 * where a GitHub outage must not redden the build. A failed append is a local
	 * disk or permission fault in a session someone is watching — it is THIS
	 * script broken, not its subject unavailable — so it throws to the top-level
	 * catch and exits 1 rather than reporting a reading it did not store. */
	writeRow(rowFor(r, today), sameDay > 0);
	console.log(
		sameDay
			? `Replaced the row dated ${today} in ${SERIES_LABEL} (${rows.length - sameDay + 1} row(s)).`
			: `Appended to ${SERIES_LABEL} (${rows.length + 1} row(s)).`,
	);
	console.log(`Commit it: git commit -m "…" -- ${SERIES_LABEL}`);
	return 0;
}

if (require.main === module) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (e) {
		if (e instanceof CliExit) exitWith(e);
		process.stderr.write(`${caught(e).message}\n`);
		process.exit(1);
	}
}
