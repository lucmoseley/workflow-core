#!/usr/bin/env node
/*
 * report-heresy-sweep-due.js — the monthly heresy sweep's filer (#3464, spec
 * #3365): files the one *Heresy sweep due* issue the `heresy-sweep` skill
 * works.
 *
 *   (no flag)  the daily filing run, launched detached at every session start
 *              by scripts/session-start-sweeps.sh, in every repo. At most one
 *              reading a day. When a sweep is due it files or refreshes the
 *              one due issue, found by title alone, so a retitled one is not
 *              found and the next due reading files a second.
 *   --dry-run  print the last sweep, the next due date and why; write nothing.
 *
 * The filing run always exits 0: a `gh` or git failure is
 * one line in the arbiter's error log, which `npm run check:guard-errors`
 * reports, and the next day's reading retries. `--dry-run` exits 2 on one,
 * and on a refused command line.
 */

const { writeFd } = require("./lib/write-fd.js");
const { failureReason, now } = require("./lib/check");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { SWEEP_DAYS, SWEEP_TITLE, judgeSweep } = require("./lib/heresy-sweep");
const { fileOrRefresh, findTrackingIssue } = require("./lib/tracking-issue");
const { takesLabel } = require("./lib/takes-label");
const { buildStandaloneLine } = require("./lib/standalone-line.js");
const { runDailyReading } = require("./lib/daily-reading.js");

const LABEL = takesLabel("implement");
const USAGE = "usage: node scripts/report-heresy-sweep-due.js [--dry-run]";

/** @typedef {import("./lib/heresy-sweep").Verdict} Verdict */

/**
 * The tracker's verdict at `nowMs`.
 *
 * @param {number} nowMs
 * @returns {Verdict}
 */
function readVerdict(nowMs) {
	const opts = { cwd: hostRoot() };
	return judgeSweep(
		(state) => findTrackingIssue({ title: SWEEP_TITLE }, state, opts),
		nowMs,
	);
}

/**
 * Carries no date of the reading's own, so a reading that finds nothing
 * changed leaves the body as it stands.
 *
 * @param {Verdict} verdict
 */
function buildBody(verdict) {
	return [
		"Filed automatically by `scripts/report-heresy-sweep-due.js`, which reads this repo once a day at session start and rewrites this body at each reading while a sweep is due. **Edit it by hand and the next reading silently overwrites it** — put anything you want kept in a comment.",
		"",
		"## This repo's monthly heresy sweep is due",
		"",
		`Last sweep: ${verdict.last}.`,
		"",
		"## What to do",
		"",
		"From this repo's own checkout, run the `heresy-sweep` skill on this issue.",
		"",
		`The next sweep falls due ${SWEEP_DAYS} days after this issue closes.`,
		"",
		buildStandaloneLine("the heresy sweep's standing condition (#3365)."),
	].join("\n");
}

/** @param {number} nowMs @returns {string} what happened, for the run to print */
function fileRun(nowMs) {
	const verdict = readVerdict(nowMs);
	const figure = `Last sweep: ${verdict.last}; ${verdict.why}`;
	if (!verdict.due) return `${figure}: nothing filed.`;
	return `${figure}. ${fileOrRefresh({ title: SWEEP_TITLE, labels: [LABEL], body: buildBody(verdict) })}`;
}

function daily() {
	runDailyReading({
		script: __filename,
		stamp: ".heresy-sweep-read",
		read: fileRun,
	});
}

function dryRun() {
	try {
		const verdict = readVerdict(now());
		writeFd(
			1,
			[
				`Last sweep: ${verdict.last}`,
				`Next due: ${verdict.next ?? "now"}`,
				`Why: ${verdict.why}`,
				verdict.due
					? "Due: a filing run would file or refresh the due issue."
					: "Not due: a filing run would file nothing.",
				"Dry run: nothing filed.",
				"",
			].join("\n"),
		);
	} catch (e) {
		writeFd(2, `BROKEN: ${failureReason(e)}\n`);
		process.exit(2);
	}
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	if ("--dry-run" in flags) dryRun();
	else daily();
}

if (require.main === module) main();
