/*
 * lander-files.js — the queue lander's machine-local files under the
 * canonical checkout's markers directory, gitignored, so a worktree's lander
 * shares them with the main tree's: its green ledger (one `<sha> <iso time>`
 * line per sha it lands, which the pre-push gate on `main` reads), its
 * pidfile lock, its heartbeat, and its verdict, batch and drop records (#4485, spec #4458).
 *
 * The ledger's and the heartbeat's times are lib/check.js's clock, as the
 * lander's own rows are (#4860). Residual: a WFC_NOW in the lander's
 * environment pins them all, so the stall check reads a live lander's
 * heartbeat as stale, and a malformed one makes each write throw.
 */

const fs = require("node:fs");
const path = require("node:path");
const { now } = require("./check.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { markersDir } = require("./marker-root.js");
const { pidLock } = require("./pid-lock.js");
const { readText } = require("./file-read.js");

/* Untraced: a fraction of the stall check's 2 h, so a live lander is never
 * read as dead mid-suite. */
const HEARTBEAT_MS = 60 * 1000;

/**
 * @typedef {object} Ledger
 * @property {(sha: string) => boolean} has
 * @property {(sha: string) => void} add
 * @typedef {{pid: number, at: string, batch: string|null}} Heartbeat
 */

/**
 * @param {string} root the canonical checkout's root
 */
function queueLanderFiles(root) {
	const dir = markersDir(root);
	return {
		ledger: path.join(dir, ".landing-green-ledger"),
		pid: path.join(dir, ".lander.pid"),
		heartbeat: path.join(dir, ".queue-lander-heartbeat.json"),
		verdicts: path.join(dir, ".queue-lander-verdicts.jsonl"),
		refused: path.join(dir, ".queue-lander-refused.jsonl"),
		batch: path.join(dir, ".queue-lander-batch.json"),
		drops: path.join(dir, ".queue-lander-drops.json"),
	};
}

/** @param {string} root the canonical checkout's root */
const landerLock = (root) =>
	pidLock(queueLanderFiles(root).pid, "queue-lander.js");

/**
 * A file's text, or null where it does not exist; any other read fault
 * throws, so an unreadable green ledger never reads as holding no sha
 * (#4856).
 * @param {string} file
 */
function readTextOrNull(file) {
	const r = readText(file);
	if (r.state === "unreadable") throw r.error;
	return r.state === "read" ? r.data : null;
}

/**
 * @param {string} file
 * @returns {Ledger & {readShas: () => string[], remove: (sha: string) => void,
 *   greenAt: (sha: string) => number|null}} with every sha it holds, `remove`
 *   rewriting it without `sha`'s lines, and `greenAt` when `sha` was added
 */
function fileLedger(file) {
	const readShas = () =>
		(readTextOrNull(file) ?? "")
			.split("\n")
			.flatMap((line) => line.split(" ")[0] || []);
	return {
		readShas,
		has: (sha) => readShas().includes(sha),
		greenAt: (sha) => {
			const line = (readTextOrNull(file) ?? "")
				.split("\n")
				.find((l) => l.split(" ")[0] === sha);
			const ms = Date.parse(line?.split(" ")[1] ?? "");
			return Number.isNaN(ms) ? null : ms;
		},
		add: (sha) =>
			fs.appendFileSync(file, `${sha} ${new Date(now()).toISOString()}\n`),
		remove: (sha) => {
			const text = readTextOrNull(file);
			if (text === null) return;
			const kept = text.split("\n").filter((l) => l.split(" ")[0] !== sha);
			writeFileAtomic(file, kept.join("\n"));
		},
	};
}

/**
 * @param {string} file
 * @returns {(batch: string|null) => void}
 */
const heartbeatWriter = (file) => (batch) =>
	writeFileAtomic(
		file,
		`${JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString(), batch })}\n`,
	);

/**
 * The heartbeat, or null where it is absent or not a heartbeat; any other
 * read fault throws.
 * @param {string} file
 * @returns {Heartbeat|null}
 */
function readHeartbeat(file) {
	const text = readTextOrNull(file);
	if (text === null) return null;
	try {
		const beat = JSON.parse(text);
		return typeof beat?.pid === "number" && typeof beat.at === "string"
			? beat
			: null;
	} catch {
		/* Written whole by heartbeatWriter, so unparseable only by a hand
		 * edit, which no run wrote (#2406). */
		return null;
	}
}

module.exports = {
	HEARTBEAT_MS,
	fileLedger,
	heartbeatWriter,
	landerLock,
	queueLanderFiles,
	readHeartbeat,
};
