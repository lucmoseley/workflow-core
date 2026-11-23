#!/usr/bin/env node
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { caught } = require("./lib/caught.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { readSubagentLogState } = require("./lib/subagent-log-state.js");

// guess (#539): above the ~18-minute median wait in the waiting-stall forensics note
const DEFAULT_CEILING_S = 3600;
// measured (#4034): about 0.5% of live agents first write later
const DEFAULT_FIRST_WRITE_S = 600;
// #5496: guess
const LOG_POLL_MS = 5000;

const EXIT = { USAGE: 2, STALLED: 3, MISSING: 4, CEILING: 5, DONE: 6 };

const ADVICE = {
	STALLED:
		"no growth across two checks; abandon the agent unless it has already reported",
	MISSING:
		"never written by the first-write deadline, deleted, or the wrong path",
	CEILING:
		"the ceiling came before two checks without growth; re-run the watch to keep waiting",
	DONE: "the agent has stopped; read its report, or take over from its artefact where it sent none",
};

const LOG_ONLY_ADVICE = {
	CEILING:
		"the ceiling came before the agent's log read stopped; re-run the watch to keep waiting",
	DONE: "the agent has stopped; read its report",
};

const USAGE = `usage: node ${__filename} <path> <interval-seconds> [ceiling-seconds] [--first-write <seconds>] [--log <agent-log>]
       node ${__filename} --no-artefact <interval-seconds> <ceiling-seconds> --log <agent-log>`;

/**
 * @param {string} message
 * @returns {never}
 */
function refuse(message) {
	writeFd(2, `watch-artefact: ${message}\n${USAGE}\n`);
	process.exit(EXIT.USAGE);
}

/**
 * @param {string | undefined} raw
 * @param {string} name
 * @returns {number}
 */
function parseSeconds(raw, name) {
	const n = Number(raw);
	if (raw === undefined || raw.trim() === "" || !Number.isFinite(n) || n <= 0)
		refuse(`${name} must be a positive number of seconds, got ${raw}`);
	return n;
}

/**
 * @param {string} file
 * @returns {number | null}
 */
function readSizeOf(file) {
	let stat;
	try {
		stat = fs.statSync(file);
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		refuse(`cannot stat ${file}: ${code ?? message}`);
	}
	if (!stat.isFile()) refuse(`${file} is not a regular file`);
	return stat.size;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SizeTrack {
	/**
	 * @param {number | null} baseline
	 * @param {number} firstWriteMs
	 */
	constructor(baseline, firstWriteMs) {
		this.size = baseline;
		/** @type {number | null} */
		this.lastGrowth = null;
		this.firstWriteMs = firstWriteMs;
		this.seen = baseline !== null;
		this.idle = 0;
		this.absent = 0;
	}

	/**
	 * @param {number | null} now
	 * @param {number} elapsedMs
	 * @param {boolean} inFlight
	 * @returns {"MISSING" | "STALLED" | null}
	 */
	observe(now, elapsedMs, inFlight) {
		const grew = now !== null && now !== this.size;
		if (!grew && inFlight) {
			this.idle = 0;
			this.absent = 0;
			this.size = now;
			return null;
		}
		if (!this.seen && now === null)
			return elapsedMs >= this.firstWriteMs ? "MISSING" : null;
		this.seen = true;
		this.idle = grew ? 0 : this.idle + 1;
		if (grew) this.lastGrowth = Date.now();
		this.absent = now === null ? this.absent + 1 : 0;
		this.size = now;
		if (this.idle < 2) return null;
		return this.absent >= 2 ? "MISSING" : "STALLED";
	}
}

/**
 * @param {string | true | undefined} raw
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
const parseOptionalMs = (raw, name, fallback) =>
	(raw === undefined ? fallback : parseSeconds(String(raw), name)) * 1000;

/**
 * @typedef {{intervalMs: number, ceilingMs: number}} Timing
 * @typedef {Timing & {logOnly: true, log: string}} LogOnlyArgs
 * @typedef {Timing & {logOnly: false, file: string, log: string | undefined, firstWriteMs: number}} ArtefactArgs
 * @returns {LogOnlyArgs | ArtefactArgs}
 */
function readArgs() {
	const { positionals, flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		max: 3,
		flags: {
			"--first-write": "value",
			"--log": "value",
			"--no-artefact": "boolean",
		},
	});
	const log = flags["--log"];
	if (log === true || log === "") refuse("--log names no agent log");
	if (flags["--no-artefact"] === true) {
		if (positionals.length > 2) refuse("--no-artefact takes no artefact path");
		if (log === undefined) refuse("--no-artefact needs --log");
		if (flags["--first-write"] !== undefined)
			refuse("--no-artefact has no first write to wait on");
		const [rawInterval, rawCeiling] = positionals;
		if (rawCeiling === undefined) refuse("--no-artefact needs a ceiling");
		return {
			logOnly: true,
			log,
			intervalMs: parseSeconds(rawInterval, "interval") * 1000,
			ceilingMs: parseSeconds(rawCeiling, "ceiling") * 1000,
		};
	}
	const [file, rawInterval, rawCeiling] = positionals;
	if (!file) refuse("no artefact path");
	const intervalMs = parseSeconds(rawInterval, "interval") * 1000;
	return {
		logOnly: false,
		file,
		log,
		intervalMs,
		ceilingMs: parseOptionalMs(rawCeiling, "ceiling", DEFAULT_CEILING_S),
		firstWriteMs: Math.max(
			parseOptionalMs(
				flags["--first-write"],
				"first-write",
				DEFAULT_FIRST_WRITE_S,
			),
			2 * intervalMs,
		),
	};
}

/** @param {number} intervalMs */
const logPollMsFor = (intervalMs) => Math.min(LOG_POLL_MS, intervalMs / 4);

/**
 * @param {string} log
 * @param {string} meanwhile
 * @returns {() => "in-flight" | "paused" | "stopped" | "unread"}
 */
function makeLogReader(log, meanwhile) {
	let unreadSaid = false;
	let pausedSaid = false;
	return () => {
		const read = readSubagentLogState(log);
		if (read.state === "unread" && !unreadSaid)
			writeFd(2, `watch-artefact: ${read.why}; ${meanwhile}\n`);
		if (read.state === "paused" && !pausedSaid)
			writeFd(
				2,
				"watch-artefact: the agent is paused on background work of its own, not stopped; waiting for it to resume\n",
			);
		unreadSaid ||= read.state === "unread";
		pausedSaid ||= read.state === "paused";
		return read.state;
	};
}

/** @param {LogOnlyArgs} args */
async function watchLogOnly({ log, intervalMs, ceilingMs }) {
	const ceiling = Date.now() + ceilingMs;
	const pollMs = logPollMsFor(intervalMs);
	writeFd(
		2,
		`watch-artefact: no artefact, reading the agent log ${log} every ${pollMs / 1000}s, DONE once it reads stopped, ceiling ${ceilingMs / 1000}s\n`,
	);
	/** @param {"DONE" | "CEILING"} verdict */
	const finish = (verdict) => {
		writeFd(1, `${verdict} ${log} — ${LOG_ONLY_ADVICE[verdict]}\n`);
		process.exit(EXIT[verdict]);
	};
	const readLogState = makeLogReader(log, "still reading it");
	for (let at = Date.now(); at < ceiling; at += pollMs) {
		await sleep(at - Date.now());
		if (readLogState() === "stopped") finish("DONE");
	}
	await sleep(ceiling - Date.now());
	finish("CEILING");
}

async function main() {
	const args = readArgs();
	if (args.logOnly) return watchLogOnly(args);
	const { file, log, intervalMs, ceilingMs, firstWriteMs } = args;

	const start = Date.now();
	const tracker = new SizeTrack(readSizeOf(file), firstWriteMs);
	writeFd(
		2,
		`watch-artefact: watching ${file} every ${intervalMs / 1000}s, first write by ${firstWriteMs / 1000}s, ceiling ${ceilingMs / 1000}s, ${log ? `reading the agent log ${log}, DONE once it reads stopped` : "on growth alone, no agent log"}\n`,
	);

	const readLog = log ? makeLogReader(log, "judging on growth alone") : null;
	/** @returns {"in-flight" | "paused" | "stopped" | "unread" | "none"} */
	const readLogState = () => (readLog ? readLog() : "none");

	/** @param {keyof typeof ADVICE} verdict */
	const finish = (verdict) => {
		const { lastGrowth } = tracker;
		const size = verdict === "DONE" ? readSizeOf(file) : tracker.size;
		const at =
			lastGrowth === null ? "none" : new Date(lastGrowth).toISOString();
		writeFd(
			1,
			`${verdict} ${file} size=${size ?? "absent"} last-growth=${at} — ${ADVICE[verdict]}\n`,
		);
		process.exit(EXIT[verdict]);
	};

	const logPollMs = logPollMsFor(intervalMs);
	/** @param {number} until */
	const pollLogUntil = async (until) => {
		if (!log) return;
		for (let at = Date.now() + logPollMs; at < until; at += logPollMs) {
			await sleep(at - Date.now());
			if (readLogState() === "stopped") finish("DONE");
		}
	};

	if (readLogState() === "stopped") finish("DONE");
	for (let check = 1; ; check++) {
		const due = start + check * intervalMs;
		const ceiling = start + ceilingMs;
		await pollLogUntil(Math.min(due, ceiling));
		if (due > ceiling) {
			await sleep(ceiling - Date.now());
			finish("CEILING");
		}
		await sleep(due - Date.now());
		const state = readLogState();
		if (state === "stopped") finish("DONE");
		const verdict = tracker.observe(
			readSizeOf(file),
			check * intervalMs,
			state === "in-flight" || state === "paused",
		);
		if (verdict) finish(verdict);
	}
}

module.exports = { main };

if (require.main === module)
	main().catch((/** @type {any} */ err) => {
		writeFd(2, `watch-artefact: ${err?.stack ?? err}\n`);
		process.exit(1);
	});
