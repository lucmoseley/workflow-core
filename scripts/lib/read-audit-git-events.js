const path = require("node:path");
const { readText } = require("./file-read.js");
const { parseJsonl } = require("./jsonl.js");
const { EXITED, SHOWN_MAX } = require("./read-audit-paths.js");
const { requiredGroup } = require("./regex-group.js");

const TRANSPORT =
	/^git-(?:upload-pack|receive-pack|upload-archive) '(?:[^']|'\\'')*'$/;

/**
 * @param {string} dir
 * @returns {(name: string|null, shown: string) => string|null}
 */
function buildGitEventsReader(dir) {
	return (name, shown) => {
		if (name === null)
			return `a git call (${shown}) named an event target of its own, so what it ran is unlogged`;
		const read = readText(path.join(dir, name));
		if (read.state !== "read")
			return `a git call (${shown}) left no log of what it ran`;
		const { rows, bad, zeroed } = parseJsonl(read.data);
		if (bad.length > 0) return `a git call (${shown}) left a torn log`;
		if (zeroed.length > 0)
			return `a git call (${shown}) left a log holding a record zeroed by a crash`;
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

/** @param {Record<string, unknown>[]} rows */
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
 * @param {Set<string>} open
 * @param {Set<string>} helped
 * @param {unknown} pid
 */
function closeKilled(open, helped, pid) {
	for (const sid of open)
		if (pidOf(sid) === pid && !helped.has(sid)) open.delete(sid);
}

/** @param {string} sid */
function pidOf(sid) {
	const re = /-P([0-9a-f]{8})$/;
	const named = re.exec(sid);
	return named ? Number.parseInt(requiredGroup(named, 1, re), 16) : Number.NaN;
}

/** @param {Record<string, unknown>} row */
function isGit(row) {
	const first = Array.isArray(row.argv) ? String(row.argv[0] ?? "") : "";
	if (row.use_shell === true)
		return row.child_class === "transport/file" && TRANSPORT.test(first);
	return first === "git";
}

module.exports = { buildGitEventsReader };
