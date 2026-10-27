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
 * THIS IS LIMB 2. `scripts/lib/wait-loop.js` (mantahostels#2042) is limb 1 and warns
 * before such a loop is created; it is lexical and sees Bash TOOL CALLS only.
 * This limb is spelling-independent and sees every process on the machine,
 * including a loop started from the founder's own terminal.
 *
 * THE SIGNATURE IS THREE FACTS TOGETHER, and no boundedness test at all:
 *
 *   1. PARENT IS AN INIT, which makes it an ORPHAN rather than a wait in
 *      progress: ppid 1 (or 0, a parent outside the pid namespace), or a
 *      parent whose argv[0] basename is `init` or `systemd` — on WSL an orphan
 *      of a Bash-tool shell reparents to its session `/init`, not pid 1
 *      (#3055). lib/orphan-hooks.js's `isInit`.
 *      Residual: a loop launched straight under an init — `wsl.exe -e bash -c`,
 *      a systemd unit's ExecStart — is live yet reads as orphaned.
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
 * /proc IS READ THROUGH lib/proc-table.js, which owns the stat parse, the
 * derivation of age from uptime, and the WFC_PROC_ROOT seam that replaces
 * /proc with a fixture directory.
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
 * Mutated at mantahostels#2043, eleven of them, each failing exactly its own test: dropping
 * the parent-is-init test; dropping the elapsed threshold; dropping each half of
 * the wait-loop predicate on its own; breaking the stat field counting; dropping
 * the zombie exclusion; removing the ancestor walk; removing the enumeration and
 * hidepid degrade-to-silence paths; and dropping the loop-centred argv window.
 * Removing the own-process skip fails two, both of them own-tree tests. The
 * stat counting, zombie exclusion, ancestor walk and enumeration now sit in
 * lib/proc-table.js (#3057); this file's tests still pin them.
 *
 * IMPLICIT:  at every session start, injects a report naming each orphaned wait loop still running on this machine — every time, while it runs. It never kills one.
 * JUSTIFIED: fail-safe — such a loop is invisible to every other checker here, and a run that cannot read /proc reports nothing rather than calling a process orphaned.
 * DEFEAT:    none at the hook; --minutes <n> moves the threshold on a hand run.
 */

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { isInit } = require("./lib/orphan-hooks.js");
const {
	ageSeconds,
	describeAge,
	ownTree,
	procRoot,
	readProcTable,
	readUptime,
} = require("./lib/proc-table.js");
const { scriptPath } = require("./lib/script-path.js");

/* The threshold, a judgement and not a measurement (mantahostels#2012). */
const ORPHAN_AFTER_MINUTES = 30;

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

/** @param {string} argv */
const isWaitLoop = (argv) =>
	/\b(?:while|until)\b/.test(argv) && /\bsleep\b/.test(argv);

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
 * @typedef {{ pid: number, ageMinutes: number, argv: string, kill: string }} Orphan
 */

/**
 * The orphaned wait loops over `minutes` old, oldest first, and how many
 * matched the rest of the signature but were too young.
 * @param {Map<number, import("./lib/proc-table.js").Proc>} table
 * @param {Set<number>} mine
 * @param {{ bootAgo: number, minutes: number }} at
 */
function findOrphans(table, mine, { bootAgo, minutes }) {
	/** @type {Orphan[]} */
	const orphans = [];
	let young = 0;

	for (const proc of table.values()) {
		if (mine.has(proc.pid)) continue;
		if (!isInit(proc.ppid, table.get(proc.ppid)?.argv[0])) continue;
		const argv = proc.argv.join(" ");
		if (!isWaitLoop(argv)) continue;
		const ageMinutes = ageSeconds(proc, bootAgo) / 60;
		if (ageMinutes < minutes) {
			young++;
			continue;
		}
		orphans.push({
			pid: proc.pid,
			ageMinutes,
			argv,
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
			`pid ${o.pid} — sleeping in a wait loop for ${describeAge(o.ageMinutes * 60)}, parent is init`,
			o,
		);

	if (orphans.length > 0) {
		ctx.say(
			`ORPHAN-WAIT-LOOP (${orphans.length}) — a wait loop whose session is gone, over ${minutes}m:`,
		);
		for (const o of listed)
			ctx.say(
				`  pid ${o.pid}, ${describeAge(o.ageMinutes * 60)}\n` +
					`    ${shorten(o.argv)}\n` +
					`    ${o.kill}`,
			);
		if (hidden)
			ctx.say(`  … and ${hidden} more, not listed. Re-run for the whole set:`);
		if (hidden) ctx.say(`    node ${scriptPath("check-orphan-wait-loops.js")}`);
		ctx.say(
			"\n  Nothing was killed, and this sweep has no way to kill anything.\n" +
				"  Each is a shell that outlived its session: read the command, then run\n" +
				"  the kill above. A loop still legitimately waited on would not usually\n" +
				"  have init for a parent.\n",
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
		const reading = readProcTable(root);
		// The machine's process table is subject, not apparatus: SKIP, never BROKEN.
		if (reading === null)
			ctx.skip(
				`${root} could not be enumerated, so what is running is unknown — not nothing.`,
			);
		const read = /** @type {NonNullable<ReturnType<typeof readProcTable>>} */ (
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

		const uptime = readUptime(root);
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
