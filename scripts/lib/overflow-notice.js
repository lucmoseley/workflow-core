/*
 * overflow-notice.js — the refill loop's record of the plan seats an overflow
 * launch rested on, and the lines naming them (#3767). A seat absent from the
 * seat file is legitimate, so the overflow trigger cannot refuse one: these
 * lines are how a seat dropped by mistake is seen.
 */

const { describeAge } = require("./proc-table.js");
const { buildSeatName } = require("./refill-seats.js");

/**
 * @typedef {{seat: string, percent: number|null, weekReadAt: number|null,
 *   weekFull: boolean}} PlanSeatBasis a plan seat's weekly bar as read, whatever
 *   its trust, and 0 once its reset has passed; `weekReadAt` null where the
 *   reading has no time
 * @typedef {{at: number, seat: string, planSeats: PlanSeatBasis[],
 *   omitted: string[]}} OverflowStart `seat`, the overflow seat launched on;
 *   `omitted`, lib/refill-seats.js's readOmittedDirs at that launch
 */

/** @param {import("./refill-decide.js").SeatReading} s @returns {PlanSeatBasis} */
const planSeatBasisOf = ({ seat, weekRead, weekFull }) => ({
	seat,
	percent: weekRead.percent,
	weekReadAt: weekRead.atMs,
	weekFull,
});

/**
 * The first of `launched` on an overflow seat whose predecessor was not, or
 * null. No predecessor counts as a plan seat's.
 * @template {{seat: string}} L
 * @param {{seat: string}[]} prior the launches before these, oldest first
 * @param {L[]} launched
 * @param {Set<string>} overflowDirs
 * @returns {L|null}
 */
function firstOverflowLaunch(prior, launched, overflowDirs) {
	let last = prior.at(-1);
	for (const l of launched) {
		if (overflowDirs.has(l.seat) && !(last && overflowDirs.has(last.seat)))
			return l;
		last = l;
	}
	return null;
}

/** @param {unknown} raw */
const isPlanSeatBasis = (raw) => {
	const b = /** @type {Partial<PlanSeatBasis>|null} */ (raw);
	return typeof b?.seat === "string" && typeof b.weekFull === "boolean";
};

/**
 * Null where the record will not read; a damaged element is dropped, so it can
 * never throw at session start.
 * @param {unknown} raw
 * @returns {OverflowStart|null}
 */
function parseOverflowStart(raw) {
	const r = /** @type {Partial<OverflowStart>|null} */ (raw);
	return typeof r?.at === "number" &&
		typeof r.seat === "string" &&
		Array.isArray(r.planSeats) &&
		Array.isArray(r.omitted)
		? {
				at: r.at,
				seat: r.seat,
				planSeats: r.planSeats.filter(isPlanSeatBasis),
				omitted: r.omitted.filter((d) => typeof d === "string"),
			}
		: null;
}

/**
 * @param {PlanSeatBasis} b
 * @param {number} at the time its age is told from
 * @param {string} ageSuffix
 */
function buildPlanSeatText(
	{ seat, percent, weekReadAt, weekFull },
	at,
	ageSuffix,
) {
	const age =
		weekReadAt === null
			? "age unknown"
			: `read ${describeAge(Math.max(0, (at - weekReadAt) / 1000))} ${ageSuffix}`;
	const reading =
		percent === null ? "no weekly reading" : `${percent}% of the week, ${age}`;
	return `${buildSeatName(seat)}: ${reading}, ${weekFull ? "weekly-full" : "not weekly-full"}`;
}

/**
 * @param {PlanSeatBasis[]} planSeats
 * @param {string[]} omitted
 * @param {{at: number, ageSuffix: string}} age
 */
const buildBasisLines = (planSeats, omitted, { at, ageSuffix }) => [
	...planSeats.map((b) => buildPlanSeatText(b, at, ageSuffix)),
	...(omitted.length > 0
		? [
				`credentials outside the seat file: ${omitted.map((d) => buildSeatName(d)).join(", ")}`,
			]
		: []),
];

/** @param {OverflowStart} start */
const buildOverflowStartLines = ({ at, planSeats, omitted }) =>
	buildBasisLines(planSeats, omitted, { at, ageSuffix: "before it" });

module.exports = {
	buildBasisLines,
	buildOverflowStartLines,
	firstOverflowLaunch,
	parseOverflowStart,
	planSeatBasisOf,
};
