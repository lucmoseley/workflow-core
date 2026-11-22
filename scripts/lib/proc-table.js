const fs = require("node:fs");
const path = require("node:path");
const { FIELD, parseStatFields, readAncestorsOf } = require("./proc-stat.js");
const { trimEndRun } = require("./trim-run.js");

// https://man7.org/linux/man-pages/man5/proc.5.html
const USER_HZ = 100;

/**
 * @typedef {{ pid: number, ppid: number, pgid: number, startTicks: number,
 *   argv: string[] }} Proc
 */

/** @param {string} stat */
function parseStat(stat) {
	const fields = parseStatFields(stat);
	const state = fields?.[FIELD.state];
	const ppid = Number(fields?.[FIELD.ppid]);
	const pgid = Number(fields?.[FIELD.pgrp]);
	const startTicks = Number(fields?.[FIELD.start]);
	if (
		!state ||
		!Number.isInteger(ppid) ||
		!Number.isInteger(pgid) ||
		!Number.isInteger(startTicks)
	)
		return null;
	return { state, ppid, pgid, startTicks };
}

/** @param {string} root */
function readProcTable(root) {
	let entries;
	try {
		entries = fs.readdirSync(root);
	} catch {
		return null;
	}
	/** @type {Map<number, Proc>} */
	const procs = new Map();
	let listed = 0;
	let unreadable = 0;
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		listed++;
		let stat;
		let cmdline;
		try {
			stat = fs.readFileSync(path.join(root, entry, "stat"), "utf8");
			cmdline = fs.readFileSync(path.join(root, entry, "cmdline"), "utf8");
		} catch {
			unreadable++;
			continue;
		}
		const parsed = parseStat(stat);
		if (!parsed) {
			unreadable++;
			continue;
		}
		if (parsed.state === "Z" || parsed.state === "X") continue;
		const argv = trimEndRun(cmdline, "\0").split("\0").filter(Boolean);
		if (argv.length === 0) continue;
		const pid = Number(entry);
		const { ppid, pgid, startTicks } = parsed;
		procs.set(pid, { pid, ppid, pgid, startTicks, argv });
	}
	return { procs, listed, unreadable };
}

/**
 * @param {string} root
 * @param {number} pid
 */
function readStartTicks(root, pid) {
	try {
		const parsed = parseStat(
			fs.readFileSync(path.join(root, String(pid), "stat"), "utf8"),
		);
		return parsed && parsed.state !== "Z" ? parsed.startTicks : null;
	} catch {
		return null;
	}
}

/** @param {string} root */
function readUptime(root) {
	try {
		const s = Number.parseFloat(
			fs.readFileSync(path.join(root, "uptime"), "utf8"),
		);
		return Number.isFinite(s) ? s : null;
	} catch {
		return null;
	}
}

/**
 * @param {{ startTicks: number }} proc
 * @param {number} bootAgo
 */
const ageSeconds = (proc, bootAgo) => bootAgo - proc.startTicks / USER_HZ;

/** @param {Map<number, { ppid: number }>} procs */
function ownTree(procs) {
	const parentOf = (/** @type {number} */ pid) => procs.get(pid)?.ppid ?? 0;
	return new Set([
		process.pid,
		process.ppid,
		...readAncestorsOf(process.pid, { parentOf }).filter((pid) => pid > 1),
	]);
}

module.exports = {
	USER_HZ,
	ageSeconds,
	ownTree,
	readProcTable,
	readStartTicks,
	readUptime,
};
