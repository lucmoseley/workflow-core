const os = require("node:os");
const path = require("node:path");
const { isClaudeArgv0 } = require("./claude-argv0.js");
const { isInit, subtree } = require("./orphan-hooks.js");
const { readEnvironVars } = require("./proc-environ.js");
const { ageSeconds } = require("./proc-table.js");

const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
const LEADER_ENV = "CLAUDE_PID";

const sessionReapLog = () =>
	process.env.WFC_SESSION_REAP_LOG ||
	path.join(
		process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
		"workflow-core",
		"orphan-session-reaps.jsonl",
	);

/**
 * @typedef {import("./proc-table.js").Proc} Proc
 * @typedef {{ id: string, leader: number }} Session
 * @typedef {import("./orphan-hooks.js").Reap & { session: Session }} SessionReap
 */

/** @param {string[]} argv */
const isClaude = (argv) => isClaudeArgv0((argv[0] ?? "").split(" ")[0]);

/**
 * @param {number} pid
 * @param {string} root
 */
function sessionOf(pid, root) {
	const read = readEnvironVars(pid, [SESSION_ENV, LEADER_ENV], root);
	if (!read.ok) return null;
	const id = read.values[SESSION_ENV];
	const leader = Number(read.values[LEADER_ENV]);
	if (!id || !Number.isInteger(leader) || leader <= 0) return null;
	return { id, leader };
}

/**
 * @param {number} pid
 * @param {string} root
 */
function sessionIdOf(pid, root) {
	const read = readEnvironVars(pid, [SESSION_ENV], root);
	return read.ok ? read.values[SESSION_ENV] || null : null;
}

/**
 * @param {Map<number, Proc>} procs
 * @param {number} leader
 * @param {Proc} proc
 */
function isLeaderLive(procs, leader, proc) {
	const held = procs.get(leader);
	return held !== undefined && held.startTicks <= proc.startTicks;
}

/**
 * @param {Map<number, Proc>} procs
 * @param {{ root: string, bootAgo: number, mine: Set<number>,
 *   skip?: Set<number> }} at
 * @returns {SessionReap[]}
 */
function findEndedSessions(procs, { root, bootAgo, mine, skip = new Set() }) {
	const ageOf = (/** @type {Proc} */ p) => ageSeconds(p, bootAgo);
	const spared = (/** @type {number} */ pid) => mine.has(pid) || skip.has(pid);
	const ended = matchEnded(procs, root, spared).sort(
		(a, b) => ageOf(b.proc) - ageOf(a.proc),
	);

	/** @type {Map<number, number[]>} */
	const children = new Map();
	for (const p of procs.values())
		if (!isClaude(p.argv) && sessionIdOf(p.pid, root) !== null)
			children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
	/** @type {Set<number>} */
	const taken = new Set();
	/** @type {SessionReap[]} */
	const reaps = [];
	for (const { proc, session } of ended) {
		if (taken.has(proc.pid)) continue;
		const targets = [...subtree(children, proc.pid)]
			.filter((pid) => !spared(pid) && !taken.has(pid))
			.map((pid) => procs.get(pid))
			.filter((t) => t !== undefined);
		for (const t of targets) taken.add(t.pid);
		reaps.push({
			pid: proc.pid,
			pgid: proc.pgid,
			scope: "tree",
			ageS: Math.round(ageOf(proc)),
			argv: proc.argv,
			targets,
			session,
		});
	}
	return reaps;
}

/**
 * @param {Map<number, Proc>} procs
 * @param {string} root
 * @param {(pid: number) => boolean} spared
 */
function matchEnded(procs, root, spared) {
	/** @type {Array<{ proc: Proc, session: Session }>} */
	const ended = [];
	for (const p of procs.values()) {
		if (spared(p.pid) || isClaude(p.argv)) continue;
		if (!isInit(p.ppid, procs.get(p.ppid)?.argv[0])) continue;
		const session = sessionOf(p.pid, root);
		if (session === null || isLeaderLive(procs, session.leader, p)) continue;
		ended.push({ proc: p, session });
	}
	return ended;
}

/** @param {Session} session */
const describeSession = (session) =>
	`session ${session.id} (leader pid ${session.leader})`;

module.exports = { describeSession, findEndedSessions, sessionReapLog };
