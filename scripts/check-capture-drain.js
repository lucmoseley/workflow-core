#!/usr/bin/env node
/*
 * check-capture-drain.js — reports that captured facts have been sitting
 * undrained too long.
 *
 * A `**Captured fact:**` comment buys durability the moment it is written and
 * nothing else: the fact is in no document, so no session reads it (mantahostels#639).
 * The settling session
 * files the fact itself and marks its own comment consumed (mantahostels#2748), so what
 * this reports is an ESCAPED one — plus the historical residue on mantahostels#678, closed.
 * Nothing else asks for the drain.
 *
 * AGE, NOT COUNT. A day that captures six facts is a productive day, not a
 * backlog; a fortnight with two uncollected is the failure. So the trigger is
 * how old the OLDEST undrained capture is.
 *
 * THE 7 DAYS IS A FIRST GUESS — `STALE_CAPTURE_DAYS` in scripts/lib/captures.js
 * owns it and says what would re-derive it. `--days <n>` overrides it for a
 * one-off look.
 *
 * WARN, never FAIL: an undrained capture is safe where it sits, and gating
 * anything on tidy-up would teach the reader to ignore the line.
 *
 * THREE PATHS, because the scan costs 20 seconds and the SessionStart hook this
 * was until ad6edc1e4 allowed 15 (the reasoning, and why no narrower query
 * exists, is on the state file in scripts/lib/captures.js):
 *
 *   --notify   reads the state file, calls gh not at all, and kicks a detached
 *              --refresh when the state is old. Wired to nothing since
 *              ad6edc1e4 lifted this off SessionStart.
 *   --refresh  scans and writes the state file. Prints nothing.
 *   neither    scans live, reports, and warms the state file. `npm run
 *              check:captures`, where waiting 20 seconds is the point.
 *
 * Usage: node check-capture-drain.js [--days <n>] [--warn] [--json] [--notify]
 *                                    [--refresh]
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), asks GitHub how old the oldest undrained `**Captured fact:**` comment is and reports a drain reminder.
 * JUSTIFIED: fail-safe — an unreacted capture is a fact that reached no document, and nothing else ever reports one.
 * DEFEAT:    none; --notify is silent while the oldest capture is inside the threshold.
 */

const { spawn } = require("node:child_process");

const { runCheck } = require("./lib/check");
const { raiseGhFailure } = require("./lib/gh");
const {
	REFRESH_MIN_AGE_HOURS,
	STALE_CAPTURE_DAYS,
	fetchCaptures,
	readState,
	writeState,
} = require("./lib/captures");
const { scriptPath } = require("./lib/script-path");

/** Fire and forget: the session must not wait on it, and its failure is the
 *  next run's stale state rather than anything to report here. */
function kickRefresh() {
	try {
		spawn(process.execPath, [__filename, "--refresh"], {
			detached: true,
			stdio: "ignore",
		}).unref();
	} catch {
		/* no refresh this time; the state simply stays as old as it was */
	}
}

/**
 * @param {{ createdAt: string }} c
 * @param {number} now
 */
const ageDaysOf = (c, now) => (now - Date.parse(c.createdAt)) / 864e5;

/**
 * --refresh: pay the scan, write the state, say nothing. Its findings would go
 * to a terminal nobody is watching.
 *
 * @param {import("./lib/check").Ctx} ctx
 */
function refreshState(ctx) {
	/** @type {ReturnType<typeof fetchCaptures>} */
	let captures;
	try {
		captures = fetchCaptures();
	} catch (e) {
		raiseGhFailure(e, "The capture-drain state file was not refreshed.");
	}
	if (!writeState(captures, Date.now()))
		ctx.broken(
			"the scan ran but its state file could not be written, so the\n" +
				"        --notify route will keep reading the old one.",
		);
	return {
		okLine: `state refreshed: ${captures.length} capture(s) on the tracker.`,
		data: { refreshed: true, captureCount: captures.length },
	};
}

/**
 * One undrained capture as either route reads it: the state file keeps only
 * these four fields of a scanned `Capture` (`writeState`).
 * @typedef {Pick<import("./lib/captures").Capture, "id" | "issue" | "url" | "createdAt">} StoredCapture
 */

/**
 * `scannedAt` is the state file's ISO stamp, as `writeState` wrote it, and
 * null on the live scan.
 * @typedef {{
 *   early?: { okLine: string, data: object },
 *   undrained: StoredCapture[],
 *   scannedAt: string | null,
 *   stateAgeHours: number | null,
 * }} UndrainedRead
 */

/**
 * --notify: the state file only. A 20-second gh call here was killed by the
 * SessionStart hook's timeout, and a killed check prints exactly what a clean
 * one prints, so the drift would never surface. `early` is the result to
 * return where no state is recent enough to speak from.
 *
 * @returns {UndrainedRead}
 */
function readUndrainedFromState() {
	const state = readState();
	if (!state || state.stale) {
		// Nothing to say yet. The refresh below is what makes the NEXT
		// --notify run able to speak — a route nothing wires today (header).
		kickRefresh();
		return {
			early: {
				okLine: "no capture-drain scan recent enough to report from.",
				data: { fromState: true, state: null },
			},
			undrained: [],
			scannedAt: null,
			stateAgeHours: null,
		};
	}
	if (state.ageHours > REFRESH_MIN_AGE_HOURS) kickRefresh();
	return {
		undrained: state.undrained || [],
		scannedAt: state.scannedAt,
		stateAgeHours: state.ageHours,
	};
}

/**
 * Neither flag: scan live, and warm the state file on the way.
 *
 * @returns {UndrainedRead}
 */
function undrainedFromScan() {
	/** @type {ReturnType<typeof fetchCaptures>} */
	let captures;
	try {
		captures = fetchCaptures();
	} catch (e) {
		raiseGhFailure(e, "No conclusion drawn about undrained captures.");
	}
	const undrained = captures.filter(
		(/** @type {{ drained: unknown }} */ c) => !c.drained,
	);
	// Warm the state so the next --notify run can speak from it.
	writeState(captures, Date.now());
	return { undrained, scannedAt: null, stateAgeHours: null };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {StoredCapture[]} undrained
 * @param {StoredCapture} oldest
 * @param {number} oldestAgeDays
 */
function reportOverdue(ctx, undrained, oldest, oldestAgeDays) {
	ctx.warn(
		"UNDRAINED-CAPTURES",
		`${undrained.length} captured fact(s) unplaced, the oldest for ${Math.floor(oldestAgeDays)} days (#${oldest.issue})`,
		{ oldest, oldestAgeDays, undrainedCount: undrained.length },
	);
	ctx.say(
		`UNDRAINED CAPTURES (${undrained.length}) — facts caught in a comment and never placed in a document.\n` +
			`  Oldest: ${Math.floor(oldestAgeDays)} days, on #${oldest.issue} — ${oldest.url}\n` +
			"  Drain them with the `capture-drain` skill; see them with\n" +
			`    node ${scriptPath("capture-drain.js")} list\n`,
	);
}

runCheck({
	name: "capture-drain",
	module: "governance",
	usage:
		"node check-capture-drain.js [--days <n>] [--warn] [--json] [--notify] [--refresh]",
	valueFlags: ["--days"],
	flags: ["--refresh"],
	/** @param {import("./lib/check").Ctx} ctx */
	run(ctx) {
		const days = Number(ctx.value("--days", String(STALE_CAPTURE_DAYS)));
		if (!Number.isFinite(days) || days < 0)
			ctx.usageError(
				`--days needs a non-negative number, got "${ctx.value("--days")}".`,
			);

		if (ctx.has("--refresh")) return refreshState(ctx);

		const read = ctx.notify ? readUndrainedFromState() : undrainedFromScan();
		if (read.early) return read.early;
		const { scannedAt, stateAgeHours } = read;

		/* Sampled after the fetch, never before: a 20-second scan taken against a
		 * clock read before it starts ages every capture 20 seconds short. */
		const now = Date.now();

		// Oldest first, so the head is the one the threshold is judged against.
		const undrained = [...read.undrained].sort(
			(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
		);
		const oldest = undrained[0] || null;
		const oldestAgeDays = oldest ? ageDaysOf(oldest, now) : null;
		const overdue =
			oldest !== null && oldestAgeDays !== null && oldestAgeDays > days;

		// `oldest && oldestAgeDays !== null` is type-only: overdue already implies both.
		if (overdue && oldest && oldestAgeDays !== null)
			reportOverdue(ctx, undrained, oldest, oldestAgeDays);

		return {
			okLine:
				undrained.length > 0
					? `${undrained.length} undrained capture(s), none older than ${days} days.`
					: "no undrained captured facts.",
			noun: "overdue capture backlog",
			count: overdue ? 1 : 0,
			data: {
				days,
				undrainedCount: undrained.length,
				oldestAgeDays,
				undrained,
				scannedAt,
				stateAgeHours,
			},
		};
	},
});
