const fs = require("node:fs");
const { procRoot } = require("./proc-root.js");

// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
const FIELD = { state: 0, ppid: 1, pgrp: 2, utime: 11, stime: 12, start: 19 };

// guess, #3056
const ANCESTOR_MAX_HOPS = 64;

/**
 * @param {string} stat
 * @returns {string[] | null}
 */
function parseStatFields(stat) {
	const close = stat.lastIndexOf(")");
	if (close < 0) return null;
	return stat
		.slice(close + 2)
		.trim()
		.split(/\s+/);
}

/**
 * @param {number|string} pid
 * @param {string} [proc]
 * @returns {string[] | null}
 */
function readStatFields(pid, proc = procRoot()) {
	try {
		return parseStatFields(fs.readFileSync(`${proc}/${pid}/stat`, "utf8"));
	} catch {
		return null;
	}
}

/**
 * @param {string[] | null | undefined} fields
 * @returns {number}
 */
function parentInFields(fields) {
	const ppid = Number(fields?.[FIELD.ppid]);
	return Number.isInteger(ppid) && ppid > 0 ? ppid : 0;
}

/**
 * @param {number|string} pid
 * @param {string} [proc]
 * @returns {number}
 */
function readParentOf(pid, proc) {
	return parentInFields(readStatFields(pid, proc));
}

/**
 * @param {number} pid
 * @param {{ parentOf?: (pid: number) => number }} [options]
 * @returns {number[]}
 */
function readAncestorsOf(pid, { parentOf = readParentOf } = {}) {
	/** @type {number[]} */
	const chain = [];
	const seen = new Set([pid]);
	for (
		let at = parentOf(pid);
		at > 0 && !seen.has(at) && chain.length < ANCESTOR_MAX_HOPS;
		at = parentOf(at)
	) {
		seen.add(at);
		chain.push(at);
	}
	return chain;
}

module.exports = {
	FIELD,
	parentInFields,
	parseStatFields,
	readAncestorsOf,
	readParentOf,
	readStatFields,
};
