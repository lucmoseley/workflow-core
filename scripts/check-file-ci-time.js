#!/usr/bin/env node
/*
 * check-file-ci-time.js — which test files' CI time is over the per-file
 * limit, judged on each file's median over the last three sweeps (#4292)?
 *
 * Usage:
 *   node check-file-ci-time.js [--reports <dir>] [--json]
 *
 * Reads each sweep's `vitest-report-*` artefacts (ci.yml, kept 14 days). The
 * judging, and which sweeps and files it takes, is `scripts/lib/file-ci-time.js`;
 * the limit is FILE_LIMIT_MS in `scripts/lib/suite-ceiling.js`.
 *
 * `--reports <dir>` judges sweeps already downloaded, one subdirectory per run
 * named by its run id, as `gh run download <id> -p 'vitest-report-*' -D <dir>/<id>`
 * leaves them.
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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { runCheck } = require("./lib/check.js");
const { SUITE_WORKFLOW } = require("./lib/actions-tester.js");
const { SWEEPS_JUDGED, collect, judge } = require("./lib/file-ci-time.js");
const { gh, ghJson } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { FILE_LIMIT_MS } = require("./lib/suite-ceiling.js");
const { readReports } = require("./lib/vitest-reports.js");

/* Untraced: a week of sweeps at four a day, past the eight `collect` reads,
 * for runs with no reports in between. */
const RUNS_LISTED = 30;
/* What `gh run download` prints for a run whose reports are gone or never
 * uploaded (#4292). */
const NO_ARTEFACTS = /no valid artifacts found/i;

/* A manual run on a feature branch tests a tree `main` never held. */
const SWEEP_BRANCHES = new Set(["main", "landing"]);

const ROOT = hostRoot();

/**
 * @param {string} run
 * @param {string} dir
 * @returns {import("./lib/file-ci-time.js").Sweep|null}
 */
function sweepAt(run, dir) {
	if (!fs.existsSync(dir)) return null;
	const rows = readReports(dir, ROOT);
	return rows.length > 0 ? { run, rows } : null;
}

/**
 * Sweeps under a directory of runs, the highest run id newest.
 * @param {string} dir
 */
function localSweeps(dir) {
	const runs = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
	return collect(runs, (run) => sweepAt(run, path.join(dir, run)));
}

/**
 * Sweeps from GitHub, each run's reports downloaded to a temp directory and
 * removed once read.
 * @param {import("./lib/check.js").Ctx} ctx
 */
function remoteSweeps(ctx) {
	/** @type {{ databaseId: number, headBranch: string }[]} */
	let listed;
	try {
		listed = ghJson([
			"run",
			"list",
			"--workflow",
			SUITE_WORKFLOW,
			"--limit",
			String(RUNS_LISTED),
			"--json",
			"databaseId,headBranch",
		]);
	} catch (e) {
		ctx.skip(`GitHub unreachable listing ${SUITE_WORKFLOW} runs: ${String(e)}`);
	}
	const runs = listed
		.filter((r) => SWEEP_BRANCHES.has(r.headBranch))
		.map((r) => r.databaseId)
		.sort((a, b) => b - a)
		.map(String);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "file-ci-time-"));
	try {
		return collect(runs, (run) => {
			const dir = path.join(work, run);
			try {
				gh(["run", "download", run, "-p", "vitest-report-*", "-D", dir]);
			} catch (e) {
				const err = caught(e);
				const stderr = String(err.stderr ?? "");
				if (NO_ARTEFACTS.test(stderr)) return null;
				ctx.skip(
					`GitHub unreachable downloading run ${run}'s vitest reports: ${(stderr || err.message).trim()}`,
				);
			}
			const sweep = sweepAt(run, dir);
			fs.rmSync(dir, { recursive: true, force: true });
			return sweep;
		});
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

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
		const reports = ctx.value("--reports", "");
		const { sweeps, passedOver } = reports
			? localSweeps(reports)
			: remoteSweeps(ctx);
		if (passedOver.length > 0)
			ctx.say(
				`Passed over ${passedOver.length} run(s) with no vitest reports: ${passedOver.join(", ")}.`,
			);
		const verdict = judge(sweeps);
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
