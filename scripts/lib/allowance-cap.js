const {
	sizedPercent,
	capSet,
	isWarned,
	POINTS_PER_USD,
} = require("./allowance");
const { listedAgents } = require("./agent-liveness");
const { caught } = require("./caught.js");
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

const readListedAgents = () => listedAgents({ requireSelf: false });

/**
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
	const agents = listed.why?.includes("listed no agents at all")
		? []
		: listed.agents;
	if (!agents)
		return { launch: 0, error: `running sessions unreadable: ${listed.why}` };
	let overflowLaunchOf;
	try {
		overflowLaunchOf = readDeclaredOverflowLookup(readDeclaredSeats(), root);
	} catch (e) {
		return { launch: 0, error: caught(e).message };
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
