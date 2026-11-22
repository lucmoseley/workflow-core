const {
	STALE_MS,
	isTrustworthy,
	readAllowance,
	sizedPercent,
} = require("./allowance.js");
const { capOf } = require("./allowance-cap.js");
const { DEFAULT_CEILINGS } = require("./dispatch-sessions.js");
const { isBudgetSpent } = require("./overflow-budget-core.js");
const {
	FULL,
	fitsLaunch,
	hasRoom,
	orderPlanSeats,
} = require("./refill-decide.js");
const { isSameSeat, overflowSeatsOf } = require("./refill-seats.js");
const { DAY_MS } = require("./retained-jsonl.js");
const { hasResetPassed } = require("./usage-cache.js");

/** @typedef {import("./refill-decide.js").SeatReading} SeatReading */
/** @typedef {import("./refill-decide.js").SizedSeat} SizedSeat */
/** @typedef {() => import("./agent-liveness.js").Listing} ReadAgents */
/** @typedef {{seat: string, outcome: string, stampMs?: number|null}} Probe */

/** @param {Record<string, string | undefined>} env */
const ceilingsOf = (env) => ({
	week: Number(env.WFC_DISPATCH_WEEK_CEILING || DEFAULT_CEILINGS.week),
	session: Number(env.WFC_DISPATCH_SESSION_CEILING || DEFAULT_CEILINGS.session),
});

/**
 * @param {import("./allowance.js").Bar} bar
 * @param {number} now
 */
const isBarFull = (bar, now) =>
	bar.percent !== null &&
	bar.percent >= FULL &&
	(bar.trust === "fresh" || Date.parse(bar.resetsAt ?? "") > now);

/**
 * @param {string} seat
 * @param {{session: import("./allowance.js").Bar,
 *   weekly_all: import("./allowance.js").Bar}} bars
 * @param {number} now
 * @returns {SeatReading}
 */
function seatReadingOf(seat, { session, weekly_all: week }, now) {
	const sessionFull = isBarFull(session, now);
	const weekResets = Date.parse(week.resetsAt ?? "");
	const rolled = week.trust !== "fresh" && hasResetPassed(week.resetsAt, now);
	return {
		readAt: Math.min(session.fetchedAtMs ?? now, week.fetchedAtMs ?? now),
		seat,
		week: sizedPercent(week),
		session: sizedPercent(session),
		weekFull: isBarFull(week, now),
		sessionFull,
		sessionResets: session.resetsAt,
		weekResets: weekResets > now ? weekResets : null,
		weekRead: {
			percent: rolled ? 0 : week.percent,
			atMs: week.fetchedAtMs ?? (week.trust === "fresh" ? now : null),
			rolled,
		},
	};
}

/**
 * @param {(SeatReading & {fits?: number|null})[]} readings
 * @param {boolean} sizeAll
 * @param {(seat: string) => boolean} isRetryDue
 */
function seatsToRefresh(readings, sizeAll, isRetryDue) {
	/** @type {string[]} */
	const stale = [];
	for (const r of readings) {
		if (r.weekFull || r.sessionFull) continue;
		if (r.week === null || r.session === null) {
			if (isRetryDue(r.seat)) stale.push(r.seat);
		} else if (!sizeAll && hasRoom(r) && r.fits !== 0) break;
	}
	return stale;
}

/**
 * @param {SeatReading[]} readings
 * @param {number} slots
 * @param {(seat: string, members: number) => number|null} sizeOf
 * @param {boolean} sizeAll
 * @returns {SizedSeat[]}
 */
function sizedSeats(readings, slots, sizeOf, sizeAll) {
	let sized = false;
	return readings.map((r) => {
		if (sized || !hasRoom(r)) return { ...r, fits: null };
		const fits = slots > 0 ? sizeOf(r.seat, slots) : 0;
		sized = !sizeAll && fitsLaunch({ ...r, fits });
		return { ...r, fits };
	});
}

/**
 * @param {SizedSeat[]} seats
 * @param {import("./refill-decide.js").HeldResume[]} resumable
 * @param {number} slots
 * @param {(seat: string, members: number) => number|null} sizeOf
 * @returns {SizedSeat[]}
 */
function sizeResumeSeats(seats, resumable, slots, sizeOf) {
	if (slots === 0 || resumable.length === 0) return seats;
	let spare = false;
	return seats.map((s) => {
		const due = resumable.filter((r) => isSameSeat(r, s)).length;
		const sized =
			s.fits === null && hasRoom(s) && (due > 0 || !spare)
				? { ...s, fits: sizeOf(s.seat, slots) }
				: s;
		spare ||= hasRoom(sized) && (sized.fits ?? 0) > due;
		return sized;
	});
}

/**
 * @param {SizedSeat[]} seats
 * @param {import("./refill-decide.js").ParkerReading[]} parkers
 * @param {(seat: string, members: number) => number|null} sizeOf
 * @returns {SizedSeat[]}
 */
const sizeParkerSeats = (seats, parkers, sizeOf) =>
	seats.map((s) =>
		s.fits === null &&
		hasRoom(s) &&
		parkers.some((p) => p.job && isSameSeat(p.job, s))
			? { ...s, fits: sizeOf(s.seat, 1) }
			: s,
	);

/**
 * @param {number} slots
 * @param {{
 *   read: (usage: Map<string, string>) => SeatReading[],
 *   probe: (seats: string[]) => {usage: Map<string, string>, probes: Probe[]},
 *   sizeOf: (seat: string, members: number, usageText: string) => number|null,
 *   typedSeat: string|null,
 *   sizeAll?: boolean,
 *   tries: {triedAt: Record<string, number>, now: number},
 * }} io
 * @returns {{seats: SizedSeat[], probes: Probe[]}}
 */
function readSizedSeats(
	slots,
	{ read, probe, sizeOf, typedSeat, sizeAll = false, tries },
) {
	/** @type {Map<string, string>} */
	const usage = new Map();
	/** @type {Probe[]} */
	const probes = [];
	/** @type {Map<string, number|null>} */
	const fits = new Map();
	const sizeOnce = (/** @type {string} */ seat, /** @type {number} */ n) => {
		const known = fits.get(seat);
		if (known !== undefined) return known;
		const sized = sizeOf(seat, n, usage.get(seat) ?? "");
		fits.set(seat, sized);
		return sized;
	};
	const readOrdered = () => orderPlanSeats(read(usage), typedSeat);
	const isRetryDue = (/** @type {string} */ seat) =>
		tries.now - (tries.triedAt[seat] ?? Number.NEGATIVE_INFINITY) >= STALE_MS;
	let readings = readOrdered();
	let stale = slots > 0 ? seatsToRefresh(readings, sizeAll, isRetryDue) : [];
	for (;;) {
		if (stale.length > 0) {
			const printed = probe(stale);
			for (const [seat, text] of printed.usage) usage.set(seat, text);
			probes.push(...printed.probes);
			readings = readOrdered();
		}
		const sized = sizedSeats(readings, slots, sizeOnce, sizeAll);
		stale =
			slots > 0
				? seatsToRefresh(sized, sizeAll, isRetryDue).filter(
						(seat) => !usage.has(seat),
					)
				: [];
		if (stale.length === 0) return { seats: sized, probes };
	}
}

/**
 * @param {string[]} seats
 * @param {{barsOf: (seat: string) => ReturnType<
 *     typeof import("./allowance.js").readAllowance>,
 *   triedAt: Record<string, number>,
 *   hasRunSince: (seat: string, sinceMs: number) => boolean, now: number}} io
 * @returns {string[]}
 */
function seatsDueRead(seats, { barsOf, triedAt, hasRunSince, now }) {
	return seats.filter((seat) => {
		const bars = barsOf(seat);
		const week = bars.weekly_all;
		const resets = Date.parse(week.resetsAt ?? "");
		if (isBarFull(week, now) || isTrustworthy(bars)) return false;
		const last = Math.max(week.fetchedAtMs ?? 0, triedAt[seat] ?? 0);
		return (
			(resets <= now && resets > last) ||
			now - last >= DAY_MS ||
			hasRunSince(seat, last)
		);
	});
}

const STAMP_UNMOVED = "finished (stamp unmoved)";

/**
 * @param {string} outcome
 * @param {{printedWeek: boolean, stampMs: number|null, startMs: number}} after
 */
const probeOutcome = (outcome, { printedWeek, stampMs, startMs }) =>
	outcome === "finished" && printedWeek && (stampMs ?? 0) <= startMs
		? STAMP_UNMOVED
		: outcome;

/**
 * @param {Record<string, number>} triedAt
 * @param {Probe[]} probes
 * @param {number} now
 * @param {{retryUnmoved?: boolean}} [opts]
 */
const seatTriedAfter = (
	triedAt,
	probes,
	now,
	{ retryUnmoved = true } = {},
) => ({
	...triedAt,
	...Object.fromEntries(
		probes
			.filter((p) => p.outcome !== "cached")
			.map((p) => {
				const stamp = p.stampMs ?? 0;
				const retry =
					retryUnmoved &&
					p.outcome === STAMP_UNMOVED &&
					(triedAt[p.seat] ?? 0) <= stamp;
				return [p.seat, retry ? stamp + 1 : now];
			}),
	),
});

/**
 * @param {import("./refill-seats.js").SeatList} list
 * @param {SeatReading[]} plan
 * @param {(seat: import("./refill-seats.js").OverflowSeat) =>
 *   import("./overflow-budget-core.js").Budget|{why: string}} budgetOf
 * @returns {import("./refill-decide.js").OverflowReading[]}
 */
function overflowReadings(list, plan, budgetOf) {
	if (list.errors.length > 0)
		return [
			{
				seat: null,
				fits: null,
				spentUntil: null,
				why: `it refuses: ${list.errors.join("; ")}`,
			},
		];
	const due = plan.every((s) => s.weekFull);
	return overflowSeatsOf(list.seats).map((seat) => {
		const unread = {
			seat: seat.dir,
			keyVar: seat.keyVar,
			fits: null,
			spentUntil: null,
		};
		if (!due) return { ...unread, why: "a plan seat is not weekly-full" };
		const b = budgetOf(seat);
		if ("why" in b) return { ...unread, why: b.why };
		return {
			seat: seat.dir,
			keyVar: seat.keyVar,
			fits: b.fit,
			headroomUsd: b.headroomUsd,
			spentUntil: isBudgetSpent(b) ? b.freeAgain : null,
			why: null,
		};
	});
}

/**
 * @param {import("./allowance-cap.js").Cap} cap
 * @returns {{fits: number} | {fits: null, why: string, fault: true}}
 */
function capFitsOf(cap) {
	if ("error" in cap) return { fits: null, why: cap.error, fault: true };
	return { fits: cap.floored === true ? 0 : cap.launch };
}

/**
 * @param {string} seat
 * @param {number} now
 * @param {string} [usageText]
 */
function readSeat(seat, now, usageText) {
	const bars = readAllowance({ configDir: seat, usageText, now });
	return { bars, reading: seatReadingOf(seat, bars, now) };
}

/**
 * @param {string[]} seats
 * @param {Map<string, string>} [usage]
 * @param {number} [now]
 * @returns {SeatReading[]}
 */
const readSeatReadings = (seats, usage = new Map(), now = Date.now()) =>
	seats.map((seat) => readSeat(seat, now, usage.get(seat)).reading);

/**
 * @param {{root: string|undefined, readAgents?: ReadAgents}} where
 * @param {string} seat
 * @param {number} members
 * @param {string} usageText
 * @returns {{fits: number, why?: undefined, fault?: undefined}
 *   | {fits: null, why: string, fault: boolean}}
 */
function readCap({ root, readAgents }, seat, members, usageText) {
	if (root === undefined)
		return {
			fits: null,
			why: "the loop serves no checkout to size it in",
			fault: true,
		};
	const result = readAllowance({ configDir: seat, usageText });
	if (!isTrustworthy(result))
		return {
			fits: null,
			why: "no trustworthy allowance reading",
			fault: false,
		};
	const ceilings = ceilingsOf(process.env);
	try {
		return capFitsOf(
			capOf(result, {
				members,
				thresholds: { session: ceilings.session, weekly_all: ceilings.week },
				configDir: seat,
				root,
				readAgents,
			}),
		);
	} catch (err) {
		return { fits: null, why: `sizing threw: ${String(err)}`, fault: true };
	}
}

/**
 * @param {string} seat
 * @param {{why: string, fault: boolean}} cap
 */
const buildCapUnsizedLine = (seat, cap) =>
	`${cap.fault ? "fault: " : ""}cap on ${seat} unsized: ${cap.why}`;

/**
 * @param {string|undefined} root
 * @param {(line: string) => void} note
 * @param {ReadAgents} [readAgents]
 * @returns {(seat: string, members: number, usageText?: string) => number|null}
 */
const capSizer =
	(root, note, readAgents) =>
	(seat, members, usageText = "") => {
		const cap = readCap({ root, readAgents }, seat, members, usageText);
		if (cap.fits === null) note(buildCapUnsizedLine(seat, cap));
		return cap.fits;
	};

module.exports = {
	capSizer,
	ceilingsOf,
	overflowReadings,
	probeOutcome,
	readSeat,
	readSeatReadings,
	readSizedSeats,
	seatsDueRead,
	seatTriedAfter,
	sizeParkerSeats,
	sizeResumeSeats,
};
