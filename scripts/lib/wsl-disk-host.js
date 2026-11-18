/*
 * wsl-disk-host.js — the reads and the append lib/wsl-disk.js's verdicts are
 * fed by (#5044). None crosses the interop bridge, since a wedged bridge is
 * one of the faults the check must still report through.
 *
 * WFC_PROC names /proc, WFC_WSL_COMPACT_LOG the log, WFC_WIN_C the mount,
 * WFC_GUEST_ROOT the guest's root, WFC_SYSTEMCTL the systemctl and
 * WFC_FSTRIM_DROPIN install-fstrim-wsl.sh's drop-in (§N7).
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
 * The guest root's used bytes, counted as `df` counts them, and the virtual
 * size of the disk it is mounted from, read from /proc/partitions; or why
 * either would not read.
 * @returns {{usedBytes: number, sizeBytes: number} | {why: string}}
 */
function readGuestDisk() {
	const root = process.env.WFC_GUEST_ROOT || "/";
	let usedBytes;
	try {
		const s = fs.statfsSync(root);
		usedBytes = (s.blocks - s.bfree) * s.bsize;
	} catch (e) {
		return { why: `${root}: ${caught(e).message}` };
	}
	const mountinfo = readProcLines("self/mountinfo");
	if ("why" in mountinfo) return mountinfo;
	// `<id> <parent> <dev> <root> <mount point> … - <fstype> <source> <opts>`;
	// the last line mounted on / is the one in force.
	const source = mountinfo.lines
		.filter((l) => l.split(" ")[4] === "/")
		.map((l) => l.split(" - ")[1]?.split(" ")[1])
		.at(-1);
	if (!source?.startsWith("/dev/"))
		return { why: `/ is mounted from ${source ?? "nothing"}, not a disk` };
	const name = path.basename(source);
	const partitions = readProcLines("partitions");
	if ("why" in partitions) return partitions;
	// `major minor #blocks name`, the blocks in KiB.
	const row = partitions.lines
		.map((l) => l.trim().split(/\s+/))
		.find((f) => f[3] === name);
	if (!row) return { why: `${name} is not in /proc/partitions` };
	return { usedBytes, sizeBytes: Number(row[2]) * 1024 };
}

/**
 * @param {string} rel a path under /proc
 * @returns {{lines: string[]} | {why: string}}
 */
function readProcLines(rel) {
	const r = readText(path.join(procRoot(), rel));
	if (r.state === "read") return { lines: r.data.split("\n") };
	return {
		why: `/proc/${rel}: ${r.state === "absent" ? "absent" : r.message}`,
	};
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
 * When install-fstrim-wsl.sh wrote fstrim.timer's drop-in, or null where it
 * has not.
 * @returns {number | null}
 */
function readTrimFixedAt() {
	const file =
		process.env.WFC_FSTRIM_DROPIN ||
		"/etc/systemd/system/fstrim.timer.d/wsl.conf";
	return fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
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
	readGuestDisk,
	readKernelRelease,
	readLastTrim,
	readTrimFixedAt,
};
