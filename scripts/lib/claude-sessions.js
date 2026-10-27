/*
 * claude-sessions.js — the live-session count docs/environment.md §5 sets, in
 * Node: `bg-pty-host` processes matched on argv[0], less the daemon's
 * unclaimed spare (workflow-core#1798).
 *
 * The Node twin of lib/claude-sessions.sh's wfc_session_count, which
 * shell-start-warn.sh still sources, and of lib/claude_sessions.py, which says
 * why the spare's `bg-spare` child is told apart by its cwd. A change to the
 * unit lands in all three; claude-sessions.test.ts runs one case list against
 * this file and the shell twin.
 *
 * countSessions is a core: it does no I/O, the one read it needs — whether a
 * process sits in a directory — arriving as a port. isProcCwd is that port's
 * production adapter, a stat of /proc.
 */

const fs = require("node:fs");
const { isClaudeArgv0 } = require("./claude-argv0.js");

/**
 * claude-argv0.js's three shapes, a Windows argv[0]'s backslashes read as
 * separators first, as the shell and Python twins do.
 * @param {string} argv0
 */
const isClaude = (argv0) => isClaudeArgv0(argv0.replaceAll("\\", "/"));

/**
 * The live sessions in `ps -eo pid=,ppid=,args=` text: one per Claude
 * `bg-pty-host`, less each host whose `bg-spare` child still sits in its claim
 * socket's directory. At most one is taken off a host, however many spare
 * children it lists.
 * @param {string} psText
 * @param {(pid: string, dir: string) => boolean} isCwd whether `pid` runs in
 *   `dir`, false where it cannot say, so the count errs high
 * @returns {number}
 */
function countSessions(psText, isCwd) {
	/** @type {Set<string>} */
	const hosts = new Set();
	let n = 0;
	/** @type {Map<string, { ppid: string, dir: string }>} */
	const spares = new Map();
	for (const line of psText.split("\n")) {
		const row = readRow(line);
		if (row?.role === "bg-pty-host") {
			hosts.add(row.pid);
			n++;
		} else if (row?.spare) spares.set(row.pid, row.spare);
	}
	/** @type {Set<string>} */
	const gone = new Set();
	for (const [pid, { ppid, dir }] of spares)
		if (hosts.has(ppid) && isCwd(pid, dir)) gone.add(ppid);
	return n - gone.size;
}

/**
 * One `ps` line as a Claude process: its pid, its role, and for a `bg-spare`
 * its parent and the directory of its claim socket — the word after
 * `--bg-spare` less its last `/` segment, wfc_session_count's awk spelling,
 * the last such word winning. Null where argv[0] is not Claude's, or the
 * line is too short to carry one.
 * @param {string} line
 */
function readRow(line) {
	const [pid, ppid, argv0, role, ...rest] = line.trim().split(/[ \t]+/);
	if (pid === undefined || ppid === undefined || argv0 === undefined)
		return null;
	if (!isClaude(argv0)) return null;
	/** @type {{ ppid: string, dir: string } | null} */
	let spare = null;
	if (role === "bg-spare")
		for (const [i, word] of rest.entries()) {
			const next = rest[i + 1];
			if (word === "--bg-spare" && next !== undefined)
				spare = { ppid, dir: next.replace(/\/[^/]*$/, "") };
		}
	return { pid, role, spare };
}

/**
 * Does `pid` run in `dir`? Compared by device and inode, as the shell twin's
 * `-ef` does; false where either will not stat.
 * @param {string} pid
 * @param {string} dir
 * @returns {boolean}
 */
function isProcCwd(pid, dir) {
	try {
		const a = fs.statSync(`/proc/${pid}/cwd`, { bigint: true });
		const b = fs.statSync(dir, { bigint: true });
		return a.dev === b.dev && a.ino === b.ino;
	} catch {
		/* Exited, not ours to read, or no such directory: claimed, so the count
		 * errs high (workflow-core#1798). */
		return false;
	}
}

module.exports = { countSessions, isProcCwd };
