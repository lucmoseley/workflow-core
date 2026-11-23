#!/usr/bin/env node
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { buildErrorText, ignoreFailure } = require("./lib/caught.js");

/**
 * @typedef {import("./lib/reaper.js").State} State
 * @typedef {import("./lib/reaper.js").Claims} Claims
 * @typedef {import("./lib/reaper.js").RunRecord} RunRecord
 */
const path = require("node:path");
const { configDir } = require("./lib/config-dir.js");
const { procRoot } = require("./lib/proc-root.js");
const { readOwnJob, stopSession } = require("./lib/claude-stop.js");
const { readRegistryAgents } = require("./lib/registry-agents.js");
const {
	readLocks,
	readLocksHeldBy,
	subjectDirtyWhereHeld,
} = require("./lib/arbiter-store");
const { transcriptPath } = require("./lib/project-slug.js");
const { lastTurn } = require("./lib/transcript.js");
const { readPendingTasks } = require("./lib/pending-tasks.js");
const { readTail } = require("./lib/file-read.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");
const { persisting: sharedPersisting } = require("./lib/persist-mode.js");
const { reportOwner } = require("./lib/session-id.js");
const { DEGRADED, openedRecord, reap } = require("./lib/reaper.js");
const { journalReapedJobs } = require("./lib/reaped-jobs.js");

const CHECKER = "reap-finished-sessions";

const PERSIST_OPTS = { forbid: ["--dry-run"] };

/** @param {string[]} argv */
const persisting = (argv) => sharedPersisting(argv, PERSIST_OPTS);

const statePath = () => path.join(configDir(), "wfc-reap-state.json");

/**
 * @param {number|null|undefined} pid
 * @returns {number|null}
 */
function readPssMb(pid) {
	try {
		const m = fs
			.readFileSync(`${procRoot()}/${pid}/smaps_rollup`, "utf8")
			.match(/^Pss:\s+(\d+) kB$/m);
		return m ? Math.round(Number(m[1]) / 1024) : null;
	} catch {
		return null;
	}
}

/** @returns {State} */
function readState() {
	try {
		const s = JSON.parse(fs.readFileSync(statePath(), "utf8"));
		return s && typeof s === "object" && !Array.isArray(s) ? s : {};
	} catch {
		return {};
	}
}

/** @param {State} state */
function writeState(state) {
	ignoreFailure(() => {
		fs.mkdirSync(configDir(), { recursive: true });
		fs.writeFileSync(statePath(), `${JSON.stringify(state, null, "\t")}\n`);
	});
}

const runPath = () => path.join(configDir(), "wfc-reap-run.json");

// lucmoseley/mantahostels#1999 guess
const REAP_LIVE_DEATHS_TO_REPORT = 3;

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
		fs.mkdirSync(configDir(), { recursive: true });
		const all = readRuns();
		all[record.mode] = record;
		fs.writeFileSync(runPath(), `${JSON.stringify(all, null, "\t")}\n`);
	});
}

/**
 * @param {string[]} argv
 * @param {Record<string, RunRecord>} runs
 * @returns {RunRecord}
 */
function openRun(argv, runs) {
	const record = openedRecord(argv, runs, Date.now());
	writeRuns(record);
	return record;
}

/**
 * @param {string} subject
 * @param {string} sessionId
 */
function claimDirty(subject, sessionId) {
	const lock = readLocksHeldBy(sessionId)?.find((l) => l.path === subject);
	return lock ? subjectDirtyWhereHeld(lock) : null;
}

/** @returns {Claims} */
function claimHolders() {
	const locks = readLocks();
	if (locks === null)
		return {
			why: "the claim store could not be read, so no session can be shown to hold nothing",
		};

	/** @type {Map<string, string[]>} */
	const held = new Map();
	/** @type {string[]} */
	const unnamed = [];
	for (const l of locks) {
		if (l.unreadable) {
			unnamed.push(l.file);
			continue;
		}
		if (!l.sessionId) {
			unnamed.push(l.path);
			continue;
		}
		const mine = held.get(l.sessionId) ?? [];
		mine.push(l.path);
		held.set(l.sessionId, mine);
	}
	return { held, unnamed };
}

/**
 * @param {{id?: string, sessionId: string}} agent
 * @returns {number|null}
 */
function readFinishAt(agent) {
	const own = readOwnTranscript(agent);
	if (!own) return null;
	const stamp = Date.parse(own.record.firstTerminalAt ?? "");
	if (!Number.isFinite(stamp)) return null;
	try {
		return Math.max(stamp, fs.statSync(own.file).mtimeMs);
	} catch {
		return null;
	}
}

/**
 * @param {{id?: string, sessionId: string}} agent
 * @returns {{record: Record<string, any>, file: string}|null}
 */
function readOwnTranscript(agent) {
	const own = readOwnJob(agent.sessionId, { jobId: agent.id });
	if (!own?.job) return null;
	const { seat, job: record } = own;
	if (!record.cwd) return null;
	return { record, file: transcriptPath(seat, record.cwd, agent.sessionId) };
}

// #2980 guess
const TURN_TAIL_BYTES = 256 * 1024;

/**
 * @param {{id?: string, sessionId: string}} agent
 * @returns {{ended: boolean, at: number|null}|null}
 */
function readLastTurn(agent) {
	const own = readOwnTranscript(agent);
	if (!own) return null;
	const tail = readTail(own.file, TURN_TAIL_BYTES);
	return tail.state === "read" ? lastTurn(tail.data.text) : null;
}

/**
 * @param {{id?: string, sessionId: string}} agent
 * @returns {{name: string}[]|null}
 */
function readPending(agent) {
	const own = readOwnTranscript(agent);
	if (!own) return null;
	try {
		const seen = readPendingTasks(own.file);
		return seen.records > 0 ? seen.pending : null;
	} catch {
		return null;
	}
}

/**
 * @param {typeof import("./lib/notify-report.js")} notify
 * @param {"OK"|"WARN"|"BROKEN"} outcome
 * @param {string[]} lines
 * @param {number} startedMs
 */
function persistReport(notify, outcome, lines, startedMs) {
	const text = lines.map((line) => `${line}\n`).join("");
	const wrote = notify.writeReport(CHECKER, {
		outcome,
		text,
		durationMs: Date.now() - startedMs,
		owner: reportOwner(),
	});
	if (wrote) notify.closeRun(CHECKER);
	if (!wrote && text) writeFd(1, text);
}

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `usage: node ${scriptPath("reap-finished-sessions.js")} [--dry-run] [--json] [--notify] [--not-a-session]

Stops other background sessions that have finished and are still resident.
The conversation is kept: \`claude attach\` resumes it.

  --dry-run  name what would be stopped, and stop nothing
  --json     print the run as one JSON document
  --notify   print the session-start report; lib/persist-mode.js says when it goes to a file
  --not-a-session  the caller is no session, so none is spared as this one;
             ignored where CLAUDE_CODE_SESSION_ID is set`,
	flags: {
		"--dry-run": "boolean",
		"--json": "boolean",
		"--notify": "boolean",
		"--not-a-session": "boolean",
	},
};

/** @param {string[]} argv */
function main(argv) {
	const { flags } = parseOrExit(argv, CLI);
	// lucmoseley/mantahostels#2152
	const notify = persisting(argv) ? require("./lib/notify-report.js") : null;
	/** @type {string[]} */
	const lines = [];
	if (notify) notify.openRun(CHECKER);
	const began = Date.now();
	/** @type {"OK"|"WARN"|"BROKEN"} */
	let outcome = "OK";
	try {
		const runs = readRuns();
		const { startedAt } = openRun(argv, runs);
		const verdict = reap({
			argv,
			listed: readRegistryAgents(),
			claims: claimHolders(),
			self:
				process.env.CLAUDE_CODE_SESSION_ID ||
				(flags["--not-a-session"] ? null : undefined),
			now: Date.now(),
			state: readState(),
			stop: stopSession,
			readPss: readPssMb,
			saveState: writeState,
			finishAt: readFinishAt,
			lastTurn: readLastTurn,
			pending: readPending,
			isDirty: claimDirty,
			runs,
			startedAt,
			recordRun: writeRuns,
			recordStopped: journalReapedJobs,
			log: notify
				? (/** @type {string} */ line) => lines.push(line)
				: console.log,
		});
		if (verdict === DEGRADED) outcome = "BROKEN";
		else if (lines.length > 0) outcome = "WARN";
		else outcome = "OK";
	} catch (e) {
		if (!notify) throw e;
		outcome = "BROKEN";
		lines.push(`reap: the run threw and reaped nothing — ${buildErrorText(e)}`);
	}
	if (notify) persistReport(notify, outcome, lines, began);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { REAP_LIVE_DEATHS_TO_REPORT };
