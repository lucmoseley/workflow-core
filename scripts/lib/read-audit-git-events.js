/*
 * read-audit-git-events.js — what a git child of a test ran, off git's own
 * event log (#4997). A hook, an alias, a helper or a pager runs from git,
 * not from a spawn the read audit's preload (lib/read-audit-preload.js)
 * wraps, and inherits every variable the test's process holds, the ones
 * naming the checkout among them. So the preload hands each real git, and
 * the git guard, a file of the audit's on `GIT_TRACE2_EVENT` (git's
 * api-trace2), and this reads it back.
 *
 * A PROCESS GIT STARTS IS A DOUBT unless it is git again, which logs to the
 * same file: run as `git` itself, or as the `git-upload-pack`,
 * `git-receive-pack` or `git-upload-archive` a local transport runs on one
 * quoted path, which git finds in its own exec path ahead of `PATH`. A
 * process git looked for and never found (`pid` -1 at its exit) ran
 * nothing. A git that logged its start and never its end may still be
 * running: a doubt too, unless the preload logged, after it, that the test
 * killed that git and it exited (`EXITED`): git 2.43 logs a SIGPIPE, but
 * not the SIGTERM a test kills a long-lived git with.
 */

const path = require("node:path");
const { readText } = require("./file-read.js");
const { parseJsonl } = require("./jsonl.js");
const { EXITED, SHOWN_MAX } = require("./read-audit-paths.js");
const { requiredGroup } = require("./regex-group.js");

/* Each quote within the path as `'\''` (git's connect.c, sq_quote). */
const TRANSPORT =
	/^git-(?:upload-pack|receive-pack|upload-archive) '(?:[^']|'\\'')*'$/;

/**
 * @param {string} dir the audit's log directory
 * @returns {(name: string|null, shown: string) => string|null} why a git
 *   call's log leaves what it ran unseen, or null where it ran only git
 */
function buildGitEventsReader(dir) {
	return (name, shown) => {
		if (name === null)
			return `a git call (${shown}) named an event target of its own, so what it ran is unlogged`;
		const read = readText(path.join(dir, name));
		if (read.state !== "read")
			return `a git call (${shown}) left no log of what it ran`;
		const { rows, bad } = parseJsonl(read.data);
		if (bad.length > 0) return `a git call (${shown}) left a torn log`;
		return otherChildDoubt(rows, shown);
	};
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} shown
 * @returns {string|null}
 */
function otherChildDoubt(rows, shown) {
	const { started, unfound, open } = tally(rows);
	if (open.size > 0)
		return `a git call (${shown}) logged no end, so what it ran may still be running`;
	for (const [child, row] of started) {
		if (unfound.has(child) || isGit(row)) continue;
		const argv = Array.isArray(row.argv) ? row.argv.map(String) : [];
		const ran = String(argv[0] ?? "a process").slice(0, SHOWN_MAX);
		return `a git call (${shown}) ran ${ran} (${row.child_class}), whose reads no log holds`;
	}
	return null;
}

/**
 * The processes the log's gits started, by git process and child.
 * @param {Record<string, unknown>[]} rows
 */
function tally(rows) {
	/** @type {Map<string, Record<string, unknown>>} */
	const started = new Map();
	/** @type {Set<string>} */
	const unfound = new Set();
	/** @type {Set<string>} */
	const open = new Set();
	/** @type {Set<string>} */
	const helped = new Set();
	for (const row of rows) {
		const sid = String(row.sid);
		const child = `${sid} ${row.child_id}`;
		if (row.event === EXITED) closeKilled(open, helped, row.pid);
		else if (row.event === "start") open.add(sid);
		else if (row.event === "atexit") open.delete(sid);
		else if (row.event === "cmd_name" && row.name === "help") helped.add(sid);
		else if (row.event === "child_start") started.set(child, row);
		else if (row.event === "child_exit" && row.pid === -1) unfound.add(child);
	}
	return { started, unfound, open };
}

/**
 * Close the open gits a mark says were killed: those whose sid names its
 * pid, started before it, and none that ran `git help`, which execs the
 * viewer in its place.
 * @param {Set<string>} open
 * @param {Set<string>} helped
 * @param {unknown} pid
 */
function closeKilled(open, helped, pid) {
	for (const sid of open)
		if (pidOf(sid) === pid && !helped.has(sid)) open.delete(sid);
}

/**
 * The pid a sid's last part names, `P` and eight hex digits (git's
 * trace2/tr2_sid.c); NaN where it names none.
 * @param {string} sid
 */
function pidOf(sid) {
	const re = /-P([0-9a-f]{8})$/;
	const named = re.exec(sid);
	return named ? Number.parseInt(requiredGroup(named, 1, re), 16) : Number.NaN;
}

/** @param {Record<string, unknown>} row a `child_start` event */
function isGit(row) {
	const first = Array.isArray(row.argv) ? String(row.argv[0] ?? "") : "";
	if (row.use_shell === true)
		return row.child_class === "transport/file" && TRANSPORT.test(first);
	return first === "git";
}

module.exports = { buildGitEventsReader };
