const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { ignoreFailure } = require("./caught.js");

/**
 * @typedef {{ open: { module: string, stage: string }[], finished: string[],
 *   scheduled: string[]|null }} InflightRecord
 */

const INFLIGHT_FILE = ".test-inflight.json";
const INFLIGHT_ENV = "WFC_INFLIGHT_FILE";

/** @param {string} root */
const inflightPath = (root) =>
	process.env[INFLIGHT_ENV] || path.join(markersDir(root), INFLIGHT_FILE);

/** @type {Map<string, string>} */
const open = new Map();

/** @type {string[]} */
const finished = [];

/** @type {{ list: string[]|null }} */
const scheduled = { list: null };

/** @param {string} root */
function flush(root) {
	ignoreFailure(() => {
		const rows = [...open].map(([module, stage]) => ({ module, stage }));
		fs.writeFileSync(
			inflightPath(root),
			`${JSON.stringify({ open: rows, finished, scheduled: scheduled.list })}\n`,
		);
	});
}

/** @param {string} root */
function begin(root) {
	open.clear();
	finished.length = 0;
	scheduled.list = null;
	flush(root);
}

/**
 * @param {string} root
 * @param {(string|undefined)[]} moduleIds
 */
function schedule(root, moduleIds) {
	scheduled.list = moduleIds.filter(
		/** @returns {m is string} */ (m) => typeof m === "string" && m !== "",
	);
	flush(root);
}

/**
 * @param {string} root
 * @param {string|undefined} moduleId
 * @param {string} stage
 */
function enter(root, moduleId, stage) {
	if (!moduleId) return;
	open.set(moduleId, stage);
	flush(root);
}

/**
 * @param {string} root
 * @param {string|undefined} moduleId
 */
function leave(root, moduleId) {
	if (!moduleId) return;
	open.delete(moduleId);
	finished.push(moduleId);
	flush(root);
}

/** @param {string} root */
function beat(root) {
	ignoreFailure(() => {
		const now = new Date();
		fs.utimesSync(inflightPath(root), now, now);
	});
}

/** @param {string} file */
function lastBeat(file) {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * @param {string} root
 * @returns {{ module: string, stage: string }[]}
 */
function read(root) {
	return readRecord(inflightPath(root)).open;
}

/**
 * @param {string} file
 * @returns {InflightRecord}
 */
function readRecord(file) {
	try {
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		const recordOpen = record?.open;
		const recordFinished = record?.finished;
		const recordScheduled = record?.scheduled;
		return {
			open: Array.isArray(recordOpen)
				? recordOpen.filter((r) => r?.module)
				: [],
			finished: Array.isArray(recordFinished)
				? recordFinished.filter((f) => typeof f === "string")
				: [],
			scheduled: Array.isArray(recordScheduled)
				? recordScheduled.filter((f) => typeof f === "string")
				: null,
		};
	} catch {
		return { open: [], finished: [], scheduled: null };
	}
}

/** @param {string} root */
function clear(root) {
	open.clear();
	finished.length = 0;
	scheduled.list = null;
	clearFile(inflightPath(root));
}

/** @param {string} file */
function clearFile(file) {
	ignoreFailure(() => fs.rmSync(file, { force: true }));
}

module.exports = {
	INFLIGHT_ENV,
	beat,
	begin,
	clear,
	clearFile,
	enter,
	lastBeat,
	leave,
	read,
	readRecord,
	schedule,
};
