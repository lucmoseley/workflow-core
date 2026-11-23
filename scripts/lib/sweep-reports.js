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

// guess: a week of sweeps at four a day, #5137
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

/** @param {string} dir */
function localSweeps(dir) {
	return collect(localRuns(dir), (run) => sweepAt(run, path.join(dir, run)));
}

/**
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
 * @param {(why: string) => never} skip
 * @returns {{ id: string, completed: boolean }[]}
 */
function listSweepRuns(skip) {
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

/** @param {import("./check.js").Ctx} ctx */
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
