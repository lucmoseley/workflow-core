#!/usr/bin/env node
/*
 * check-orphan-wait-loops.js — report a HAND-ROLLED WAIT LOOP that outlived the
 * session that wrote it: a shell still sleeping in a `while`/`until` loop whose
 * parent is init, long after anyone was waiting for its condition.
 *
 * Usage:  npm run check:orphan-loops  [--minutes <n>] [--notify] [--json]
 *
 * WHAT IT IS FOR (mantahostels#2012, which found five; mantahostels#2017, the spec; mantahostels#2043, this limb).
 * A session that waits on a background suite or a neighbour's claim writes
 * `until <condition>; do sleep 5; done` inside one Bash call. Where that
 * condition can never become true the shell loops for ever, outlives its
 * session, reparents to init, and keeps holding a slot after the founder has
 * been told the session is Completed.
 *
 * THIS IS LIMB 2. `scripts/guard-wait-loop.sh` (mantahostels#2042) is limb 1 and warns
 * before such a loop is created; it is lexical and sees Bash TOOL CALLS only.
 * This limb is spelling-independent and sees every process on the machine,
 * including a loop started from the founder's own terminal.
 *
 * THE SIGNATURE IS THREE FACTS TOGETHER, and no boundedness test at all:
 *
 *   1. PARENT IS PID 1, which makes it an ORPHAN rather than a wait in progress.
 *   2. ARGV CARRIES A `while`/`until` AND A `sleep`. A `for i in $(seq 1 N)`
 *      loop cannot run for ever and is out of scope, per mantahostels#2017.
 *   3. ELAPSED OVER THE THRESHOLD, which from the sweep's vantage point already
 *      does boundedness's work.
 *
 * IT RE-REPORTS ON EVERY SESSION START while the loop still runs, deliberately
 * unlike check-ghost-jobs.js, which stamps each ghost and reports it once. A
 * ghost job is a record to retire; an orphaned loop is a live process consuming
 * a slot until someone kills it.
 *
 * /proc READING DISCIPLINE, per scripts/lib/arbiter-proc.js's header. Fields are
 * counted from the LAST ')' because the comm field is parenthesised and may
 * itself contain spaces and brackets — state is the first token after it, ppid
 * the second, start time the 20th.
 *
 * ELAPSED IS DERIVED, NOT READ: `/proc/uptime` minus `starttime / USER_HZ`.
 * USER_HZ is fixed at 100 by the Linux arm64 ABI whatever CONFIG_HZ says, and
 * Node exposes no sysconf to read it. It is not a safe-either-way guess: too
 * large silently misses orphans, too small invents them.
 *
 * DEGRADES TO SILENCE, NEVER TO "DEAD". No /proc, an unreadable root, an
 * unreadable uptime, or a root that lists pids of which NOT ONE reads — the
 * hidepid=2 shape, where an empty table would otherwise report all-clear — all
 * leave through ctx.skip(). One process whose stat line has an unexpected shape
 * is passed over on its own and counted in `unreadable`.
 *
 * IT REPORTS; A HUMAN DECIDES. WARN, never FAIL, and nothing here kills
 * anything — the report prints the `kill` and the founder runs it.
 *
 * IT SKIPS ITS OWN PROCESS TREE — this process and every ancestor of it.
 *
 * WFC_PROC_ROOT REPLACES /proc, the house seam lib/admission.js takes
 * WFC_MEMINFO by. Set it in a real environment and this sweep looks at that
 * directory rather than at the machine.
 *
 * Mutated at mantahostels#2043, eleven of them, each failing exactly its own test: dropping
 * the parent-is-init test; dropping the elapsed threshold; dropping each half of
 * the wait-loop predicate on its own; breaking the stat field counting; dropping
 * the zombie exclusion; removing the ancestor walk; removing the enumeration and
 * hidepid degrade-to-silence paths; and dropping the loop-centred argv window.
 * Removing the own-process skip fails two, both of them own-tree tests.
 *
 * IMPLICIT:  at every session start, injects a report naming each orphaned wait loop still running on this machine — every time, while it runs. It never kills one.
 * JUSTIFIED: fail-safe — such a loop is invisible to every other checker here, and a run that cannot read /proc reports nothing rather than calling a process orphaned.
 * DEFEAT:    none at the hook; --minutes <n> moves the threshold on a hand run.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");

/* The threshold, a judgement and not a measurement (mantahostels#2012). */
const ORPHAN_AFTER_MINUTES = 30;

/** Kernel clock ticks per second. See the header on why this is a constant. */
const USER_HZ = 100;

/**
 * How many loops are itemised before the rest become a count. A guess against no
 * measurement: mantahostels#2012's worst snapshot held five, so ten is headroom over the
 * only sample there is.
 */
const MAX_LISTED = 10;

/**
 * How many characters of one loop's command line are printed. A guess: two
 * terminal lines at this repo's usual width, which fits the whole of every loop
 * mantahostels#2012 quoted once the preamble is windowed off.
 */
const WINDOW = 160;

const procRoot = () => process.env.WFC_PROC_ROOT || "/proc";

/**
 * Seconds since boot, or null where /proc/uptime will not be read or parsed.
 * @param {string} root
 */
function uptimeSeconds(root) {
	let raw;
	try {
		raw = fs.readFileSync(path.join(root, "uptime"), "utf8");
	} catch {
		return null;
	}
	const seconds = Number.parseFloat(raw);
	return Number.isFinite(seconds) ? seconds : null;
}

/**
 * `{ppid, startTicks, state}` from one /proc/<pid>/stat line, or null where the
 * line has a shape this cannot read.
 *
 * The state is returned rather than judged here so the caller can tell a line it
 * FAILED to read from one it read and excluded — the two mean opposite things
 * about whether the sweep saw the machine at all.
 * @param {string} stat
 */
function parseStat(stat) {
	const close = stat.lastIndexOf(")");
	if (close === -1) return null;
	const after = stat.slice(close + 2).split(/\s+/);
	const [state, ppidField] = after;
	const startField = after[19];
	if (
		state === undefined ||
		ppidField === undefined ||
		startField === undefined
	)
		return null;
	const ppid = Number.parseInt(ppidField, 10);
	const startTicks = Number.parseInt(startField, 10);
	if (!Number.isFinite(ppid) || !Number.isFinite(startTicks)) return null;
	return { ppid, startTicks, state };
}

/**
 * Every readable process, keyed by pid. A pid that vanishes mid-walk, or whose
 * stat will not parse, is passed over in silence.
 * @param {string} root
 */
function readProcesses(root) {
	let entries;
	try {
		entries = fs.readdirSync(root);
	} catch {
		return null;
	}

	/** @type {Map<number, {pid: number, ppid: number, startTicks: number, argv: string}>} */
	const procs = new Map();
	let listed = 0;
	let unreadable = 0;
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		listed++;
		const pid = Number.parseInt(entry, 10);
		let stat;
		let cmdline;
		try {
			stat = fs.readFileSync(path.join(root, entry, "stat"), "utf8");
			cmdline = fs.readFileSync(path.join(root, entry, "cmdline"), "utf8");
		} catch {
			unreadable++;
			continue;
		}
		const parsed = parseStat(stat);
		if (!parsed) {
			unreadable++;
			continue;
		}
		/* A zombie (Z) or a dying process (X) keeps its stat entry until its
		 * parent reaps it, and it is not looping — arbiter-proc.js's exclusion,
		 * taken for the same reason. Read, not unreadable. */
		if (parsed.state === "Z" || parsed.state === "X") continue;
		// cmdline is NUL-separated and NUL-terminated; a kernel thread's is empty.
		const argv = cmdline.replace(/\0+$/, "").split("\0").join(" ").trim();
		if (!argv) continue;
		procs.set(pid, { pid, ...parsed, argv });
	}
	return { procs, listed, unreadable };
}

/**
 * This process and every ancestor of it. Walked over the snapshot rather than up
 * live /proc so the fixture tree answers the same way, and bounded by the map's
 * own size so a cycle cannot loop for ever.
 * @param {Map<number, {ppid: number}>} procs
 */
function ownTree(procs) {
	const mine = new Set();
	let pid = process.pid;
	for (let hops = 0; hops <= procs.size; hops++) {
		if (mine.has(pid) || pid <= 1) break;
		mine.add(pid);
		const proc = procs.get(pid);
		if (!proc) break;
		pid = proc.ppid;
	}
	// Never in the snapshot on a fixture root, where the walk above stops at once.
	mine.add(process.pid);
	mine.add(process.ppid);
	return mine;
}

/** @param {string} argv */
const isWaitLoop = (argv) =>
	/\b(?:while|until)\b/.test(argv) && /\bsleep\b/.test(argv);

/** @param {number} minutes */
function describeAge(minutes) {
	if (minutes < 90) return `${Math.floor(minutes)}m`;
	if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
	return `${Math.floor(minutes / 1440)}d`;
}

/**
 * One line of argv, truncated so a long compound command stays readable, and
 * WINDOWED ON THE LOOP rather than on the start of the string.
 *
 * The Bash tool prefixes every command with a shell-snapshot `source` line and
 * several `unalias` fixups, so a head truncation shows the reader that preamble
 * and cuts away the condition that never came true.
 * @param {string} argv
 */
function shorten(argv) {
	const flat = argv.replace(/\s+/g, " ");
	if (flat.length <= WINDOW) return flat;
	const at = flat.search(/\b(?:while|until)\b/);
	// isWaitLoop matched, so `at` is only ever -1 on a shape this cannot window.
	const from = at > 0 ? Math.max(0, at - 20) : 0;
	const clip = flat.slice(from, from + WINDOW);
	return `${from ? "…" : ""}${clip}${from + WINDOW < flat.length ? "…" : ""}`;
}

/**
 * @typedef {{ pid: number, ppid: number, startTicks: number, argv: string }} Proc
 * @typedef {{ pid: number, ageMinutes: number, argv: string, kill: string }} Orphan
 */

/**
 * The orphaned wait loops over `minutes` old, oldest first, and how many
 * matched the rest of the signature but were too young.
 * @param {Map<number, Proc>} table
 * @param {Set<number>} mine
 * @param {{ bootAgo: number, minutes: number }} at
 */
function findOrphans(table, mine, { bootAgo, minutes }) {
	/** @type {Orphan[]} */
	const orphans = [];
	let young = 0;

	for (const proc of table.values()) {
		if (mine.has(proc.pid)) continue;
		if (proc.ppid !== 1) continue;
		if (!isWaitLoop(proc.argv)) continue;
		const ageMinutes = (bootAgo - proc.startTicks / USER_HZ) / 60;
		if (ageMinutes < minutes) {
			young++;
			continue;
		}
		orphans.push({
			pid: proc.pid,
			ageMinutes,
			argv: proc.argv,
			kill: `kill ${proc.pid}`,
		});
	}

	orphans.sort((a, b) => b.ageMinutes - a.ageMinutes);
	return { orphans, young };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ orphans: Orphan[], listed: Orphan[], hidden: number, minutes: number }} found
 */
function reportOrphans(ctx, { orphans, listed, hidden, minutes }) {
	for (const o of orphans)
		ctx.warn(
			"ORPHAN-WAIT-LOOP",
			`pid ${o.pid} — sleeping in a wait loop for ${describeAge(o.ageMinutes)}, parent is init`,
			o,
		);

	if (orphans.length > 0) {
		ctx.say(
			`ORPHAN-WAIT-LOOP (${orphans.length}) — a wait loop whose session is gone, over ${minutes}m:`,
		);
		for (const o of listed)
			ctx.say(
				`  pid ${o.pid}, ${describeAge(o.ageMinutes)}\n` +
					`    ${shorten(o.argv)}\n` +
					`    ${o.kill}`,
			);
		if (hidden)
			ctx.say(`  … and ${hidden} more, not listed. Re-run for the whole set:`);
		if (hidden) ctx.say(`    node ${scriptPath("check-orphan-wait-loops.js")}`);
		ctx.say(
			"\n  Nothing was killed, and this sweep has no way to kill anything.\n" +
				"  Each is a shell that outlived its session: read the command, then run\n" +
				"  the kill above. A loop still legitimately waited on would not have\n" +
				"  init for a parent.\n",
		);
	}
}

runCheck({
	name: "orphan-wait-loops",
	usage: "node check-orphan-wait-loops.js [--minutes <n>] [--notify] [--json]",
	valueFlags: ["--minutes"],
	run(ctx) {
		const minutes = ctx.has("--minutes")
			? Number(ctx.value("--minutes"))
			: ORPHAN_AFTER_MINUTES;
		if (!Number.isFinite(minutes) || minutes < 0)
			ctx.usageError("--minutes must be a non-negative number.");

		const root = procRoot();
		const reading = readProcesses(root);
		// The machine's process table is subject, not apparatus: SKIP, never BROKEN.
		if (reading === null)
			ctx.skip(
				`${root} could not be enumerated, so what is running is unknown — not nothing.`,
			);
		const read = /** @type {NonNullable<ReturnType<typeof readProcesses>>} */ (
			reading
		);
		/*
		 * A root that lists pids of which not one reads is hidepid=2 or a hardened
		 * container, and an empty table there would report all-clear over a machine
		 * this run never saw. The test is that EVERY listed pid failed to read: a
		 * table emptied by exclusion — a machine of nothing but zombies — was seen
		 * and is genuinely all-clear.
		 */
		if (read.unreadable && read.unreadable === read.listed)
			ctx.skip(
				`${root} lists ${read.listed} process(es) and not one of them would read, so what is running is unknown — not nothing.`,
			);
		const table = read.procs;

		const uptime = uptimeSeconds(root);
		if (uptime === null)
			ctx.skip(
				`${path.join(root, "uptime")} could not be read, so no process's age can be derived — and age is half the signature.`,
			);
		const bootAgo = /** @type {number} */ (uptime);

		const mine = ownTree(table);
		const { orphans, young } = findOrphans(table, mine, { bootAgo, minutes });

		const listed = orphans.slice(0, MAX_LISTED);
		const hidden = orphans.length - listed.length;

		reportOrphans(ctx, { orphans, listed, hidden, minutes });

		return {
			okLine: `no orphaned wait loop over ${minutes}m in ${table.size} process(es).`,
			noun: "orphaned wait loop(s)",
			data: {
				orphans,
				orphanCount: orphans.length,
				listedCount: listed.length,
				hidden,
				young,
				processes: table.size,
				listed: read.listed,
				unreadable: read.unreadable,
				thresholdMinutes: minutes,
				procRoot: root,
			},
		};
	},
});
