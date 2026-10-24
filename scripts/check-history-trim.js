#!/usr/bin/env node
/*
 * check-history-trim.js — the retroactive-corpus-loss detector mantahostels#2617 built.
 *
 * WHAT IT FIRES ON: a seat root's `~/.claudeN/history.jsonl` whose oldest
 * surviving line's timestamp has moved FORWARD since the last recording —
 * the signature of trimming, per-seat burn attribution (mantahostels#2607) resting
 * entirely on these files with no archive and no documented retention cap.
 *
 * WHAT IT NEVER DOES: repair, archive or copy `history.jsonl`. It reports
 * only. Building the archiver is mantahostels#2607's ruling, deferred until trimming is a
 * dated fact rather than a hypothesis.
 *
 * A root that is absent (no history.jsonl), unreadable (permission error, or
 * a file whose lines carry no parseable timestamp), or new (no prior
 * recording to compare against) is never reported as trimming — see
 * lib/history-trim.js's header for why each is distinct from a real trim.
 *
 * Severity is WARN, matching check-seat-utilisation.js's own upward trigger:
 * this is a notice for the founder's judgement, not a gate — nothing here can
 * regenerate lost history, so failing a commit over it would gate on a fact
 * the commit cannot fix.
 *
 * WHERE IT RUNS: `npm run status` only (scripts/status-report.js), WITHOUT
 * --notify, so a session does not open on a fault list. --notify is exercised
 * by the tests and wired by nothing.
 *
 * THE RESIDUAL of running on demand rather than at every session start: a trim
 * is detected late. The signal itself does not decay — a forward move of the
 * oldest line persists — but the corpus can shrink further in the gap, and
 * mantahostels#2607's archiver is gated on a DATED detection, so a late date is a real
 * cost.
 *
 * IMPLICIT:  on each run, reads each seat root's history.jsonl and reports a
 *            trimming notice when one is detected; records one reading a day
 *            either way.
 * JUSTIFIED: fail-safe — the loss is unrecoverable and silent otherwise.
 * DEFEAT:    --notify — recordReading() runs unconditionally, so an append (or
 *            a failed one) lands there too, but finish() suppresses every
 *            ctx.dirtied() note under --notify (mantahostels#2665); that route is unwired
 *            to any reader today (see WHERE IT RUNS above). The plain
 *            `npm run status` route has none — see the dirtied() call below.
 */

const { configDirs } = require("./lib/arbiter-store");

const { now, runCheck, skipError } = require("./lib/check");
const {
	WATCH_FILE,
	readBaseline,
	readRoots,
	recordReading,
	trimmedRoots,
} = require("./lib/history-trim");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {import("./lib/history-trim").RootReading} RootReading */

/**
 * @param {RootReading[]} roots
 */
function rootTable(roots) {
	const rows = roots.map((r) => {
		if (r.state === "absent") return `  ${r.dir.padEnd(10)}  no history.jsonl`;
		if (r.state === "unreadable")
			return `  ${r.dir.padEnd(10)}  unreadable — permission error or no parseable timestamp`;
		const oldest =
			r.oldestMs === null
				? "?"
				: new Date(r.oldestMs).toISOString().slice(0, 10);
		return `  ${r.dir.padEnd(10)}  oldest ${oldest}  ${r.lineCount} line(s)`;
	});
	return `HISTORY ROOTS (${roots.length})\n${rows.join("\n")}\n`;
}

/**
 * Roots reading ok now with nothing comparable in the baseline; none when
 * there is no usable baseline at all.
 * @param {RootReading[]} roots
 * @param {Record<string, RootReading> | null | undefined} baseline
 */
function newRootsSince(roots, baseline) {
	if (baseline === null || baseline === undefined) return [];
	return roots.filter((r) => {
		if (r.state !== "ok") return false;
		const prior = baseline[r.dir];
		return prior?.state !== "ok" || prior.oldestMs === null;
	});
}

/**
 * The human-readable body: the root table, then the baseline, new-root and
 * failed-append notes.
 * @param {Ctx} ctx
 * @param {{ roots: RootReading[], baseline: Record<string, RootReading> | null | undefined, newRoots: RootReading[], recorded: "recorded" | "throttled" | "failed" }} reading
 */
function sayReadingSummary(ctx, { roots, baseline, newRoots, recorded }) {
	ctx.say(rootTable(roots));
	if (baseline === null)
		ctx.say(
			`(no prior recording in ${WATCH_FILE()} — this is the baseline.)\n`,
		);
	if (newRoots.length > 0)
		ctx.say(
			`NEW ROOT(S) (${newRoots.length}) — first recording, nothing to compare: ${newRoots.map((r) => r.dir).join(", ")}\n`,
		);
	if (recorded === "failed")
		ctx.say(
			`(could not append today's reading to ${WATCH_FILE()}, so this\n` +
				"reading is lost — see WATCH_FILE in scripts/lib/history-trim.js.)\n",
		);
}

/**
 * One HISTORY-TRIMMED warn per trimmed root, then the summary block.
 * @param {Ctx} ctx
 * @param {{ dir: string, priorOldestMs: number, newOldestMs: number }[]} trimmed
 */
function reportTrimmed(ctx, trimmed) {
	for (const t2 of trimmed) {
		ctx.warn(
			"HISTORY-TRIMMED",
			`${t2.dir}/history.jsonl's oldest line moved from ${new Date(t2.priorOldestMs).toISOString()} to ${new Date(t2.newOldestMs).toISOString()} — history was dropped`,
			{
				dir: t2.dir,
				priorOldestMs: t2.priorOldestMs,
				newOldestMs: t2.newOldestMs,
			},
			`history-trimmed:${t2.dir}`,
		);
	}
	ctx.say(
		`HISTORY TRIMMED (${trimmed.length}) — the oldest surviving line moved forward, so\n` +
			"burn attribution's retroactive corpus (mantahostels#2607) has shrunk. This never repairs\n" +
			"or archives; the archiver is mantahostels#2607's deferred ruling.\n" +
			trimmed
				.map(
					(t2) =>
						`  ${t2.dir}: oldest was ${new Date(t2.priorOldestMs).toISOString().slice(0, 10)}, now ${new Date(t2.newOldestMs).toISOString().slice(0, 10)}\n`,
				)
				.join(""),
	);
}

runCheck({
	name: "history-trim",
	usage: "node check-history-trim.js [--warn] [--json] [--notify]",
	/** @param {Ctx} ctx */
	run(ctx) {
		const t = now();
		const dirs = configDirs();
		const roots = readRoots(dirs);
		const present = roots.filter((r) => r.state !== "absent");
		/* SKIP, not BROKEN: the histories are the SUBJECT and live outside the
		 * repo — a machine that has never run Claude Code is not this repo's
		 * fault. */
		if (present.length === 0)
			throw skipError(
				`no Claude Code seat directory holds a history.jsonl (${dirs.join(", ")}).`,
			);

		const baseline = readBaseline();
		/* undefined is distinct from null: the watch file exists and is TRACKED,
		 * so a corrupt or unreadable reading of it is this checker's own
		 * apparatus failing on repo bytes, not the subject (history.jsonl) —
		 * BROKEN, never silently treated as "no baseline yet". Reading it as
		 * null here would re-baseline over whatever trim happened in the gap,
		 * the one failure mode this detector exists to catch. */
		if (baseline === undefined)
			ctx.broken(
				`could not read the prior recording in ${WATCH_FILE()} — it exists but its newest line will not parse, or it is unreadable.`,
			);
		const trimmed = trimmedRoots(roots, baseline);
		/* "New" is a root reading ok now with nothing comparable in the baseline —
		 * never seen at all, or seen only as absent/unreadable/empty. recordReading
		 * always writes every SEAT_DIR (mostly as "absent"), so `baseline[dir]`
		 * being present but not a comparable ok reading is the common case, not
		 * `=== undefined`, which recordReading's own shape makes nearly
		 * unreachable once a baseline exists at all. */
		const newRoots = newRootsSince(roots, baseline);
		const recorded = recordReading(roots, t);
		/* dirtied(): status-report.js's verdict() (the DEFEAT note above) drops
		 * a clean checker's whole body, so a landed or failed reading must say
		 * so here to survive that drop. Silent only on "throttled" — nothing
		 * was attempted. */
		if (recorded === "recorded")
			ctx.dirtied(`${WATCH_FILE()} gained a new reading — needs committing.`);
		else if (recorded === "failed")
			ctx.dirtied(
				`${WATCH_FILE()} could not be appended to just now — today's reading is lost.`,
			);

		if (!ctx.notify)
			sayReadingSummary(ctx, { roots, baseline, newRoots, recorded });

		if (trimmed.length > 0) reportTrimmed(ctx, trimmed);

		return {
			okLine:
				trimmed.length === 0
					? `${present.length} history root(s) read, none trimmed since the last recording.`
					: undefined,
			noun: "trimmed root(s)",
			count: trimmed.length,
			data: {
				recorded,
				roots: roots.map((r) => ({
					dir: r.dir,
					state: r.state,
					oldestMs: r.oldestMs,
					lineCount: r.lineCount,
				})),
				trimmed,
				newRoots: newRoots.map((r) => r.dir),
			},
		};
	},
});
