const { spawnOutliving } = require("./user-scope.js");
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
// guess, workflow-core#2480
const READING_STALE_MS = 36 * 3_600_000;
// guess, workflow-core#2480
const LAUNCH_COOLDOWN_MS = 3_600_000;

/**
 * @param {string} dir
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
 * @param {string} root
 * @param {string} dir
 * @param {number} nowMs
 * @returns {string}
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
		const child = spawnOutliving(process.execPath, [filer], {
			cwd: root,
			stdio: ["ignore", fd, fd],
		});
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
 * @param {string} root
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
