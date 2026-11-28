#!/usr/bin/env node

const { parseOrExit } = require("./lib/cli-args.js");
const { now } = require("./lib/clock.js");
const { scriptPath } = require("./lib/script-path.js");
const { STAMP_ALARM_DAYS } = require("./lib/stale-run-plan.js");
const {
	DAY_MS,
	readNewestRow,
	recordPath,
} = require("./lib/stale-run-record.js");
const { takesLabel } = require("./lib/takes-label.js");
const { fileOrRefresh } = require("./lib/tracking-issue.js");
const { originLabel } = require("./lib/issue-origin.js");
const { buildStandaloneLine } = require("./lib/standalone-line.js");
const { writeFd } = require("./lib/write-fd.js");

const TITLE = `The daily stale-ticket run has not run for ${STAMP_ALARM_DAYS} days`;
const LABEL = takesLabel("triage");
const USAGE = `usage: node ${scriptPath("report-stale-run-stamp.js")} [--dry-run]`;

/** @param {number} nowMs @returns {string|null} */
function readFault(nowMs) {
	const file = recordPath();
	const row = readNewestRow(file);
	if (row === null) return `no run is recorded in ${file}`;
	const days = (nowMs - Date.parse(row.date)) / DAY_MS;
	return days > STAMP_ALARM_DAYS
		? `its newest run, ${row.date}, is ${Math.floor(days)} days old`
		: null;
}

/** @param {string} fault */
function buildBody(fault) {
	return [
		"Filed automatically by `scripts/report-stale-run-stamp.js`, which reads the daily stale-ticket run's record once a day and rewrites this body while the record is missing or stale. **Edit it by hand and the next reading silently overwrites it** — put anything you want kept in a comment.",
		"",
		`The daily stale-ticket run (\`scripts/stale-ticket-run.js\`, #5857) has not run: ${fault}.`,
		"",
		"## What to do",
		"",
		`Read the timer's state with \`systemctl --user status stale-ticket-run.timer\` and its last run with \`journalctl --user -u stale-ticket-run.service\`. Where the timer is not installed, install it with \`node ${scriptPath("install-stale-run-timer.js")}\`. Close this issue once a run is recorded.`,
		"",
		buildStandaloneLine("the stale-ticket run's timer alarm (#5857)."),
	].join("\n");
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const fault = readFault(now());
	if (fault === null) {
		writeFd(1, "The stale-ticket run's record is current: nothing filed.\n");
		return;
	}
	if (flags["--dry-run"] === true) {
		writeFd(
			1,
			`${fault}: a filing run would file or refresh the alarm issue.\n`,
		);
		return;
	}
	writeFd(
		1,
		`${fault}. ${fileOrRefresh({
			title: TITLE,
			labels: [originLabel("repo-checks-script")],
			takes: LABEL,
			body: buildBody(fault),
		})}\n`,
	);
}

module.exports = { LABEL, TITLE, readFault };

if (require.main === module) main();
