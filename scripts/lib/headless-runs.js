/*
 * headless-runs.js — the store of headless overflow runs lib/headless-sessions.js
 * launches (workflow-core#2607, spec workflow-core#2570): each run's record, whether it is live, how it
 * ended, and its stop. Apart from the launcher, so lib/agent-liveness.js and
 * the stop library read live runs without reaching the launch's auth and key
 * modules, which reach the liveness oracle themselves.
 *
 * THE STORE is beside the refill loop's files (lib/refill-dir.js): one
 * directory per run, named by its 8-hex job id, holding `run.json`, the
 * stream-json log, stderr and the job dir.
 *
 * LIVE is the recorded pid still running with its recorded start time on this
 * boot (lib/arbiter-proc.js), which rules out a reused pid. A run can emit a
 * `result` per turn while a background task keeps it alive (workflow-core#2604 (a)), so a
 * `result` never says the run ended; the last one gives its outcome and cost.
 *
 * STOP is SIGTERM to the run's process group, then SIGKILL to what outlives
 * the grace period. Synchronous, as `claude stop` is, so lib/claude-stop.js
 * routes a headless job here (workflow-core#4580).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readCurrentBootId, holderAlive } = require("./arbiter-proc.js");
const { caught } = require("./caught.js");
const { endGroup, isGroupAlive } = require("./grouped-child.js");
const { readJsonl } = require("./jsonl.js");
const { refillPath } = require("./refill-dir.js");

/* Untraced: long enough for a session to finish its current write. */
const STOP_GRACE_MS = 10_000;
/* 4 bytes print as the 8 hex characters dispatch-sessions.sh's job-id parse
 * takes from a launch's first line. */
const JOB_ID_BYTES = 4;
const JOB_ID = /^[0-9a-f]{8}$/;
/* Anthropic's refusal once an organisation's credits are spent (workflow-core#2551). */
const CREDIT_REFUSAL = /credit balance is too low|billing_error/i;

/**
 * @typedef {object} RunRecord
 * @property {string} jobId
 * @property {string} sessionId
 * @property {number} pid
 * @property {string|null} procStart /proc/<pid>/stat's start time
 * @property {string|null} bootId
 * @property {number} pgid
 * @property {string} seat config dir
 * @property {string} keyVar the overflow seat's identity
 * @property {string} cwd
 * @property {string} prompt the turn the run was launched with
 * @property {string} log stream-json output
 * @property {string} stderr
 * @property {number} launchedAt ms
 * @property {true} [founderReply] a founder's reply, which the allowance stop
 *   leaves to its own `--max-budget-usd` (workflow-core#4174)
 *
 * @typedef {{id: string, sessionId: string, pid: number, cwd: string,
 *   startedAt: number, state: "working", kind: "headless", seat: string,
 *   founderReply?: true}} HeadlessAgent
 *   shaped as lib/agent-liveness.js's AgentRecord
 *
 * @typedef {object} EndResult
 * @property {"running"|"success"|"error"|"key-exhausted"|"killed"} outcome
 * @property {number|null} costUsd the last `result`'s cumulative cost
 * @property {string} sessionId
 */

const storeDir = () => refillPath(".headless-runs");

/**
 * A fresh run directory under the store, named by a new job id.
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
 * Every run in the store; none where the store is absent. A run directory
 * whose record is not yet written, mid-launch, is skipped.
 * @returns {RunRecord[]}
 * @throws where the store or a record cannot be read
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
 * The live runs, each as a liveness record.
 * @returns {HeadlessAgent[]}
 * @throws where the store cannot be read
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
 * The job's record; null for a job the store has none for.
 * @param {string} jobId
 * @returns {RunRecord|null}
 * @throws where the record cannot be read
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
 * SIGTERM to the run's process group, then SIGKILL to what is left after the
 * grace period.
 * @param {string} jobId
 * @param {{graceMs?: number}} [opts]
 * @returns {"unknown"|"not running"|"stopped"|"killed"}
 */
function stop(jobId, { graceMs = STOP_GRACE_MS } = {}) {
	const run = readRun(jobId);
	if (!run) return "unknown";
	/* A background task can outlive its leader in the group (workflow-core#2604 (a)). A
	 * pgid with members left is never reused, so signalling it is safe. */
	const groupLeft =
		run.bootId === readCurrentBootId() && isGroupAlive(run.pgid);
	if (!isLive(run) && !groupLeft) return "not running";
	const { killed, unkilled } = endGroup(run.pgid, graceMs);
	if (unkilled) throw new Error(`group ${run.pgid} still runs: ${unkilled}`);
	return killed ? "killed" : "stopped";
}

/**
 * How a run ended, or that it is still running.
 * @param {RunRecord} run
 * @returns {EndResult}
 */
function readEndResult(run) {
	const results = (readJsonl(run.log)?.rows ?? []).filter(
		(e) => e.type === "result",
	);
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
	let stderr = "";
	try {
		stderr = fs.readFileSync(run.stderr, "utf8");
	} catch {
		/* no stderr is no refusal in it (workflow-core#2607) */
	}
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
 * Run `jobId` in the shape of a `--bg` job's state.json, which the refill
 * loop's job readers take: `working` while it runs, `done` once it ended in
 * success, else `failed` naming how it ended; null where none is stored.
 * @param {string} jobId
 * @returns {{state: string, sessionId: string, cwd: string,
 *   detail?: string}|null}
 * @throws where the record or its log cannot be read
 */
function readRunAsJob(jobId) {
	const run = readRun(jobId);
	if (!run) return null;
	let outcome;
	try {
		({ outcome } = readEndResult(run));
	} catch (e) {
		throw new Error(`its log ${run.log}: ${caught(e).message}`, { cause: e });
	}
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
 * The latest run of session `sessionId` launched at or after `since`, else
 * null: the job a resume started, found after the resume was killed before
 * it said (workflow-core#4580).
 * @param {string} sessionId
 * @param {number} since ms
 * @returns {{jobId: string, sessionId: string}|null}
 * @throws where the store or a record cannot be read
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
