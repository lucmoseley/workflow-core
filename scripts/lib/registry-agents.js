const fs = require("node:fs");
const path = require("node:path");
const { readProcStartOf } = require("./arbiter-proc.js");
const { readRecord, sessionDirs } = require("./arbiter-core.js");
const { isRecordObject } = require("./arbiter-records.js");
const { readOwnJob } = require("./claude-stop.js");
const { caught } = require("./caught.js");
const headless = require("./headless-runs.js");

/**
 * @typedef {import("./agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {{agents: AgentRecord[], faults: string[], seats: string[]}} RegistryListing
 * @typedef {{pid?: unknown, sessionId?: unknown, procStart?: unknown,
 *   jobId?: unknown, name?: unknown, cwd?: unknown, kind?: unknown,
 *   startedAt?: unknown}} RegistryEntry
 */

const KIND_NAMES = new Map([["bg", "background"]]);

/**
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
	if (readProcStartOf(pid) !== String(procStart)) return null;
	/** @type {AgentRecord} */
	const agent = { sessionId, pid, seat };
	const { name, cwd, kind, startedAt } = entry;
	if (typeof name === "string" && name) agent.name = name;
	if (typeof cwd === "string" && cwd) agent.cwd = cwd;
	if (typeof kind === "string" && kind)
		agent.kind = KIND_NAMES.get(kind) ?? kind;
	if (typeof startedAt === "number") agent.startedAt = startedAt;
	return withJob(agent, seat, entry.jobId);
}

/**
 * @param {AgentRecord} agent
 * @param {string} seat
 * @param {unknown} jobId
 * @returns {AgentRecord}
 */
function withJob(agent, seat, jobId) {
	if (typeof jobId !== "string" || !/^[0-9a-z]+$/i.test(jobId)) return agent;
	agent.id = jobId;
	const job = readOwnJob(agent.sessionId, { jobId, seats: [seat] })?.job;
	if (typeof job?.state === "string") agent.state = job.state;
	if (typeof job?.tempo === "string") agent.tempo = job.tempo;
	return agent;
}

/**
 * @param {string} seat
 * @returns {{agents: AgentRecord[], read: boolean} | {fault: string}}
 */
function readSeatAgents(seat) {
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
			continue;
		}
		const agent = isRecordObject(entry) ? agentOf(seat, entry) : null;
		if (agent) agents.push(agent);
	}
	return { agents, read: true };
}

/** @returns {RegistryListing} */
function readRegistryAgents() {
	/** @type {AgentRecord[]} */
	const agents = [];
	/** @type {string[]} */
	const faults = [];
	/** @type {string[]} */
	const seats = [];
	for (const seat of sessionDirs()) {
		const read = readSeatAgents(seat);
		if ("fault" in read) faults.push(read.fault);
		else agents.push(...read.agents);
		if ("read" in read && read.read) seats.push(seat);
	}
	try {
		agents.push(...headless.readLiveAgents());
	} catch (e) {
		faults.push(
			`the headless-run store would not read (${caught(e).code || caught(e).message})`,
		);
	}
	return { agents, faults, seats };
}

/**
 * @param {AgentRecord[]} cli
 * @param {AgentRecord[]} registry
 * @returns {string[]}
 */
function buildDriftLines(cli, registry) {
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

module.exports = { buildDriftLines, readRegistryAgents };
