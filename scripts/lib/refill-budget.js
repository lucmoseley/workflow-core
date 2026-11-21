const { isActionable, launchName, stopJob } = require("./refill-block-core.js");
const { buildChildLine, buildHandOffArgs } = require("./refill-blocks.js");
const { landingOf, sessionIdsOf } = require("./refill-breaker.js");

/* #5466 guess: each figure fitted to the 11 parks recorded by 2026-11-21. */
/** @type {Readonly<BudgetRule>} */
const BUDGET_RULE = Object.freeze({
	streakLimit: 4,
	backstopRuns: 10,
	systemicSessions: 2,
	systemicWindowMs: 2 * 3_600_000,
	sleepAllowanceS: 60,
});

/* How long after a passing gate run its push is still due (#5441): the
 * longest gap from a passing run's end to its push in four checkouts'
 * gate-run and queue-log records, 634 s, rounded up to the minute. */
const PUSH_DUE_MS = 11 * 60_000;

/* git's `%ct` is whole seconds: https://git-scm.com/docs/pretty-formats */
const CT_RESOLUTION_MS = 1000;

/**
 * @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch
 * @typedef {import("./refill-blocks.js").JobLaunch} JobLaunch
 * @typedef {import("./refill-blocks.js").Tick} Tick
 * @typedef {import("./refill-breaker.js").ThroughputRead} ThroughputRead
 * @typedef {import("./refill-breaker.js").BreakerEvent} BreakerEvent
 * @typedef {import("./gate-seat.js").GateRun} GateRun
 * @typedef {{streakLimit: number, backstopRuns: number,
 *   systemicSessions: number, systemicWindowMs: number,
 *   sleepAllowanceS: number}} BudgetRule
 * @typedef {{failStreak: number, counted: number, newest: GateRun|null}} BudgetCount
 */

/**
 * @param {GateRun} run
 * @param {GateRun[]} repoRuns
 * @param {Set<string>} ids
 * @param {BudgetRule} rule
 */
function isSystemicCeiling(run, repoRuns, ids, rule) {
	const at = Date.parse(run.at);
	const others = new Set();
	for (const r of repoRuns) {
		if (r.outcome !== "ceiling" || r.session === null || ids.has(r.session))
			continue;
		const before = at - Date.parse(r.at);
		if (before >= 0 && before <= rule.systemicWindowMs) others.add(r.session);
	}
	return others.size >= rule.systemicSessions;
}

/**
 * @param {GateRun} run
 * @param {GateRun[]} repoRuns
 * @param {Set<string>} ids
 * @param {BudgetRule} rule
 */
const neitherFailsNorResets = (run, repoRuns, ids, rule) =>
	run.outcome === "killed" ||
	(run.wallS !== undefined && run.wallS - run.runS > rule.sleepAllowanceS) ||
	(run.outcome === "ceiling" && isSystemicCeiling(run, repoRuns, ids, rule));

/**
 * @param {GateRun[]} repoRuns
 * @param {{ids: Set<string>, launchedAt: number, landingAt: number|null,
 *   suiteCommand: string}} of
 * @param {BudgetRule} [rule]
 * @returns {BudgetCount}
 */
function countBudget(
	repoRuns,
	{ ids, launchedAt, landingAt, suiteCommand },
	rule = BUDGET_RULE,
) {
	const counted = repoRuns
		.filter((r) => {
			const at = Date.parse(r.at);
			return (
				r.session !== null &&
				ids.has(r.session) &&
				r.command === suiteCommand &&
				at > launchedAt &&
				(landingAt === null || at >= landingAt + CT_RESOLUTION_MS)
			);
		})
		.filter((r) => !neitherFailsNorResets(r, repoRuns, ids, rule))
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const lastPass = counted.findLastIndex((r) => r.outcome === "pass");
	return {
		failStreak: counted.length - lastPass - 1,
		counted: counted.length,
		newest: counted.at(-1) ?? null,
	};
}

/**
 * @param {BudgetCount} count
 * @param {BudgetRule} [rule]
 * @returns {{onStreak: boolean, why: string}|null}
 */
function budgetPark({ failStreak, counted }, rule = BUDGET_RULE) {
	if (failStreak >= rule.streakLimit)
		return {
			onStreak: true,
			why: `its ${failStreak} failed whole-suite gate runs in a row since its last landing, at the limit of ${rule.streakLimit}`,
		};
	if (counted >= rule.backstopRuns)
		return {
			onStreak: false,
			why: `its ${counted} whole-suite gate runs since its last landing, at the backstop of ${rule.backstopRuns}`,
		};
	return null;
}

/**
 * @param {LoopLaunch} l
 * @param {ThroughputRead} read
 * @param {number} now
 * @returns {{park: string}|{note: string}|null}
 */
function budgetVerdict(l, read, now) {
	const at = read.byRoot[l.root];
	const runs = at?.gateRuns;
	if (!runs) return null;
	const ids = sessionIdsOf(l);
	if (!at.suiteCommand)
		return runs.some((r) => r.session !== null && ids.has(r.session))
			? { note: "not judged: its checkout declares no commands.test" }
			: null;
	const landing = landingOf(l, read);
	if (!("at" in landing)) return { note: `not judged: ${landing.unread}` };
	const count = countBudget(runs, {
		ids,
		launchedAt: l.launchedAt,
		landingAt: landing.at,
		suiteCommand: at.suiteCommand,
	});
	const park = budgetPark(count);
	if (park === null) return null;
	if (park.onStreak || count.newest?.outcome !== "pass")
		return { park: park.why };
	const queue = read.queueOf(l);
	/* An unread queue ref parks nothing, as an unread landing does (#5273). */
	if (queue.state === "unread") return { note: `not judged: ${queue.why}` };
	if (queue.state !== "gone")
		return { note: "held: its passed commit waits on the lander" };
	return now - Date.parse(count.newest.at) < PUSH_DUE_MS
		? { note: "held: its push of its passed commit is still due" }
		: { park: park.why };
}

/**
 * Park `l` on its budget: stopped, handed off, its issues labelled `parked`
 * and told why. A stop that fails is logged and tried again next tick.
 * @param {JobLaunch} l
 * @param {string} why
 * @param {Tick} seen
 * @returns {LoopLaunch|null} the parked launch, or null where the stop failed
 */
function parkOnBudget(l, why, { now, io }) {
	const failed = stopJob(l, io);
	if (failed) {
		io.log(`could not stop ${launchName(l)} at its gate-run budget: ${failed}`);
		return null;
	}
	const handed = io.postHandOff(l.root, buildHandOffArgs(l));
	const unlabelled = io.labelParked(l);
	io.log(
		buildChildLine(
			`stopped ${launchName(l)} on ${why}, handed it off and parked it${unlabelled.length > 0 ? `; parked label refused on ${unlabelled.map((u) => `#${u.n} (${u.why})`).join(", ")}` : ""}`,
			handed,
		),
	);
	io.comment(
		l,
		`Refill loop: stopped this issue's session on ${why} (#5275, #5471), and parked it for a human or a later resume. The conversation is kept: \`claude attach\` reopens it.`,
	);
	return { ...l, ...io.progressOf(l), finishedAt: now, budgetParked: now };
}

/**
 * @param {LoopLaunch[]} launches
 * @param {ThroughputRead} read
 * @param {Tick} seen
 * @returns {{launches: LoopLaunch[], events: BreakerEvent[]}}
 */
function parkOverBudget(launches, read, seen) {
	/** @type {BreakerEvent[]} */
	const events = [];
	const out = launches.map((l) => {
		if (!isActionable(l) || l.jobId === null) return l;
		const verdict = budgetVerdict(l, read, seen.now);
		if (verdict === null) return l;
		if ("note" in verdict) {
			seen.io.log(`gate-run budget of ${launchName(l)} ${verdict.note}`);
			return l;
		}
		const parked = parkOnBudget(
			/** @type {JobLaunch} */ (l),
			verdict.park,
			seen,
		);
		if (parked === null) return l;
		events.push({
			at: new Date(seen.now).toISOString(),
			repo: l.root,
			event: "budget-park",
			rate: null,
			workingHours: 0,
			session: l.sessionId ?? l.jobId,
			...(l.issues[0] === undefined ? {} : { ticket: l.issues[0] }),
		});
		return parked;
	});
	return { launches: out, events };
}

module.exports = { BUDGET_RULE, budgetPark, countBudget, parkOverBudget };
