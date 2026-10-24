/*
 * registry-agents.js — the sessions every seat's registry proves are running,
 * as lib/agent-liveness.js's AgentRecords, read from files alone: no
 * `claude agents --json` (workflow-core#2665, ruled at workflow-core#2663).
 *
 * WHAT IT READS, on each seat lib/arbiter-core.js's sessionDirs() names:
 * `sessions/<pid>.json`, kept only where /proc/<pid>/stat's start time equals
 * its `procStart`, joined to the same seat's `jobs/<jobId>/state.json` for
 * `state`, taken only where that record names the same session. These are
 * undocumented harness files; the refill loop logs where this listing and the
 * CLI one disagree (`driftLines`).
 *
 * THE REAPER ACTS ONLY ON WHAT A RECORD SAYS, so a missing or garbled record
 * makes it stop less, never the wrong session.
 * THE REFILL LOOP'S NEVER-STARTED STOP DOES JUDGE BY ABSENCE — a working job
 * whose session has no live record here. It may use this read only because
 * absence is not its whole test: the job must also be past its 30-minute
 * grace with no transcript on any seat, which no running session shows; and
 * it judges a job only on a seat in `seats`, whose registry was read.
 * NEVER A READER THAT JUDGES BY ABSENCE ALONE — release `--force`, the claim
 * prune, admission's live set. A session whose record is missing would read
 * dead (mantahostels#104); those keep the CLI listing.
 *
 * PARTIAL BY DESIGN. A record of unrecognised shape is skipped. A seat whose
 * registry will not read is a fault naming it, and the other seats are read.
 */

const fs = require("node:fs");
const path = require("node:path");
const { procStartOf } = require("./arbiter-proc.js");
const { readRecord, sessionDirs } = require("./arbiter-core.js");
const { caught } = require("./caught.js");
const headless = require("./headless-sessions.js");

/**
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {{agents: AgentRecord[], faults: string[], seats: string[]}} RegistryListing
 *   `faults` names each seat, or the headless store, that would not read;
 *   `seats` the config dirs whose registry was read
 * @typedef {{pid?: unknown, sessionId?: unknown, procStart?: unknown,
 *   jobId?: unknown, name?: unknown, cwd?: unknown, kind?: unknown,
 *   startedAt?: unknown}} RegistryEntry a parsed `sessions/<pid>.json`: the
 *   harness owns its schema, so every field is checked before it is read
 * @typedef {{sessionId?: unknown, state?: unknown}} JobState the fields read
 *   from a parsed `jobs/<id>/state.json`, unchecked for the same reason
 */

/* The registry's spelling of a background session, and the oracle's, which
 * `isFinishedAgent` reads. */
const KIND_NAMES = new Map([["bg", "background"]]);

/**
 * One registry entry as an AgentRecord, or null where its shape is not the
 * one this reads or its process is not the one it recorded.
 * @param {string} seat
 * @param {RegistryEntry} entry
 * @returns {AgentRecord|null}
 */
function agentOf(seat, entry) {
	const { pid, sessionId, procStart } = entry;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
		return null;
	if (typeof sessionId !== "string" || !sessionId) return null;
	if (typeof procStart !== "string" && typeof procStart !== "number")
		return null;
	if (procStartOf(pid) !== String(procStart)) return null;
	/** @type {AgentRecord} */
	const agent = { sessionId, pid };
	const { name, cwd, kind, startedAt } = entry;
	if (typeof name === "string" && name) agent.name = name;
	if (typeof cwd === "string" && cwd) agent.cwd = cwd;
	if (typeof kind === "string" && kind)
		agent.kind = KIND_NAMES.get(kind) ?? kind;
	if (typeof startedAt === "number") agent.startedAt = startedAt;
	return withJob(agent, seat, entry.jobId);
}

/**
 * `agent` with its job id, and its state where that seat's job record names
 * the same session. An id that is not plain alphanumeric is never followed
 * into a path.
 * @param {AgentRecord} agent
 * @param {string} seat
 * @param {unknown} jobId
 * @returns {AgentRecord}
 */
function withJob(agent, seat, jobId) {
	if (typeof jobId !== "string" || !/^[0-9a-z]+$/i.test(jobId)) return agent;
	agent.id = jobId;
	const job = jobRecord(seat, jobId);
	if (job?.sessionId === agent.sessionId && typeof job.state === "string")
		agent.state = job.state;
	return agent;
}

/**
 * A job's parsed state.json on one seat, or null where it is absent, torn or
 * refused.
 * @param {string} seat
 * @param {string} jobId
 * @returns {JobState|null}
 */
function jobRecord(seat, jobId) {
	try {
		return readRecord(path.join(seat, "jobs", jobId, "state.json"));
	} catch {
		/* A refused read is no state, so the session is not reaped: PARTIAL BY
		 * DESIGN, the header. */
		return null;
	}
}

/**
 * One seat's pid-verified sessions, `read` false where it has no registry
 * at all — or the fault that kept its registry from reading.
 * @param {string} seat
 * @returns {{agents: AgentRecord[], read: boolean} | {fault: string}}
 */
function seatAgents(seat) {
	const dir = path.join(seat, "sessions");
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		const { code } = caught(e);
		if (code === "ENOENT") return { agents: [], read: false };
		return { fault: `${dir} would not read (${code})` };
	}
	/** @type {AgentRecord[]} */
	const agents = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		let entry;
		try {
			entry = readRecord(path.join(dir, name));
		} catch {
			/* One refused entry is skipped and the rest read: PARTIAL BY DESIGN,
			 * the header. */
			continue;
		}
		const agent = entry && agentOf(seat, entry);
		if (agent) agents.push(agent);
	}
	return { agents, read: true };
}

/**
 * Every pid-verified session on every seat, with the live headless runs
 * merged in as lib/agent-liveness.js merges them.
 * @returns {RegistryListing}
 */
function registryAgents() {
	/** @type {AgentRecord[]} */
	const agents = [];
	/** @type {string[]} */
	const faults = [];
	/** @type {string[]} */
	const seats = [];
	for (const seat of sessionDirs()) {
		const read = seatAgents(seat);
		if ("fault" in read) faults.push(read.fault);
		else agents.push(...read.agents);
		if ("read" in read && read.read) seats.push(seat);
	}
	try {
		agents.push(...headless.liveAgents());
	} catch (e) {
		faults.push(
			`the headless-run store would not read (${caught(e).code || caught(e).message})`,
		);
	}
	return { agents, faults, seats };
}

/**
 * One line per background session the CLI listing and this one disagree on —
 * listed by one alone, or with a different pid or state. A session that
 * changes state between the two reads shows here too, once.
 * @param {AgentRecord[]} cli
 * @param {AgentRecord[]} registry
 * @returns {string[]}
 */
function driftLines(cli, registry) {
	/** @param {AgentRecord[]} list */
	const background = (list) =>
		new Map(
			list.filter((a) => a.kind === "background").map((a) => [a.sessionId, a]),
		);
	const fromCli = background(cli);
	const fromRegistry = background(registry);
	const lines = [];
	for (const [id, a] of fromCli) {
		const r = fromRegistry.get(id);
		if (!r) lines.push(`${id} is listed by the CLI alone`);
		else if (r.pid !== a.pid || r.state !== a.state)
			lines.push(
				`${id} reads pid ${a.pid}, state ${a.state} from the CLI but pid ${r.pid}, state ${r.state} from the registry`,
			);
	}
	for (const id of fromRegistry.keys())
		if (!fromCli.has(id)) lines.push(`${id} is listed by the registry alone`);
	return lines.map((l) => `listing drift: ${l}`);
}

module.exports = { driftLines, registryAgents };
