#!/usr/bin/env node

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
const { ignoreFailure } = require("./lib/caught.js");

function kickRefresh() {
	ignoreFailure(() =>
		spawn(process.execPath, [__filename, "--refresh"], {
			detached: true,
			stdio: "ignore",
		}).unref(),
	);
}

/**
 * @param {{ createdAt: string }} c
 * @param {number} now
 */
const ageDaysOf = (c, now) => (now - Date.parse(c.createdAt)) / 864e5;

/** @param {import("./lib/check").Ctx} ctx */
function refreshState(ctx) {
	/** @type {ReturnType<typeof fetchCaptures>} */
	let captures;
	try {
		captures = fetchCaptures();
	} catch (e) {
		return raiseGhFailure(e, "The capture-drain state file was not refreshed.");
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

/** @typedef {Pick<import("./lib/captures").Capture, "id" | "issue" | "url" | "createdAt">} StoredCapture */

/**
 * @typedef {{
 *   early?: { okLine: string, data: object },
 *   undrained: StoredCapture[],
 *   scannedAt: string | null,
 *   stateAgeHours: number | null,
 * }} UndrainedRead
 */

/** @returns {UndrainedRead} */
function readUndrainedFromState() {
	const state = readState();
	if (!state || state.stale) {
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

/** @returns {UndrainedRead} */
function undrainedFromScan() {
	/** @type {ReturnType<typeof fetchCaptures>} */
	let captures;
	try {
		captures = fetchCaptures();
	} catch (e) {
		return raiseGhFailure(e, "No conclusion drawn about undrained captures.");
	}
	const undrained = captures.filter(
		(/** @type {{ drained: unknown }} */ c) => !c.drained,
	);
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

		const now = Date.now();

		const undrained = [...read.undrained].sort(
			(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
		);
		const oldest = undrained[0] || null;
		const oldestAgeDays = oldest ? ageDaysOf(oldest, now) : null;
		const overdue =
			oldest !== null && oldestAgeDays !== null && oldestAgeDays > days;

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
