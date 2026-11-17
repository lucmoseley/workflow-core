#!/usr/bin/env node
/*
 * peak-tripwire.js — read and re-arm the peak tripwire (lib/peak-tripwire.js,
 * #5367): the switch that holds every part-suite on the ladder once earlyoom
 * kills a test run while a peak-charged run is live.
 *
 *   node scripts/peak-tripwire.js status
 *   node scripts/peak-tripwire.js arm [--session <id>]
 *
 * `status` prints the persisted state, the tripping kill, the peak-charged
 * runs live at it and the last check; it reads no journal. `arm` re-arms it
 * and advances the journal cursor to now, so the kill read cannot trip it
 * again: run it once you have read the kill. The arming session is
 * `--session`, else the environment's (lib/session-id.js); `arm` refuses
 * without one.
 *
 * Exit codes: 0 done; 1 the state file would not write; 2 a command line it
 * refuses.
 *
 * In no family: it gates nothing and files nothing, so neither `check-*`'s
 * alphabet nor `report-*`'s exit 0 fits.
 */

const { parseOrCode, flagValue } = require("./lib/cli-args.js");
const { caught } = require("./lib/caught.js");
const {
	armTripwire,
	describeTrip,
	readTripwire,
	rearmCommands,
} = require("./lib/peak-tripwire.js");
const idSeam = require("./lib/session-id.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("peak-tripwire.js")} status | arm [--session <id>]`;

const CLI = {
	usage: USAGE,
	commands: {
		status: { usage: `usage: node ${scriptPath("peak-tripwire.js")} status` },
		arm: {
			usage: `usage: node ${scriptPath("peak-tripwire.js")} arm [--session <id>]`,
			flags: { "--session": /** @type {const} */ ("value") },
		},
	},
};

/**
 * @param {import("./lib/peak-tripwire.js").Read} read
 * @returns {string}
 */
function statusText({ tripwire: t, corrupt }) {
	const lines = [`peak tripwire: ${t.state}`];
	if (corrupt !== null)
		lines.push(
			`  state file unreadable, read as blind: ${corrupt}`,
			`  \`${rearmCommands().arm}\` rewrites it`,
		);
	if (t.state === "tripped") {
		lines.push(`  tripped at ${t.trippedAt}: ${describeTrip(t)}`);
		if (t.trip !== null)
			lines.push(
				`  the killed run: ${t.trip.testRun.kind} run by ${t.trip.testRun.session ?? "an unnamed session"}, ${t.trip.testRun.fileCount} files, argv \`${t.trip.testRun.argv.join(" ")}\``,
			);
		for (const r of t.liveRuns)
			lines.push(
				`  live: ${r.kind} run by ${r.session ?? "an unnamed session"} in ${r.repo}, ${r.fileCount} files, from ${r.at}`,
			);
	}
	lines.push(
		`  last check: ${t.checkedAt ?? "never"}, journal read through ${t.checkedThrough ?? "nothing yet"}`,
	);
	if (t.unread !== null)
		lines.push(
			`  journal unread at ${t.unread.at}, part-suites on the ladder: ${t.unread.why}`,
		);
	if (t.armedAt !== null)
		lines.push(`  last armed by ${t.armedBy} at ${t.armedAt}`);
	if (t.state === "tripped")
		lines.push(`re-arm once the kill is read: ${rearmCommands().arm}`);
	return `${lines.join("\n")}\n`;
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string|undefined>, now?: number, file?: string }} [o]
 * @returns {number}
 */
function main(argv, { env = process.env, now = Date.now(), file } = {}) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	if (parsed.command === "status") {
		writeFd(1, statusText(readTripwire({ file })));
		return 0;
	}
	const session = flagValue(parsed.flags, "--session") ?? idSeam.fromEnv(env);
	if (session === null || session === undefined) {
		writeFd(
			2,
			`peak-tripwire: no session to record as the arming one — pass --session <id>\n${USAGE}\n`,
		);
		return 2;
	}
	try {
		const t = armTripwire({ session, now, file });
		writeFd(
			1,
			`peak tripwire armed by ${t.armedBy} at ${t.armedAt}; the journal is read from here on\n`,
		);
		return 0;
	} catch (e) {
		writeFd(
			2,
			`peak-tripwire: the state would not write: ${caught(e).message}\n`,
		);
		return 1;
	}
}

module.exports = { main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
