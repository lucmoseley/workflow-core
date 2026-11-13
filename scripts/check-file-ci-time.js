#!/usr/bin/env node
/*
 * check-file-ci-time.js — which test files' CI time is over the per-file
 * limit, judged on each file's median over the last three sweeps (#4292)?
 *
 * Usage:
 *   node check-file-ci-time.js [--reports <dir>] [--json]
 *
 * Reads each sweep's vitest reports (`scripts/lib/sweep-reports.js`, where
 * `--reports <dir>` names sweeps already downloaded). The judging, and which
 * sweeps and files it takes, is `scripts/lib/file-ci-time.js`; the limit is
 * FILE_LIMIT_MS in `scripts/lib/suite-ceiling.js`.
 *
 * FEWER THAN THREE SWEEPS READABLE IS A SKIP THAT SAYS IT JUDGED NOTHING,
 * never an OK.
 *
 * WARN-ONLY until #4293 (fail the sweep while any file is over) lands.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js) and in the scheduled sweep (scheduled-checks.yml), names each test file whose median CI time over its last three sweeps is over the limit scripts/lib/suite-ceiling.js sets, downloading those sweeps' vitest reports. It refuses nothing.
 * JUSTIFIED: fail-safe — a file over the limit holds the whole suite over its 180 s target (#2729) and is otherwise counted only by hand.
 * DEFEAT:    convenience — --reports judges sweeps already downloaded, with no gh call.
 */

const { runCheck } = require("./lib/check.js");
const { SWEEPS_JUDGED, judge } = require("./lib/file-ci-time.js");
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
		if (!verdict.judged)
			ctx.skip(
				`judged nothing: ${verdict.runs.length} sweep(s) with vitest reports readable${verdict.runs.length > 0 ? ` (${verdict.runs.join(", ")})` : ""}, ${SWEEPS_JUDGED} needed for a median.`,
			);
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
			ctx.warn(
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
			"  Cut each by measured cost (#4290). The limit gates nothing until it is switched on (#4293).",
		);
		return {
			noun: `file(s) over ${LIMIT}`,
			count: over.length + slowUnjudged.length,
			data: { over, unjudged },
		};
	},
});
