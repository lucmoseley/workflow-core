/*
 * wsl-disk-host.js — the reads and the append lib/wsl-disk.js's verdicts are
 * fed by (#5044). None crosses the interop bridge, since a wedged bridge is
 * one of the faults the check must still report through.
 *
 * WFC_PROC names /proc, WFC_WSL_COMPACT_LOG the log, WFC_WIN_C the mount and
 * WFC_SYSTEMCTL the systemctl (§N7).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { procRoot } = require("./proc-root.js");
const { runCommand } = require("./run-command.js");

const LOG_NAME = "wsl-compact.log";
const USERS_DIR = "/mnt/c/Users";

/**
 * @typedef {{state: "absent"} | {state: "read", path: string, text: string}
 *   | {state: "unreadable", why: string}} LogRead
 */

/**
 * The kernel release, "" where there is none (not Linux), or why it would
 * not read: check-wsl-currency.js's shape.
 * @returns {string | {why: string}}
 */
function readKernelRelease() {
	const r = readText(path.join(procRoot(), "sys/kernel/osrelease"));
	if (r.state === "absent") return "";
	if (r.state === "unreadable") return { why: r.message };
	return r.data;
}

/**
 * The compaction log: WFC_WSL_COMPACT_LOG's, else the newest
 * `<user>/AppData/Local/wsl-compact.log` under /mnt/c/Users, the ps1 writing
 * it to %LOCALAPPDATA%. Residual: two Windows users with a log each, the
 * newer read.
 * @returns {LogRead}
 */
function readCompactLog() {
	const named = process.env.WFC_WSL_COMPACT_LOG;
	const found = named ? { path: named } : newestLog(USERS_DIR);
	if ("why" in found) return { state: "unreadable", why: found.why };
	if (found.path === null) return { state: "absent" };
	const r = readText(found.path);
	if (r.state === "absent") return { state: "absent" };
	if (r.state === "unreadable") return { state: "unreadable", why: r.message };
	return { state: "read", path: found.path, text: r.data };
}

/**
 * @param {string} usersDir
 * @returns {{path: string | null} | {why: string}}
 */
function newestLog(usersDir) {
	let names;
	try {
		names = fs.readdirSync(usersDir);
	} catch (e) {
		// Not "absent": an unmounted C: says nothing about the task.
		return { why: `${usersDir}: ${caught(e).message}` };
	}
	let best = null;
	let bestAt = -1;
	for (const name of names) {
		const p = path.join(usersDir, name, "AppData", "Local", LOG_NAME);
		const at = fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? -1;
		if (at > bestAt) [best, bestAt] = [p, at];
	}
	return { path: best };
}

/**
 * C:'s free space in GiB, the unit the ps1 logs, or why it would not read.
 * @returns {number | {why: string}}
 */
function readFreeGB() {
	const mount = process.env.WFC_WIN_C || "/mnt/c";
	try {
		const s = fs.statfsSync(mount);
		return (s.bavail * s.bsize) / 2 ** 30;
	} catch (e) {
		return { why: `${mount}: ${caught(e).message}` };
	}
}

/**
 * When fstrim.timer last fired, null where it never has, or why it would not
 * read. TZ=UTC makes systemctl print a zone Date.parse reads, where a local
 * zone may print as an abbreviation.
 * @returns {number | null | {why: string}}
 */
function readLastTrim() {
	const r = runCommand(
		process.env.WFC_SYSTEMCTL || "systemctl",
		["show", "fstrim.timer", "-p", "LastTriggerUSec", "--value"],
		{ env: { ...process.env, TZ: "UTC" } },
	);
	if (r.error !== null) return { why: r.error };
	if (r.out === "" || r.out === "n/a") return null;
	const m = /^\w{3} (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/.exec(r.out);
	const at = m ? Date.parse(`${m[1]}T${m[2]}Z`) : Number.NaN;
	return Number.isNaN(at) ? { why: `unread timestamp: ${r.out}` } : at;
}

/**
 * Appends one line in the ps1's CRLF.
 * @param {string} file
 * @param {string} line
 */
function appendCompactLog(file, line) {
	fs.appendFileSync(file, `${line}\r\n`);
}

module.exports = {
	appendCompactLog,
	readCompactLog,
	readFreeGB,
	readKernelRelease,
	readLastTrim,
};
