/*
 * proc-stat.js — the shared parser of `/proc/<pid>/stat` (workflow-core#3056): a pid's
 * fields, its parent and its ancestors.
 *
 * `comm` is parenthesised, unquoted and may itself hold spaces and brackets,
 * so the fields are counted from after its LAST `)` — never by splitting the
 * whole line.
 *
 * A leaf: it depends on nothing but `fs`.
 */

const fs = require("node:fs");

/* Indices into the array `parseStatFields` returns, each proc(5)'s field
 * number less 3. */
const FIELD = { state: 0, ppid: 1, pgrp: 2, utime: 11, stime: 12, start: 19 };

/* How many parents `readAncestorsOf` walks before giving up: a guess, set far
 * above the session → shell → driver → runner depth any caller looks through. */
const ANCESTOR_MAX_HOPS = 64;

/**
 * The fields of one stat line from the state on, or null where the line holds
 * no `)` to count from.
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
 * `pid`'s stat fields, or null where they cannot be read.
 * @param {number|string} pid
 * @param {string} [proc] the procfs root; a fixture tree in tests
 * @returns {string[] | null}
 */
function readStatFields(pid, proc = "/proc") {
	try {
		return parseStatFields(fs.readFileSync(`${proc}/${pid}/stat`, "utf8"));
	} catch {
		return null;
	}
}

/**
 * The parent pid on one stat line's fields; 0 where they are missing or hold
 * none.
 * @param {string[] | null | undefined} fields
 * @returns {number}
 */
function parentInFields(fields) {
	const ppid = Number(fields?.[FIELD.ppid]);
	return Number.isInteger(ppid) && ppid > 0 ? ppid : 0;
}

/**
 * `pid`'s parent pid; 0 where it cannot be read.
 * @param {number|string} pid
 * @param {string} [proc]
 * @returns {number}
 */
function readParentOf(pid, proc) {
	return parentInFields(readStatFields(pid, proc));
}

/**
 * `pid`'s ancestors, nearest first, `pid` itself left out. The walk stops at a
 * parent that reads 0, at a pid already seen, or after ANCESTOR_MAX_HOPS.
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
