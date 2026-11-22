#!/usr/bin/env node

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
		if (corrupt !== null)
			warnings.push({
				tag: "STATE-UNREAD",
				line: `the peak tripwire's state will not read, so part-suites are judged on the ladder: ${corrupt}; \`${arm}\` rewrites the state file.`,
			});
		else if (t.unread !== null)
			warnings.push({
				tag: "JOURNAL-BLIND",
				line: `the peak tripwire is blind, so part-suites are judged on the ladder: ${t.unread.why}; \`${status}\` shows the last check.`,
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
