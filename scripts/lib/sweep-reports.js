/*
 * sweep-reports.js — the latest scheduled sweeps' per-file vitest times, read
 * off each run's `vitest-report-*` artefacts (scheduled-checks.yml, kept 14
 * days) or from runs already downloaded. Which sweeps are read is
 * `collect`'s, in `scripts/lib/file-ci-time.js`.
 *
 * Its own module so `check-file-ci-time.js` and `check-suite-budget.js` judge
 * one download path (#5137), split from the first.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const { collect } = require("./file-ci-time.js");
const { ghJson } = require("./gh.js");
const { hostRoot } = require("./host-root.js");
const { VERIFIED_BRANCH } = require("./landing-refs.js");
const {
	SUITE_WORKFLOW,
	downloadReports,
	readReports,
} = require("./suite-timings.js");

/* Untraced: a week of sweeps at four a day, past the eight `collect` reads,
 * for runs with no reports in between. */
const RUNS_LISTED = 30;

const ROOT = hostRoot();

/**
 * @param {string} run
 * @param {string} dir
 * @returns {import("./file-ci-time.js").Sweep|null}
 */
function sweepAt(run, dir) {
	if (!fs.existsSync(dir)) return null;
	const rows = readReports(dir, ROOT);
	return rows.length > 0 ? { run, rows } : null;
}

/**
 * Sweeps under a directory of runs, one subdirectory per run named by its run
 * id, as `gh run download <id> -p 'vitest-report-*' -D <dir>/<id>` leaves
 * them; the highest run id newest.
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
 * @param {(why: string) => never} skip called where GitHub cannot answer
 */
function remoteSweeps(skip) {
	/* Listed by branch at the source: the lander's pushes run the same
	 * workflow, and enough of them push every sweep out of a mixed window
	 * (#4559); a manual run on a feature branch tests a tree `main` never
	 * held. */
	/** @type {{ databaseId: number }[]} */
	let listed;
	try {
		listed = ghJson([
			"run",
			"list",
			"--workflow",
			SUITE_WORKFLOW,
			"--branch",
			VERIFIED_BRANCH,
			"--limit",
			String(RUNS_LISTED),
			"--json",
			"databaseId",
		]);
	} catch (e) {
		skip(
			`GitHub unreachable listing ${SUITE_WORKFLOW} runs on ${VERIFIED_BRANCH}: ${String(e)}`,
		);
	}
	const runs = listed
		.map((r) => r.databaseId)
		.sort((a, b) => b - a)
		.map(String);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-reports-"));
	try {
		return collect(runs, (run) => {
			const dir = path.join(work, run);
			try {
				if (!downloadReports(run, dir)) return null;
			} catch (e) {
				const err = caught(e);
				skip(
					`GitHub unreachable downloading run ${run}'s vitest reports: ${(String(err.stderr ?? "") || err.message).trim()}`,
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

/**
 * The sweeps a check judges: those under `reports` where it names a
 * directory, else GitHub's; and the runs passed over for holding no reports,
 * said through `ctx`.
 * @param {import("./check.js").Ctx} ctx
 */
function readSweeps(ctx) {
	const reports = ctx.value("--reports", "");
	const { sweeps, passedOver } = reports
		? localSweeps(reports)
		: remoteSweeps((why) => ctx.skip(why));
	if (passedOver.length > 0)
		ctx.say(
			`Passed over ${passedOver.length} run(s) with no vitest reports: ${passedOver.join(", ")}.`,
		);
	return sweeps;
}

module.exports = { readSweeps };
