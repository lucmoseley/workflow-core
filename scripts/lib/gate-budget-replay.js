const path = require("node:path");
const {
	BUDGET_RULE,
	budgetPark,
	countBudget,
	isLaunchRun,
} = require("./refill-budget.js");
const { CEILING_MS } = require("./suite-ceiling.js");

/**
 * @typedef {import("./gate-seat.js").GateRun} GateRun
 * @typedef {import("./refill-budget.js").BudgetRule} BudgetRule
 * @typedef {import("./refill-budget.js").BudgetCount} BudgetCount
 * @typedef {import("./refill-budget.js").BudgetParkEvent} BudgetParkEvent
 * @typedef {Pick<BudgetParkEvent, "at"|"repo"|"ticket"> & {session: string}
 *   & Partial<Pick<BudgetParkEvent, "sessions"|"launchedAt">>} Park
 * @typedef {{arrivedAt: number, at: number}} Landing
 * @typedef {{park: Park, repoRuns: GateRun[], suiteCommand: string,
 *   landings: Landing[]}} ParkInput
 * @typedef {{park: Park,
 *   firstPark: {at: string, why: string, onBackstopPass: boolean}|null,
 *   count: BudgetCount|null}} ParkReplay
 */

/* #5446 */
/**
 * @param {GateRun} run
 * @param {BudgetRule} rule
 * @returns {GateRun}
 */
function withLegacyWallClock(run, rule) {
	const ceilingS = CEILING_MS / 1000;
	if (run.wallS !== undefined || run.runS <= ceilingS + rule.sleepAllowanceS)
		return run;
	return { ...run, wallS: run.runS, runS: ceilingS };
}

/* #5514 */
/**
 * @param {Park} park
 * @returns {{ids: Set<string>, launchedAt: number}}
 */
const launchOf = (park) => ({
	ids: new Set(park.sessions ?? [park.session]),
	launchedAt: park.launchedAt === undefined ? 0 : Date.parse(park.launchedAt),
});

/**
 * @param {Park} park
 */
const parkLabel = (park) =>
	`${path.basename(park.repo)} #${park.ticket ?? "?"} ${park.session.slice(0, 8)}`;

/**
 * @param {ParkInput} input
 * @param {BudgetRule} [rule]
 * @returns {ParkReplay}
 */
function replayPark(
	{ park, repoRuns, suiteCommand, landings },
	rule = BUDGET_RULE,
) {
	const parkedAt = Date.parse(park.at);
	const launch = launchOf(park);
	const { ids, launchedAt } = launch;
	const runs = repoRuns.map((r) => withLegacyWallClock(r, rule));
	const mine = runs
		.filter((r) => isLaunchRun(r, launch) && Date.parse(r.at) <= parkedAt)
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	/** @type {BudgetCount|null} */
	let count = null;
	for (const run of mine) {
		const t = Date.parse(run.at);
		const arrived = landings.filter((l) => l.arrivedAt <= t).map((l) => l.at);
		count = countBudget(
			runs.filter((r) => Date.parse(r.at) <= t),
			{
				ids,
				launchedAt,
				landingAt: arrived.length > 0 ? Math.max(...arrived) : null,
				suiteCommand,
			},
			rule,
		);
		const parks = budgetPark(count, rule);
		if (parks)
			return {
				park,
				firstPark: {
					at: run.at,
					why: parks.why,
					onBackstopPass: !parks.onStreak && count.newest?.outcome === "pass",
				},
				count,
			};
	}
	return { park, firstPark: null, count };
}

/**
 * @param {{at: number, sha: string}[]} reflog
 * @param {(sha: string) => boolean} holds
 * @returns {number|null}
 */
function firstHeldAt(reflog, holds) {
	let lo = 0;
	let hi = reflog.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (holds(reflog[mid]?.sha ?? "")) hi = mid;
		else lo = mid + 1;
	}
	return reflog[lo]?.at ?? null;
}

/**
 * @param {Park} park
 * @param {"gate-run record"|"commands.test"|"commit ledger"} unread
 */
const unreadLine = (park, unread) =>
	unread === "commit ledger"
		? `${parkLabel(park)}: its commit ledger will not read, so nothing of it is taken to have landed`
		: `${parkLabel(park)}: not replayed, its checkout's ${unread} will not read`;

/**
 * @param {ParkReplay} r
 */
function replayLine({ park, firstPark, count }) {
	const head = `${parkLabel(park)}, parked ${park.at}:`;
	if (firstPark)
		return `${head} kept at ${firstPark.at}, on ${firstPark.why}${firstPark.onBackstopPass ? " (a newest pass: the #5438 and #5441 holds unjudged)" : ""}`;
	if (count === null) return `${head} released, no gate run of its read`;
	return `${head} released, ${count.failStreak} failed in a row and ${count.counted} counted at its last run`;
}

/**
 * @param {ParkInput[]} inputs
 * @param {BudgetRule} [rule]
 */
function renderReplay(inputs, rule = BUDGET_RULE) {
	const replays = inputs.map((i) => replayPark(i, rule));
	const kept = replays.filter((r) => r.firstPark).length;
	return [
		`Rule: park on ${rule.streakLimit} failed whole-suite runs in a row, or ${rule.backstopRuns} counted; a ceiling is systemic at ${rule.systemicSessions} other sessions in ${rule.systemicWindowMs / 3_600_000} h; a run spanned a sleep past ${rule.sleepAllowanceS} s.`,
		...replays.map(replayLine),
		`Kept ${kept}, released ${replays.length - kept}, of ${replays.length} parks.`,
	].join("\n");
}

/**
 * @param {ParkInput[]} inputs
 * @param {{streaks: number[], backstops: number[]}} grid
 * @param {BudgetRule} [rule]
 */
function renderSweep(inputs, { streaks, backstops }, rule = BUDGET_RULE) {
	const lines = ["streak backstop kept"];
	for (const streakLimit of streaks)
		for (const backstopRuns of backstops) {
			const tried = { ...rule, streakLimit, backstopRuns };
			const kept = inputs
				.map((i) => replayPark(i, tried))
				.filter((r) => r.firstPark)
				.map((r) => parkLabel(r.park));
			lines.push(
				`${streakLimit} ${backstopRuns} ${kept.length}: ${kept.join(", ") || "none"}`,
			);
		}
	return lines.join("\n");
}

module.exports = {
	firstHeldAt,
	launchOf,
	renderReplay,
	renderSweep,
	unreadLine,
};
