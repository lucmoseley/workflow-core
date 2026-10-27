/*
 * orphan-hooks.js — which hook runs outlived whatever was waiting on them, and
 * the kill that ends each one with its group: the judgement and the effect for
 * scripts/reap-orphan-hooks.js, its one caller, with /proc's root, the clock,
 * the kill and the log handed in (#2922).
 *
 * The incident it answers: docs/environment.md §7, 25 Oct 2026.
 *
 * THE SIGNATURE IS THREE FACTS TOGETHER:
 *
 *   1. IT RUNS A GUARD OR A REGISTERED HOOK INVOCATION: any `scripts/guard-*`
 *      script, by path alone (isGuard says why), or the script a hook command names,
 *      as argv[0] or as an interpreter's first operand, followed by exactly the
 *      arguments that command passes. Exact arguments are what spare a hook
 *      script's deliberately detached child — `session-arbiter.js
 *      prune-markers`, `audit-escape-lines.js --judge` — which has init for a
 *      parent by design and no hook timeout bounding it. A fork of a bash guard
 *      keeps its parent's argv, so it matches too.
 *   2. ITS PARENT IS AN INIT: pid 1, a process whose argv[0] is `init` or
 *      `/init`, or a `systemd` — on WSL an orphan reparents to its session
 *      `/init`, not pid 1.
 *   3. IT IS OLDER THAN THE CEILING: the longest timeout any registered hook
 *      carries plus MARGIN_S.
 *
 * WHAT IS KILLED. Claude Code starts every hook as a session and group leader,
 * so a matched process leading its own group takes the whole group. A matched
 * process that leads none — the incident's shape, a fork in a harness's group —
 * takes the group too where every live member of it is matched or descends
 * from one, since nothing else is left in it; otherwise only its own descendant
 * tree. Every kill is SIGKILL.
 *
 * A RECYCLED PID IS NEVER KILLED: each target's start time is read again just
 * before the kill and must match the snapshot's.
 *
 * /proc is read through lib/proc-table.js.
 */

const path = require("node:path");
const { ageSeconds, readStartTicks } = require("./proc-table.js");

/* Claude Code's timeout for a command hook that sets none: "Defaults: 600 for
 * `command`" (code.claude.com/docs/en/hooks). */
const DEFAULT_HOOK_TIMEOUT_S = 600;

/* Slack past the longest timeout before a run counts as orphaned. A guess,
 * against no measurement: room for a cancelled hook's own exit to land. */
const MARGIN_S = 60;

/* How much of a killed process's argv the log keeps — memwatch's own bound
 * (docs/environment.md §4). */
const ARGV_KEPT = 512;

const INTERPRETER = /^(?:ba|da)?sh$|^node$/;
const INIT = /^(?:init|systemd)$/;
/* Where a hook command's own arguments stop. */
const COMMAND_END = /^(?:\|\||&&|;|\||[0-9]*>.*|<.*)$/;

/**
 * @typedef {import("./proc-table.js").Proc} Proc
 * @typedef {{ script: string, args: string[] }} Invocation `script` relative
 *   to `scripts/`, so any checkout's copy matches
 * @typedef {{ type?: string, command?: string, args?: unknown, timeout?: number }} Hook
 * @typedef {Record<string, Array<{ hooks?: Hook[] }>>} Hooks
 * @typedef {{ pid: number, pgid: number, scope: "group"|"tree", ageS: number,
 *   argv: string[], targets: Proc[] }} Reap
 */

/**
 * The invocation one hook command makes of a core script, or null where it
 * names none.
 * @param {Hook} hook
 * @returns {Invocation | null}
 */
function invocationOf(hook) {
	if (typeof hook.command !== "string") return null;
	const words = hook.command.split(/\s+/).map((w) => w.replace(/["']/g, ""));
	const at = words.findIndex((w) => /(?:^|\/)scripts\/\S+$/.test(w));
	const named = words[at];
	if (named === undefined) return null;
	const script = named.replace(/^.*?(?:^|\/)scripts\//, "");
	const tail = words.slice(at + 1);
	const end = tail.findIndex((w) => COMMAND_END.test(w));
	const args = end === -1 ? tail : tail.slice(0, end);
	const extra = Array.isArray(hook.args) ? hook.args.map(String) : [];
	return { script, args: [...args.filter(Boolean), ...extra] };
}

/**
 * Every invocation `hooks` registers, and the ceiling past which a run of one
 * is orphaned.
 * @param {Hooks} hooks
 */
function readRegistry(hooks) {
	/** @type {Invocation[]} */
	const invocations = [];
	let longest = 0;
	for (const groups of Object.values(hooks))
		for (const group of groups ?? [])
			for (const hook of group.hooks ?? []) {
				const inv = invocationOf(hook);
				if (!inv) continue;
				invocations.push(inv);
				longest = Math.max(longest, hook.timeout ?? DEFAULT_HOOK_TIMEOUT_S);
			}
	return { invocations, ceilingS: longest + MARGIN_S };
}

/**
 * A guard, registered or not and whatever its arguments: a harness may run a
 * copy the registry does not name (#2922). No guard detaches a
 * child of its own, so an orphaned guard is never one meant to outlive its
 * hook.
 * @param {string} script relative to `scripts/`
 */
const isGuard = (script) => /^guard-[^/]+\.(?:sh|js)$/.test(script);

/** @param {string[]} a @param {string[]} b */
const isSameArgs = (a, b) =>
	a.length === b.length && a.every((w, i) => w === b[i]);

/**
 * Whether `argv` runs one of `invocations`, exactly.
 * @param {string[]} argv
 * @param {Invocation[]} invocations
 */
function isHookInvocation(argv, invocations) {
	const head = argv[0] ?? "";
	/* A compound hook command — `command -v node && node …/x.js --notify ||
	 * true` — runs as `sh -c <command>`, its node a child of that shell. */
	if (argv[1] === "-c" && INTERPRETER.test(path.basename(head))) {
		const inv = invocationOf({ command: argv[2] ?? "" });
		return (
			inv !== null &&
			(isGuard(inv.script) ||
				invocations.some(
					(i) => i.script === inv.script && isSameArgs(i.args, inv.args),
				))
		);
	}
	let at = 0;
	if (INTERPRETER.test(path.basename(head))) {
		at = argv.findIndex((w, i) => i > 0 && !w.startsWith("-"));
		if (at === -1) return false;
	}
	const word = argv[at] ?? "";
	const rest = argv.slice(at + 1);
	const guard = /(?:^|\/)scripts\/(guard-[^/]+)$/.exec(word);
	if (guard?.[1] && isGuard(guard[1])) return true;
	return invocations.some(
		(inv) =>
			(word === `scripts/${inv.script}` ||
				word.endsWith(`/scripts/${inv.script}`)) &&
			isSameArgs(rest, inv.args),
	);
}

/** @param {number} ppid @param {string | undefined} parentArgv0 */
const isInit = (ppid, parentArgv0) =>
	ppid <= 1 ||
	(parentArgv0 !== undefined && INIT.test(path.basename(parentArgv0)));

/**
 * `pid` and everything descending from it.
 * @param {Map<number, number[]>} children parent pid to child pids
 * @param {number} pid
 */
function subtree(children, pid) {
	const seen = new Set([pid]);
	const queue = [pid];
	for (let next = queue.shift(); next !== undefined; next = queue.shift())
		for (const child of children.get(next) ?? [])
			if (!seen.has(child)) {
				seen.add(child);
				queue.push(child);
			}
	return seen;
}

/**
 * The orphaned hook runs in `procs` and what each kill takes, oldest first.
 * `mine` — this process and its ancestors — is never matched or killed.
 * @param {Map<number, Proc>} procs
 * @param {{ invocations: Invocation[], ceilingS: number, bootAgo: number, mine: Set<number> }} at
 * @returns {{ reaps: Reap[], young: number }}
 */
function findOrphanHooks(procs, { invocations, ceilingS, bootAgo, mine }) {
	const ageOf = (/** @type {Proc} */ p) => ageSeconds(p, bootAgo);
	/** @type {Proc[]} */
	const orphans = [];
	let young = 0;
	for (const p of procs.values()) {
		if (mine.has(p.pid)) continue;
		if (!isInit(p.ppid, procs.get(p.ppid)?.argv[0])) continue;
		if (!isHookInvocation(p.argv, invocations)) continue;
		if (ageOf(p) < ceilingS) young++;
		else orphans.push(p);
	}
	orphans.sort((a, b) => ageOf(b) - ageOf(a));
	const reaps = planReaps(procs, orphans, mine).map(
		({ orphan, scope, targets }) => ({
			pid: orphan.pid,
			pgid: orphan.pgid,
			scope,
			ageS: Math.round(ageOf(orphan)),
			argv: orphan.argv,
			targets,
		}),
	);
	return { reaps, young };
}

/**
 * Whether `orphan`'s kill takes its whole group: never one holding a process
 * of `mine`; always one it leads; else one whose every member is `covered` —
 * matched, or descending from a match.
 * @param {Proc} orphan
 * @param {Proc[]} members
 * @param {{ mine: Set<number>, covered: Set<number> }} sets
 */
const isWholeGroupKill = (orphan, members, { mine, covered }) =>
	!members.some((m) => mine.has(m.pid)) &&
	(orphan.pgid === orphan.pid || members.every((m) => covered.has(m.pid)));

/**
 * What each orphan's kill takes, a process taken by an earlier one left out
 * of a later.
 * @param {Map<number, Proc>} procs
 * @param {Proc[]} orphans
 * @param {Set<number>} mine
 */
function planReaps(procs, orphans, mine) {
	/** @type {Map<number, number[]>} */
	const children = new Map();
	for (const p of procs.values())
		children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
	/** @type {Set<number>} */
	const covered = new Set();
	for (const o of orphans)
		for (const pid of subtree(children, o.pid)) covered.add(pid);

	/** @type {Set<number>} */
	const taken = new Set();
	/** @type {Array<{ orphan: Proc, scope: "group"|"tree", targets: Proc[] }>} */
	const plans = [];
	for (const orphan of orphans) {
		if (taken.has(orphan.pid)) continue;
		const members = [...procs.values()].filter((p) => p.pgid === orphan.pgid);
		const wholeGroup = isWholeGroupKill(orphan, members, { mine, covered });
		const own = subtree(children, orphan.pid);
		const pids = wholeGroup
			? new Set([...members.map((m) => m.pid), ...own])
			: own;
		const targets = [...pids]
			.filter((pid) => !mine.has(pid) && !taken.has(pid))
			.map((pid) => procs.get(pid))
			.filter((p) => p !== undefined);
		for (const t of targets) taken.add(t.pid);
		plans.push({ orphan, scope: wholeGroup ? "group" : "tree", targets });
	}
	return plans;
}

/**
 * Kill each reap's targets, logging one line per reap. A group whose every
 * snapshot member still holds its start time is killed by pgid, taking any
 * member forked since; otherwise each target whose start time still matches
 * is killed on its own.
 * @param {Reap[]} reaps
 * @param {{ root: string, kill: (pid: number, signal: "SIGKILL") => void,
 *   log: (entry: Record<string, unknown> & { at: string }) => boolean }} io
 */
function killReaps(reaps, { root, kill, log }) {
	return reaps.map((r) => {
		const live = r.targets.filter(
			(t) => readStartTicks(root, t.pid) === t.startTicks,
		);
		/** @type {number[]} */
		const killed = [];
		/** @type {string[]} */
		const errors = [];
		const send = (
			/** @type {number} */ target,
			/** @type {number[]} */ pids,
		) => {
			try {
				kill(target, "SIGKILL");
				killed.push(...pids);
			} catch (e) {
				errors.push(`${target}: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		if (r.scope === "group" && live.length === r.targets.length)
			send(
				-r.pgid,
				live.map((t) => t.pid),
			);
		else for (const t of live) send(t.pid, [t.pid]);
		const logged = log({
			at: new Date().toISOString(),
			pid: r.pid,
			pgid: r.pgid,
			scope: r.scope,
			ageS: r.ageS,
			argv: r.argv.join(" ").slice(0, ARGV_KEPT),
			/* A pgid kill also takes any member forked after the snapshot,
			 * which no line names. */
			byPgid: r.scope === "group" && live.length === r.targets.length,
			targets: live.map((t) => ({
				pid: t.pid,
				argv: t.argv.join(" ").slice(0, ARGV_KEPT),
			})),
			killed,
			gone: r.targets.length - live.length,
			...(errors.length > 0 ? { errors } : {}),
		});
		return { ...r, killed, errors, logged };
	});
}

module.exports = {
	findOrphanHooks,
	isInit,
	killReaps,
	readRegistry,
};
