/*
 * proc-table.js — the machine's process table as the orphan sweeps read it
 * (#3057): every live process with its parent, group, start time and argv,
 * the seconds since boot, a process's age, the reader's own tree, and the age
 * wording a report prints. check-orphan-wait-loops.js and lib/orphan-hooks.js
 * read /proc through it and through nothing else.
 *
 * AGE IS DERIVED, NOT READ: `/proc/uptime` minus `starttime / USER_HZ`.
 * USER_HZ is fixed at 100 by the Linux arm64 ABI whatever CONFIG_HZ says, and
 * Node exposes no sysconf to read it. It is not a safe-either-way guess: too
 * large silently misses orphans, too small invents them.
 *
 * WFC_PROC_ROOT REPLACES /proc; lib/proc-fake.ts writes one.
 */

const fs = require("node:fs");
const path = require("node:path");
const { FIELD, parseStatFields, readAncestorsOf } = require("./proc-stat.js");
const { trimEndRun } = require("./trim-run.js");

/** Kernel clock ticks per second. */
const USER_HZ = 100;

const procRoot = () => process.env.WFC_PROC_ROOT || "/proc";

/**
 * @typedef {{ pid: number, ppid: number, pgid: number, startTicks: number,
 *   argv: string[] }} Proc
 */

/**
 * `{state, ppid, pgid, startTicks}` from one stat line, or null where the
 * line has a shape this cannot read.
 *
 * The state is returned rather than judged here so the caller can tell a line
 * it FAILED to read from one it read and excluded — the two mean opposite
 * things about whether the sweep saw the machine at all.
 * @param {string} stat
 */
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

/**
 * Every live process under `root`, keyed by pid, or null where `root` will
 * not list. One whose stat or cmdline will not read, or whose stat will not
 * parse, is counted in `unreadable`: a root of which every listed pid is, the
 * hidepid=2 shape, has been seen not at all.
 *
 * A zombie (Z) or a dying process (X) keeps its stat entry until its parent
 * reaps it and runs nothing, and a kernel thread has an empty cmdline: both are read and left
 * out, never counted unreadable.
 * @param {string} root
 */
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
 * `pid`'s start time read afresh, or null where it is gone or a zombie — what
 * a kill compares against its snapshot so a recycled pid is never taken.
 * @param {string} root @param {number} pid
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

/** Seconds since boot, or null where uptime will not read or parse.
 * @param {string} root */
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

/** Seconds since `proc` started, on a machine `bootAgo` seconds up.
 * @param {{ startTicks: number }} proc @param {number} bootAgo */
const ageSeconds = (proc, bootAgo) => bootAgo - proc.startTicks / USER_HZ;

/**
 * This process and every ancestor of it in `procs` — walked over the snapshot
 * rather than live /proc so a fixture tree answers the same way. Its own pid
 * and parent are in it always: on a fixture root neither is in the snapshot.
 * @param {Map<number, { ppid: number }>} procs
 */
function ownTree(procs) {
	const parentOf = (/** @type {number} */ pid) => procs.get(pid)?.ppid ?? 0;
	return new Set([
		process.pid,
		process.ppid,
		...readAncestorsOf(process.pid, { parentOf }).filter((pid) => pid > 1),
	]);
}

/** Minutes under 90 m, hours under 48 h, else days: edges a judgement, so no
 * figure prints above 90 or 48 of its unit.
 * @param {number} s seconds */
function describeAge(s) {
	if (s < 90 * 60) return `${Math.floor(s / 60)}m`;
	if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86_400)}d`;
}

module.exports = {
	USER_HZ,
	ageSeconds,
	describeAge,
	ownTree,
	procRoot,
	readProcTable,
	readStartTicks,
	readUptime,
};
