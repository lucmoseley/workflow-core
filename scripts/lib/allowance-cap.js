/*
 * allowance-cap.js — how many of a set's members launch on a seat under
 * lib/allowance.js's capSet: `allowance.js --cap`'s sizing, which
 * dispatch-sessions.sh reads through that CLI and the refill loop calls here
 * in-process (lib/seat-reading.js's readCap), so both size one figure without
 * the loop starting a child per seat per read (#4176).
 *
 * Only where a trusted bar is past its threshold does it read the running
 * sessions — one `claude agents --json` call and their own transcripts, no
 * allowance spent — leaving out those the launch record marks overflow, whose
 * spend bills a key and not this seat (#3696), a record read only where the
 * seat file declares an overflow seat (#4393). A bar counts only the spend
 * projected to land before its own `resetsAt`, by the cost table's
 * `landedByHours`; spend after it falls in the next window, and a reset that
 * does not parse counts all of it (#2925).
 */

const {
	sizedPercent,
	capSet,
	isWarned,
	POINTS_PER_USD,
} = require("./allowance");
const { listedAgents } = require("./agent-liveness");
const { readDeclaredOverflowLookup } = require("./dispatch-ledger.js");
const { readDeclaredSeats } = require("./refill-seats.js");
const { scriptPath } = require("./script-path.js");
const {
	costTableFile,
	landedShare,
	readCostTable,
	runningRemainders,
} = require("./session-spend");

/**
 * @typedef {ReturnType<typeof capSet> & {running: import("./session-spend").Running[]}
 *   | {launch: 0, error: string}} Cap
 */

/** The listing `allowance.js --cap` reads: strict, waiving the self-test. */
const readListedAgents = () => listedAgents({ requireSelf: false });

/**
 * The cap on a trustworthy `result` for `members`, against the caller's
 * `thresholds` (#293 ruling 2); `error` set, and `launch` 0, where it cannot be
 * read: a count or threshold that is no number, the cost table unreadable, the
 * listing unanswered, or the launch record unread. `root` is the host checkout
 * whose cost table and dispatch ledger it reads, this process's by default;
 * `readAgents` the running-session listing, strict by default.
 * @param {ReturnType<typeof import("./allowance").readAllowance>} result
 * @param {{members: number|null,
 *   thresholds: {session: number|null, weekly_all: number|null},
 *   configDir: string, root?: string,
 *   readAgents?: () => import("./agent-liveness").Listing}} opts
 * @returns {Cap}
 */
function capOf(
	result,
	{
		members,
		thresholds: asked,
		configDir,
		root,
		readAgents = readListedAgents,
	},
) {
	// No default threshold: a missing or non-numeric one refuses rather than
	// reading as NaN, which no reading is past, and launching the whole set.
	if (
		!Number.isInteger(members) ||
		/** @type {number} */ (members) < 0 ||
		!Number.isFinite(asked.session) ||
		!Number.isFinite(asked.weekly_all)
	)
		return {
			launch: 0,
			error: `the member count and both thresholds need numbers, got members ${members}, session ${asked.session}, week ${asked.weekly_all}`,
		};
	const count = /** @type {number} */ (members);
	// Only a trustworthy reading is sized, so neither bar reads null here.
	const readings = {
		session: sizedPercent(result.session) ?? 0,
		weekly_all: sizedPercent(result.weekly_all) ?? 0,
	};
	const thresholds = /** @type {Record<"session" | "weekly_all", number>} */ (
		asked
	);
	const none = { session: 0, weekly_all: 0 };
	if (
		!isWarned("session", readings, thresholds) &&
		!isWarned("weekly_all", readings, thresholds)
	)
		return {
			...capSet({
				readings,
				thresholds,
				members: count,
				runningPoints: none,
				perSessionPoints: none,
			}),
			running: [],
		};
	const table = readCostTable(costTableFile(root));
	if (!table)
		return {
			launch: 0,
			error: `the session cost table is unreadable — build it: node ${scriptPath("measure-session-cost.js")} --write`,
		};
	const listed = readAgents();
	// An empty listing is the one `why` that still answers: nothing is running,
	// as from a terminal with no session open.
	const agents = listed.why?.includes("listed no agents at all")
		? []
		: listed.agents;
	if (!agents)
		return { launch: 0, error: `running sessions unreadable: ${listed.why}` };
	let overflowLaunchOf;
	try {
		overflowLaunchOf = readDeclaredOverflowLookup(readDeclaredSeats(), root);
	} catch (e) {
		return {
			launch: 0,
			error: `launch record unreadable: ${String(e)} — fix that read and re-run: until then an overflow session cannot be told from a plan one`,
		};
	}
	const running = runningRemainders({
		agents: agents.filter((a) => !overflowLaunchOf({ sessionId: a.sessionId })),
		table,
		configDir,
	});
	const runningUsd = running.reduce((s, r) => s + r.remainderUsd, 0);
	/** @param {"session" | "weekly_all"} bar */
	const landed = (bar) => {
		const resetMs = Date.parse(result[bar].resetsAt ?? "");
		return Number.isNaN(resetMs)
			? 1
			: landedShare(table, (resetMs - Date.now()) / 3_600_000);
	};
	const share = {
		session: landed("session"),
		weekly_all: landed("weekly_all"),
	};
	const points = (/** @type {number} */ usd) => ({
		session: usd * share.session * POINTS_PER_USD.session,
		weekly_all: usd * share.weekly_all * POINTS_PER_USD.weekly_all,
	});
	return {
		...capSet({
			readings,
			thresholds,
			members: count,
			runningPoints: points(runningUsd),
			perSessionPoints: points(table.meanUsd),
		}),
		running,
	};
}

module.exports = { capOf };
