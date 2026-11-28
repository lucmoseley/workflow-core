#!/usr/bin/env node
// #5865

const { runCheck } = require("./lib/check");
const { ignoreFailure, parseErrorText } = require("./lib/caught.js");
const { readText } = require("./lib/file-read.js");
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
const { describeAge } = require("./lib/age-text.js");
const { ownTree, readProcTable, readUptime } = require("./lib/proc-table.js");
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

// #2922 guess
const RETAIN_MS = 30 * DAY_MS;

/**
 * @typedef {{ tag: string, heading: (n: number) => string, trace: string,
 *   what: (r: import("./lib/orphan-hooks.js").Reap) => string }} Part
 */

/**
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
			: `\n  ${buildKilledLine(done, logFile)}\n${part.trace}`,
	);
}

/**
 * @param {Array<{ logged: boolean }>} done
 * @param {string|null} logFile
 */
function buildKilledLine(done, logFile) {
	if (logFile === null)
		return "Killed; no line records these kills: git names no canonical checkout.";
	const unlogged = done.filter((r) => !r.logged).length;
	if (unlogged === 0) return `Killed, and logged to ${logFile}.`;
	return unlogged === done.length
		? `Killed, but the log write to ${logFile} failed: no line records these kills.`
		: `Killed; the log write to ${logFile} failed for ${unlogged} of ${done.length}, and only the rest are logged.`;
}

/**
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

const SHOWN_STAMP = ".orphan-session-reaps-shown";

/**
 * @param {string|null} canonical
 * @param {string} log
 */
function unseenSessionKills(canonical, log) {
	if (canonical === null) return null;
	const stamp = path.join(markersDir(canonical), SHOWN_STAMP);
	const shown = readText(stamp);
	const since = shown.state === "read" ? shown.data.trim() : "";
	let read;
	try {
		read = readJsonl(log);
	} catch (err) {
		return { rows: [], stamp, unreadable: `${log}: ${parseErrorText(err)}` };
	}
	const rows = (read?.rows ?? []).filter(
		(r) => typeof r.at === "string" && r.at > since,
	);
	return { rows, stamp, unreadable: null };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ rows: Record<string, unknown>[], stamp: string, unreadable: string|null }} unseen
 */
function reportUnseen(ctx, { rows, stamp, unreadable }) {
	if (unreadable !== null) {
		const line = `will not read the timer's kill log, so its kills go unnamed — ${unreadable}. Repair the file or move it aside; the next session start reads it again.`;
		ctx.warn("ORPHAN-SESSION", line);
		ctx.say(`ORPHAN-SESSION: ${line}`);
	}
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
	ignoreFailure(() => {
		fs.mkdirSync(path.dirname(stamp), { recursive: true });
		writeFileAtomic(stamp, `${newest}\n`);
	});
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
				what: (r) => `a hook run orphaned for ${describeAge(r.ageS * 1000)}`,
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
					`${describeAge(r.ageS * 1000)} old, ${r.session ? describeSession(r.session) : "its session"} ended`,
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
			noun: "orphaned hook run(s), suite run(s), session process(es) or unread kill log(s)",
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
