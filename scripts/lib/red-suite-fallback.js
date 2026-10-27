/*
 * red-suite-fallback.js — the second route a red suite reaches the tracker
 * by, where the daily filer did not (workflow-core#2480).
 *
 * scripts/report-red-suite.js runs only inside the daily repo-checks
 * reading, so a filer that breaks there leaves a red suite unticketed until
 * someone reads `npm run status`.
 * check-ci-status.js already knows at session start that the suite is red
 * and that no open issue covers it, so where the day's reading shows the
 * filer did not file, it launches the filer itself, detached, through this.
 *
 * THE FILER'S READING COUNTS AS FILED only where its `red-suite` job is OK
 * and the reading is under READING_STALE_MS old.
 *
 * ONE LAUNCH AN HOUR (LAUNCH_COOLDOWN_MS), stamped in `.red-suite-fallback`
 * in the git common directory. The launch's stdout and stderr land in
 * `.red-suite-fallback.log` beside it, under a first line naming the tree it
 * ran from, and the log's last line is shown while the cooldown holds.
 *
 * IT LAUNCHES FROM THE TREE THE CALLER LOADED FROM, which a half-edited
 * shared checkout can break. check-ci-status.js
 * requires report-red-suite.js at load, so a launch only follows a load of
 * the filer's whole require tree from that same tree moments before.
 *
 * Core only: the registry gates `red-suite` on the core host, so an adopter
 * keeps no such reading and has no filer to launch.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { caught } = require("./caught.js");
const { isCoreHost } = require("./plugin-state");
const { gitCommonDirOrThrow } = require("./git.js");
const { resultFile } = require("./repo-checks-reading");
const { coreRoot } = require("./script-path");

const JOB = "red-suite";
const FILER = "report-red-suite.js";
const STAMP = ".red-suite-fallback";
const LOG = ".red-suite-fallback.log";
/* One missed daily reading and a half, so a reading that ran late is not
 * yet stale. A guess. */
const READING_STALE_MS = 36 * 3_600_000;
/* A guess: long enough that a failing filer is not relaunched at every
 * session start, short of letting a fixed one wait a sweep. */
const LAUNCH_COOLDOWN_MS = 3_600_000;

/**
 * Why the day's reading does not show the filer filed, or null where it does.
 *
 * @param {string} dir the git common directory
 * @param {number} nowMs
 * @returns {string | null}
 */
function unfiledBecause(dir, nowMs) {
	/** @type {{ collectedAt?: string, jobs?: { job?: string, outcome?: string, summary?: string }[] }} */
	let reading;
	try {
		reading = JSON.parse(fs.readFileSync(resultFile(dir), "utf8"));
	} catch (e) {
		return caught(e).code === "ENOENT"
			? "no daily repo-checks reading exists"
			: "the daily repo-checks reading will not read";
	}
	if (!reading || typeof reading !== "object" || !Array.isArray(reading.jobs))
		return "the daily repo-checks reading carries no jobs list";
	const at = Date.parse(reading.collectedAt ?? "");
	if (!Number.isFinite(at) || nowMs - at > READING_STALE_MS)
		return `the daily repo-checks reading is stale (collected ${reading.collectedAt ?? "at no recorded time"})`;
	const job = reading.jobs.find((j) => j?.job === JOB);
	if (!job)
		return `the daily reading of ${reading.collectedAt} has no ${JOB} job`;
	if (job.outcome === "OK") return null;
	return `the daily reading of ${reading.collectedAt} recorded ${job.summary ?? job.outcome}`;
}

/** @param {string} file */
function readLastLine(file) {
	try {
		return (
			fs.readFileSync(file, "utf8").trim().split("\n").pop() ||
			"(it printed nothing)"
		);
	} catch {
		return "(its log will not read)";
	}
}

/**
 * Launch the filer detached, unless a launch is inside the cooldown.
 *
 * @param {string} root the host checkout
 * @param {string} dir the git common directory
 * @param {number} nowMs
 * @returns {string} what was done, as a clause
 */
function launchFiler(root, dir, nowMs) {
	const stamp = path.join(dir, STAMP);
	const log = path.join(dir, LOG);
	let last = Number.NaN;
	try {
		last = Date.parse(fs.readFileSync(stamp, "utf8").trim());
	} catch (e) {
		if (caught(e).code !== "ENOENT")
			return `the fallback's launch stamp ${stamp} will not read: ${caught(e).message}`;
	}
	if (Number.isFinite(last) && nowMs - last < LAUNCH_COOLDOWN_MS)
		return `the filer launched from here at ${new Date(last).toISOString()} left no open issue; its last line: ${readLastLine(log)} (${log})`;
	const filer = path.join(coreRoot(), "scripts", FILER);
	let fd;
	try {
		fs.writeFileSync(log, `launched ${filer} from ${root}\n`);
		fd = fs.openSync(log, "a");
		const child = spawn(process.execPath, [filer], {
			cwd: root,
			detached: true,
			stdio: ["ignore", fd, fd],
		});
		/* An async spawn fault would otherwise throw in the caller. */
		child.on("error", (e) =>
			fs.appendFileSync(log, `could not launch: ${caught(e).message}\n`),
		);
		child.unref();
		fs.writeFileSync(stamp, `${new Date(nowMs).toISOString()}\n`);
	} catch (e) {
		return `the filer could not be launched from here: ${caught(e).message}`;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	return `filing from here now, in the background; its output lands in ${log}`;
}

/**
 * Where no open issue covers a red suite job: launch the filer where the
 * daily reading shows it did not file, and say what was done. Null where the
 * daily filer is the route — it filed, or this is no core host.
 *
 * @param {string} root the host checkout
 * @param {number} nowMs
 * @returns {string | null}
 */
function fileWhereUnfiled(root, nowMs) {
	if (!isCoreHost(root)) return null;
	/** @type {string} */
	let dir;
	try {
		dir = gitCommonDirOrThrow(root);
	} catch (e) {
		return `the daily repo-checks reading could not be found, as ${root}'s git directory will not resolve: ${caught(e).message} (workflow-core#2480)`;
	}
	const why = unfiledBecause(dir, nowMs);
	if (why === null) return null;
	return `${why} — ${launchFiler(root, dir, nowMs)} (workflow-core#2480)`;
}

module.exports = { fileWhereUnfiled };
