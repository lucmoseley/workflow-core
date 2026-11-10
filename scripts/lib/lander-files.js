/*
 * lander-files.js — the queue lander's machine-local files under the
 * canonical checkout's markers directory, gitignored, so a worktree's lander
 * shares them with the main tree's: its green ledger (one `<sha> <iso time>`
 * line per sha it lands, which the pre-push gate on `main` reads), its
 * pidfile lock, its heartbeat, and its verdict, batch and drop records (#4485, spec #4458).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { markersDir } = require("./marker-root.js");
const { pidLock } = require("./pid-lock.js");

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
 * A file's text, or null where it cannot be read.
 * @param {string} file
 */
function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * @param {string} file
 * @returns {Ledger & {readShas: () => string[], remove: (sha: string) => void,
 *   greenAt: (sha: string) => number|null}} with every sha it holds, `remove`
 *   rewriting it without `sha`'s lines, and `greenAt` when `sha` was added
 */
function fileLedger(file) {
	const readShas = () =>
		(readText(file) ?? "")
			.split("\n")
			.flatMap((line) => line.split(" ")[0] || []);
	return {
		readShas,
		has: (sha) => readShas().includes(sha),
		greenAt: (sha) => {
			const line = (readText(file) ?? "")
				.split("\n")
				.find((l) => l.split(" ")[0] === sha);
			const ms = Date.parse(line?.split(" ")[1] ?? "");
			return Number.isNaN(ms) ? null : ms;
		},
		add: (sha) =>
			fs.appendFileSync(file, `${sha} ${new Date().toISOString()}\n`),
		remove: (sha) => {
			const text = readText(file);
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
		`${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), batch })}\n`,
	);

/**
 * The heartbeat, or null where it is absent or not a heartbeat; any other
 * read fault throws.
 * @param {string} file
 * @returns {Heartbeat|null}
 */
function readHeartbeat(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
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
