const fs = require("node:fs");
const path = require("node:path");
const { configDir } = require("./config-dir.js");
const { caught, ignoreFailure } = require("./caught.js");

const RUN_FILE = "wfc-detached-run.json";

/** @type {"prune-markers"} */
const JOB_PRUNE_MARKERS = "prune-markers";
/** @type {"retire-stale-containers"} */
const JOB_RETIRE_STALE_CONTAINERS = "retire-stale-containers";

/**
 * @type {readonly [typeof JOB_PRUNE_MARKERS, typeof JOB_RETIRE_STALE_CONTAINERS]}
 */
const JOBS = [JOB_PRUNE_MARKERS, JOB_RETIRE_STALE_CONTAINERS];

const runPath = () => path.join(configDir(), RUN_FILE);

/**
 * @typedef {{
 *   job: string,
 *   startedAt: string,
 *   openedSince: string,
 *   deaths: number,
 *   finishedAt?: string,
 *   lastFinishedAt?: string,
 *   ok?: boolean,
 *   error?: string,
 *   counts?: Record<string, number>,
 * }} RunRecord
 */

// guess, lucmoseley/mantahostels#1920
const INFLIGHT_MS = 300_000;

// guess, lucmoseley/mantahostels#1999
const DEATHS_TO_REPORT = 3;

/** @returns {Record<string, RunRecord>} */
function readRuns() {
	try {
		const r = JSON.parse(fs.readFileSync(runPath(), "utf8"));
		return r && typeof r === "object" && !Array.isArray(r) ? r : {};
	} catch {
		return {};
	}
}

/** @param {RunRecord} record */
function writeRuns(record) {
	ignoreFailure(() => {
		const all = readRuns();
		all[record.job] = record;
		fs.writeFileSync(runPath(), `${JSON.stringify(all, null, "\t")}\n`);
	});
}

/**
 * @param {{deaths?: unknown, openedSince?: string, finishedAt?: string} | undefined} prior
 * @param {number} graceMs
 * @param {number} now
 * @returns {{deaths: number, openedSince: string}}
 */
function deathCount(prior, graceMs, now) {
	let deaths = Number.isFinite(prior?.deaths) ? Number(prior?.deaths) : 0;
	let openedSince = new Date(now).toISOString();
	if (prior?.finishedAt) {
		deaths = 0;
	} else if (prior?.openedSince) {
		const sinceMs = Date.parse(prior.openedSince);
		if (Number.isFinite(sinceMs)) {
			openedSince = prior.openedSince;
			if (now - sinceMs > graceMs) {
				deaths += 1;
				openedSince = new Date(now).toISOString();
			}
		}
	}
	return { deaths, openedSince };
}

/**
 * @param {string} job
 * @param {number} [now]
 * @returns {RunRecord}
 */
function openRun(job, now = Date.now()) {
	const prior = readRuns()[job];
	const priorFinish = prior?.finishedAt || prior?.lastFinishedAt;
	const { deaths, openedSince } = deathCount(prior, INFLIGHT_MS, now);

	/** @type {RunRecord} */
	const record = {
		job,
		startedAt: new Date(now).toISOString(),
		openedSince,
		deaths,
	};
	if (priorFinish) record.lastFinishedAt = priorFinish;
	writeRuns(record);
	return record;
}

/**
 * @param {RunRecord} record
 * @param {{ ok: boolean, error?: string, counts?: Record<string, number> }} outcome
 */
function closeRun(record, outcome) {
	/** @type {RunRecord} */
	const closed = {
		...record,
		finishedAt: new Date().toISOString(),
		ok: outcome.ok,
	};
	if (outcome.error) closed.error = outcome.error;
	if (outcome.counts) closed.counts = outcome.counts;
	writeRuns(closed);
}

/**
 * @template T
 * @param {string} job
 * @param {() => T} fn
 * @returns {T}
 */
function recordRun(job, fn) {
	const record = openRun(job);
	try {
		const out = fn();
		closeRun(record, { ok: true });
		return out;
	} catch (e) {
		closeRun(record, { ok: false, error: caught(e).message });
		throw e;
	}
}

module.exports = {
	DEATHS_TO_REPORT,
	JOBS,
	JOB_PRUNE_MARKERS,
	JOB_RETIRE_STALE_CONTAINERS,
	RUN_FILE,
	closeRun,
	deathCount,
	openRun,
	recordRun,
};
