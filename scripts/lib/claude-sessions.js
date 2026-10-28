/*
 * claude-sessions.js — the live-session count docs/environment.md §5 sets, in
 * Node: `bg-pty-host` processes matched on argv[0], less the daemon's
 * unclaimed spare (#1798); and admission's idle-or-claimed reading of each
 * spare pair, by the same cwd test (#2502).
 *
 * The Node twin of lib/claude-sessions.sh's wfc_session_count, which
 * shell-start-warn.sh still sources, and of lib/claude_sessions.py, which says
 * why the spare's `bg-spare` child is told apart by its cwd. A change to the
 * unit lands in all three; claude-sessions.test.ts runs one case list against
 * countSessions and the shell twin. sparePairs, which countSessions counts
 * by, has no twin: only admission pairs by socket id.
 *
 * Both are cores: they do no I/O, the one read they need — where a process
 * sits — arriving as a port. readProcCwd is its production adapter.
 */

const fs = require("node:fs");
const { isClaudeArgv0 } = require("./claude-argv0.js");

/**
 * claude-argv0.js's three shapes, a Windows argv[0]'s backslashes read as
 * separators first, as the shell and Python twins do.
 * @param {string} argv0
 */
const isClaude = (argv0) => isClaudeArgv0(argv0.replaceAll("\\", "/"));

/*
 * The socket id both halves of a daemon spare pair carry in argv, claimed or
 * not. DUPLICATED BY HAND as SPARE_SOCKET in scripts/lib/claude_sessions.py,
 * which the session memory sampler pairs by: move both, or neither (#2231).
 */
const SPARE_SOCKET = /\/spare\/([A-Za-z0-9]+)\./;

/**
 * The word after the last `--bg-spare` in a `bg-spare`'s argv past its role,
 * its claim socket; null where there is none.
 * @param {string[]} rest
 */
function claimSocketOf(rest) {
	let sock = null;
	for (const [i, word] of rest.entries()) {
		const next = rest[i + 1];
		if (word === "--bg-spare" && next !== undefined) sock = next;
	}
	return sock;
}

/** A path less its last `/` segment, wfc_session_count's awk spelling. */
const dirOf = (/** @type {string} */ p) => p.replace(/\/[^/]*$/, "");

/**
 * The live sessions in `ps -eo pid=,ppid=,args=` text: one per Claude
 * `bg-pty-host`, less each idle pair's host.
 * @param {string} psText
 * @param {(pid: string) => string | null} cwdOf `pid`'s cwd, null where it
 *   cannot say, so the count errs high
 * @returns {number}
 */
function countSessions(psText, cwdOf) {
	/** @type {{ pid: string, args: string }[]} */
	const procs = [];
	for (const line of psText.split("\n")) {
		const m = line.trim().match(/^(\S+)[ \t]+\S+[ \t]+(.+)$/);
		if (m?.[1] && m[2]) procs.push({ pid: m[1], args: m[2] });
	}
	const idleHosts = new Set(
		sparePairs(procs, cwdOf)
			.filter((p) => p.idle)
			.map((p) => p.host),
	);
	return procs.filter(({ pid, args }) => {
		const [argv0 = "", role] = args.split(/[ \t]+/);
		return isClaude(argv0) && role === "bg-pty-host" && !idleHosts.has(pid);
	}).length;
}

/**
 * @typedef {{
 *   socket: string,
 *   pids: string[],
 *   host: string | null,
 *   spare: string | null,
 *   claimSock: string | null,
 *   dir: string | null,
 *   idle: boolean,
 * }} SparePair `host` and `spare` are its `bg-pty-host` and `bg-spare`
 *   halves' pids, `claimSock` the spare's `--bg-spare` argument and `dir` that
 *   socket's directory, each null where the pair lists no such half.
 */

/**
 * The daemon's spare pairs among `procs`: the Claude processes sharing a
 * `SPARE_SOCKET` id, one pair each. A pair is idle where its `bg-spare` half's
 * cwd string is its claim socket's directory, the spare not yet moved to a
 * job's cwd; every other pair is claimed — a cwd that will not read, and a
 * pair with no `bg-spare` half, included. A spare still booting, its socket not yet made, already sits in
 * that directory and reads idle.
 * @param {{ pid: string, args: string }[]} procs `ps` rows, argv as one string
 * @param {(pid: string) => string | null} cwdOf `pid`'s cwd, null where it
 *   cannot say
 * @returns {SparePair[]}
 */
function sparePairs(procs, cwdOf) {
	/** @type {Map<string, SparePair>} */
	const pairs = new Map();
	for (const { pid, args } of procs) {
		const [argv0 = "", role, ...rest] = args.trim().split(/[ \t]+/);
		const socket = args.match(SPARE_SOCKET)?.[1];
		if (!socket || !isClaude(argv0)) continue;
		let pair = pairs.get(socket);
		if (!pair) {
			pair = {
				socket,
				pids: [],
				host: null,
				spare: null,
				claimSock: null,
				dir: null,
				idle: false,
			};
			pairs.set(socket, pair);
		}
		pair.pids.push(pid);
		if (role === "bg-pty-host") pair.host = pid;
		else if (role === "bg-spare") {
			pair.spare = pid;
			pair.claimSock = claimSocketOf(rest);
			pair.dir = pair.claimSock === null ? null : dirOf(pair.claimSock);
		}
	}
	for (const pair of pairs.values())
		pair.idle =
			pair.spare !== null &&
			pair.dir !== null &&
			cwdOf(pair.spare) === pair.dir;
	return [...pairs.values()];
}

/**
 * `pid`'s cwd as `<proc>/<pid>/cwd` names it, the path string the Python twin
 * compares, as wfc_session_count's `-ef` does not: a symlinked spare
 * directory reads claimed, high, the safe direction. Null where it has
 * exited or is not ours to read, which `sparePairs` reads as claimed
 * (#1798, #2502).
 * @param {string} pid
 * @param {string} [proc] the /proc to read, `WFC_PROC`'s stand-in in a test
 * @returns {string | null}
 */
function readProcCwd(pid, proc = "/proc") {
	try {
		return fs.readlinkSync(`${proc}/${pid}/cwd`);
	} catch {
		return null;
	}
}

module.exports = {
	countSessions,
	sparePairs,
	readProcCwd,
	SPARE_SOCKET,
};
