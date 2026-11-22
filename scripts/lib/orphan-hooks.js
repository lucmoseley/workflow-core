const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { ageSeconds, readStartTicks } = require("./proc-table.js");

// https://code.claude.com/docs/en/hooks
const DEFAULT_HOOK_TIMEOUT_S = 600;

// guess, #2922
const MARGIN_S = 60;

// guess, #2922
const ARGV_KEPT = 512;

const REAP_LOG = ".orphan-hook-reaps.jsonl";

// guess, #4342
const ARGV_SHOWN = 160;

/** @param {string} canonical */
const reapLogPath = (canonical) => path.join(markersDir(canonical), REAP_LOG);

const INTERPRETER = /^(?:ba|da)?sh$|^node$/;
const INIT = /^(?:init|systemd)$/;
const COMMAND_END = /^(?:\|\||&&|;|\||[0-9]*>.*|<.*)$/;

/**
 * @typedef {import("./proc-table.js").Proc} Proc
 * @typedef {{ script: string, args: string[] }} Invocation
 * @typedef {{ type?: string, command?: string, args?: unknown, timeout?: number }} Hook
 * @typedef {Record<string, Array<{ hooks?: Hook[] }>>} Hooks
 * @typedef {{ pid: number, pgid: number, scope: "group"|"tree", ageS: number,
 *   argv: string[], targets: Proc[],
 *   session?: import("./ended-sessions.js").Session }} Reap
 */

/**
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

/** @param {Hooks} hooks */
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

/** @param {string} script */
const isGuard = (script) => /^guard-[^/]+\.(?:sh|js)$/.test(script);

/** @param {string[]} a @param {string[]} b */
const isSameArgs = (a, b) =>
	a.length === b.length && a.every((w, i) => w === b[i]);

/**
 * @param {string[]} argv
 * @param {Invocation[]} invocations
 */
function isHookInvocation(argv, invocations) {
	const head = argv[0] ?? "";
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
 * @param {Map<number, number[]>} children
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
 * @param {Proc} orphan
 * @param {Proc[]} members
 * @param {{ mine: Set<number>, covered: Set<number> }} sets
 */
const isWholeGroupKill = (orphan, members, { mine, covered }) =>
	!members.some((m) => mine.has(m.pid)) &&
	(orphan.pgid === orphan.pid || members.every((m) => covered.has(m.pid)));

/**
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
 * @template {Reap} R
 * @param {R[]} reaps
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
			byPgid: r.scope === "group" && live.length === r.targets.length,
			targets: live.map((t) => ({
				pid: t.pid,
				argv: t.argv.join(" ").slice(0, ARGV_KEPT),
			})),
			killed,
			gone: r.targets.length - live.length,
			...(r.session ? { session: r.session } : {}),
			...(errors.length > 0 ? { errors } : {}),
		});
		return { ...r, killed, errors, logged };
	});
}

module.exports = {
	ARGV_SHOWN,
	findOrphanHooks,
	isInit,
	killReaps,
	readRegistry,
	reapLogPath,
	subtree,
};
