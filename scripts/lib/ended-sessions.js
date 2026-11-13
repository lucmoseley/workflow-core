/*
 * ended-sessions.js — which processes outlived the Claude session that started
 * them, and the tree each kill takes (workflow-core#4342): the judgement for
 * reap-orphan-hooks.js's ORPHAN-SESSION part, with /proc's root handed in.
 *
 * A PROCESS IS A SESSION'S by its environ: `CLAUDE_CODE_SESSION_ID` names the
 * session and `CLAUDE_PID` its leader, the daemon spare every hook and tool
 * child inherits (workflow-core#4341 Q1). Both must be set. lib/session-id.js's
 * forgetSession strips the id from a child meant to outlive its starter — the
 * lander, the refill loop — so that child is never matched.
 *
 * THE SESSION HAS ENDED when no process holds its leader's pid, or the one
 * that does started after the matched process: a pid reused since cannot be
 * the leader of a process that predates it. Read off the snapshot, so a
 * zombie leader, which the table leaves out, reads as ended.
 *
 * WHAT IS MATCHED: a process with an init for a parent (lib/orphan-hooks.js's
 * isInit), so a live parent's child is its parent's to end. Never a Claude
 * process — the daemon a session's `claude --bg` started carries that
 * session's environ and holds every other session — and never the sweep's own
 * tree.
 *
 * WHAT IS KILLED: the matched process and its descendants, the walk stopping
 * at a Claude process, which is a session of its own, and at one carrying no
 * session id, which forgetSession marked to outlive its starter.
 * lib/orphan-hooks.js's killReaps sends each SIGKILL, re-reading start times
 * first.
 *
 * EACH KILL IS LOGGED MACHINE-WIDE, in sessionReapLog(). WFC_SESSION_REAP_LOG names another file, for a test.
 */

const os = require("node:os");
const path = require("node:path");
const { isClaudeArgv0 } = require("./claude-argv0.js");
const { isInit, subtree } = require("./orphan-hooks.js");
const { readEnvironVars } = require("./proc-environ.js");
const { ageSeconds } = require("./proc-table.js");

const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
const LEADER_ENV = "CLAUDE_PID";

/** The machine's log of every kill this part makes, one JSON line a kill. */
const sessionReapLog = () =>
	process.env.WFC_SESSION_REAP_LOG ||
	path.join(
		process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
		"workflow-core",
		"orphan-session-reaps.jsonl",
	);

/**
 * @typedef {import("./proc-table.js").Proc} Proc
 * @typedef {{ id: string, leader: number }} Session a session's id, and its
 *   leader's pid
 * @typedef {import("./orphan-hooks.js").Reap & { session: Session }} SessionReap
 */

/**
 * Whether `argv` is a Claude process's. A daemon spare's argv is rewritten
 * into one word, `claude bg-spare --bg-spare <sock>` (workflow-core#4341 Q1), so its first
 * space-separated word is the one judged.
 * @param {string[]} argv
 */
const isClaude = (argv) => isClaudeArgv0((argv[0] ?? "").split(" ")[0]);

/**
 * The session `pid` belongs to, or null where its environ will not read or
 * lacks either key.
 * @param {number} pid @param {string} root
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
 * `pid`'s session id, or null where its environ will not read or carries none.
 * @param {number} pid @param {string} root
 */
function sessionIdOf(pid, root) {
	const read = readEnvironVars(pid, [SESSION_ENV], root);
	return read.ok ? read.values[SESSION_ENV] || null : null;
}

/**
 * Whether the session led by `leader` is still running for `proc`.
 * @param {Map<number, Proc>} procs @param {number} leader @param {Proc} proc
 */
function isLeaderLive(procs, leader, proc) {
	const held = procs.get(leader);
	return held !== undefined && held.startTicks <= proc.startTicks;
}

/**
 * Every process in `procs` whose session has ended, oldest first, with the
 * tree each kill takes; a process an earlier kill takes is left out of a
 * later one. `mine` — this process and its ancestors — and `skip`, already
 * taken by another part, are never matched or killed.
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
 * The init-parented processes in `procs`, bar Claude's and the `spared`,
 * whose session has ended.
 * @param {Map<number, Proc>} procs @param {string} root
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
