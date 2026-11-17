#!/usr/bin/env node
/*
 * check-peak-tripwire.js — say so on `npm run status` when the peak tripwire
 * (lib/peak-tripwire.js, #5367) holds part-suites on the ladder: tripped by an
 * earlyoom kill, or blind on a journal or state file that would not read.
 *
 * WARNS on either, naming the re-arm route; OK while armed and seeing. Reads
 * the persisted state alone, never the journal.
 */

const { runCheck } = require("./lib/check");
const {
	describeTrip,
	readTripwire,
	rearmCommands,
} = require("./lib/peak-tripwire.js");

runCheck({
	name: "peak-tripwire",
	usage: "node check-peak-tripwire.js [--json]",
	run(ctx) {
		const { tripwire: t, corrupt } = readTripwire();
		const { status, arm } = rearmCommands();
		const route = `read the kill with \`${status}\`, then \`${arm}\``;
		/** @type {{tag: string, line: string}[]} */
		const warnings = [];
		if (t.state === "tripped")
			warnings.push({
				tag: "TRIPPED",
				line: `the peak tripwire is tripped since ${t.trippedAt}: part-suites are judged on the ladder (${describeTrip(t)}); ${route}.`,
			});
		const blind = corrupt ?? t.unread?.why ?? null;
		if (blind !== null)
			warnings.push({
				tag: "JOURNAL-BLIND",
				line: `the peak tripwire is blind, so part-suites are judged on the ladder: ${blind}; \`${status}\` shows the last check${corrupt === null ? "" : `, and \`${arm}\` rewrites the state file`}.`,
			});
		if (warnings.length === 0) {
			const okLine = "peak tripwire armed";
			return { okLine, data: { okLine } };
		}
		for (const w of warnings) {
			ctx.warn(w.tag, w.line);
			ctx.say(w.line);
		}
		return { noun: "peak tripwire finding(s)", data: { warnings } };
	},
});
