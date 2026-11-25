const fs = require("node:fs");
const os = require("node:os");

const { caught } = require("./caught.js");
const { procRoot } = require("./proc-root.js");
const {
	parentInFields,
	parseStatFields,
	readAncestorsOf,
} = require("./proc-stat.js");
const {
	defaultQueueDir,
	isMarkerStale,
	readMarkers,
} = require("./suite-queue.js");

// 4.8 s to 9.3 s measured, workflow-core#2993
const YIELD_NICE = 10;

/** @typedef {{ queueDir?: string, pid?: number,
 *   readStat?: (pid: number) => string,
 *   readCgroup?: (pid: number) => string,
 *   alive?: (pid: number) => boolean }} WholeProbe */

/**
 * @param {number} pid
 * @param {(pid: number) => string} readStat
 * @returns {Set<number>}
 */
function lineageOf(pid, readStat) {
	const parentOf = (/** @type {number} */ p) => {
		try {
			return parentInFields(parseStatFields(readStat(p)));
		} catch {
			return 0;
		}
	};
	return new Set([pid, ...readAncestorsOf(pid, { parentOf })]);
}

/**
 * @param {number} a
 * @param {number} b
 * @param {(pid: number) => string} readCgroup
 * @param {{ write: (s: string) => unknown }} err
 */
function isSameCgroup(a, b, readCgroup, err) {
	try {
		return readCgroup(a) === readCgroup(b);
	} catch (error) {
		err.write(
			`could not read pid ${String(a)} or ${String(b)}'s cgroup (${caught(error).message}) — yielding as if they share one (workflow-core#2956).\n`,
		);
		return true;
	}
}

/**
 * @param {WholeProbe & { err: { write: (s: string) => unknown } }} probe
 * @returns {boolean}
 */
function isForeignWholeRunning({
	queueDir = defaultQueueDir(),
	pid = process.pid,
	readStat = (p) => fs.readFileSync(`${procRoot()}/${p}/stat`, "utf8"),
	readCgroup = (p) => fs.readFileSync(`${procRoot()}/${p}/cgroup`, "utf8"),
	alive,
	err,
}) {
	const { markers, error } = readMarkers(queueDir);
	if (error) throw error;
	const own = lineageOf(pid, readStat);
	return markers.some(
		({ record }) =>
			record.spawned === true &&
			record.part !== true &&
			!own.has(record.pid) &&
			!isMarkerStale(record, alive ? { alive } : {}) &&
			isSameCgroup(pid, record.pid, readCgroup, err),
	);
}

/**
 * @param {{ pid?: number }} child
 * @param {WholeProbe & {
 * priority?: Pick<typeof os, "getPriority" | "setPriority">,
 * err?: { write: (s: string) => unknown } }} [options]
 * @returns {boolean}
 */
function yieldToWhole(
	child,
	{ priority = os, err = process.stderr, ...probe } = {},
) {
	if (!child.pid) return false;
	try {
		if (!isForeignWholeRunning({ ...probe, err })) return false;
		priority.setPriority(
			child.pid,
			Math.min(19, priority.getPriority(child.pid) + YIELD_NICE),
		);
		return true;
	} catch (error) {
		err.write(
			`could not yield this run's CPU to the whole suite (${caught(error).message}) — it competes at full weight (workflow-core#2955).\n`,
		);
		return false;
	}
}

module.exports = { yieldToWhole };
