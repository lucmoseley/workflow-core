const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId, holderAlive } = require("./arbiter-proc.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { endGroup, isGroupAlive } = require("./grouped-child.js");
const { readJsonl } = require("./jsonl.js");
const { refillPath } = require("./refill-dir.js");

// guess, workflow-core#2607
const STOP_GRACE_MS = 10_000;
const JOB_ID_BYTES = 4;
const JOB_ID = /^[0-9a-f]{8}$/;
const CREDIT_REFUSAL = /credit balance is too low|billing_error/i;

/**
 * @typedef {object} RunRecord
 * @property {string} jobId
 * @property {string} sessionId
 * @property {number} pid
 * @property {string|null} procStart
 * @property {string|null} bootId
 * @property {number} pgid
 * @property {string} seat
 * @property {string} keyVar
 * @property {string} cwd
 * @property {string} prompt
 * @property {string} log
 * @property {string} stderr
 * @property {number} launchedAt
 * @property {true} [founderReply]
 * @typedef {{id: string, sessionId: string, pid: number, cwd: string,
 *   startedAt: number, state: "working", kind: "headless", seat: string,
 *   founderReply?: true}} HeadlessAgent
 * @typedef {object} EndResult
 * @property {"running"|"success"|"error"|"key-exhausted"|"killed"} outcome
 * @property {number|null} costUsd
 * @property {string} sessionId
 */

const storeDir = () => refillPath(".headless-runs");

/**
 * @returns {{jobId: string, dir: string}}
 */
function freshRunDir() {
	fs.mkdirSync(storeDir(), { recursive: true });
	for (;;) {
		const jobId = crypto.randomBytes(JOB_ID_BYTES).toString("hex");
		const dir = path.join(storeDir(), jobId);
		try {
			fs.mkdirSync(dir);
			return { jobId, dir };
		} catch (err) {
			if (caught(err).code !== "EEXIST") throw err;
		}
	}
}

/**
 * @returns {RunRecord[]}
 */
function readStoredRuns() {
	let names;
	try {
		names = fs.readdirSync(storeDir());
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		throw err;
	}
	return names.flatMap((name) => readRun(name) ?? []);
}

/** @param {RunRecord} r */
const isLive = (r) =>
	holderAlive({ pid: r.pid, procStart: r.procStart, bootId: r.bootId });

/**
 * @returns {HeadlessAgent[]}
 */
function readLiveAgents() {
	return readStoredRuns()
		.filter(isLive)
		.map((r) => ({
			id: r.jobId,
			sessionId: r.sessionId,
			pid: r.pid,
			cwd: r.cwd,
			startedAt: r.launchedAt,
			state: "working",
			kind: "headless",
			seat: r.seat,
			...(r.founderReply ? { founderReply: true } : {}),
		}));
}

/**
 * @param {string} jobId
 * @returns {RunRecord|null}
 */
function readRun(jobId) {
	if (!JOB_ID.test(jobId)) return null;
	try {
		return JSON.parse(
			fs.readFileSync(path.join(storeDir(), jobId, "run.json"), "utf8"),
		);
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
}

/**
 * @param {string} jobId
 * @param {{graceMs?: number}} [opts]
 * @returns {"unknown"|"not running"|"stopped"|"killed"}
 */
function stop(jobId, { graceMs = STOP_GRACE_MS } = {}) {
	const run = readRun(jobId);
	if (!run) return "unknown";
	const groupLeft =
		run.bootId === readCurrentBootId() && isGroupAlive(run.pgid);
	if (!isLive(run) && !groupLeft) return "not running";
	const { killed, unkilled } = endGroup(run.pgid, graceMs);
	if (unkilled) throw new Error(`group ${run.pgid} still runs: ${unkilled}`);
	return killed ? "killed" : "stopped";
}

/**
 * @param {RunRecord} run
 * @returns {EndResult}
 */
function readEndResult(run) {
	let rows;
	try {
		rows = readJsonl(run.log)?.rows ?? [];
	} catch (e) {
		throw new Error(`its log ${run.log}: ${caught(e).message}`, { cause: e });
	}
	const results = rows.filter((e) => e.type === "result");
	const last = results.reduce(
		(a, e) =>
			a === null || Number(e.result_index ?? 0) >= Number(a.result_index ?? 0)
				? e
				: a,
		/** @type {Record<string, unknown>|null} */ (null),
	);
	const costUsd =
		typeof last?.total_cost_usd === "number" ? last.total_cost_usd : null;
	const base = { costUsd, sessionId: run.sessionId };
	if (isLive(run)) return { outcome: "running", ...base };
	const err = readText(run.stderr);
	if (err.state === "unreadable")
		throw new Error(`its stderr ${run.stderr}: ${err.message}`, {
			cause: err.error,
		});
	const stderr = err.state === "read" ? err.data : "";
	const failed = last?.is_error
		? `${last.result ?? ""} ${last.error ?? ""}`
		: "";
	if (CREDIT_REFUSAL.test(`${failed} ${stderr}`))
		return { outcome: "key-exhausted", ...base };
	if (!last) return { outcome: "killed", ...base };
	return { outcome: last.is_error ? "error" : "success", ...base };
}

const JOB_STATE_OF = /** @type {const} */ ({
	running: "working",
	success: "done",
});

/**
 * @param {string} jobId
 * @returns {{state: string, sessionId: string, cwd: string,
 *   detail?: string}|null}
 */
function readRunAsJob(jobId) {
	const run = readRun(jobId);
	if (!run) return null;
	const { outcome } = readEndResult(run);
	const base = { sessionId: run.sessionId, cwd: run.cwd };
	if (outcome === "running" || outcome === "success")
		return { state: JOB_STATE_OF[outcome], ...base };
	return {
		state: "failed",
		detail: `its headless run ended ${outcome}`,
		...base,
	};
}

/**
 * @param {string} sessionId
 * @param {number} since
 * @returns {{jobId: string, sessionId: string}|null}
 */
function findRunSince(sessionId, since) {
	const found = readStoredRuns()
		.filter((r) => r.sessionId === sessionId && r.launchedAt >= since)
		.sort((a, b) => a.launchedAt - b.launchedAt)
		.at(-1);
	return found ? { jobId: found.jobId, sessionId: found.sessionId } : null;
}

module.exports = {
	CREDIT_REFUSAL,
	readEndResult,
	findRunSince,
	freshRunDir,
	readLiveAgents,
	readRunAsJob,
	readStoredRuns,
	readRun,
	stop,
};
