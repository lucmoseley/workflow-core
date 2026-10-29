/*
 * cpu-yield.js — a test run outside the whole-suite slot gives a running
 * whole suite the CPU (#2955).
 *
 * The lander's whole suite has to finish inside the 840 s ceiling (#2667),
 * and the part-suites and touched runs admitted beside it (#2931, #2935)
 * share its nice level, so each takes a full share of the cores. A run that
 * finds another process's whole suite running raises its own nice by
 * YIELD_NICE before it forks its workers, which inherit it.
 *
 * Residuals: the nice is set once, at spawn — a whole suite that starts
 * later is not yielded to, and one that ends leaves the run niced; Linux
 * renices the one thread `setPriority` names, so threads the child started
 * before the call keep their weight; and sessions and hooks, at the same
 * nice as a whole suite in their cgroup, still compete with it at full
 * weight.
 *
 * Nice weighs a task only against tasks in its own cgroup, so a whole suite
 * in another cgroup, as the lander's is (#2956), is never yielded to: the
 * renice would slow this run and give that suite nothing.
 */

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

/* CFS weighs a task 10 nice levels up at about a tenth (weight 110 against
 * 1024), enough that the whole suite takes the cores first while the run
 * still progresses. Measured beside a whole suite on 8 cores, it took a
 * 4-file touched run's median wall time from 4.8 s to 9.3 s at load 16-18
 * (#2993), and a 100-file touched run's from 51 s to 69 s at load 20-28
 * (#3002; named files are touched runs, per #2868's Admission decision). 10 holds on those readings, per the story 17 entries in #2868's
 * `**Deviations:**` comments. */
const YIELD_NICE = 10;

/** @typedef {{ queueDir?: string, pid?: number,
 *   readStat?: (pid: number) => string,
 *   readCgroup?: (pid: number) => string,
 *   alive?: (pid: number) => boolean }} WholeProbe */

/**
 * The pids from `pid` up to init, `pid` included.
 * @param {number} pid
 * @param {(pid: number) => string} readStat
 * @returns {Set<number>}
 */
function lineageOf(pid, readStat) {
	const parentOf = (/** @type {number} */ p) => {
		try {
			return parentInFields(parseStatFields(readStat(p)));
		} catch {
			/* Exited mid-walk: the lineage ends where it can no longer be read. */
			return 0;
		}
	};
	return new Set([pid, ...readAncestorsOf(pid, { parentOf })]);
}

/**
 * Whether `a` and `b` sit in one cgroup.
 * @param {number} a
 * @param {number} b
 * @param {(pid: number) => string} readCgroup
 * @param {{ write: (s: string) => unknown }} err
 */
function isSameCgroup(a, b, readCgroup, err) {
	try {
		return readCgroup(a) === readCgroup(b);
	} catch (error) {
		/* Read as one cgroup, as every run sat before #2956 put the lander in
		 * a scope: a yield the cgroup would void costs this run some
		 * speed, where a missed one costs the whole suite its margin. */
		err.write(
			`could not read pid ${String(a)} or ${String(b)}'s cgroup (${caught(error).message}) — yielding as if they share one (#2956).\n`,
		);
		return true;
	}
}

/**
 * Whether a whole suite outside this process's own lineage is running in its
 * cgroup: a live, spawned suite-queue marker joined whole. A lander's own
 * bisect runs sit below its marker and never yield to it. Throws on a queue
 * directory that will not read, which no marker list can clear.
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
 * Raises `child`'s nice by YIELD_NICE where a foreign whole suite runs in
 * its cgroup.
 * Fails open, printing why.
 * @param {{ pid?: number }} child
 * @param {WholeProbe & {
 *   priority?: Pick<typeof os, "getPriority" | "setPriority">,
 *   err?: { write: (s: string) => unknown } }} [options]
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
			`could not yield this run's CPU to the whole suite (${caught(error).message}) — it competes at full weight (#2955).\n`,
		);
		return false;
	}
}

module.exports = { yieldToWhole };
