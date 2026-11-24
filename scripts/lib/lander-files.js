const fs = require("node:fs");
const path = require("node:path");
const { readOwnIdentity } = require("./arbiter-proc.js");
const { now } = require("./check.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { markersDir } = require("./marker-root.js");
const { pidLock } = require("./pid-lock.js");
const { readText } = require("./file-read.js");

// guess, workflow-core#2402
const HEARTBEAT_MS = 60 * 1000;

/**
 * @typedef {object} Ledger
 * @property {(sha: string) => boolean} has
 * @property {(sha: string) => void} add
 * @typedef {{pid: number, procStart?: string|null, bootId?: string|null,
 *   at: string, batch: string|null}} Heartbeat
 */

/** @param {string} root */
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

/** @param {string} root */
const landerLock = (root) =>
	pidLock(queueLanderFiles(root).pid, "queue-lander.js");

/** @param {string} file */
function readTextOrNull(file) {
	const r = readText(file);
	if (r.state === "unreadable") throw r.error;
	return r.state === "read" ? r.data : null;
}

/** @param {string} text */
const parseLedgerShas = (text) =>
	text.split("\n").flatMap((line) => line.split(" ")[0] || []);

/**
 * @param {string} file
 * @returns {Ledger & {readShas: () => string[], remove: (sha: string) => void,
 *   greenAt: (sha: string) => number|null}}
 */
function fileLedger(file) {
	const readShas = () => parseLedgerShas(readTextOrNull(file) ?? "");
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
 * @returns {(batch?: string|null) => void}
 */
function heartbeatWriter(file) {
	/** @type {string|null} */
	let last = null;
	const self = readOwnIdentity();
	return (batch = last) => {
		last = batch;
		writeFileAtomic(
			file,
			`${JSON.stringify({ ...self, at: new Date(now()).toISOString(), batch })}\n`,
		);
	};
}

/**
 * @template {object} T
 * @param {() => void} beat
 * @param {T} deps
 * @returns {T}
 */
const beatingBefore = (beat, deps) =>
	/** @type {T} */ (
		Object.fromEntries(
			Object.entries(deps).map(([key, value]) => [
				key,
				typeof value === "function"
					? (/** @type {unknown[]} */ ...args) => {
							beat();
							return value(...args);
						}
					: value,
			]),
		)
	);

/**
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
		return null;
	}
}

module.exports = {
	HEARTBEAT_MS,
	fileLedger,
	beatingBefore,
	heartbeatWriter,
	landerLock,
	parseLedgerShas,
	queueLanderFiles,
	readHeartbeat,
};
