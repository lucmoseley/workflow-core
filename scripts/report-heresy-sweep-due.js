#!/usr/bin/env node

const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");
const { failureReason, now } = require("./lib/check");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { SWEEP_DAYS, SWEEP_TITLE, judgeSweep } = require("./lib/heresy-sweep");
const { fileOrRefresh, findTrackingIssue } = require("./lib/tracking-issue");
const { takesLabel } = require("./lib/takes-label");
const { buildStandaloneLine } = require("./lib/standalone-line.js");
const { runDailyReading } = require("./lib/daily-reading.js");

const LABEL = takesLabel("implement");
const USAGE = `usage: node ${scriptPath("report-heresy-sweep-due.js")} [--dry-run]`;

/** @typedef {import("./lib/heresy-sweep").Verdict} Verdict */

/**
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

/** @param {Verdict} verdict */
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

/** @param {number} nowMs @returns {string} */
function fileRun(nowMs) {
	const verdict = readVerdict(nowMs);
	const figure = `Last sweep: ${verdict.last}; ${verdict.why}`;
	if (!verdict.due) return `${figure}: nothing filed.`;
	return `${figure}. ${fileOrRefresh({ title: SWEEP_TITLE, labels: [LABEL], body: buildBody(verdict) }).text}`;
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
