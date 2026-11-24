#!/usr/bin/env node

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { isInit } = require("./lib/orphan-hooks.js");
const { describeAge, MINUTE_MS } = require("./lib/age-text.js");
const {
	ageSeconds,
	ownTree,
	readProcTable,
	readUptime,
} = require("./lib/proc-table.js");
const { procRoot } = require("./lib/proc-root.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseWatcherArgv } = require("./lib/session-scope.js");

// guess, lucmoseley/mantahostels#2012
const ORPHAN_AFTER_MINUTES = 30;

// guess over a measured worst of five, lucmoseley/mantahostels#2012
const MAX_LISTED = 10;

// guess, lucmoseley/mantahostels#2012
const WINDOW = 160;

/** @param {string} argv */
const isWaitLoop = (argv) =>
	/\b(?:while|until)\b/.test(argv) && /\bsleep\b/.test(argv);

/**
 * @param {string} argv
 */
function shorten(argv) {
	const flat = argv.replace(/\s+/g, " ");
	if (flat.length <= WINDOW) return flat;
	const at = flat.search(/\b(?:while|until)\b/);
	const from = at > 0 ? Math.max(0, at - 20) : 0;
	const clip = flat.slice(from, from + WINDOW);
	return `${from ? "…" : ""}${clip}${from + WINDOW < flat.length ? "…" : ""}`;
}

/**
 * @param {import("./lib/proc-table.js").Proc} proc
 * @param {Map<number, import("./lib/proc-table.js").Proc>} table
 */
function isLiveLeaderWatcher(proc, table) {
	const leader = parseWatcherArgv(proc.argv);
	return (
		leader !== null && table.get(leader.pid)?.startTicks === leader.startTicks
	);
}

/**
 * @typedef {{ pid: number, ageMinutes: number, argv: string, kill: string }} Orphan
 */

/**
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
		if (isLiveLeaderWatcher(proc, table)) continue;
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
			`pid ${o.pid} — sleeping in a wait loop for ${describeAge(o.ageMinutes * MINUTE_MS)}, parent is init`,
			o,
		);

	if (orphans.length > 0) {
		ctx.say(
			`ORPHAN-WAIT-LOOP (${orphans.length}) — a wait loop whose session is gone, over ${minutes}m:`,
		);
		for (const o of listed)
			ctx.say(
				`  pid ${o.pid}, ${describeAge(o.ageMinutes * MINUTE_MS)}\n` +
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
		if (reading === null)
			ctx.skip(
				`${root} could not be enumerated, so what is running is unknown — not nothing.`,
			);
		const read = /** @type {NonNullable<ReturnType<typeof readProcTable>>} */ (
			reading
		);
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
