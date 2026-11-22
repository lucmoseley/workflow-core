#!/usr/bin/env node
const { runCheck } = require("./lib/check.js");
const {
	SWEEPS_JUDGED,
	judge,
	judgedNothing,
} = require("./lib/file-ci-time.js");
const { FILE_LIMIT_MS } = require("./lib/suite-ceiling.js");
const { readSweeps } = require("./lib/sweep-reports.js");

/** @param {number} s */
const secs = (s) => `${Math.round(s)} s`;

const LIMIT = secs(FILE_LIMIT_MS / 1000);

/** @param {import("./lib/file-ci-time.js").Reading[]} readings */
const timesText = (readings) =>
	readings.map((r) => `${secs(r.seconds)} (run ${r.run})`).join(", ");

runCheck({
	name: "file-ci-time",
	usage: "node check-file-ci-time.js [--reports <dir>] [--json]",
	valueFlags: ["--reports"],
	run(/** @type {import("./lib/check.js").Ctx} */ ctx) {
		const verdict = judge(readSweeps(ctx));
		if (!verdict.judged) ctx.skip(judgedNothing(verdict.runs));
		const { over, unjudged, runs } = verdict;
		const window = `latest ${runs.slice(0, SWEEPS_JUDGED).join(", ")}`;
		const slowUnjudged = unjudged.filter((u) => u.overInASweep);
		if (over.length === 0 && slowUnjudged.length === 0) {
			const short =
				unjudged.length > 0
					? ` ${unjudged.length} file(s) timed in fewer than ${SWEEPS_JUDGED} of the ${runs.length} sweeps read are unjudged, none over ${LIMIT} in any.`
					: "";
			return {
				okLine: `no test file's median CI time over its last ${SWEEPS_JUDGED} sweeps (${window}) is over ${LIMIT}.${short}`,
			};
		}
		if (over.length > 0)
			ctx.say(
				`FILE-CI-TIME — ${over.length} test file(s) whose median CI time over their last ${SWEEPS_JUDGED} sweeps (${window}) is over ${LIMIT}, slowest first:`,
			);
		for (const f of over) {
			ctx.fail(
				"FILE-CI-TIME-OVER",
				`${f.file}: median ${secs(f.medianSeconds)}, over ${LIMIT}.`,
				f,
				`FILE-CI-TIME-OVER\t${f.file}`,
			);
			ctx.say(
				`  ${secs(f.medianSeconds)}  ${f.file} — ${timesText(f.readings)}`,
			);
		}
		if (unjudged.length > 0)
			ctx.say(
				`${unjudged.length} file(s) timed in fewer than ${SWEEPS_JUDGED} of the ${runs.length} sweeps read, unjudged${slowUnjudged.length > 0 ? `; over ${LIMIT} in a sweep:` : "."}`,
			);
		for (const u of slowUnjudged) {
			ctx.warn(
				"FILE-CI-TIME-UNJUDGED",
				`${u.file}: over ${LIMIT} in a sweep, timed in fewer than ${SWEEPS_JUDGED}.`,
				u,
				`FILE-CI-TIME-UNJUDGED\t${u.file}`,
			);
			ctx.say(`  ${u.file} — ${timesText(u.readings)}`);
		}
		ctx.say(
			"  Cut each by measured cost (#4290), profiled first. The scheduled sweep stays red while any median is over.",
		);
		return {
			noun: `file(s) over ${LIMIT}`,
			data: { over, unjudged },
		};
	},
});
