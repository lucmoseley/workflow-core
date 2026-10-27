#!/usr/bin/env node
/*
 * reap-orphan-hooks.js — kill every hook run that outlived its hook timeout
 * with no parent left to wait on it, together with its group, and log each
 * kill (workflow-core#2922).
 *
 * Usage:  npm run reap:orphan-hooks  [--notify] [--json]
 *
 * WHY A KILL AND NOT A REPORT, unlike check-orphan-wait-loops.js: an orphaned
 * hook run has nothing waiting on its answer, while every hook call
 * machine-wide may be blocking behind it (docs/environment.md §7).
 *
 * The signature, what a kill takes and why: lib/orphan-hooks.js.
 *
 * THE REGISTRY IS THE RUNNING HOOKS — the self-plugin's at the core, the
 * plugin's plus the host's settings at an adopter (lib/core-hooks.js) — read
 * fresh each run.
 *
 * EVERY KILL IS LOGGED, one JSON line in `.orphan-hook-reaps.jsonl` under the
 * canonical checkout's .claude/tmp/markers (lib/orphan-hooks.js's killReaps
 * writes its fields). Lines are kept
 * RETAIN_MS. An unwritable log costs the line, never the kill.
 *
 * WFC_PROC_ROOT REPLACES /proc (lib/proc-table.js). A run against it names
 * what it would kill and kills and logs nothing — unless WFC_REAP_FAKE_ROOT
 * is `kill`, which a test sets to cross the real kill and log against a fake
 * root that links in only its own orphan (workflow-core#3057).
 *
 * DEGRADES TO SILENCE: no /proc, a hidepid root that lists pids of which not
 * one reads, or an unreadable uptime leave through ctx.skip(). An unparseable
 * hook file is the apparatus failing, and is BROKEN.
 *
 * RESIDUAL: it runs at session start alone, so a machine on which no session
 * starts keeps its orphans until one does. A hook's child running a different
 * script, orphaned with its own parent gone, is not matched.
 *
 * IMPLICIT:  at every session start, SIGKILLs every process on this machine that runs any `scripts/guard-*` script or a registered hook invocation, has an init for a parent and is older than the longest registered hook timeout plus a minute, together with its process group where it leads it or the group holds nothing else, else its descendant tree; appends one line per kill to `.orphan-hook-reaps.jsonl` under the canonical checkout's .claude/tmp/markers; and names each kill in the session.
 * JUSTIFIED: fail-safe — an orphaned hook run has nothing waiting on its answer, and one left spinning timed out every session's hooks for eleven hours (workflow-core#2922); a run that cannot read /proc kills nothing.
 * DEFEAT:    none at the hook; WFC_PROC_ROOT on a hand run reads a fixture and kills nothing.
 */

const { runCheck } = require("./lib/check");
const path = require("node:path");
const { readRunningHooks } = require("./lib/core-hooks.js");
const { hostRoot } = require("./lib/host-root.js");
const { markersDir } = require("./lib/marker-root.js");
const { DAY_MS, appendRetained } = require("./lib/retained-jsonl.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	findOrphanHooks,
	killReaps,
	readRegistry,
} = require("./lib/orphan-hooks.js");
const {
	describeAge,
	ownTree,
	procRoot,
	readProcTable,
	readUptime,
} = require("./lib/proc-table.js");

const REAP_LOG = ".orphan-hook-reaps.jsonl";
/* 30 days, chosen and not measured: a month of incident traces, the span
 * queue-exit-log.js keeps for the same kind of record. */
const RETAIN_MS = 30 * DAY_MS;

/* How much of an argv the session report prints: two terminal lines at this
 * repo's usual width, check-orphan-wait-loops.js's WINDOW. A guess. */
const ARGV_SHOWN = 160;

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<import("./lib/orphan-hooks.js").Reap & { errors: string[] }>} done
 * @param {{ ceilingS: number, fixture: boolean, logFile: string|null }} at
 */
function report(ctx, done, { ceilingS, fixture, logFile }) {
	for (const r of done)
		ctx.warn(
			"ORPHAN-HOOK",
			`pid ${r.pid} — a hook run orphaned for ${describeAge(r.ageS)}, ${fixture ? "not killed (fixture root)" : `${r.scope} killed`}`,
			{ ...r, targets: r.targets.map((t) => t.pid) },
		);
	if (done.length === 0) return;
	ctx.say(
		`ORPHAN-HOOK (${done.length}) — a hook run with init for a parent, older than the ${ceilingS}s hook ceiling:`,
	);
	for (const r of done) {
		ctx.say(
			`  pid ${r.pid}, ${describeAge(r.ageS)}, ${r.scope} of ${r.targets.length}: ${r.argv.join(" ").slice(0, ARGV_SHOWN)}`,
		);
		if (r.errors.length > 0) ctx.say(`    kill failed: ${r.errors.join("; ")}`);
	}
	ctx.say(
		fixture
			? "\n  A fixture /proc root: nothing was killed or logged.\n"
			: `\n  Killed, and logged to ${logFile ?? "nowhere: git names no canonical checkout"}.\n` +
					"  Trace the source from the argv: a scratch harness's spawnSync timeout\n" +
					"  is the known one (docs/environment.md §7).\n",
	);
}

runCheck({
	name: "orphan-hooks",
	usage: "node reap-orphan-hooks.js [--notify] [--json]",
	run(ctx) {
		const root = procRoot();
		const reading = readProcTable(root);
		if (reading === null)
			ctx.skip(
				`${root} could not be enumerated, so what is running is unknown.`,
			);
		const read = /** @type {NonNullable<typeof reading>} */ (reading);
		if (read.unreadable && read.unreadable === read.listed)
			ctx.skip(
				`${root} lists ${read.listed} process(es) and not one of them would read, so what is running is unknown.`,
			);
		const uptime = readUptime(root);
		if (uptime === null)
			ctx.skip(
				`${path.join(root, "uptime")} could not be read, so no process's age can be derived.`,
			);

		const { invocations, ceilingS } = readRegistry(
			readRunningHooks(hostRoot(), { quiet: true }),
		);
		const { reaps, young } = findOrphanHooks(read.procs, {
			invocations,
			ceilingS,
			bootAgo: /** @type {number} */ (uptime),
			mine: ownTree(read.procs),
		});

		const fixture =
			root !== "/proc" && process.env.WFC_REAP_FAKE_ROOT !== "kill";
		const canonical = fixture ? null : repoRoot();
		const logFile = canonical
			? path.join(markersDir(canonical), REAP_LOG)
			: null;
		const done = fixture
			? reaps.map((r) => ({ ...r, killed: [], errors: [], logged: false }))
			: killReaps(reaps, {
					root,
					kill: (pid, signal) => process.kill(pid, signal),
					log: (entry) => appendRetained(logFile, entry, RETAIN_MS),
				});

		report(ctx, done, { ceilingS, fixture, logFile });

		return {
			okLine: `no orphaned hook run past ${ceilingS}s in ${read.procs.size} process(es).`,
			noun: "orphaned hook run(s)",
			data: {
				reaps: done.map((r) => ({
					...r,
					targets: r.targets.map((t) => t.pid),
				})),
				ceilingS,
				young,
				processes: read.procs.size,
				procRoot: root,
				log: logFile,
			},
		};
	},
});
