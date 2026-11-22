#!/usr/bin/env node
/*
 * reap-finished-sessions.js — stops background sessions that have FINISHED but
 * are still resident, so their memory returns to the admission arithmetic.
 *
 * THE PROBLEM (mantahostels#421). A background session that finishes does not
 * exit: it stays resumable, holding 330-450 MB PSS, so pick-next.js reads the
 * pool as spent memory and admits fewer sessions than fit.
 *
 * WHY STOPPING IS NOT DESTRUCTIVE. Resume is transcript-based
 * (~/.claude/projects/<slug>/<session-id>.jsonl), not process-based, so
 * `claude stop` keeps the conversation for a later `claude attach`. A kill
 * would destroy the host, which is what mantahostels#319 rejected reaping over; measured
 * at mantahostels#492, the live-pool verification.
 *
 * IT READS NO CLI LISTING (#2665). Its pool is lib/registry-agents.js: each
 * seat's registry, pid-verified, joined to its job records. That reader's header says why acting on it
 * is safe here and nowhere that judges a session dead by its absence.
 *
 * IT REAPS ONLY WHAT IT CAN PROVE IS FINISHED, AND DEGRADES TO REAPING NOTHING.
 * Six gates, every one of which must pass:
 *   1. its registry record says `kind: bg` (the listing's `background`) AND
 *      its job record says `state: done` with `tempo` not `active` — a
 *      session mid-decision reads `working`, one in a forced Stop-hook turn
 *      `done` and `active` (#2980);
 *   2. it is not this very session — waived under `--not-a-session`, for a
 *      caller with no session of its own (the refill loop, #2012), and only
 *      where CLAUDE_CODE_SESSION_ID is unset: a session that passes it is
 *      still told apart from the rest;
 *   3. its registry record names a job id — `claude stop` is addressed by that, and
 *      answers anything else with lib/claude-stop.js's NO_JOB_ANSWER and exit 1;
 *   4. it finished at least GRACE_MS ago, and its transcript shows its last
 *      turn ended — else it is held for the windows HOW LONG A JOB WHOSE TURN
 *      HAS NOT VISIBLY ENDED IS LEFT ALONE sets (lib/reaper.js, which holds the
 *      gates' code and the constants this header names);
 *   5. its last `claude stop` did not fail inside the retry window that failure
 *      opened — see HOW A STOP THAT FAILED IS LEFT ALONE in lib/reaper.js;
 *   6. its transcript reads, and shows no launch still out (lib/pending-tasks.js,
 *      the reading the `waiting:` Stop guard takes) — a job that ended its turn
 *      on `waiting:` can be listed `done` (#4659, #5387), so gate 1 alone would stop it
 *      mid-wait. lib/reaper.js's pendingHold says what keeps it.
 * Reaping stops entirely on an unset CLAUDE_CODE_SESSION_ID without
 * `--not-a-session`, because gate 2 cannot be applied without knowing which
 * session is this one. A seat whose registry will not read costs that seat's
 * sessions, named in the report, and the rest are reaped. An unreadable claim store costs the
 * naming below and nothing else (mantahostels#747).
 *
 * NO GATE READS `status` (mantahostels#768;
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md):
 * a gate reading `status === "idle"` would exclude finished sessions
 * invisibly — such a session would be a candidate in no reap log.
 *
 * A FILE CLAIM DOES NOT KEEP A SESSION (mantahostels#747).
 *
 * AND THE CLAIMS ARE NOT RELEASED — nothing here touches a lock. A lock is
 * breakable once its holder's HOST PROCESS is dead (arbiter-core.js's
 * liveEntryIn, which re-resolves the holder's pid against /proc). `claude stop`
 * ends that host, so the lock falls into the ordinary stale class and the next
 * claimant breaks it by the same rule that breaks any dead session's lock.
 *
 * GATE 4 READS A REAL FINISH TIME, NOT A SIGHTING (mantahostels#654;
 * mantahostels#652; readFinishAt below).
 * The first session start after a burst finishes reaps it (mantahostels#632, the burst a
 * sighting clock could not reap: only a session start runs this script, so a
 * burst was always sighted at an age of zero). The first-sighting clock
 * survives as the fallback, for a session whose finish time cannot be read.
 *
 * IT REAPS EVERY SEAT, NOT ONLY ITS OWN (#1571). The listing spans every seat,
 * but `claude stop` and the job record are scoped to CLAUDE_CONFIG_DIR. So each
 * session is addressed on the seat whose `jobs/<id>` record names it
 * (lib/claude-stop.js's stopSession).
 *
 * NO AGE EVER EXPIRES A CLAIM HERE. mantahostels#318 refused claim expiry outright; the
 * grace (lib/reaper.js's GRACE_MS) is an age on a session's own idleness, never on a lock.
 *
 * Usage: node scripts/reap-finished-sessions.js [--dry-run] [--json] [--notify] [--not-a-session]
 * Runs at every session start, from self-plugin/hooks/hooks.json's SessionStart hooks,
 * and, when the pretest headroom check finds the machine short, from
 * scripts/pretest-reap.js's own call at `npm run test`'s pretest (mantahostels#1840).
 *
 * WHAT IS COVERED, AND WHAT IS NOT. mantahostels#493 holds the mutation-by-mutation
 * roll of what is covered. UNVERIFIED: lib/reaper.js's isFinished `kind` limb,
 * the rest of main()'s readings, and gate 5's `failures &&` conjunct, an equivalent
 * mutant. Also UNVERIFIED: that `main()` threads its own `runs` read into
 * `openRun` rather than a second `readRuns()` there.
 *
 * Exit codes: always 0. A session start must never be blocked by this. The
 * one exception is a command line lib/cli-args.js refuses — exit 2, before
 * anything is read or stopped (#920).
 *
 * IT PERSISTS ITS REPORT UNDER `WFC_NOTIFY_PERSIST=1 … --notify` (mantahostels#2152).
 * See PERSIST MODE below. Without both, every path is exactly as it was; the
 * SessionStart registration passes both.
 */

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
		if (!l || l.unreadable || !l.sessionId) {
			unnamed.push(l?.file ?? l?.path ?? "an unnamed record");
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
