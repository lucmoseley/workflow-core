const fs = require("node:fs");
const { isClaudeArgv0 } = require("./claude-argv0.js");
const { procRoot } = require("./proc-root.js");

/** @param {string} argv0 */
const isClaude = (argv0) => isClaudeArgv0(argv0.replaceAll("\\", "/"));

const SPARE_SOCKET = /\/spare\/([A-Za-z0-9]+)\./;

/** @param {string[]} rest */
function claimSocketOf(rest) {
	let sock = null;
	for (const [i, word] of rest.entries()) {
		const next = rest[i + 1];
		if (word === "--bg-spare" && next !== undefined) sock = next;
	}
	return sock;
}

const dirOf = (/** @type {string} */ p) => p.replace(/\/[^/]*$/, "");

/**
 * @param {string} psText
 * @param {(pid: string) => string | null} cwdOf
 * @returns {number}
 */
function countSessions(psText, cwdOf) {
	/** @type {{ pid: string, args: string }[]} */
	const procs = [];
	for (const line of psText.split("\n")) {
		const m = line.trim().match(/^(\S+)[ \t]+\S+[ \t]+((?![ \t]).+)$/);
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
 * }} SparePair
 */

/**
 * @param {{ pid: string, args: string }[]} procs
 * @param {(pid: string) => string | null} cwdOf
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

/** @param {string} args */
const isDaemon = (args) =>
	isClaude(args.trim().split(/[ \t]+/)[0] ?? "") &&
	/(^|[ \t])daemon[ \t]+run([ \t]|$)/.test(args);

/**
 * @param {string} pid
 * @param {string} [proc]
 * @returns {string | null}
 */
function readProcCwd(pid, proc = procRoot()) {
	try {
		return fs.readlinkSync(`${proc}/${pid}/cwd`);
	} catch {
		return null;
	}
}

module.exports = {
	countSessions,
	sparePairs,
	isDaemon,
	readProcCwd,
	SPARE_SOCKET,
};
