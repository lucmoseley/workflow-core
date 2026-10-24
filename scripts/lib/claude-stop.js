/*
 * claude-stop.js — the one `claude stop`: every caller that stops a background
 * job goes through stopOn or stopSession (workflow-core#2697). `claude stop` keeps the
 * conversation for a later `claude attach`; a kill would not.
 *
 * `claude stop` and the job record are scoped to CLAUDE_CONFIG_DIR, so a job is
 * addressed on a seat. A caller that knows the seat calls stopOn; one that knows
 * only the job and its session calls stopSession, which finds the seat (workflow-core#1571).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { configDirs } = require("./arbiter-store");
const { caught } = require("./caught.js");
const { claudeBin } = require("./claude-bin.js");

/**
 * @typedef {{ok: true, said: string}
 *   | {ok: false, why: string, said: string|null, timedOut: boolean}} StopOutcome
 *   `said` is what the daemon printed — its stdout on success, the last line of
 *   its stderr on failure; `why` adds the exit code to it. `timedOut` marks a
 *   stop killed at STOP_TIMEOUT_MS.
 */

/** A hang guard, never measured: a stop answers in seconds when well. */
const STOP_TIMEOUT_MS = 15_000;

/**
 * @param {string} seat
 * @param {string} jobId
 */
const jobStatePath = (seat, jobId) =>
	path.join(seat, "jobs", jobId, "state.json");

/**
 * The seats to address a job on, in order: those whose `jobs/<id>` record names
 * this session, then those with no record of it naming anyone — this seat first
 * among them, configDirs() leading with it. A missing record proves nothing, a
 * job dir being cleaned under a session still running (mantahostels#104).
 *
 * A SEAT WHOSE RECORD NAMES ANOTHER SESSION IS LEFT OUT: the id there belongs to
 * a different job, which the caller never judged.
 *
 * Residual: a seat whose record of a colliding id was cleaned while its job
 * runs is still asked, and would stop that job. Two 8-hex ids colliding with
 * one of them live and recordless is the whole exposure.
 *
 * @param {string} jobId
 * @param {string} sessionId
 * @returns {string[]}
 */
function seatsFor(jobId, sessionId) {
	/** @type {string[]} */
	const named = [];
	/** @type {string[]} */
	const unknown = [];
	for (const seat of configDirs()) {
		if (!fs.existsSync(seat)) continue;
		let owner;
		try {
			owner = JSON.parse(
				fs.readFileSync(jobStatePath(seat, jobId), "utf8"),
			)?.sessionId;
		} catch {
			owner = null;
		}
		if (owner === sessionId) named.push(seat);
		else if (typeof owner !== "string" || !owner) unknown.push(seat);
	}
	return [...named, ...unknown];
}

/**
 * Stops a job on the first seat that holds it, seatsFor's order.
 *
 * ONLY "No job matching" MOVES ON TO THE NEXT SEAT — the answer of a seat whose
 * daemon has no such job. Any other failure, a timeout above all, is reported
 * from the seat that gave it: retrying a busy daemon elsewhere buys one STOP_TIMEOUT_MS
 * per seat and no memory. A reworded daemon costs the cross-seat retry, and the stop
 * fails as it did before workflow-core#1571.
 *
 * @param {string} id  the short job id, never the session id
 * @param {string} sessionId
 * @returns {StopOutcome}
 */
function stopSession(id, sessionId) {
	const seats = seatsFor(id, sessionId);
	/** @type {Extract<StopOutcome, {ok: false}>|undefined} */
	let firstRefusal;
	for (const seat of seats) {
		const r = stopOn(seat, id);
		if (r.ok || !/No job matching/.test(r.why)) return r;
		firstRefusal ??= r;
	}
	if (!firstRefusal)
		return {
			ok: false,
			why: `every seat's record of ${id} names another session`,
			said: null,
			timedOut: false,
		};
	return seats.length > 1
		? {
				...firstRefusal,
				why: `${firstRefusal.why} (on all ${seats.length} seats)`,
			}
		: firstRefusal;
}

/**
 * @param {string} seat  a CLAUDE_CONFIG_DIR
 * @param {string} id  the short job id, never the session id
 * @param {string} [bin]  the binary, where the caller pins a CLI version
 * @returns {StopOutcome}
 */
function stopOn(seat, id, bin = claudeBin()) {
	try {
		const out = execFileSync(bin, ["stop", id], {
			encoding: "utf8",
			timeout: STOP_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CLAUDE_CONFIG_DIR: seat },
		});
		return { ok: true, said: out.trim() || "ok" };
	} catch (e) {
		const err = caught(e);
		// err.code / err.status, never err.message: the message embeds the whole argv.
		// What the DAEMON said is separate, and it is what tells "No job matching
		// '<id>'", the permanent failure of mantahostels#846, from a timeout. Its LAST line,
		// per docs/agents/verification.md: the reason prints under any warnings.
		const said =
			String(err.stderr || "")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.pop()
				?.slice(0, 120) ?? null;
		const code = err.code || `exit ${err.status ?? "on a signal"}`;
		return {
			ok: false,
			why: said ? `${code}: ${said}` : code,
			said,
			timedOut: err.code === "ETIMEDOUT",
		};
	}
}

module.exports = { jobStatePath, seatsFor, stopOn, stopSession };
