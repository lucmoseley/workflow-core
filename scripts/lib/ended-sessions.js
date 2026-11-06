/*
 * ended-sessions.js — which processes outlived the Claude session that started
 * them, and the tree each kill takes (#4342): the judgement for
 * reap-orphan-hooks.js's ORPHAN-SESSION part, with /proc's root handed in.
 * It backs up the per-session scope (#4341), whose session can die without
 * its watcher, and covers every launch route #4333 found uncontained.
 *
 * A PROCESS IS A SESSION'S by its environ: `CLAUDE_CODE_SESSION_ID` names the
 * session and `CLAUDE_PID` its leader, the daemon spare every hook and tool
 * child inherits (#4341 Q1). Both must be set. lib/session-id.js's
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
 * at a Claude process, which is a session of its own. lib/orphan-hooks.js's
 * killReaps sends each SIGKILL, re-reading start times first.
 */

const { isClaudeArgv0 } = require("./claude-argv0.js");
const { isInit, subtree } = require("./orphan-hooks.js");
const { readEnvironVars } = require("./proc-environ.js");
const { ageSeconds } = require("./proc-table.js");

const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
const LEADER_ENV = "CLAUDE_PID";

/**
 * @typedef {import("./proc-table.js").Proc} Proc
 * @typedef {import("./orphan-hooks.js").Reap & {
 *   session: { id: string, leader: number } }} SessionReap
 */

/**
 * Whether `argv` is a Claude process's. A daemon spare's argv is rewritten
 * into one word, `claude bg-spare --bg-spare <sock>` (#4341 Q1), so its first
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
		if (!isClaude(p.argv))
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
	/** @type {Array<{ proc: Proc, session: { id: string, leader: number } }>} */
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

/** The session a report names: its id, and its leader's pid.
 * @param {{ id: string, leader: number }} session */
const describeSession = (session) =>
	`session ${session.id} (leader pid ${session.leader})`;

module.exports = {
	describeSession,
	findEndedSessions,
	isClaude,
	LEADER_ENV,
	SESSION_ENV,
};
