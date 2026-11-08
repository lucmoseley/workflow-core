#!/usr/bin/env node
/*
 * reap-orphan-hooks.js — kill every hook run that outlived its hook timeout
 * with no parent left to wait on it, together with its group, and log each
 * kill (#2922).
 *
 * Usage:  npm run reap:orphan-hooks  [--notify] [--json]
 *
 * WHY A KILL AND NOT A REPORT, unlike check-orphan-wait-loops.js: an orphaned
 * hook run has nothing waiting on its answer, while every hook call
 * machine-wide may be blocking behind it (docs/environment.md §7).
 *
 * The signature, what a kill takes and why: lib/orphan-hooks.js.
 *
 * AND EVERY PROCESS OF A SUITE RUN WHOSE WRAPPER IS GONE (#3528): a SIGKILLed
 * run-vitest.js runs no handler, so its reparented workers live on until a
 * sweep from outside it (lib/suite-ceiling.js's sweepOrphanedRuns) finds them.
 * Those kills are named in the session, never logged.
 *
 * AND EVERY PROCESS WHOSE CLAUDE SESSION HAS ENDED (#4342), reparented to an
 * init: the judgement is lib/ended-sessions.js's.
 *
 * IT ALSO RUNS WITH NO SESSION OPEN, every few minutes, from a user timer
 * (start-orphan-sweep-timer.js). A session start's run names the logged
 * kills no start in its checkout has named yet.
 *
 * THE REGISTRY IS THE RUNNING HOOKS — the self-plugin's at the core, the
 * plugin's plus the host's settings at an adopter (lib/core-hooks.js) — read
 * fresh each run.
 *
 * EVERY KILL IS LOGGED, one JSON line in `.orphan-hook-reaps.jsonl` under the
 * canonical checkout's .claude/tmp/markers (lib/orphan-hooks.js's killReaps
 * writes its fields). Lines are kept
 * RETAIN_MS. Each log's directory is made first. An unwritable log costs the
 * line, never the kill, and the report then says the write failed.
 *
 * WFC_PROC REPLACES /proc (lib/proc-root.js). A run against it names
 * what it would kill and kills and logs nothing — unless WFC_REAP_FAKE_ROOT
 * is `kill`, which a test sets to cross the real kill and log against a fake
 * root that links in only its own orphan (#3057).
 *
 * DEGRADES TO SILENCE: no /proc, a hidepid root that lists pids of which not
 * one reads, or an unreadable uptime leave through ctx.skip(). An unparseable
 * hook file is the apparatus failing, and is BROKEN.
 *
 * RESIDUAL: a machine with no systemd user manager has no timer, so there it
 * runs at session start alone. A hook's child running a different script,
 * orphaned with its own parent gone, is not matched while its session lives.
 *
 * IMPLICIT:  at every session start, and every few minutes from a user timer, SIGKILLs every process on this machine that runs any `scripts/guard-*` script or a registered hook invocation, has an init for a parent and is older than the longest registered hook timeout plus a minute, together with its process group where it leads it or the group holds nothing else, else its descendant tree; appends one line per kill to `.orphan-hook-reaps.jsonl` under the canonical checkout's .claude/tmp/markers; SIGKILLs every process whose WFC_INFLIGHT_OWNER names a run-vitest.js pid no longer running; SIGKILLs every process with an init for a parent whose CLAUDE_CODE_SESSION_ID and CLAUDE_PID name a session whose leader is gone, with its descendants, and appends one line per kill to `~/.local/state/workflow-core/orphan-session-reaps.jsonl`, making that directory where it is missing; names each kill in the session; and at a session start names the kills that log holds that no start in this checkout has named, writing `.orphan-session-reaps-shown` under its markers.
 * JUSTIFIED: fail-safe — an orphaned hook run has nothing waiting on its answer, and one left spinning timed out every session's hooks for eleven hours (#2922); a session's worker left spinning at 80% CPU ran for eight hours unseen (2026-11-04, #4333); a run that cannot read /proc kills nothing.
 * DEFEAT:    none at the hook; WFC_PROC on a hand run reads a fixture and kills nothing.
 * TREE:      host — matches /proc against the hooks the main checkout registers
 */

const { runCheck } = require("./lib/check");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { readJsonl } = require("./lib/jsonl.js");
const { markersDir } = require("./lib/marker-root.js");
const { readRunningHooks } = require("./lib/core-hooks.js");
const { hostRoot } = require("./lib/host-root.js");
const { DAY_MS, appendRetained } = require("./lib/retained-jsonl.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	ARGV_SHOWN,
	findOrphanHooks,
	killReaps,
	readRegistry,
	reapLogPath,
} = require("./lib/orphan-hooks.js");
const {
	describeAge,
	ownTree,
	readProcTable,
	readUptime,
} = require("./lib/proc-table.js");
const { procRoot, REAL_PROC } = require("./lib/proc-root.js");
const {
	describeSession,
	findEndedSessions,
	sessionReapLog,
} = require("./lib/ended-sessions.js");
const {
	carrierUnkilled,
	killPid,
	sweepOrphanedRuns,
} = require("./lib/suite-ceiling.js");

/* 30 days, chosen and not measured: a month of incident traces, the span
 * queue-exit-log.js keeps for the same kind of record. */
const RETAIN_MS = 30 * DAY_MS;

/**
 * @typedef {{ tag: string, heading: (n: number) => string, trace: string,
 *   what: (r: import("./lib/orphan-hooks.js").Reap) => string }} Part how one
 *   part's kills read: `what` is a kill's own words, after its pid
 */

/**
 * Name each of one part's kills as a finding and in the session.
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<import("./lib/orphan-hooks.js").Reap & { errors: string[], logged: boolean }>} done
 * @param {Part} part
 * @param {{ fixture: boolean, logFile: string|null }} at
 */
function report(ctx, done, part, { fixture, logFile }) {
	for (const r of done)
		ctx.warn(
			part.tag,
			`pid ${r.pid} — ${part.what(r)}, ${fixture ? "not killed (fixture root)" : `${r.scope} of ${r.targets.length} killed`}`,
			{ ...r, targets: r.targets.map((t) => t.pid) },
		);
	if (done.length === 0) return;
	ctx.say(part.heading(done.length));
	for (const r of done) {
		ctx.say(
			`  pid ${r.pid}, ${part.what(r)}, ${r.scope} of ${r.targets.length}: ${r.argv.join(" ").slice(0, ARGV_SHOWN)}`,
		);
		if (r.errors.length > 0) ctx.say(`    kill failed: ${r.errors.join("; ")}`);
	}
	ctx.say(
		fixture
			? "\n  A fixture /proc root: nothing was killed or logged.\n"
			: `\n  ${killedLine(done, logFile)}\n${part.trace}`,
	);
}

/**
 * Where a part's kills were recorded: "logged" only for lines written.
 * @param {Array<{ logged: boolean }>} done @param {string|null} logFile
 */
function killedLine(done, logFile) {
	if (logFile === null)
		return "Killed, and logged nowhere: git names no canonical checkout.";
	const unlogged = done.filter((r) => !r.logged).length;
	if (unlogged === 0) return `Killed, and logged to ${logFile}.`;
	return unlogged === done.length
		? `Killed, but the log write to ${logFile} failed: no line records these kills.`
		: `Killed; the log write to ${logFile} failed for ${unlogged} of ${done.length}, and only the rest are logged.`;
}

/**
 * One kill's line appended to `log`, its directory made first, which a fresh
 * machine's `~/.local/state` lacks (#4706); false where it was not written.
 * @param {string|null} log
 * @param {Record<string, unknown> & { at: string }} entry
 */
function appendLog(log, entry) {
	if (log === null) return false;
	try {
		fs.mkdirSync(path.dirname(log), { recursive: true });
	} catch {
		return false;
	}
	return appendRetained(log, entry, RETAIN_MS);
}

/* Under a canonical checkout's markers: the `at` of the newest session kill
 * a session start there has named. */
const SHOWN_STAMP = ".orphan-session-reaps-shown";

/**
 * The machine log's session kills a session start in `canonical` has not yet
 * named — the timer's, made with no session open — and the stamp that marks
 * them named; null where no checkout holds a stamp.
 * @param {string|null} canonical @param {string} log
 */
function unseenSessionKills(canonical, log) {
	if (canonical === null) return null;
	const stamp = path.join(markersDir(canonical), SHOWN_STAMP);
	let since = "";
	try {
		since = fs.readFileSync(stamp, "utf8").trim();
	} catch {
		/* none yet */
	}
	let read;
	try {
		read = readJsonl(log);
	} catch {
		/* An unreadable log names nothing here; the kills still go ahead. */
		read = null;
	}
	const rows = (read?.rows ?? []).filter(
		(r) => typeof r.at === "string" && r.at > since,
	);
	return { rows, stamp };
}

/**
 * Name the timer's kills since this checkout's last session start, then
 * stamp them named.
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ rows: Record<string, unknown>[], stamp: string }} unseen
 */
function reportUnseen(ctx, { rows, stamp }) {
	if (rows.length === 0) return;
	ctx.say(
		`ORPHAN-SESSION, since this checkout's last session start (${rows.length}) — killed with no session open:`,
	);
	for (const r of rows) {
		const session =
			/** @type {import("./lib/ended-sessions.js").Session | undefined} */ (
				r.session
			);
		const line = `${r.at}: pid ${r.pid}, ${session ? describeSession(session) : "a session"} ended: ${String(r.argv ?? "").slice(0, ARGV_SHOWN)}`;
		ctx.warn("ORPHAN-SESSION", line, r);
		ctx.say(`  ${line}`);
	}
	ctx.say("");
	const newest =
		rows
			.map((r) => String(r.at))
			.sort()
			.at(-1) ?? "";
	try {
		fs.mkdirSync(path.dirname(stamp), { recursive: true });
		writeFileAtomic(stamp, `${newest}\n`);
	} catch {
		/* An unwritable stamp names them again next start, never loses one. */
	}
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
		const mine = ownTree(read.procs);
		const { reaps, young } = findOrphanHooks(read.procs, {
			invocations,
			ceilingS,
			bootAgo: /** @type {number} */ (uptime),
			mine,
		});

		const fixture =
			root !== REAL_PROC && process.env.WFC_REAP_FAKE_ROOT !== "kill";
		const canonical = fixture ? null : repoRoot();
		const logFile = canonical ? reapLogPath(canonical) : null;
		const sessionLog = sessionReapLog();
		/**
		 * @template {import("./lib/orphan-hooks.js").Reap} R
		 * @param {R[]} planned @param {string|null} log
		 */
		const kill = (planned, log) =>
			fixture
				? planned.map((r) => ({ ...r, killed: [], errors: [], logged: false }))
				: killReaps(planned, {
						root,
						kill: killPid,
						log: (entry) => appendLog(log, entry),
					});
		const at = { fixture, logFile };
		/* Read before this run's own kills, which it names itself. */
		const unseen =
			fixture || !ctx.notify || !process.env.CLAUDE_CODE_SESSION_ID
				? null
				: unseenSessionKills(canonical, sessionLog);

		const done = kill(reaps, logFile);
		report(
			ctx,
			done,
			{
				tag: "ORPHAN-HOOK",
				heading: (n) =>
					`ORPHAN-HOOK (${n}) — a hook run with init for a parent, older than the ${ceilingS}s hook ceiling:`,
				what: (r) => `a hook run orphaned for ${describeAge(r.ageS)}`,
				trace:
					"  Trace the source from the argv: a scratch harness's spawnSync timeout\n" +
					"  is the known one (docs/environment.md §7).\n",
			},
			at,
		);

		const sessionsDone = kill(
			findEndedSessions(read.procs, {
				root,
				bootAgo: /** @type {number} */ (uptime),
				mine,
				skip: new Set(reaps.flatMap((r) => r.targets.map((t) => t.pid))),
			}),
			sessionLog,
		);
		report(
			ctx,
			sessionsDone,
			{
				tag: "ORPHAN-SESSION",
				heading: (n) =>
					`ORPHAN-SESSION (${n}) — a process with init for a parent whose Claude session has ended:`,
				what: (r) =>
					`${describeAge(r.ageS)} old, ${r.session ? describeSession(r.session) : "its session"} ended`,
				trace:
					"  Trace the launch from the argv: a route the session's scope did not hold (#4333).\n",
			},
			{ fixture, logFile: sessionLog },
		);
		if (unseen) reportUnseen(ctx, unseen);

		const runs = sweepOrphanedRuns({
			proc: root,
			kill: fixture ? () => undefined : killPid,
		});
		for (const k of runs.killed)
			ctx.warn(
				"ORPHAN-RUN",
				`pid ${k.pid} — a suite run's process whose wrapper, pid ${k.owner}, is gone, ${fixture ? "not killed (fixture root)" : "killed"}`,
				k,
			);
		if (runs.unkilled)
			ctx.say(
				`ORPHAN-RUN: ${carrierUnkilled(runs.unkilled, "a suite run").trimEnd()}`,
			);

		return {
			okLine: `no orphaned hook run past ${ceilingS}s, and no process of an ended session, in ${read.procs.size} process(es).`,
			noun: "orphaned hook run(s), suite run(s) or session process(es)",
			data: {
				reaps: done.map((r) => ({
					...r,
					targets: r.targets.map((t) => t.pid),
				})),
				ceilingS,
				young,
				sessionReaps: sessionsDone.map((r) => ({
					...r,
					targets: r.targets.map((t) => t.pid),
				})),
				orphanRuns: runs,
				processes: read.procs.size,
				procRoot: root,
				log: logFile,
			},
		};
	},
});
