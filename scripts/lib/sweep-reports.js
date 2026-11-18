/*
 * sweep-reports.js — the latest scheduled sweeps' per-file vitest times, read
 * off each run's `vitest-report-*` artefacts (scheduled-checks.yml, kept 14
 * days) or from runs already downloaded. Which sweeps are read is
 * `collect`'s, in `scripts/lib/file-ci-time.js`.
 *
 * Its own module so `check-file-ci-time.js` and `check-suite-budget.js` judge
 * one download path (#5137).
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
	return collect(localRuns(dir), (run) => sweepAt(run, path.join(dir, run)));
}

/**
 * The run ids under a directory of downloaded runs, newest first.
 * @param {string} dir
 * @returns {string[]}
 */
function localRuns(dir) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}

/**
 * Run `run`'s vitest reports into `dir`: true, or false where it holds none.
 * A gh failure skips through `skip`.
 * @param {string} run
 * @param {string} dir
 * @param {(why: string) => never} skip
 * @returns {boolean}
 */
function downloadRun(run, dir, skip) {
	try {
		return downloadReports(run, dir);
	} catch (e) {
		const err = caught(e);
		return skip(
			`GitHub unreachable downloading run ${run}'s vitest reports: ${(String(err.stderr ?? "") || err.message).trim()}`,
		);
	}
}

/**
 * The sweep runs on the verified branch, newest first: the latest
 * RUNS_LISTED, ids as strings, each with whether it has finished.
 * @param {(why: string) => never} skip
 * @returns {{ id: string, completed: boolean }[]}
 */
function listSweepRuns(skip) {
	/* Listed by branch at the source: the lander's pushes run the same
	 * workflow, and enough of them push every sweep out of a mixed window
	 * (#4559); a manual run on a feature branch tests a tree `main` never
	 * held. */
	/** @type {{ databaseId: number, status: string }[]} */
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
			"databaseId,status",
		]);
	} catch (e) {
		skip(
			`GitHub unreachable listing ${SUITE_WORKFLOW} runs on ${VERIFIED_BRANCH}: ${String(e)}`,
		);
	}
	return listed
		.sort((a, b) => b.databaseId - a.databaseId)
		.map((r) => ({
			id: String(r.databaseId),
			completed: r.status === "completed",
		}));
}

/**
 * @param {(why: string) => never} skip
 */
function remoteSweeps(skip) {
	const runs = listSweepRuns(skip).map((r) => r.id);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-reports-"));
	try {
		return collect(runs, (run) => {
			const dir = path.join(work, run);
			if (!downloadRun(run, dir, skip)) return null;
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

module.exports = { downloadRun, listSweepRuns, localRuns, readSweeps };
